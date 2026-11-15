use std::sync::Arc;

use ompdesk_app_contract::Owner;

use super::{Admitted, CommandAdmission, CommandEffects, CommandView, EffectFuture, Host, Service};
use crate::application::source::Source;
use crate::pool::application::Sidecar;
use crate::server::{Fault, Scope};

/// An original presentation selection, not a generation-zero command grant.
pub(crate) struct PendingCommand {
    caller: Admitted,
    execution: Owner,
    tab: String,
    source: Arc<Source>,
    incarnation: u64,
    window: i64,
    view: String,
    channel: Option<Arc<str>>,
    scope: Scope,
}

impl PendingCommand {
    pub(crate) fn source(&self) -> &Arc<Source> {
        &self.source
    }
    pub(crate) fn scope(&self) -> &Scope {
        &self.scope
    }
}

impl<H: Host<Sidecar = Source>> Service<H> {
    pub(crate) fn select_page_command(
        &self,
        caller: Admitted,
        requested_tab: Option<String>,
        channel: Option<Arc<str>>,
        scope: Scope,
    ) -> EffectFuture<'static, Result<PendingCommand, Fault>> {
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                let window = app.host.window_for(&caller.owner)?;
                let target = ctx
                    .selected_target(window, requested_tab.as_deref())
                    .ok_or_else(super::stale)?;
                app.host.authorize_tab(&caller.owner, &target.tab)?;
                let execution = callers.execution_owner(&target.tab)?;
                let (source, incarnation, view) = callers
                    .request_effect_for_execution(
                        &caller,
                        None,
                        &scope,
                        (&execution, &target.tab),
                        || {
                            let source = app.sidecar(&target.tab).ok_or_else(super::stale)?;
                            let (incarnation, view) = ctx.with(|pool| {
                                let entry = pool.entry(&target.tab).ok_or_else(super::stale)?;
                                Ok::<_, Fault>((
                                    entry.seq,
                                    entry
                                        .view_id(&pool.view_epoch, window)
                                        .ok_or_else(super::stale)?,
                                ))
                            })?;
                            Ok((source, incarnation, view))
                        },
                    )?
                    .ok_or_else(super::stale)?;
                Ok(PendingCommand {
                    caller,
                    execution,
                    tab: target.tab,
                    source,
                    incarnation,
                    window,
                    view,
                    channel,
                    scope,
                })
            })
        })
    }

    /// Wait on the original Source, then admit only its ready run in the same hub capture.
    pub(crate) fn finish_page_command(
        self: &Arc<Self>,
        pending: PendingCommand,
    ) -> EffectFuture<'static, Result<Arc<CommandAdmission<Source>>, Fault>> {
        let settled = crate::application::command_start::settled_start(
            Arc::clone(pending.source()),
            pending.scope().clone(),
        );
        let pool = Arc::clone(self);
        Box::pin(async move {
            settled.await?;
            let callers = Arc::clone(&pool.callers);
            let app = Arc::clone(&pool.app);
            let effects = CommandEffects::new(pool.out, &pool.app, Arc::clone(&pool.run_namespace));
            pool.execute_typed(move |ctx| {
                Box::pin(async move {
                    let admission = callers.capture_command(
                        pending.caller,
                        None,
                        pending.channel,
                        pending.scope,
                        effects,
                        |window| {
                            if window.is_none_or(|window| window.id != pending.window) {
                                return Err(super::stale());
                            }
                            if !app
                                .sidecar(&pending.tab)
                                .is_some_and(|source| Arc::ptr_eq(&source, &pending.source))
                            {
                                return Err(super::stale());
                            }
                            ctx.with(|pool| {
                                let entry = pool.entry(&pending.tab).ok_or_else(super::stale)?;
                                if entry.seq != pending.incarnation
                                    || entry.view_id(&pool.view_epoch, pending.window).as_deref()
                                        != Some(pending.view.as_str())
                                {
                                    return Err(super::stale());
                                }
                                Ok(())
                            })?;
                            let facts = pending.source.facts();
                            if facts["offline"] == true {
                                return Err(Fault::new(
                                    "remote_offline",
                                    "The device running this tab is offline",
                                ));
                            }
                            if facts["status"] != "ready" {
                                return Err(Fault::new(
                                    "sidecar_not_ready",
                                    format!(
                                        "Sidecar not ready ({})",
                                        facts["status"].as_str().unwrap_or_default()
                                    ),
                                ));
                            }
                            Ok((
                                super::selection(&ctx, &app, &pending.tab, pending.window)?,
                                pending.incarnation,
                                CommandView::Window(pending.view),
                            ))
                        },
                    )?;
                    if admission.execution_owner() != &pending.execution {
                        return Err(super::stale());
                    }
                    Ok(Arc::new(admission))
                })
            })
            .await
        })
    }
}

#[cfg(test)]
#[path = "dispatch_start_tests.rs"]
mod tests;
