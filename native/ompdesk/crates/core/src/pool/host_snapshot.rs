//! Synchronous hosted reads run on the same hub as the canonical pool; no blocking relay or shadow cache.

use serde_json::{Map, Value};

use super::{ExecutionTarget, Host, Selected, Service, Sidecar, engine, peer_admission};
use crate::server::Fault;

pub(crate) struct HostSnapshot<S: Sidecar + ?Sized> {
    pub selected: Selected<S>,
    pub source_facts: Value,
    pub kind: String,
    pub status_detail: Map<String, Value>,
    pub presentation: Value,
    pub busy: bool,
    pub visible_windows: usize,
    pub other_device_views: usize,
    pub sign_ins: Vec<String>,
    pub pending_plan: Value,
}

impl<H: Host> Service<H> {
    /// Root constructs and polls HostServices on the hub's existing current-thread runtime.
    /// This read grants no command authority and cannot run through a blocking hub request.
    pub(crate) fn host_snapshot_now(
        &self,
        target: &ExecutionTarget<H::Sidecar>,
        own_device_view: Option<u64>,
    ) -> Result<HostSnapshot<H::Sidecar>, Fault> {
        if !self.out.open() {
            return Err(Fault::new(
                "native_snapshot_context",
                "The original pool is not open on this native hub",
            ));
        }
        let ctx = engine::POOLS
            .with(|pools| pools.borrow().get(&self.out.id()).cloned())
            .ok_or_else(super::closed)?;
        self.callers.admit_execution(target.owner(), target.tab(), None, || {
            let (selected, source_facts) = peer_admission::selected_facts(&ctx, &self.app, target)?;
            let (kind, status_detail, busy, visible_windows, other_device_views, sign_ins) = ctx.with(|pool| {
                let entry = pool.entry(target.tab()).expect("original execution checked in this hub step");
                (
                    entry.kind.clone(),
                    crate::pool::state::Pool::tab_status(entry, &selected.cwd),
                    entry.busy(),
                    entry.full.as_ref().map_or(0, Vec::len),
                    entry.device_views.iter().filter(|view| Some(**view) != own_device_view).count(),
                    entry.sign_in_providers.clone(),
                )
            });
            Ok(HostSnapshot {
                selected, source_facts, kind, status_detail,
                presentation: ctx.device_snapshot(target.tab()), busy, visible_windows,
                other_device_views, sign_ins, pending_plan: ctx.pending_plan(target.tab()),
            })
        })
    }
}

#[cfg(test)]
#[path = "host_snapshot_tests.rs"]
mod tests;
