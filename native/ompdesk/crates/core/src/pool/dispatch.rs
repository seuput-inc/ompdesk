//! Per-command capture and effect checks over the existing pool and Callers authorities.

use std::sync::Arc;

#[path = "dispatch_claims.rs"]
mod claims;
pub(crate) use claims::AnswerClaim;
#[path = "dispatch_moves.rs"]
mod moves;
#[path = "dispatch_completion.rs"]
mod completion;
pub(crate) use completion::Completion;
#[path = "dispatch_login.rs"]
mod login;
#[path = "dispatch_start.rs"]
mod start;

use super::{Application, EffectFuture, ExecutionTarget, Host, Selected, Service, Sidecar};
use crate::application::callers::{Admitted, CommandAdmission, CommandView};
use crate::pool::state::Ctx;
use crate::remote::requests::RemoteRequests;
use crate::server::{Fault, Scope};

pub(crate) enum CommandOperation<S: Sidecar<Error = Fault> + ?Sized + 'static> {
    Stock(serde_json::Value, crate::agentctl::service::host::Deadline),
    PlanApproval(
        crate::local_dispatch::protocol::RpcCommand,
        Arc<AnswerClaim<S>>,
    ),
    Bridge {
        method: String,
        params: Option<serde_json::Value>,
        timeout_ms: Option<u64>,
    },
}

pub(crate) enum CommandFailure {
    Guard(Fault),
    Other(Fault),
}
impl CommandFailure {
    pub(crate) fn fault(self) -> Fault {
        match self {
            Self::Guard(error) | Self::Other(error) => error,
        }
    }
    pub(crate) fn local(self) -> crate::local_dispatch::protocol::CommandError {
        match self {
            Self::Guard(error) => {
                crate::local_dispatch::protocol::CommandError::local(error.code, error.message)
            }
            Self::Other(error) => error.into(),
        }
    }
}

/// A weak reference to the existing Application handle map, never a second source registry.
pub(crate) struct CommandEffects<S: Sidecar<Error = Fault> + ?Sized> {
    out: crate::hub::Out,
    handles: std::sync::Weak<
        std::sync::Mutex<
            std::collections::HashMap<super::super::HandleKey, super::super::Handle<S>>,
        >,
    >,
    epoch: Arc<str>,
}

impl<S: Sidecar<Error = Fault> + ?Sized> Clone for CommandEffects<S> {
    fn clone(&self) -> Self {
        Self {
            out: self.out,
            handles: self.handles.clone(),
            epoch: Arc::clone(&self.epoch),
        }
    }
}

impl<S: Sidecar<Error = Fault> + ?Sized + 'static> CommandEffects<S> {
    fn new<H: Host<Sidecar = S>>(
        out: crate::hub::Out,
        app: &Application<H>,
        epoch: Arc<str>,
    ) -> Self {
        Self {
            out,
            handles: Arc::downgrade(&app.handles),
            epoch,
        }
    }

    fn original_ctx(&self) -> Option<Ctx> {
        let ctx = crate::pool::POOLS.with(|pools| pools.borrow().get(&self.out.id()).cloned())?;
        ctx.with(|pool| pool.view_epoch == self.epoch.as_ref())
            .then_some(ctx)
    }

    pub(crate) fn guard_plan(
        &self,
        admission: Arc<CommandAdmission<S>>,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        self.apply(admission, |ctx, admission| {
            ctx.guard_plan(&admission.selected().tab, false)
        })
    }

    pub(crate) fn effect_selected<T: Send + 'static>(
        &self,
        admission: Arc<CommandAdmission<S>>,
        effect: impl FnOnce(&Selected<S>) -> Result<T, Fault> + Send + 'static,
    ) -> EffectFuture<'static, Result<T, Fault>> {
        self.apply(admission, move |_, admission| effect(admission.selected()))
    }

    fn apply<T: Send + 'static>(
        &self,
        admission: Arc<CommandAdmission<S>>,
        effect: impl FnOnce(&Ctx, &Arc<CommandAdmission<S>>) -> Result<T, Fault> + Send + 'static,
    ) -> EffectFuture<'static, Result<T, Fault>> {
        let effects = self.clone();
        let (reply, answer) = tokio::sync::oneshot::channel();
        crate::hub::post(move || {
            let result = effects.original_ctx().ok_or_else(stale).and_then(|ctx| {
                admission.authority().admit_command(&admission, || {
                    effects.check(&ctx, &admission)?;
                    effect(&ctx, &admission)
                })
            });
            let _ = reply.send(result);
        });
        Box::pin(async move {
            answer
                .await
                .map_err(|_| Fault::new("pool_closed", "The original command executor ended"))?
        })
    }

    fn check(&self, ctx: &Ctx, admission: &CommandAdmission<S>) -> Result<(), Fault> {
        self.check_at_file(ctx, admission, admission.selected().session_file.as_deref())
    }

    fn check_at_file(&self, ctx: &Ctx, admission: &CommandAdmission<S>, file: Option<&str>) -> Result<(), Fault> {
        if !self.out.open() {
            return Err(stale());
        }
        let selected = admission.selected();
        let handles = self.handles.upgrade().ok_or_else(stale)?;
        let current = handles
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&super::super::HandleKey::Tab(selected.tab.clone()))
            .is_some_and(|handle| Arc::ptr_eq(&handle.sidecar, &selected.sidecar));
        if !current || selected.sidecar.generation() != selected.generation {
            return Err(stale());
        }
        ctx.with(|pool| {
            if pool.view_epoch != self.epoch.as_ref() {
                return Err(stale());
            }
            check_entry_at_file(pool, admission, file)
        })
    }

    /// Revalidation and Lane enqueue are one admitted segment. Bridge effects retain their receipt; ending a
    /// stock waiter only unregisters its reply, never cancels the command already sent to the original Lane.
    pub(crate) fn enqueue<E: Send + 'static>(
        &self,
        admission: Arc<CommandAdmission<S>>,
        operation: CommandOperation<S>,
        failure: fn(CommandFailure) -> E,
    ) -> EffectFuture<'static, Result<serde_json::Value, E>> {
        let effects = self.clone();
        let stock_waiter = matches!(&operation, CommandOperation::Stock(..));
        let (reply, answer) = tokio::sync::oneshot::channel();
        crate::hub::post(move || {
            let ctx =
                crate::pool::POOLS.with(|pools| pools.borrow().get(&effects.out.id()).cloned());
            let work = ctx.ok_or_else(stale).and_then(|ctx| {
                admission.authority().admit_command(&admission, || {
                    effects.check(&ctx, &admission)?;
                    let selected = admission.selected();
                    let guarded = match &operation {
                        CommandOperation::Stock(command, _) => command["type"] == "plan_approval",
                        CommandOperation::Bridge { method, .. } => {
                            method == crate::local_dispatch::modes::PLAN_APPROVAL_METHOD
                        }
                        CommandOperation::PlanApproval(..) => false,
                    };
                    if guarded && let Err(error) = ctx.guard_plan(&selected.tab, false) {
                        return Ok(Err(error));
                    }
                    Ok(Ok(match operation {
                        CommandOperation::Stock(command, deadline) => selected
                            .sidecar
                            .stock_for_generation(selected.generation, command, deadline),
                        CommandOperation::PlanApproval(command, claim) => {
                            if command.kind != "plan_approval"
                                || !claim.plan_matches(&ctx, &admission)
                            {
                                return Err(stale());
                            }
                            selected.sidecar.bridge_for_generation(
                                selected.generation,
                                crate::local_dispatch::modes::PLAN_APPROVAL_METHOD.into(),
                                Some(command.fields()),
                                None,
                            )
                        }
                        CommandOperation::Bridge {
                            method,
                            params,
                            timeout_ms,
                        } => selected.sidecar.bridge_for_generation(
                            selected.generation,
                            method,
                            params,
                            timeout_ms,
                        ),
                    }))
                })
            });
            match work {
                Ok(Ok(work)) => crate::hub::spawn(async move {
                    let _original_request = admission;
                    let mut reply = reply;
                    if stock_waiter {
                        tokio::select! {
                            biased;
                            result = work => {
                                let _ = reply.send(result.map_err(|error| failure(CommandFailure::Other(error))));
                            }
                            _ = reply.closed() => {}
                        }
                    } else {
                        let result = work.await.map_err(|error| failure(CommandFailure::Other(error)));
                        let _ = reply.send(result);
                    }
                }),
                Ok(Err(error)) => {
                    let _ = reply.send(Err(failure(CommandFailure::Guard(error))));
                }
                Err(error) => {
                    let _ = reply.send(Err(failure(CommandFailure::Other(error))));
                }
            }
        });
        Box::pin(async move {
            answer.await.map_err(|_| {
                failure(CommandFailure::Other(Fault::new(
                    "pool_closed",
                    "The original command executor ended",
                )))
            })?
        })
    }
}

fn stale() -> Fault {
    Fault::new("tab_stale", "The original command target has changed")
}

fn selection<H: Host>(
    ctx: &Ctx,
    app: &Application<H>,
    tab: &str,
    window: i64,
) -> Result<Selected<H::Sidecar>, Fault> {
    let source = app.sidecar(tab).ok_or_else(stale)?;
    let generation = source.generation();
    let facts = source.facts();
    let cwd = facts["cwd"].as_str().ok_or_else(stale)?.to_owned();
    let (device, session_file) = ctx.with(|pool| {
        pool.entry(tab)
            .map(|entry| (entry.device.clone(), entry.session_file.clone()))
            .ok_or_else(stale)
    })?;
    if source.generation() != generation {
        return Err(stale());
    }
    Ok(Selected {
        tab: tab.to_owned(),
        cwd,
        device,
        window: Some(window),
        session_file,
        generation,
        sidecar: source,
    })
}

fn check<H: Host>(
    ctx: &Ctx,
    app: &Application<H>,
    admission: &CommandAdmission<H::Sidecar>,
) -> Result<(), Fault> {
    let selected = admission.selected();
    if !app.sidecar(&selected.tab).is_some_and(|source| {
        Arc::ptr_eq(&source, &selected.sidecar) && source.generation() == selected.generation
    }) {
        return Err(stale());
    }
    ctx.with(|pool| check_entry(pool, admission))
}

fn check_entry<S: Sidecar<Error = Fault> + ?Sized + 'static>(
    pool: &crate::pool::state::Pool,
    admission: &CommandAdmission<S>,
) -> Result<(), Fault> {
    check_entry_at_file(pool, admission, admission.selected().session_file.as_deref())
}

fn check_entry_at_file<S: Sidecar<Error = Fault> + ?Sized + 'static>(
    pool: &crate::pool::state::Pool,
    admission: &CommandAdmission<S>,
    file: Option<&str>,
) -> Result<(), Fault> {
    let selected = admission.selected();
    let entry = pool.entry(&selected.tab).ok_or_else(stale)?;
    if entry.closing.is_some()
        || entry.seq != admission.incarnation()
        || entry.device != selected.device
        || entry.session_file.as_deref() != file
    {
        return Err(stale());
    }
    if let Some(window) = admission.window()
        && entry.view_id(&pool.view_epoch, window.id).as_deref() != admission.view_id()
    {
        return Err(stale());
    }
    if let Some(view) = admission.view_handle()
        && !entry.device_views.contains(&view)
    {
        return Err(stale());
    }
    Ok(())
}

impl<H: Host> Service<H> {
    pub(crate) fn note_draft_command(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
        command: String,
        empty: bool,
    ) -> EffectFuture<'static, Result<bool, Fault>> {
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| Box::pin(async move {
            callers.admit_command(&admission, || {
                check(&ctx, &app, &admission)?;
                Ok(match admission.window() {
                    Some(window) => ctx.note_draft(&admission.selected().tab, window.id, &command, empty),
                    None => empty,
                })
            })
        }))
    }

    pub(crate) fn note_subagent_level_command(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
        level: String,
    ) -> EffectFuture<'static, Result<String, Fault>> {
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| Box::pin(async move {
            callers.admit_command(&admission, || {
                check(&ctx, &app, &admission)?;
                let key = match (admission.window(), admission.view_handle()) {
                    (Some(window), None) => crate::pool::state::LevelKey::Window(window.id),
                    (None, Some(view)) => crate::pool::state::LevelKey::View(view),
                    _ => return Err(stale()),
                };
                Ok(ctx.note_subagent_level(&admission.selected().tab, key, &level))
            })
        }))
    }

    pub(crate) fn foreign_session_owner_command(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
        path: String,
    ) -> EffectFuture<'static, Result<serde_json::Value, Fault>> {
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| Box::pin(async move {
            callers.admit_command(&admission, || {
                check(&ctx, &app, &admission)?;
                Ok(ctx.foreign_session_owner(Some(&admission.selected().tab), &path))
            })
        }))
    }

    pub(crate) fn note_slot_stopped(
        &self,
        caller: Admitted,
        connection: Option<RemoteRequests>,
        scope: Scope,
        capture: crate::desktop_slot::Capture,
    ) -> EffectFuture<'static, Result<Option<String>, Fault>> {
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                let (changed, session_file) = callers
                    .request_effect_for_execution(
                        &caller,
                        connection.as_ref(),
                        &scope,
                        (capture.owner(), capture.tab()),
                        || {
                            let current = app.sidecar(capture.tab()).is_some_and(|source| {
                                app.host.local_source(source.as_ref()).is_some_and(|local| {
                                    std::ptr::eq(local, capture.source().as_ref())
                                        && local.generation() == capture.generation()
                                })
                            });
                            let session_file = current.then(|| ctx.with(|pool| {
                                pool.entry(capture.tab()).and_then(|entry| entry.session_file.clone())
                            })).flatten();
                            Ok((current && ctx.note_stopped_start(capture.tab()), session_file))
                        },
                    )?
                    .unwrap_or((false, None));
                if changed {
                    ctx.on_running_change().await?;
                }
                Ok(session_file)
            })
        })
    }

    pub(crate) fn note_unstarted_command(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
        unstarted: bool,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                let window = callers.admit_command(&admission, || {
                    check(&ctx, &app, &admission)?;
                    let selected = admission.selected();
                    let window = ctx.note_unstarted_start(&selected.tab, unstarted);
                    if window.is_some() {
                        let facts = selected.sidecar.facts();
                        ctx.forward_status_now(
                            &selected.tab,
                            facts["cwd"].as_str().unwrap_or(&selected.cwd),
                        );
                    }
                    Ok(window)
                })?;
                if let Some(Some(window)) = window {
                    ctx.notify_window_tabs_changed(window).await?;
                }
                Ok(())
            })
        })
    }

    pub(crate) fn note_stopped_command(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                let changed = callers.admit_command(&admission, || {
                    check(&ctx, &app, &admission)?;
                    Ok(ctx.note_stopped_start(&admission.selected().tab))
                })?;
                if changed {
                    ctx.on_running_change().await?;
                }
                Ok(())
            })
        })
    }

    pub(crate) fn note_person_prompt(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
        runtime: Arc<crate::agentctl::runtime::Runtime>,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                callers.admit_command(&admission, || {
                    check(&ctx, &app, &admission)?;
                    let tab = &admission.selected().tab;
                    let has_parent = runtime.has_parent(tab);
                    ctx.with(|pool| {
                        let entry = pool
                            .entry_mut(tab)
                            .expect("captured entry remains in this hub step");
                        entry.user_prompted |= has_parent;
                        entry.prompted += 1;
                    });
                    Ok(())
                })?;
                ctx.on_running_change().await
            })
        })
    }

    pub(crate) fn capture_page_command(
        &self,
        caller: Admitted,
        requested_tab: Option<String>,
        channel: Option<Arc<str>>,
        scope: Scope,
    ) -> EffectFuture<'static, Result<Arc<CommandAdmission<H::Sidecar>>, Fault>> {
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        let effects = CommandEffects::new(self.out, &self.app, Arc::clone(&self.run_namespace));
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                let window = app.host.window_for(&caller.owner)?;
                let target = ctx
                    .selected_target(window, requested_tab.as_deref())
                    .ok_or_else(stale)?;
                app.host.authorize_tab(&caller.owner, &target.tab)?;
                callers
                    .capture_command(caller, None, channel, scope, effects, |original_window| {
                        let original_window = original_window.ok_or_else(stale)?;
                        if original_window.id != window {
                            return Err(stale());
                        }
                        let (incarnation, view_id) = ctx.with(|pool| {
                            let entry = pool.entry(&target.tab).ok_or_else(stale)?;
                            let view_id =
                                entry.view_id(&pool.view_epoch, window).ok_or_else(stale)?;
                            Ok::<_, Fault>((entry.seq, view_id))
                        })?;
                        Ok((
                            selection(&ctx, &app, &target.tab, window)?,
                            incarnation,
                            CommandView::Window(view_id),
                        ))
                    })
                    .map(Arc::new)
            })
        })
    }

    pub(crate) fn capture_peer_command(
        &self,
        caller: Admitted,
        connection: RemoteRequests,
        view: &super::PeerPresentation<H>,
        expected_omp: Option<String>,
        scope: Scope,
    ) -> EffectFuture<'static, Result<Arc<CommandAdmission<H::Sidecar>>, Fault>> {
        if !view.belongs(self) {
            return Box::pin(async { Err(stale()) });
        }
        let target = view.target().clone();
        let proof = view.proof().clone();
        let view_handle = proof.handle();
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        let namespace = self.run_namespace.clone();
        let effects = CommandEffects::new(self.out, &self.app, Arc::clone(&self.run_namespace));
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                callers
                    .capture_command(caller, Some(connection), None, scope, effects, |window| {
                        if window.is_some() {
                            return Err(stale());
                        }
                        let captured = super::peer_admission::selected(&ctx, &app, &target)?;
                        if expected_omp.as_ref().is_some_and(|expected| {
                            *expected
                                != super::observed::run_token(
                                    &namespace,
                                    target.incarnation(),
                                    captured.generation,
                                )
                        }) {
                            return Err(stale());
                        }
                        // The persistent peer target is not promoted to another execution after rejoin.
                        if captured.tab != target.tab()
                            || !Arc::ptr_eq(&captured.sidecar, target.source())
                        {
                            return Err(stale());
                        }
                        if !ctx.with(|pool| pool.entry(&captured.tab).is_some_and(|entry| entry.device_views.contains(&view_handle))) {
                            return Err(stale());
                        }
                        Ok((captured, target.incarnation(), CommandView::Peer(proof)))
                    })
                    .and_then(|admission| {
                        if admission.execution_owner() != target.owner() {
                            return Err(stale());
                        }
                        Ok(Arc::new(admission))
                    })
            })
        })
    }

    /// Recheck before polling a concrete native effect. `effect` may only capture/enqueue work, never await.
    pub(crate) fn command_effect<T: Send + 'static>(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
        effect: impl FnOnce(&Selected<H::Sidecar>) -> Result<T, Fault> + Send + 'static,
    ) -> EffectFuture<'static, Result<T, Fault>> {
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                callers.admit_command(&admission, || {
                    check(&ctx, &app, &admission)?;
                    effect(admission.selected())
                })
            })
        })
    }
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
pub(crate) mod tests;
