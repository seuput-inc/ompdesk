use std::sync::Arc;

use super::{CommandAdmission, CommandEffects, EffectFuture, ExecutionTarget, Host, Service, Sidecar};
use crate::server::Fault;

/// One in-flight move of the original entry. Drop ends only bookkeeping, never cancels the RPC.
pub(crate) struct Move<S: Sidecar<Error = Fault> + ?Sized + 'static> {
    admission: Arc<CommandAdmission<S>>,
    effects: CommandEffects<S>,
    pending: tokio::sync::watch::Sender<usize>,
}

impl<S: Sidecar<Error = Fault> + ?Sized + 'static> Move<S> {
    /// The policy decides moved/unknown from the typed RPC outcome, before this token ends.
    pub(crate) fn finish(self, touched: bool) -> EffectFuture<'static, Result<(), Fault>> {
        let effects = self.effects.clone();
        let admission = Arc::clone(&self.admission);
        let (reply, answer) = tokio::sync::oneshot::channel();
        crate::hub::post(move || crate::hub::spawn(async move {
            let result = async {
                let ctx = effects.original_ctx().ok_or_else(super::stale)?;
                admission.authority().admit_command(&admission, || {
                    effects.check(&ctx, &admission)?;
                    if touched {
                        ctx.with(|pool| {
                            let entry = pool.entry_mut(&admission.selected().tab).expect("original entry checked");
                            entry.touched += 1;
                        });
                    }
                    Ok(())
                })?;
                if touched { ctx.on_running_change().await?; }
                Ok(())
            }.await;
            drop(self);
            let _ = reply.send(result);
        }));
        Box::pin(async move { answer.await.map_err(|_| Fault::new("pool_closed", "The original move executor ended"))? })
    }
}

impl<S: Sidecar<Error = Fault> + ?Sized + 'static> Drop for Move<S> {
    fn drop(&mut self) {
        self.pending.send_modify(|pending| *pending = pending.checked_sub(1).expect("one move token ends once"));
    }
}

impl<H: Host> Service<H> {
    pub(crate) fn begin_move_command(
        &self,
        admission: Arc<CommandAdmission<H::Sidecar>>,
    ) -> EffectFuture<'static, Result<Move<H::Sidecar>, Fault>> {
        let effects = admission.effects().clone();
        let token_effects = effects.clone();
        effects.apply(admission, move |ctx, admission| {
            let pending = ctx.with(|pool| pool.entry(&admission.selected().tab).expect("original entry checked").moves.clone());
            pending.send_modify(|pending| *pending += 1);
            Ok(Move { admission: Arc::clone(admission), effects: token_effects, pending })
        })
    }

    /// Resume keeps its original execution capability and judges touched only after every admitted move ends.
    pub(crate) fn moves_settled(
        &self,
        target: &ExecutionTarget<H::Sidecar>,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        let target = target.clone();
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        let captured = self.execute_typed(move |ctx| Box::pin(async move {
            callers.admit_execution(target.owner(), target.tab(), None, || {
                super::super::peer_admission::selected(&ctx, &app, &target)?;
                Ok(ctx.with(|pool| pool.entry(target.tab()).expect("original entry checked").moves.subscribe()))
            })
        }));
        Box::pin(async move {
            let mut pending = captured.await?;
            while *pending.borrow_and_update() != 0 {
                pending.changed().await.map_err(|_| Fault::new("pool_closed", "The original move tracker ended"))?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
#[path = "dispatch_moves_tests.rs"]
mod tests;
