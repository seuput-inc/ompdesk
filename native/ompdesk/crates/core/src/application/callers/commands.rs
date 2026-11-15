//! A per-request capture from the existing caller/execution authority, not another context registry.

use std::sync::Arc;

use ompdesk_app_contract::{NativeCaller, Owner};

use super::executions::Life;
use super::{Admitted, Callers, Principal, State};
use crate::pool::application::Sidecar;
use crate::pool::application::native::Selected;
use crate::pool::application::native::dispatch::{
    CommandEffects, CommandFailure, CommandOperation,
};
use crate::remote::requests::RemoteRequests;
use crate::server::{Fault, Scope};
use crate::worktree_lifecycle::Window;

pub(crate) enum CommandView {
    Window(String),
    Peer(super::PeerView),
}

pub(crate) struct CommandAdmission<S: Sidecar<Error = Fault> + ?Sized> {
    authority: Arc<Callers>,
    effects: CommandEffects<S>,
    caller: Admitted,
    execution: Owner,
    selected: Selected<S>,
    incarnation: u64,
    window: Option<Window>,
    view: CommandView,
    connection: Option<RemoteRequests>,
    channel: Option<Arc<str>>,
    scope: Scope,
}

impl<S: Sidecar<Error = Fault> + ?Sized + 'static> CommandAdmission<S> {
    pub(crate) fn effect<T: Send + 'static>(
        self: &Arc<Self>,
        effect: impl FnOnce(&Selected<S>) -> Result<T, Fault> + Send + 'static,
    ) -> crate::sidecar::application::EffectFuture<'static, Result<T, Fault>> {
        self.effects.effect_selected(Arc::clone(self), effect)
    }
    pub(crate) fn effects(&self) -> &CommandEffects<S> {
        &self.effects
    }
    pub(crate) fn guard_plan(
        self: &Arc<Self>,
    ) -> crate::sidecar::application::EffectFuture<'static, Result<(), Fault>> {
        self.effects.guard_plan(Arc::clone(self))
    }
    pub(crate) fn claim_question(
        self: &Arc<Self>,
        id: String,
    ) -> crate::sidecar::application::EffectFuture<
        'static,
        Result<Option<Arc<crate::pool::application::native::dispatch::AnswerClaim<S>>>, Fault>,
    > {
        self.effects.claim_question(Arc::clone(self), id)
    }
    pub(crate) fn claim_plan(
        self: &Arc<Self>,
        file: String,
        generation: u64,
    ) -> crate::sidecar::application::EffectFuture<
        'static,
        Result<Option<Arc<crate::pool::application::native::dispatch::AnswerClaim<S>>>, Fault>,
    > {
        self.effects.claim_plan(Arc::clone(self), file, generation)
    }
    pub(crate) fn authority(&self) -> &Arc<Callers> {
        &self.authority
    }
    pub fn stock(
        self: &Arc<Self>,
        command: serde_json::Value,
    ) -> crate::sidecar::application::EffectFuture<'static, Result<serde_json::Value, Fault>> {
        self.stock_with_deadline(command, crate::agentctl::service::host::Deadline::Default)
    }
    pub fn stock_with_deadline(
        self: &Arc<Self>,
        command: serde_json::Value,
        deadline: crate::agentctl::service::host::Deadline,
    ) -> crate::sidecar::application::EffectFuture<'static, Result<serde_json::Value, Fault>> {
        let kind = command["type"].as_str().unwrap_or("").to_owned();
        let work = self.effects.enqueue(
            Arc::clone(self),
            CommandOperation::Stock(command, crate::agentctl::service::host::Deadline::None),
            CommandFailure::fault,
        );
        let waiter = crate::local_dispatch::rpc_call::wait(work, kind, deadline);
        Box::pin(async move { waiter.await.map_err(crate::local_dispatch::RpcError::into_fault) })
    }
    pub(crate) fn stock_call(
        self: &Arc<Self>,
        command: serde_json::Value,
        deadline: crate::agentctl::service::host::Deadline,
    ) -> crate::sidecar::application::EffectFuture<
        'static,
        Result<serde_json::Value, crate::local_dispatch::RpcError>,
    > {
        let kind = command["type"].as_str().unwrap_or("").to_owned();
        let work = self.effects.enqueue(
            Arc::clone(self),
            CommandOperation::Stock(command, crate::agentctl::service::host::Deadline::None),
            CommandFailure::fault,
        );
        Box::pin(crate::local_dispatch::rpc_call::wait(work, kind, deadline))
    }
    pub fn bridge(
        self: &Arc<Self>,
        method: String,
        params: Option<serde_json::Value>,
        timeout_ms: Option<u64>,
    ) -> crate::sidecar::application::EffectFuture<'static, Result<serde_json::Value, Fault>> {
        self.effects.enqueue(
            Arc::clone(self),
            CommandOperation::Bridge {
                method,
                params,
                timeout_ms,
            },
            CommandFailure::fault,
        )
    }
    pub(crate) fn bridge_for_local(
        self: &Arc<Self>,
        method: String,
        params: Option<serde_json::Value>,
        timeout_ms: Option<u64>,
    ) -> crate::sidecar::application::EffectFuture<
        'static,
        Result<serde_json::Value, crate::local_dispatch::protocol::CommandError>,
    > {
        self.effects.enqueue(
            Arc::clone(self),
            CommandOperation::Bridge {
                method,
                params,
                timeout_ms,
            },
            CommandFailure::local,
        )
    }
    pub fn caller(&self) -> &Admitted {
        &self.caller
    }
    pub fn execution_owner(&self) -> &Owner {
        &self.execution
    }
    pub fn selected(&self) -> &Selected<S> {
        &self.selected
    }
    pub fn incarnation(&self) -> u64 {
        self.incarnation
    }
    pub fn window(&self) -> Option<Window> {
        self.window
    }
    pub fn view_id(&self) -> Option<&str> {
        match &self.view {
            CommandView::Window(id) => Some(id),
            CommandView::Peer(_) => None,
        }
    }
    pub(crate) fn view_handle(&self) -> Option<u64> {
        match &self.view {
            CommandView::Window(_) => None,
            CommandView::Peer(view) => Some(view.handle()),
        }
    }
    pub fn connection(&self) -> Option<&RemoteRequests> {
        self.connection.as_ref()
    }
    pub fn channel(&self) -> Option<&str> {
        self.channel.as_deref()
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
}

fn stale() -> Fault {
    Fault::new("caller_closed", "The original command admission has ended")
}

fn original_caller(
    state: &State,
    caller: &Admitted,
    connection: Option<&RemoteRequests>,
) -> Result<Option<Window>, Fault> {
    if state.stopped || state.owners.get(&caller.owner) != Some(&caller.principal) {
        return Err(stale());
    }
    match &caller.principal {
        Principal::Page(page) => {
            if connection.is_some() || !state.pages.get(page).is_some_and(|page| page.owner == caller.owner) {
                return Err(stale());
            }
            let id = match page {
                NativeCaller::Desktop { win_id, .. } => {
                    i64::try_from(*win_id).map_err(|_| stale())?
                }
                NativeCaller::Web { window_id, .. } => *window_id,
            };
            Ok(Some(Window {
                id,
                incarnation: caller.owner.id(),
            }))
        }
        Principal::Peer { connection: id, .. } => {
            let connection = connection.ok_or_else(stale)?;
            if connection.link_id() != Some(*id)
                || !state
                    .peer_links
                    .get(&caller.owner)
                    .is_some_and(|current| current.same_connection(connection))
            {
                return Err(stale());
            }
            Ok(None)
        }
    }
}

fn execution(state: &State, caller: &Admitted, tab: &str, view: &CommandView) -> Result<Owner, Fault> {
    let owner = state.active_tabs.get(tab).ok_or_else(stale)?;
    let record = state.executions.get(owner).ok_or_else(stale)?;
    if record.facts.tab != tab || !matches!(record.life, Life::Bound { .. }) {
        return Err(stale());
    }
    if matches!(&caller.principal, Principal::Peer { .. })
        && !matches!(view, CommandView::Peer(view) if view.matches(caller, owner))
    {
        return Err(stale());
    }
    Ok(owner.clone())
}

impl Callers {
    /// Called only by the pool's synchronous hub capture. `capture` must check the original visible tab,
    /// source Arc and pool incarnation without reentering Callers or awaiting.
    pub(crate) fn capture_command<S: Sidecar<Error = Fault> + ?Sized + 'static>(
        self: &Arc<Self>,
        caller: Admitted,
        connection: Option<RemoteRequests>,
        channel: Option<Arc<str>>,
        scope: Scope,
        effects: CommandEffects<S>,
        capture: impl FnOnce(Option<Window>) -> Result<(Selected<S>, u64, CommandView), Fault>,
    ) -> Result<CommandAdmission<S>, Fault> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let window = original_caller(&state, &caller, connection.as_ref())?;
        let make = || {
            if scope.cancelled() {
                return Err(Fault::new("cancelled", "The command was cancelled"));
            }
            let (selected, incarnation, view) = capture(window)?;
            if window.is_some() != matches!(view, CommandView::Window(_)) {
                return Err(stale());
            }
            let execution = execution(&state, &caller, &selected.tab, &view)?;
            Ok((selected, incarnation, view, execution))
        };
        let (selected, incarnation, view, execution) = match &connection {
            Some(connection) => connection.admit_online(make)?,
            None => make()?,
        };
        Ok(CommandAdmission {
            authority: Arc::clone(self),
            effects,
            caller,
            execution,
            selected,
            incarnation,
            window,
            view,
            connection,
            channel,
            scope,
        })
    }

    pub(crate) fn request_effect<T>(
        &self,
        caller: &Admitted,
        connection: Option<&RemoteRequests>,
        scope: &Scope,
        effect: impl FnOnce() -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        self.request_effect_state(caller, connection, scope, |_| effect())
    }

    fn request_effect_state<T>(
        &self,
        caller: &Admitted,
        connection: Option<&RemoteRequests>,
        scope: &Scope,
        effect: impl FnOnce(&State) -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        original_caller(&state, caller, connection)?;
        let run = || {
            if scope.cancelled() {
                return Err(Fault::new("cancelled", "The command was cancelled"));
            }
            effect(&state)
        };
        match connection {
            Some(connection) => connection.admit_online(run),
            None => run(),
        }
    }

    /// App-wide actions still carry the original caller/scope; the private Slot capture names its cleanup target.
    pub(crate) fn request_effect_for_execution<T>(
        &self,
        caller: &Admitted,
        connection: Option<&RemoteRequests>,
        scope: &Scope,
        target: (&Owner, &str),
        effect: impl FnOnce() -> Result<T, Fault>,
    ) -> Result<Option<T>, Fault> {
        self.request_effect_state(caller, connection, scope, |state| {
            if !state.executions.get(target.0).is_some_and(|record| {
                record.facts.tab == target.1
                    && matches!(record.life, Life::Bound { .. })
                    && state.active_tabs.get(target.1) == Some(target.0)
            }) {
                return Ok(None);
            }
            effect().map(Some)
        })
    }

    /// One synchronous segment of the same request. The pool must also recheck its captured source and incarnation.
    pub(crate) fn admit_command<S: Sidecar<Error = Fault> + ?Sized + 'static, T>(
        &self,
        command: &CommandAdmission<S>,
        effect: impl FnOnce() -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let window = original_caller(&state, &command.caller, command.connection.as_ref())?;
        if window != command.window
            || execution(&state, &command.caller, &command.selected.tab, &command.view)? != command.execution
        {
            return Err(stale());
        }
        let run = || {
            if command.scope.cancelled() {
                return Err(Fault::new("cancelled", "The command was cancelled"));
            }
            effect()
        };
        match &command.connection {
            Some(connection) => connection.admit_online(run),
            None => run(),
        }
    }
}
