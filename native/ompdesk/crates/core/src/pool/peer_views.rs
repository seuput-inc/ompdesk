//! A device's existing Ctx view, bound to one execution and authenticated peer, not another registry.

use std::sync::{Arc, OnceLock};

use crate::application::callers::PeerView;
use crate::application::exits::Receipt;
use crate::remote::requests::RemoteRequests;
use crate::server::Fault;
use crate::sidecar::application::EffectFuture;
use ompdesk_app_contract::Owner;

use super::{ExecutionTarget, Host, Service, execution_source, peer_admission};

pub(crate) struct PeerPresentation<H: Host>(Arc<View<H>>);

struct View<H: Host> {
    pool: Arc<Service<H>>,
    target: ExecutionTarget<H::Sidecar>,
    proof: PeerView,
    retired: OnceLock<Receipt>,
}

impl<H: Host> Clone for PeerPresentation<H> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<H: Host> PeerPresentation<H> {
    pub(crate) fn target(&self) -> &ExecutionTarget<H::Sidecar> {
        &self.0.target
    }
    pub(super) fn belongs(&self, pool: &Service<H>) -> bool {
        std::ptr::eq(self.0.pool.as_ref(), pool)
    }
    pub(super) fn proof(&self) -> &PeerView {
        &self.0.proof
    }
    pub(crate) fn handle(&self) -> u64 {
        self.0.proof.handle()
    }
    pub(crate) fn retire(&self) -> Receipt {
        self.0.retire()
    }
}

impl<H: Host> View<H> {
    fn retire(&self) -> Receipt {
        self.retired
            .get_or_init(|| {
                let cleanup = self
                    .pool
                    .release_peer_presentation(&self.target, self.proof.handle());
                Receipt::join(cleanup)
            })
            .clone()
    }
}

impl<H: Host> Drop for View<H> {
    fn drop(&mut self) {
        let cleanup = self.retire();
        tokio::spawn(async move {
            if let Err(error) = cleanup.wait().await {
                eprintln!(
                    "native peer presentation cleanup: {}: {}",
                    error.code, error.message
                );
            }
        });
    }
}

impl<H: Host> Service<H> {
    /// Called by actual Host acquisition, never from a network-supplied handle alone.
    pub(crate) fn attach_peer_presentation(
        self: &Arc<Self>,
        owner: &Owner,
        connection: &RemoteRequests,
        target: &ExecutionTarget<H::Sidecar>,
        expected_session: Option<String>,
        handle: u64,
    ) -> EffectFuture<'static, Result<PeerPresentation<H>, Fault>> {
        let owner = owner.clone();
        let connection = connection.clone();
        let target = target.clone();
        let pool = Arc::clone(self);
        let app = Arc::clone(&self.app);
        let callers = Arc::clone(&self.callers);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                let proof = callers.capture_peer_view(
                    &owner,
                    &connection,
                    target.owner(),
                    handle,
                    |owned| {
                        let selected = peer_admission::selected(&ctx, &app, &target)?;
                        if !owned {
                            let path = expected_session
                                .as_deref()
                                .filter(|path| !path.is_empty())
                                .ok_or_else(changed)?;
                            if selected.device.is_some()
                                || selected.session_file.as_deref() != Some(path)
                                || ctx.view_target(path).as_str() != Some(target.tab())
                            {
                                return Err(changed());
                            }
                        }
                        if ctx.with(|state| {
                            state
                                .entries
                                .iter()
                                .any(|entry| entry.device_views.contains(&handle))
                        }) {
                            return Err(changed());
                        }
                        if !ctx.device_view_added_start(target.tab(), handle) {
                            return Err(changed());
                        }
                        Ok(())
                    },
                )?;
                let view = PeerPresentation(Arc::new(View {
                    pool,
                    target,
                    proof,
                    retired: OnceLock::new(),
                }));
                if let Err(error) = ctx.send_tab_lists(view.target().tab()).await {
                    let cleanup = view.retire();
                    if let Err(cleanup_error) = cleanup.wait().await {
                        eprintln!(
                            "native peer presentation cleanup: {}: {}",
                            cleanup_error.code, cleanup_error.message
                        );
                    }
                    return Err(error);
                }
                Ok(view)
            })
        })
    }

    fn release_peer_presentation(
        &self,
        target: &ExecutionTarget<H::Sidecar>,
        handle: u64,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        let target = target.clone();
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                if execution_source(&ctx, &app, target.tab(), target.source(), None).is_err()
                    || !ctx.with(|state| {
                        state
                            .entry(target.tab())
                            .is_some_and(|entry| entry.seq == target.incarnation())
                    })
                {
                    return Ok(());
                }
                ctx.device_view_left(target.tab(), handle).await
            })
        })
    }
}

fn changed() -> Fault {
    Fault::new(
        "tab_stale",
        "The original peer presentation is no longer available",
    )
}

#[cfg(test)]
#[path = "peer_views_tests.rs"]
mod tests;
