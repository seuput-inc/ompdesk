//! Object-safe [`AgentAdapter`] trait and [`AgentSession`] runtime handle.
//!
//! Uses boxed futures ([`BoxFuture`]) rather than `async-trait` so `Cargo.lock` stays unchanged
//! while every adapter remains dyn-compatible (`Arc<dyn AgentAdapter>`).

use std::future::Future;
use std::pin::Pin;

use tokio::sync::mpsc;

use super::types::{
    AgentCapabilities, AgentError, AgentEvent, BackendId, BackendKind, InstalledBackend,
    ResumeHandle, SessionLifecycleState, SessionSpec, TurnInput,
};

/// Object-safe heap-allocated future returned by [`AgentAdapter`] methods.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Runtime handle representing one live or hibernatable session created by an [`AgentAdapter`].
#[derive(Debug)]
pub struct AgentSession {
    session_id: String,
    backend: BackendId,
    capabilities: AgentCapabilities,
    state: SessionLifecycleState,
    pid: Option<u32>,
    resume_handle: Option<ResumeHandle>,
    events: Option<mpsc::Receiver<AgentEvent>>,
}

impl AgentSession {
    /// Creates a new session handle attached to its normalized event stream.
    pub fn new(
        session_id: impl Into<String>,
        backend: BackendId,
        capabilities: AgentCapabilities,
        events: mpsc::Receiver<AgentEvent>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            backend,
            capabilities,
            state: SessionLifecycleState::Ready,
            pid: None,
            resume_handle: None,
            events: Some(events),
        }
    }

    pub fn with_state(mut self, state: SessionLifecycleState) -> Self {
        self.state = state;
        self
    }

    pub fn with_pid(mut self, pid: u32) -> Self {
        self.pid = Some(pid);
        self
    }

    pub fn with_resume_handle(mut self, handle: ResumeHandle) -> Self {
        self.resume_handle = Some(handle);
        self
    }

    pub fn id(&self) -> &str {
        &self.session_id
    }

    pub fn backend(&self) -> BackendId {
        self.backend
    }

    pub fn kind(&self) -> BackendKind {
        self.backend.kind()
    }

    pub fn capabilities(&self) -> &AgentCapabilities {
        &self.capabilities
    }

    pub fn state(&self) -> SessionLifecycleState {
        self.state
    }

    pub fn set_state(&mut self, state: SessionLifecycleState) {
        self.state = state;
    }

    /// Root child process ID for memory-footprint accounting (`None` for processless `DirectApi`).
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn set_pid(&mut self, pid: Option<u32>) {
        self.pid = pid;
    }

    pub fn resume_handle(&self) -> Option<&ResumeHandle> {
        self.resume_handle.as_ref()
    }

    pub fn set_resume_handle(&mut self, handle: ResumeHandle) {
        self.resume_handle = Some(handle);
    }

    /// Transfers ownership of the normalized event receiver to the lane's pump task.
    pub fn take_events(&mut self) -> Option<mpsc::Receiver<AgentEvent>> {
        self.events.take()
    }

    /// Borrows the event receiver directly when driving a session inline.
    pub fn events_mut(&mut self) -> Option<&mut mpsc::Receiver<AgentEvent>> {
        self.events.as_mut()
    }
}

/// Uniform lifecycle and discovery contract implemented by every agent backend.
pub trait AgentAdapter: Send + Sync {
    /// Concrete backend identity (family + provider discriminator).
    fn id(&self) -> BackendId;

    /// Coarse backend family (`ProviderCli`, `Omp`, or `DirectApi`).
    fn kind(&self) -> BackendKind {
        self.id().kind()
    }

    /// Static capability profile advertised by this adapter.
    fn capabilities(&self) -> AgentCapabilities;

    /// Probes whether this backend is installed, authenticated, or ready on this machine.
    fn detect_installed(&self) -> BoxFuture<'_, InstalledBackend>;

    /// Launches a fresh session according to `spec`.
    fn start(&self, spec: SessionSpec) -> BoxFuture<'_, Result<AgentSession, AgentError>>;

    /// Submits a new user turn to a live session.
    fn send_turn<'a>(
        &'a self,
        session: &'a AgentSession,
        input: TurnInput,
    ) -> BoxFuture<'a, Result<(), AgentError>>;

    /// Injects mid-turn steering input while a turn is already running.
    fn steer<'a>(
        &'a self,
        _session: &'a AgentSession,
        _input: TurnInput,
    ) -> BoxFuture<'a, Result<(), AgentError>> {
        let backend = self.id();
        Box::pin(async move {
            Err(AgentError::UnsupportedCapability {
                backend,
                capability: "mid_turn_steer".to_owned(),
            })
        })
    }

    /// Requests cooperative interruption of the currently running turn.
    fn interrupt<'a>(&'a self, session: &'a AgentSession) -> BoxFuture<'a, Result<(), AgentError>>;

    /// Flushes session state, persists an opaque [`ResumeHandle`], and releases runtime resources.
    fn hibernate<'a>(
        &'a self,
        _session: &'a mut AgentSession,
    ) -> BoxFuture<'a, Result<ResumeHandle, AgentError>> {
        let backend = self.id();
        Box::pin(async move {
            Err(AgentError::UnsupportedCapability {
                backend,
                capability: "idle_hibernation".to_owned(),
            })
        })
    }

    /// Rehydrates a previously persisted or hibernated session from its [`ResumeHandle`].
    fn resume(
        &self,
        handle: ResumeHandle,
        _spec: SessionSpec,
    ) -> BoxFuture<'_, Result<AgentSession, AgentError>> {
        let expected = self.id();
        Box::pin(async move {
            if handle.backend != expected {
                return Err(AgentError::InvalidResumeHandle {
                    expected,
                    found: handle.backend,
                });
            }
            Err(AgentError::UnsupportedCapability {
                backend: expected,
                capability: "resume".to_owned(),
            })
        })
    }

    /// Stops the session and tears down any child process or active network stream.
    fn stop<'a>(&'a self, session: &'a mut AgentSession) -> BoxFuture<'a, Result<(), AgentError>>;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::agent::types::{DiscoverySource, ProviderCliKind, TurnFinishReason};

    struct MinimalPtyAdapter;

    impl AgentAdapter for MinimalPtyAdapter {
        fn id(&self) -> BackendId {
            BackendId::ProviderCli(ProviderCliKind::GenericPty)
        }

        fn capabilities(&self) -> AgentCapabilities {
            AgentCapabilities::provider_cli(ProviderCliKind::GenericPty)
        }

        fn detect_installed(&self) -> BoxFuture<'_, InstalledBackend> {
            Box::pin(async { InstalledBackend::available(self.id(), DiscoverySource::UserInstall) })
        }

        fn start(&self, spec: SessionSpec) -> BoxFuture<'_, Result<AgentSession, AgentError>> {
            Box::pin(async move {
                let (tx, rx) = mpsc::channel(8);
                let _ = tx
                    .send(AgentEvent::SessionStateChanged {
                        state: SessionLifecycleState::Ready,
                        detail: None,
                    })
                    .await;
                Ok(AgentSession::new(
                    spec.session_id,
                    self.id(),
                    self.capabilities(),
                    rx,
                ))
            })
        }

        fn send_turn<'a>(
            &'a self,
            _session: &'a AgentSession,
            _input: TurnInput,
        ) -> BoxFuture<'a, Result<(), AgentError>> {
            Box::pin(async { Ok(()) })
        }

        fn interrupt<'a>(
            &'a self,
            _session: &'a AgentSession,
        ) -> BoxFuture<'a, Result<(), AgentError>> {
            Box::pin(async { Ok(()) })
        }

        fn stop<'a>(
            &'a self,
            session: &'a mut AgentSession,
        ) -> BoxFuture<'a, Result<(), AgentError>> {
            Box::pin(async move {
                session.set_state(SessionLifecycleState::Stopped);
                Ok(())
            })
        }
    }

    #[tokio::test]
    fn adapter_trait_is_dyn_compatible_and_defaults_guard_optional_operations() {
        let adapter: Arc<dyn AgentAdapter> = Arc::new(MinimalPtyAdapter);
        assert_eq!(adapter.kind(), BackendKind::ProviderCli);

        let mut session = adapter
            .start(SessionSpec::new("tab-1", "/tmp"))
            .await
            .unwrap();
        assert_eq!(session.id(), "tab-1");
        assert_eq!(session.kind(), BackendKind::ProviderCli);
        assert_eq!(session.state(), SessionLifecycleState::Ready);

        let mut rx = session.take_events().unwrap();
        assert!(session.take_events().is_none());
        assert_eq!(
            rx.recv().await,
            Some(AgentEvent::SessionStateChanged {
                state: SessionLifecycleState::Ready,
                detail: None,
            })
        );

        let steer_err = adapter
            .steer(&session, TurnInput::text("hurry"))
            .await
            .unwrap_err();
        assert_eq!(
            steer_err,
            AgentError::UnsupportedCapability {
                backend: BackendId::ProviderCli(ProviderCliKind::GenericPty),
                capability: "mid_turn_steer".to_owned(),
            }
        );

        let hibernate_err = adapter.hibernate(&mut session).await.unwrap_err();
        assert_eq!(hibernate_err.code(), "unsupported_capability");

        let mismatch_err = adapter
            .resume(
                ResumeHandle::new(BackendId::Omp, "/tmp/session.jsonl"),
                SessionSpec::new("tab-1", "/tmp"),
            )
            .await
            .unwrap_err();
        assert_eq!(
            mismatch_err,
            AgentError::InvalidResumeHandle {
                expected: BackendId::ProviderCli(ProviderCliKind::GenericPty),
                found: BackendId::Omp,
            }
        );

        let unsupported_resume = adapter
            .resume(
                ResumeHandle::new(BackendId::ProviderCli(ProviderCliKind::GenericPty), "pty-1"),
                SessionSpec::new("tab-1", "/tmp"),
            )
            .await
            .unwrap_err();
        assert_eq!(unsupported_resume.code(), "unsupported_capability");

        adapter.stop(&mut session).await.unwrap();
        assert_eq!(session.state(), SessionLifecycleState::Stopped);

        let finish = AgentEvent::TurnFinished {
            turn_id: None,
            reason: TurnFinishReason::Completed,
            resume_handle: None,
        };
        assert!(matches!(finish, AgentEvent::TurnFinished { .. }));
    }
}
