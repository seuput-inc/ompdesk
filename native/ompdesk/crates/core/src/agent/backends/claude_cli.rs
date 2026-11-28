//! Concrete [`AgentAdapter`] for Claude Code (`claude -p --output-format stream-json --verbose`).
//!
//! Spawns the user's installed `claude` CLI directly over `tokio::process` pipes (zero Node SDK
//! dependency), feeds stdout NDJSON lines through [`ClaudeStreamParser`], preserves `session_id`
//! across turns and hibernation via `--resume`, and cleanly kills active child processes on
//! `interrupt`, `hibernate`, or `stop`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use super::detect::{CliCommandSpec, DiscoveryEnv, build_tokio_command, detect_cli, detect_cli_in};
use crate::agent::adapter::{AgentAdapter, AgentSession, BoxFuture};
use crate::agent::parsers::claude_stream::ClaudeStreamParser;
use crate::agent::types::{
    AgentCapabilities, AgentError, AgentEvent, ApprovalMode, BackendId, InstalledBackend,
    ProviderCliKind, ResumeHandle, SessionLifecycleState, SessionSpec, TurnFinishReason, TurnInput,
};

const EVENT_CHANNEL_CAPACITY: usize = 256;
const CLAUDE_ENV_REMOVE: &[&str] = &["CLAUDECODE"];

/// Maps OMPdesk [`ApprovalMode`] onto Claude Code `--permission-mode` values.
pub const fn claude_permission_mode(mode: ApprovalMode) -> &'static str {
    match mode {
        ApprovalMode::Ask => "default",
        ApprovalMode::AutoApprove => "acceptEdits",
        ApprovalMode::ReadOnly => "plan",
        ApprovalMode::FullAccess => "bypassPermissions",
    }
}

/// Builds the exact `claude` CLI invocation spec for a print/stream-json turn or persistent stream.
pub fn build_claude_command(
    binary: PathBuf,
    spec: &SessionSpec,
    turn: Option<&TurnInput>,
    resume_id: Option<&str>,
    is_windows: bool,
) -> CliCommandSpec {
    let mut args = vec![
        "-p".to_owned(),
        "--output-format".to_owned(),
        "stream-json".to_owned(),
        "--verbose".to_owned(),
        "--include-partial-messages".to_owned(),
    ];

    if turn.is_none() {
        args.push("--input-format".to_owned());
        args.push("stream-json".to_owned());
    }

    let effective_resume = resume_id
        .filter(|id| !id.is_empty())
        .or_else(|| spec.resume.as_ref().map(|handle| handle.native_id.as_str()))
        .filter(|id| !id.is_empty());
    if let Some(id) = effective_resume {
        args.push("--resume".to_owned());
        args.push(id.to_owned());
    }

    let effective_model = turn
        .and_then(|input| input.model_override.as_deref())
        .filter(|model| !model.is_empty())
        .or_else(|| spec.model.as_deref().filter(|model| !model.is_empty()));
    if let Some(model) = effective_model {
        args.push("--model".to_owned());
        args.push(model.to_owned());
    }

    args.push("--permission-mode".to_owned());
    args.push(claude_permission_mode(spec.approval_mode).to_owned());

    if let Some(system_prompt) = spec
        .system_prompt
        .as_deref()
        .filter(|prompt| !prompt.is_empty())
    {
        args.push("--append-system-prompt".to_owned());
        args.push(system_prompt.to_owned());
    }

    args.extend(spec.extra_args.iter().cloned());
    CliCommandSpec::new(binary, args, is_windows)
}

/// Pumps NDJSON lines from `reader` through [`ClaudeStreamParser`] into `tx`, returning the
/// observed [`ResumeHandle`] (if Claude emitted a `session_id`).
pub async fn pump_claude_stream<R: AsyncBufRead + Unpin>(
    mut reader: R,
    parser: &mut ClaudeStreamParser,
    tx: &mpsc::Sender<AgentEvent>,
) -> Result<Option<ResumeHandle>, AgentError> {
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            break;
        }
        match parser.parse_line(&line) {
            Ok(events) => {
                for event in events {
                    if tx.send(event).await.is_err() {
                        return Ok(parser.resume_handle());
                    }
                }
            }
            Err(error) => {
                let _ = tx
                    .send(AgentEvent::Error {
                        code: error.code().to_owned(),
                        message: error.to_string(),
                        retryable: false,
                    })
                    .await;
            }
        }
    }
    Ok(parser.resume_handle())
}

struct ClaudeSessionRuntime {
    spec: SessionSpec,
    binary: PathBuf,
    is_windows: bool,
    event_tx: mpsc::Sender<AgentEvent>,
    resume_handle: StdMutex<Option<ResumeHandle>>,
    active_cancel: StdMutex<Option<oneshot::Sender<()>>>,
}

impl ClaudeSessionRuntime {
    fn cancel_active_turn(&self) -> bool {
        let cancel = self
            .active_cancel
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(tx) = cancel {
            let _ = tx.send(());
            true
        } else {
            false
        }
    }

    fn current_resume_handle(&self) -> Option<ResumeHandle> {
        self.resume_handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_resume_handle(&self, handle: ResumeHandle) {
        *self
            .resume_handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(handle);
    }
}

/// Concrete [`AgentAdapter`] driving Claude Code over `--output-format stream-json`.
pub struct ClaudeCliAdapter {
    binary_override: Option<PathBuf>,
    discovery_env: Option<DiscoveryEnv>,
    sessions: Arc<StdMutex<HashMap<String, Arc<ClaudeSessionRuntime>>>>,
}

impl Default for ClaudeCliAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeCliAdapter {
    pub fn new() -> Self {
        Self {
            binary_override: None,
            discovery_env: None,
            sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    /// Pins an explicit `claude` binary path (useful for tests and custom installs).
    pub fn with_binary(binary: impl Into<PathBuf>) -> Self {
        Self {
            binary_override: Some(binary.into()),
            discovery_env: None,
            sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    /// Uses a custom [`DiscoveryEnv`] instead of reading the host environment.
    pub fn with_discovery_env(env: DiscoveryEnv) -> Self {
        Self {
            binary_override: None,
            discovery_env: Some(env),
            sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    fn resolve_binary(&self) -> Result<(PathBuf, bool), AgentError> {
        let is_windows = self
            .discovery_env
            .as_ref()
            .map_or(cfg!(windows), |env| env.is_windows);
        if let Some(path) = &self.binary_override {
            return Ok((path.clone(), is_windows));
        }
        let info = match &self.discovery_env {
            Some(env) => detect_cli_in(self.id(), env),
            None => detect_cli(self.id()),
        };
        info.binary_path
            .map(|path| (path, is_windows))
            .ok_or_else(|| AgentError::NotInstalled {
                backend: self.id(),
                detail: info
                    .detail
                    .unwrap_or_else(|| "claude CLI binary not found on PATH".to_owned()),
            })
    }

    fn lookup_session(&self, session_id: &str) -> Result<Arc<ClaudeSessionRuntime>, AgentError> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(session_id)
            .cloned()
            .ok_or(AgentError::SessionNotReady {
                state: SessionLifecycleState::Stopped,
            })
    }
}

impl AgentAdapter for ClaudeCliAdapter {
    fn id(&self) -> BackendId {
        BackendId::ProviderCli(ProviderCliKind::ClaudeCode)
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::provider_cli(ProviderCliKind::ClaudeCode)
    }

    fn detect_installed(&self) -> BoxFuture<'_, InstalledBackend> {
        let report = if let Some(path) = &self.binary_override {
            let mut installed = InstalledBackend::available(
                self.id(),
                crate::agent::types::DiscoverySource::UserInstall,
            );
            installed.executable_path = Some(path.clone());
            installed
        } else {
            let info = match &self.discovery_env {
                Some(env) => detect_cli_in(self.id(), env),
                None => detect_cli(self.id()),
            };
            info.to_installed_backend()
        };
        Box::pin(async move { report })
    }

    fn start(&self, spec: SessionSpec) -> BoxFuture<'_, Result<AgentSession, AgentError>> {
        let resolved = self.resolve_binary();
        let backend = self.id();
        let caps = self.capabilities();
        let sessions = Arc::clone(&self.sessions);
        Box::pin(async move {
            let (binary, is_windows) = resolved?;
            if let Some(resume) = &spec.resume
                && resume.backend != backend
            {
                return Err(AgentError::InvalidResumeHandle {
                    expected: backend,
                    found: resume.backend,
                });
            }
            let (tx, rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
            let initial_resume = spec.resume.clone();
            let session_id = spec.session_id.clone();

            let runtime = Arc::new(ClaudeSessionRuntime {
                spec,
                binary,
                is_windows,
                event_tx: tx.clone(),
                resume_handle: StdMutex::new(initial_resume.clone()),
                active_cancel: StdMutex::new(None),
            });
            sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(session_id.clone(), runtime);

            let _ = tx
                .send(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Ready,
                    detail: None,
                })
                .await;

            let mut session = AgentSession::new(session_id, backend, caps, rx);
            if let Some(handle) = initial_resume {
                session.set_resume_handle(handle);
            }
            Ok(session)
        })
    }

    fn send_turn<'a>(
        &'a self,
        session: &'a AgentSession,
        input: TurnInput,
    ) -> BoxFuture<'a, Result<(), AgentError>> {
        let runtime = self.lookup_session(session.id());
        Box::pin(async move {
            let runtime = runtime?;
            let resume_id = runtime
                .current_resume_handle()
                .map(|handle| handle.native_id);
            let cmd_spec = build_claude_command(
                runtime.binary.clone(),
                &runtime.spec,
                Some(&input),
                resume_id.as_deref(),
                runtime.is_windows,
            );
            let mut cmd = build_tokio_command(
                &cmd_spec,
                Some(&runtime.spec.cwd),
                &runtime.spec.env,
                CLAUDE_ENV_REMOVE,
            );

            let mut child = cmd.spawn().map_err(|error| AgentError::SpawnFailed {
                message: format!("failed to spawn claude CLI: {error}"),
            })?;

            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(input.prompt.as_bytes()).await?;
                if !input.prompt.ends_with('\n') {
                    stdin.write_all(b"\n").await?;
                }
                stdin.shutdown().await?;
            }

            let stdout = child.stdout.take().ok_or_else(|| AgentError::SpawnFailed {
                message: "claude CLI child stdout pipe unavailable".to_owned(),
            })?;

            let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
            {
                let mut guard = runtime
                    .active_cancel
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if let Some(previous) = guard.replace(cancel_tx) {
                    let _ = previous.send(());
                }
            }

            let runtime_bg = Arc::clone(&runtime);
            tokio::spawn(async move {
                let mut parser = ClaudeStreamParser::new();
                let reader = BufReader::new(stdout);
                let tx = runtime_bg.event_tx.clone();
                let mut interrupted = false;

                tokio::select! {
                    result = pump_claude_stream(reader, &mut parser, &tx) => {
                        match result {
                            Ok(Some(handle)) => runtime_bg.set_resume_handle(handle),
                            Ok(None) => {}
                            Err(error) => {
                                let _ = tx
                                    .send(AgentEvent::Error {
                                        code: error.code().to_owned(),
                                        message: error.to_string(),
                                        retryable: error.is_retryable(),
                                    })
                                    .await;
                            }
                        }
                        let _ = child.wait().await;
                    }
                    _ = &mut cancel_rx => {
                        interrupted = true;
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                    }
                }

                if let Some(handle) = parser.resume_handle() {
                    runtime_bg.set_resume_handle(handle);
                }
                if interrupted {
                    let _ = tx
                        .send(AgentEvent::TurnFinished {
                            turn_id: input.turn_id,
                            reason: TurnFinishReason::Interrupted,
                            resume_handle: runtime_bg.current_resume_handle().map(Box::new),
                        })
                        .await;
                }
                let _ = runtime_bg
                    .active_cancel
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take();
            });

            Ok(())
        })
    }

    fn interrupt<'a>(&'a self, session: &'a AgentSession) -> BoxFuture<'a, Result<(), AgentError>> {
        let runtime = self.lookup_session(session.id());
        Box::pin(async move {
            let runtime = runtime?;
            let _ = runtime.cancel_active_turn();
            Ok(())
        })
    }

    fn hibernate<'a>(
        &'a self,
        session: &'a mut AgentSession,
    ) -> BoxFuture<'a, Result<ResumeHandle, AgentError>> {
        let session_id = session.id().to_owned();
        let runtime = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&session_id);
        Box::pin(async move {
            let handle = if let Some(rt) = runtime {
                let _ = rt.cancel_active_turn();
                let _ = rt.event_tx.try_send(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Hibernated,
                    detail: None,
                });
                rt.current_resume_handle()
                    .or_else(|| session.resume_handle().cloned())
                    .or_else(|| rt.spec.resume.clone())
            } else {
                session.resume_handle().cloned()
            };

            session.set_pid(None);
            session.set_state(SessionLifecycleState::Hibernated);

            let Some(handle) = handle else {
                return Err(AgentError::InvalidSpec {
                    message: "Claude session has no observed session_id to hibernate with"
                        .to_owned(),
                });
            };
            session.set_resume_handle(handle.clone());
            Ok(handle)
        })
    }

    fn resume(
        &self,
        handle: ResumeHandle,
        mut spec: SessionSpec,
    ) -> BoxFuture<'_, Result<AgentSession, AgentError>> {
        let expected = self.id();
        if handle.backend != expected {
            return Box::pin(async move {
                Err(AgentError::InvalidResumeHandle {
                    expected,
                    found: handle.backend,
                })
            });
        }
        spec.resume = Some(handle);
        self.start(spec)
    }

    fn stop<'a>(&'a self, session: &'a mut AgentSession) -> BoxFuture<'a, Result<(), AgentError>> {
        let session_id = session.id().to_owned();
        let runtime = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&session_id);
        Box::pin(async move {
            if let Some(rt) = runtime {
                let _ = rt.cancel_active_turn();
                let _ = rt.event_tx.try_send(AgentEvent::SessionStateChanged {
                    state: SessionLifecycleState::Stopped,
                    detail: None,
                });
            }
            session.set_pid(None);
            session.set_state(SessionLifecycleState::Stopped);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn builds_exact_claude_stream_json_argv_with_resume_model_and_permissions() {
        let mut spec = SessionSpec::new("tab-claude", "/repo");
        spec.model = Some("claude-sonnet-4-6".to_owned());
        spec.approval_mode = ApprovalMode::AutoApprove;
        spec.system_prompt = Some("Be concise.".to_owned());
        spec.extra_args = vec!["--max-turns".to_owned(), "12".to_owned()];

        let mut turn = TurnInput::text("Inspect Cargo.toml");
        turn.model_override = Some("claude-opus-4-6".to_owned());

        let cmd = build_claude_command(
            PathBuf::from("C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd"),
            &spec,
            Some(&turn),
            Some("sess-999"),
            true,
        );

        assert!(cmd.use_cmd_shim);
        assert_eq!(
            cmd.args,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--resume",
                "sess-999",
                "--model",
                "claude-opus-4-6",
                "--permission-mode",
                "acceptEdits",
                "--append-system-prompt",
                "Be concise.",
                "--max-turns",
                "12",
            ]
        );
    }

    #[tokio::test]
    async fn pumps_mock_claude_ndjson_stream_and_preserves_resume_handle() {
        let ndjson = concat!(
            "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"cl-sess-7\",\"model\":\"claude-sonnet-4-6\"}\n",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-6\"}}}\n",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello!\"}}}\n",
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"cl-sess-7\"}\n",
        );
        let (tx, mut rx) = mpsc::channel(16);
        let mut parser = ClaudeStreamParser::new();
        let handle = pump_claude_stream(BufReader::new(Cursor::new(ndjson)), &mut parser, &tx)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            handle,
            ResumeHandle::new(
                BackendId::ProviderCli(ProviderCliKind::ClaudeCode),
                "cl-sess-7"
            )
        );
        drop(tx);

        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::TextDelta { text, .. } if text == "Hello!"
        )));
        assert!(events.iter().any(|ev| matches!(
            ev,
            AgentEvent::TurnFinished {
                reason: TurnFinishReason::Completed,
                ..
            }
        )));
    }

    #[tokio::test]
    async fn hibernate_and_resume_preserve_claude_resume_handle_and_reject_mismatched_backend() {
        let adapter = ClaudeCliAdapter::with_binary("/usr/local/bin/claude");
        let mut spec = SessionSpec::new("tab-2", "/tmp");
        spec.resume = Some(ResumeHandle::new(
            BackendId::ProviderCli(ProviderCliKind::ClaudeCode),
            "cl-resume-42",
        ));

        let mut session = adapter.start(spec).await.unwrap();
        let handle = adapter.hibernate(&mut session).await.unwrap();
        assert_eq!(session.state(), SessionLifecycleState::Hibernated);
        assert_eq!(handle.native_id, "cl-resume-42");

        let resumed = adapter
            .resume(handle.clone(), SessionSpec::new("tab-2", "/tmp"))
            .await
            .unwrap();
        assert_eq!(resumed.resume_handle(), Some(&handle));

        let err = adapter
            .resume(
                ResumeHandle::new(BackendId::Omp, "/tmp/omp.jsonl"),
                SessionSpec::new("tab-3", "/tmp"),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_resume_handle");
    }
}
