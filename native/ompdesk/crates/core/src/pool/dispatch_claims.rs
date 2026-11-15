//! Private question/plan capabilities from the original admitted pool entry.

use std::sync::Arc;

use serde_json::Value;

use super::{CommandEffects, CommandFailure, CommandOperation, stale};
use crate::application::callers::CommandAdmission;
use crate::pool::application::{EffectFuture, Sidecar};
use crate::pool::state::Ctx;
use crate::server::Fault;

pub(crate) enum Kind {
    Question(String),
    Plan,
}

/// Never serialized or constructed from a command's `own`/claim fields.
pub(crate) struct AnswerClaim<S: Sidecar<Error = Fault> + ?Sized + 'static> {
    admission: Arc<CommandAdmission<S>>,
    kind: Kind,
    token: u64,
}

impl<S: Sidecar<Error = Fault> + ?Sized + 'static> AnswerClaim<S> {
    pub(super) fn plan_matches(&self, ctx: &Ctx, admission: &Arc<CommandAdmission<S>>) -> bool {
        Arc::ptr_eq(&self.admission, admission)
            && matches!(self.kind, Kind::Plan)
            && ctx.plan_still_claimed(&admission.selected().tab, self.token)
    }

    pub(crate) fn still_current(self: &Arc<Self>) -> EffectFuture<'static, Result<bool, Fault>> {
        let claim = Arc::clone(self);
        self.admission
            .effects()
            .apply(Arc::clone(&self.admission), move |ctx, admission| {
                Ok(match &claim.kind {
                    Kind::Plan => claim.plan_matches(ctx, admission),
                    Kind::Question(id) => {
                        ctx.is_request_open(&admission.selected().tab, id)
                            && ctx.with(|pool| pool.claims.get(id) == Some(&claim.token))
                    }
                })
            })
    }

    pub(crate) fn approve(
        self: &Arc<Self>,
        command: crate::local_dispatch::protocol::RpcCommand,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        self.admission.effects().enqueue(
            Arc::clone(&self.admission),
            CommandOperation::PlanApproval(command, Arc::clone(self)),
            CommandFailure::fault,
        )
    }

    pub(crate) fn answer(
        self: &Arc<Self>,
        frame: Value,
        choice: String,
    ) -> EffectFuture<'static, Result<bool, Fault>> {
        let claim = Arc::clone(self);
        let (reply, answer) = tokio::sync::oneshot::channel();
        let begin =
            self.admission
                .effects()
                .apply(Arc::clone(&self.admission), move |ctx, admission| {
                    let Kind::Question(id) = &claim.kind else {
                        return Err(stale());
                    };
                    if frame["type"] != "extension_ui_response"
                        || frame["id"].as_str() != Some(id.as_str())
                    {
                        return Err(Fault::new(
                            "invalid_response",
                            "The answer does not belong to the claimed question",
                        ));
                    }
                    if !ctx.is_request_open(&admission.selected().tab, id) {
                        return Err(stale());
                    }
                    ctx.guard_ask(id, Some(claim.token))?;
                    let held = ctx.with(|pool| {
                        pool.request_bodies
                            .get(id)
                            .map(|held| held.source_generation)
                    });
                    if held != Some(Some(admission.selected().generation)) {
                        return Err(stale());
                    }
                    let responder = admission.window().map(|window| window.id);
                    let (seq, shared) = match ctx.route_answer_begin(
                        id,
                        Some(&admission.selected().tab),
                        responder,
                    ) {
                        crate::pool::later::Begin::Unknown => {
                            let _ = reply.send(Ok(false));
                            return Ok(());
                        }
                        crate::pool::later::Begin::Refused => {
                            return Err(Fault::new(
                                "already_answered",
                                "Another window already answered this request",
                            ));
                        }
                        crate::pool::later::Begin::Go { seq, shared, .. } => (seq, shared),
                    };
                    let delivered = admission
                        .selected()
                        .sidecar
                        .send_for_generation(admission.selected().generation, frame.clone());
                    let ctx = ctx.clone();
                    let id = id.clone();
                    let original = Arc::clone(admission);
                    crate::hub::spawn(async move {
                        let _original_request = original;
                        let _claim = claim;
                        let delivered = delivered.await;
                        ctx.with(|pool| {
                            if delivered.is_err() && shared {
                                pool.answered.remove(&id);
                            }
                            pool.answering.remove(&id);
                        });
                        let result = match delivered {
                            Err(error) => Err(error),
                            Ok(()) => ctx
                                .route_answered(seq, &id, &frame, responder, shared, &choice)
                                .await
                                .map(|()| true),
                        };
                        let _ = reply.send(result);
                    });
                    Ok(())
                });
        Box::pin(async move {
            begin.await?;
            answer
                .await
                .map_err(|_| Fault::new("pool_closed", "The original answer executor ended"))?
        })
    }
}

impl<S: Sidecar<Error = Fault> + ?Sized + 'static> Drop for AnswerClaim<S> {
    fn drop(&mut self) {
        let effects = self.admission.effects().clone();
        let token = self.token;
        let tab = self.admission.selected().tab.clone();
        let question = match &self.kind {
            Kind::Question(id) => Some(id.clone()),
            Kind::Plan => None,
        };
        crate::hub::post(move || {
            // Releasing only this token is bookkeeping, not a new mutation permission.
            if let Some(ctx) = effects.original_ctx() {
                match question {
                    Some(id) => ctx.release_request(&id, token),
                    None => ctx.release_plan(&tab, token),
                }
            }
        });
    }
}

impl<S: Sidecar<Error = Fault> + ?Sized + 'static> CommandEffects<S> {
    pub(crate) fn claim_question(
        &self,
        admission: Arc<CommandAdmission<S>>,
        id: String,
    ) -> EffectFuture<'static, Result<Option<Arc<AnswerClaim<S>>>, Fault>> {
        self.apply(admission, move |ctx, admission| {
            let generation = ctx.with(|pool| {
                pool.request_bodies
                    .get(&id)
                    .map(|held| held.source_generation)
            });
            if generation != Some(Some(admission.selected().generation)) {
                return Ok(None);
            }
            Ok(ctx
                .claim_request(&admission.selected().tab, &id)
                .as_u64()
                .map(|token| {
                    Arc::new(AnswerClaim {
                        admission: Arc::clone(admission),
                        kind: Kind::Question(id),
                        token,
                    })
                }))
        })
    }

    pub(crate) fn claim_plan(
        &self,
        admission: Arc<CommandAdmission<S>>,
        file: String,
        generation: u64,
    ) -> EffectFuture<'static, Result<Option<Arc<AnswerClaim<S>>>, Fault>> {
        self.apply(admission, move |ctx, admission| {
            let run = ctx.with(|pool| {
                pool.entry(&admission.selected().tab)
                    .and_then(|entry| entry.plan_source_generation)
            });
            if run != Some(admission.selected().generation) {
                return Ok(None);
            }
            Ok(ctx
                .claim_plan(&admission.selected().tab, &file, generation)
                .as_u64()
                .map(|token| {
                    Arc::new(AnswerClaim {
                        admission: Arc::clone(admission),
                        kind: Kind::Plan,
                        token,
                    })
                }))
        })
    }
}
