use super::executions::Life;
use super::{Callers, Owner, Principal, State};
use crate::remote::requests::RemoteRequests;
use crate::server::Fault;

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

impl Callers {
    /// Completes the authenticated native link handoff before any hosted operation is admitted.
    pub fn bind_peer_connection(
        &self,
        owner: &Owner,
        connection: RemoteRequests,
    ) -> Result<(), Fault> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Some(Principal::Peer {
            device,
            connection: id,
        }) = state.owners.get(owner)
        else {
            return Err(closed());
        };
        if state.stopped || !connection.is_online() || connection.link_id() != Some(*id) {
            return Err(closed());
        }
        let device = device.clone();
        let State {
            owners,
            peer_links,
            requests,
            ..
        } = &mut *state;
        for (previous, _) in owners.extract_if(|other, principal| {
            other != owner && matches!(principal, Principal::Peer { device: other_device, .. } if other_device == &device)
        }) {
            peer_links.remove(&previous);
            for request in requests.values().filter(|request| request.owner == previous) {
                request.cancel.cancel();
            }
        }
        state.peer_links.insert(owner.clone(), connection);
        Ok(())
    }

    /// The effect only captures/enqueues work; it must neither await nor reenter Callers.
    pub fn admit_peer_connection<T>(
        &self,
        owner: &Owner,
        connection: &RemoteRequests,
        effect: impl FnOnce() -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        peer(&state, owner, connection)?;
        connection.admit_online(effect)
    }

    /// A reconnect controls the original execution, never a replacement selected by an rtab name.
    pub fn admit_peer_execution<T>(
        &self,
        owner: &Owner,
        connection: &RemoteRequests,
        execution: &Owner,
        effect: impl FnOnce() -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let device = peer(&state, owner, connection)?;
        let record = state.executions.get(execution).ok_or_else(closed)?;
        if !matches!(&record.facts.creator, Principal::Peer { device: original, .. } if original == device)
            || !matches!(record.life, Life::Bound { .. })
            || state.active_tabs.get(&record.facts.tab) != Some(execution)
        {
            return Err(closed());
        }
        connection.admit_online(effect)
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
}

fn peer<'a>(
    state: &'a State,
    owner: &Owner,
    connection: &RemoteRequests,
) -> Result<&'a str, Fault> {
    if state.stopped || !connection.is_online() {
        return Err(closed());
    }
    let Some(Principal::Peer {
        device,
        connection: id,
    }) = state.owners.get(owner)
    else {
        return Err(closed());
    };
    if connection.link_id() != Some(*id)
        || !state
            .peer_links
            .get(owner)
            .is_some_and(|current| current.same_connection(connection))
    {
        return Err(closed());
    }
    Ok(device)
}

fn closed() -> Fault {
    Fault::new(
        "peer_closed",
        "The authenticated peer connection is no longer admitted",
    )
}

#[cfg(test)]
mod tests;
