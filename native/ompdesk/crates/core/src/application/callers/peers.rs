/// Issued by the canonical pool while it attaches an authenticated peer's actual presentation.
/// The handle alone, a device id, and network JSON cannot construct this capability.
#[derive(Clone)]
pub(crate) struct PeerView {
    execution: Owner,
    device: String,
    handle: u64,
}

impl PeerView {
    pub(crate) fn handle(&self) -> u64 {
        self.handle
    }

    pub(super) fn matches(&self, caller: &super::Admitted, execution: &Owner) -> bool {
        &self.execution == execution
            && matches!(&caller.principal, Principal::Peer { device, .. } if device == &self.device)
    }
}


    /// `attach` must verify the original pool entry/source/path and synchronously attach its device view.
    /// A foreign execution is presentable only when it was created by a real page on this computer.
    pub(crate) fn capture_peer_view(
        &self,
        owner: &Owner,
        connection: &RemoteRequests,
        execution: &Owner,
        handle: u64,
        attach: impl FnOnce(bool) -> Result<(), Fault>,
    ) -> Result<PeerView, Fault> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let device = peer(&state, owner, connection)?;
        let record = state.executions.get(execution).ok_or_else(closed)?;
        if !matches!(record.life, Life::Bound { .. })
            || state.active_tabs.get(&record.facts.tab) != Some(execution)
        {
            return Err(closed());
        }
        let owned = matches!(&record.facts.creator,
            Principal::Peer { device: original, .. } if original == device);
        if !owned && !matches!(&record.facts.creator, Principal::Page(_)) {
            return Err(closed());
        }
        connection.admit_online(|| {
            attach(owned)?;
            Ok(PeerView { execution: execution.clone(), device: device.to_owned(), handle })
        })
    }