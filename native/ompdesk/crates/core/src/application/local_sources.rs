//! Construct a local execution from Root's already-admitted Spawn. Root owns owner issuance, pool registration,
//! start gates and successful Source lifetimes. This factory retains only cleanup of failed constructions.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde_json::Value;
use tokio::sync::oneshot;
use tokio::task::{JoinError, JoinSet};

use super::callers::Callers;
use super::launch_host::{BrowserState, Config as LaunchConfig, LaunchHost};
use super::launch_ingress::LaunchIngress;
use super::prefs::Prefs;
use super::sessions::SessionIndex;
use super::tools::HostTools;
use crate::aimemory::application::Memory;
use crate::machine::{Environment, Service as Machine};
use crate::mcp_hub::{McpHub, policy::LaunchKind};
use crate::pool::application::Spawn;
use crate::server::{Events, Fault};
use crate::session_ownership::SessionOwnership;
use crate::sidecar::application::Application;
use crate::sidecar::native::{self, Held, Service as NativeSidecar, Sink, SpawnAdapter};

type Joined = Shared<BoxFuture<'static, Result<(), Fault>>>;

/// Canonical machine-wide services and trusted boot facts. No caller, origin or control grant is cached here.
/// The existing native lane options remain boot configuration, not permission switches.
#[derive(Clone)]
pub(crate) struct Config {
    pub callers: Arc<Callers>,
    pub machine: Arc<Machine>,
    pub prefs: Arc<Prefs>,
    pub sessions: Arc<SessionIndex>,
    pub memory: Arc<Memory>,
    pub hub: Arc<McpHub>,
    pub ownership: Arc<SessionOwnership>,
    pub browsers: Arc<BrowserState>,
    pub host_tools: HostTools,
    pub events: Events,
    pub spawn: Arc<dyn SpawnAdapter>,
    pub commands: Arc<crate::local_dispatch::Config>,
    pub bridge_dir: PathBuf,
    pub builtin_dir: PathBuf,
    pub memory_state_file: PathBuf,
    pub roles_file: PathBuf,
    pub rotation_ledger: PathBuf,
    pub user_flags: Vec<String>,
    pub session_owned_text: String,
    pub device_reply_language: Option<String>,
    pub bridge: bool,
    pub event_filter: Vec<String>,
    pub ledger_file: Option<String>,
    pub start_slow_ms: Option<u64>,
    pub entry_id_timeout_ms: Option<u64>,
    pub tuning: Option<native::Tuning>,
}

/// Root retains all four together until the exact Source exit. Nothing starts a child during construction.
pub(crate) struct Created {
    pub source: Arc<NativeSidecar>,
    pub application: Arc<Application<LaunchHost>>,
    pub ingress: Arc<LaunchIngress<LaunchHost>>,
    pub commands: Arc<crate::local_dispatch::Commands<NativeSidecar>>,
    pub held: Held,
}

enum State {
    Open {
        cleanup: JoinSet<Result<(), Fault>>,
        failure: Option<Fault>,
    },
    Closed(Joined),
}

pub(crate) struct LocalSources {
    config: Config,
    state: Mutex<State>,
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|error| error.into_inner())
}

fn record(result: Result<Result<(), Fault>, JoinError>, failure: &mut Option<Fault>) {
    if let Err(error) = result.unwrap_or_else(|error| Err(Fault::new("local_source_cleanup", error.to_string()))) {
        failure.get_or_insert(error);
    }
}

impl LocalSources {
    pub fn new(config: Config) -> Self {
        Self { config, state: Mutex::new(State::Open { cleanup: JoinSet::new(), failure: None }) }
    }

    /// Root calls this after reserve/keep has returned, never while holding the Callers admission lock.
    /// `lane_id` is Root's globally unique internal id; the original external pool tab stays in LaunchConfig.
    pub fn create(
        &self,
        spawn: &Spawn,
        lane_id: String,
        downstream: Arc<dyn Sink>,
        origin: Option<Value>,
        control_environment: Environment,
    ) -> Result<Created, Fault> {
        let kind = match spawn.kind.as_str() {
            "agent" => LaunchKind::Agent,
            "chat" => LaunchKind::Chat,
            _ => return Err(Fault::new("tab_state", "The native spawn kind is not agent or chat")),
        };
        let mut state = lock(&self.state);
        let State::Open { cleanup, failure } = &mut *state else {
            return Err(Fault::new("local_sources_closed", "The native local source factory is closed"));
        };
        while let Some(result) = cleanup.try_join_next() { record(result, failure); }
        let ingress = LaunchIngress::new(downstream);
        let (source, held) = NativeSidecar::new(native::Config {
            tab: lane_id, seq: 0, cwd: spawn.cwd.clone(), fresh: spawn.fresh,
            event_filter: self.config.event_filter.clone(), bridge: self.config.bridge,
            ledger_file: self.config.ledger_file.clone(), start_slow_ms: self.config.start_slow_ms,
            entry_id_timeout_ms: self.config.entry_id_timeout_ms, tuning: self.config.tuning.clone(),
            session_path: spawn.session_path.clone(), is_new: Some(spawn.fresh),
        }, self.config.events.clone(), ingress.clone(), Arc::clone(&self.config.spawn))?;
        let host = LaunchHost::new(LaunchConfig {
            owner: spawn.owner.clone(), tab: spawn.tab.clone(), callers: Arc::clone(&self.config.callers),
            source: Arc::clone(&source), machine: Arc::clone(&self.config.machine), prefs: Arc::clone(&self.config.prefs),
            sessions: Arc::clone(&self.config.sessions), memory: Arc::clone(&self.config.memory),
            hub: Arc::clone(&self.config.hub), ownership: Arc::clone(&self.config.ownership),
            browsers: Arc::clone(&self.config.browsers), bridge_dir: self.config.bridge_dir.clone(),
            builtin_dir: self.config.builtin_dir.clone(), memory_state_file: self.config.memory_state_file.clone(),
            roles_file: self.config.roles_file.clone(), rotation_ledger: self.config.rotation_ledger.clone(),
            user_flags: self.config.user_flags.clone(), host_tools: Arc::clone(&self.config.host_tools.base),
            control_tools: Arc::clone(&self.config.host_tools.control), origin, kind, device: spawn.device.clone(),
            control_environment, session_owned_text: self.config.session_owned_text.clone(),
            device_reply_language: self.config.device_reply_language.clone(),
        });
        let application = match host {
            Ok(host) => Arc::new(Application::new(host)),
            Err(error) => {
                retain_failed(cleanup, source, ingress, held);
                return Err(error);
            }
        };
        if let Err(error) = ingress.bind(&application) {
            retain_failed(cleanup, source, ingress, held);
            return Err(error);
        }
        let commands = match crate::local_dispatch::Commands::new(
            Arc::clone(&source), Arc::clone(&self.config.commands),
        ) {
            Ok(commands) => Arc::new(commands),
            Err(error) => {
                retain_failed(cleanup, source, ingress, held);
                return Err(error);
            }
        };
        Ok(Created { source, application, ingress, commands, held })
    }

    /// Latch synchronously, then join every failed construction independently of any waiter's lifetime.
    /// Successful Created values belong to Root and are deliberately not a second Source registry here.
    pub fn close(&self) -> Joined {
        let mut state = lock(&self.state);
        if let State::Closed(joined) = &*state { return joined.clone(); }
        let (reply, answer) = oneshot::channel();
        let joined = async move {
            answer.await.unwrap_or_else(|_| Err(Fault::new("local_source_cleanup", "Local source cleanup ended without a receipt")))
        }.boxed().shared();
        let State::Open { mut cleanup, mut failure } = std::mem::replace(&mut *state, State::Closed(joined.clone())) else { unreachable!() };
        tokio::spawn(async move {
            while let Some(result) = cleanup.join_next().await { record(result, &mut failure); }
            let _ = reply.send(failure.map_or(Ok(()), Err));
        });
        joined
    }
}

impl Drop for LocalSources {
    fn drop(&mut self) {
        // Root normally joins close. Abandoning the factory must not cancel an already-open Lane's cleanup.
        let state = self.state.get_mut().unwrap_or_else(|error| error.into_inner());
        if let State::Open { cleanup, .. } = state { cleanup.detach_all(); }
    }
}

fn retain_failed(
    cleanup: &mut JoinSet<Result<(), Fault>>,
    source: Arc<NativeSidecar>,
    ingress: Arc<LaunchIngress<LaunchHost>>,
    held: Held,
) {
    let joined = ingress.close();
    let exited = source.when_exited();
    source.dispose(Duration::ZERO);
    cleanup.spawn(async move {
        let exited = exited.await;
        let held = held.await;
        let joined = joined.await;
        drop(source);
        exited.and(held).and(joined)
    });
}

#[cfg(test)]
#[path = "local_sources_tests.rs"]
mod tests;
