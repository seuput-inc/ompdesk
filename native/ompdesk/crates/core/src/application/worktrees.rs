use std::sync::{Arc, Mutex};

use ompdesk_app_contract::{NativeCaller, Owner};
use serde_json::{Value, json};

use super::callers::Callers;
use super::exits::Receipt;
use super::prefs::Prefs;
use crate::pool::application::native::{
    ExecutionCommand, ExecutionRun, Host as PoolHost, Service as Pool,
};
use crate::pool::application::{Sidecar, Spawn as PoolSpawn};
use crate::server::{Events, Fault};
use crate::web::router::{Host as Router, Pushed};
use crate::worktree_lifecycle::native::{Captured, NativeHost};
use crate::worktree_lifecycle::{self as policy, Spawn, UiEvent, Window, Work};

type Lifecycle<P> = policy::Lifecycle<NativeHost<Hooks<P>>>;
type Capture<P> = Captured<<P as crate::pool::application::Host>::Sidecar>;

pub struct Hooks<P: PoolHost> {
    pool: Arc<Pool<P>>,
    callers: Arc<Callers>,
    prefs: Arc<Prefs>,
    events: Events,
    router: Arc<Router>,
}

impl<P: PoolHost> policy::native::Hooks for Hooks<P> {
    type Source = P::Sidecar;

    fn windows(&self) -> Vec<Window> {
        self.callers.windows()
    }

    fn send(&self, window: Window, event: UiEvent) {
        let (channel, data) = match event {
            UiEvent::Prompts(prompts) => {
                ("worktree-lifecycle:prompts", serde_json::to_value(prompts))
            }
            UiEvent::Notice(notice) => ("worktree-lifecycle:notice", serde_json::to_value(notice)),
        };
        let data = match data {
            Ok(data) => data,
            Err(error) => {
                self.events.send(
                    "application.error",
                    &json!({"code":"worktree_notice", "message":error.to_string()}),
                );
                return;
            }
        };
        self.callers.with_window(window, |caller| match caller {
            NativeCaller::Desktop { wc_id, .. } => self.events.send(
                "wc.send",
                &json!({
                    "wcId":wc_id, "channel":channel, "args":[data],
                }),
            ),
            NativeCaller::Web {
                device_id, conn_id, ..
            } => match serde_json::value::to_raw_value(&data) {
                Ok(data) => {
                    self.router.deliver_connection(
                        device_id,
                        conn_id,
                        Pushed::new(channel.into(), Some(data)),
                    );
                }
                Err(error) => self.events.send(
                    "application.error",
                    &json!({"code":"worktree_notice", "message":error.to_string()}),
                ),
            },
        });
    }

    fn branch_prefix(&self) -> Option<String> {
        self.prefs
            .get("worktreeBranchPrefix")
            .ok()
            .flatten()
            .as_ref()
            .and_then(branch_prefix)
    }

    fn create(
        &self,
        spawn: &Spawn,
        captured: &Captured<Self::Source>,
        params: Option<Value>,
    ) -> Work<Value> {
        self.pool.execution_command(
            Arc::clone(&self.callers),
            &spawn.owner,
            &spawn.tab,
            Arc::clone(&captured.source),
            Some(spawn.window),
            ExecutionRun::Captured(captured.generation),
            ExecutionCommand::Bridge {
                method: "worktree_lifecycle_create".into(),
                params,
                timeout_ms: None,
            },
        )
    }

    fn bind_if_live(
        &self,
        spawn: &Spawn,
        captured: &Captured<Self::Source>,
        binding: Value,
    ) -> Work<bool> {
        self.pool.bind_execution(
            Arc::clone(&self.callers),
            &spawn.owner,
            &spawn.tab,
            Arc::clone(&captured.source),
            spawn.window,
            binding,
        )
    }

    fn refresh(&self, spawn: &Spawn, captured: &Captured<Self::Source>) -> Work<Value> {
        self.pool.execution_command(
            Arc::clone(&self.callers),
            &spawn.owner,
            &spawn.tab,
            Arc::clone(&captured.source),
            None,
            ExecutionRun::Current,
            ExecutionCommand::Bridge {
                method: "worktree_lifecycle_settings".into(),
                params: None,
                timeout_ms: None,
            },
        )
    }

    fn stop_turn(&self, spawn: &Spawn, captured: &Captured<Self::Source>) -> Work<()> {
        let stopped = self.pool.execution_command(
            Arc::clone(&self.callers),
            &spawn.owner,
            &spawn.tab,
            Arc::clone(&captured.source),
            None,
            ExecutionRun::Current,
            ExecutionCommand::Stock(json!({"type":"abort"})),
        );
        Box::pin(async move { stopped.await.map(|_| ()) })
    }

    fn release(&self, spawn: &Spawn, captured: &Captured<Self::Source>) -> Work<()> {
        self.pool.release_execution(
            Arc::clone(&self.callers),
            &spawn.owner,
            &spawn.tab,
            Arc::clone(&captured.source),
        )
    }
}

pub struct Service<P: PoolHost> {
    lifecycle: Arc<Lifecycle<P>>,
    callers: Arc<Callers>,
}

pub struct Prepared<P: PoolHost> {
    pub gate: crate::sidecar::application::StartGate,
    pub released: Release<P>,
}

enum Gate<P: PoolHost> {
    Pending,
    Started(Arc<Capture<P>>),
    Closed,
}

pub struct Release<P: PoolHost> {
    lifecycle: Arc<Lifecycle<P>>,
    owner: Owner,
    tab: String,
    captured: Arc<Mutex<Gate<P>>>,
}

impl<P: PoolHost> Release<P> {
    pub fn released(self, receipt: &Receipt) {
        let captured = {
            let mut gate = self
                .captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            std::mem::replace(&mut *gate, Gate::Closed)
        };
        if let Gate::Started(captured) = captured {
            self.lifecycle
                .released(&self.owner, &self.tab, &captured, receipt.wait());
        }
    }
}

pub struct Config<P: PoolHost> {
    pub pool: Arc<Pool<P>>,
    pub callers: Arc<Callers>,
    pub prefs: Arc<Prefs>,
    pub events: Events,
    pub router: Arc<Router>,
    pub git: Arc<crate::git::session_lifecycle::Service>,
}

impl<P: PoolHost> Service<P> {
    pub fn new(config: Config<P>) -> Arc<Self> {
        let callers = Arc::clone(&config.callers);
        let hooks = Arc::new(Hooks {
            pool: config.pool,
            callers: config.callers,
            prefs: config.prefs,
            events: config.events,
            router: config.router,
        });
        let host = NativeHost::new(hooks, config.git);
        Arc::new(Self {
            lifecycle: policy::Lifecycle::new(host, policy::Config::default()),
            callers,
        })
    }

    pub fn prepare_gate(
        &self,
        spawn: &PoolSpawn,
        source: Arc<P::Sidecar>,
    ) -> Result<Option<Prepared<P>>, Fault> {
        self.callers
            .execution_facts(&spawn.owner)
            .filter(|execution| execution.tab == spawn.tab)
            .ok_or_else(|| {
                Fault::new(
                    "tab_stale",
                    "The captured execution is no longer registered",
                )
            })?;
        let Some(window) = self.callers.execution_window(&spawn.owner)? else {
            // Peer executions have no original page on whose behalf a creation gate can act.
            return Ok(None);
        };
        if Some(window.id) != spawn.window {
            return Err(Fault::new("tab_stale", "The captured execution is no longer registered"));
        }
        let spawn = Spawn {
            owner: spawn.owner.clone(),
            tab: spawn.tab.clone(),
            window,
            cwd: spawn.cwd.clone(),
            agent: spawn.kind == "agent",
            fresh: spawn.fresh,
            session_path: spawn.session_path.clone(),
            device: spawn.device.clone(),
            explicit_worktree: spawn.worktree.is_some(),
            placeholder: spawn.placeholder,
            defer_start: spawn.defer_start,
        };
        let captured = Arc::new(Mutex::new(Gate::Pending));
        let released = Release {
            lifecycle: Arc::clone(&self.lifecycle),
            owner: spawn.owner.clone(),
            tab: spawn.tab.clone(),
            captured: Arc::clone(&captured),
        };
        let lifecycle = Arc::clone(&self.lifecycle);
        let gate = Box::new(move || {
            let mut gate = captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !matches!(*gate, Gate::Pending) {
                return Box::pin(async { Err("The captured start gate was released".to_owned()) })
                    as crate::sidecar::application::EffectFuture<
                        'static,
                        Result<Option<String>, String>,
                    >;
            }
            let source = Arc::new(Captured {
                generation: source.generation(),
                source,
            });
            *gate = Gate::Started(Arc::clone(&source));
            let started = lifecycle.start(spawn, source);
            Box::pin(async move { started.await.map_err(|error| error.message) })
                as crate::sidecar::application::EffectFuture<
                    'static,
                    Result<Option<String>, String>,
                >
        });
        Ok(Some(Prepared { gate, released }))
    }

    pub fn answer(&self, window: Window, id: &str, accept: bool) -> bool {
        self.lifecycle.answer(window, id, accept)
    }
    pub fn prompts(&self, window: Window) -> Vec<policy::Prompt> {
        self.lifecycle.prompts(window)
    }
    pub fn window_closed(&self, window: Window) {
        self.lifecycle.window_closed(window);
    }
    pub async fn finalize(&self) {
        self.lifecycle.finalize().await;
    }
    pub async fn settled(&self) {
        self.lifecycle.settle().await;
    }
}

// The renderer/main counterpart is src/shared/worktree-branch.ts::worktreeBranchPrefix; it must be available before omp starts.
pub(crate) fn branch_prefix(value: &Value) -> Option<String> {
    let prefix = crate::fs::order::js_trim(value.as_str()?);
    if prefix.is_empty()
        || prefix.len() > 40
        || prefix.starts_with('-')
        || prefix.contains("..")
        || !prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
        || !prefix.ends_with(['/', '_', '-'])
    {
        return None;
    }
    let mut parts = prefix.split('/').peekable();
    while let Some(part) = parts.next() {
        if part.starts_with('.')
            || (parts.peek().is_some() && (part.is_empty() || part.ends_with(".lock")))
        {
            return None;
        }
    }
    Some(prefix.to_owned())
}
