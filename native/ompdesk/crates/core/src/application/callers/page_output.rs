use std::sync::{Arc, Mutex};

use ompdesk_app_contract::{NativeCaller, Owner};

use super::{Admitted, Callers, Principal};
use crate::server::Fault;
use crate::worktree_lifecycle::Window;

pub(super) struct Page {
    pub(super) owner: Owner,
    caller: NativeCaller,
    live: Mutex<bool>,
}

impl Page {
    pub(super) fn new(owner: Owner, caller: NativeCaller) -> Self {
        Self {
            owner,
            caller,
            live: Mutex::new(true),
        }
    }

    pub(super) fn close(&self) {
        *self.live.lock().unwrap_or_else(|error| error.into_inner()) = false;
    }
}

/// Transport capability for one existing page record, not permission to select or control a tab.
/// A downstream enqueue can use this while original source admission holds Callers without reentering it.
#[derive(Clone)]
pub(crate) struct PageOutput {
    page: Arc<Page>,
    window: Window,
}

impl PageOutput {
    pub(crate) fn window(&self) -> Window {
        self.window
    }

    /// The native transport must only enqueue, never await, invoke a page callback or reenter Callers.
    pub(crate) fn enqueue<T>(
        &self,
        effect: impl FnOnce(&NativeCaller) -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        let live = self
            .page
            .live
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !*live {
            return Err(closed());
        }
        effect(&self.page.caller)
    }
}

impl Callers {
    pub(crate) fn page_output(&self, caller: &Admitted) -> Result<PageOutput, Fault> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Principal::Page(endpoint) = &caller.principal else {
            return Err(closed());
        };
        if state.stopped || state.owners.get(&caller.owner) != Some(&caller.principal) {
            return Err(closed());
        }
        let page = state
            .pages
            .get(endpoint)
            .filter(|page| page.owner == caller.owner)
            .ok_or_else(closed)?;
        let id = match endpoint {
            NativeCaller::Desktop { win_id, .. } => i64::try_from(*win_id).map_err(|_| closed())?,
            NativeCaller::Web { window_id, .. } => *window_id,
        };
        Ok(PageOutput {
            page: Arc::clone(page),
            window: Window {
                id,
                incarnation: caller.owner.id(),
            },
        })
    }
}

fn closed() -> Fault {
    Fault::new("caller_closed", "The page is no longer admitted")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_cannot_receive_output_captured_for_the_previous_page() {
        let callers = Callers::new(41);
        let endpoint = NativeCaller::Desktop {
            win_id: 9,
            wc_id: 19,
        };
        let first = callers.admit_page(endpoint.clone()).unwrap();
        let output = callers.page_output(&first).unwrap();
        assert_eq!(
            output.window(),
            Window {
                id: 9,
                incarnation: first.owner.id()
            }
        );
        let mut received = Vec::new();
        callers
            .admit_owner(&first.owner, || {
                output.enqueue(|caller| {
                    received.push(caller.clone());
                    Ok(())
                })
            })
            .unwrap();
        assert_eq!(received, vec![endpoint.clone()]);
        let replacement = callers.admit_page(endpoint.clone()).unwrap();
        assert_eq!(
            output
                .enqueue(|caller| {
                    received.push(caller.clone());
                    Ok(())
                })
                .unwrap_err()
                .code,
            "caller_closed"
        );
        callers
            .page_output(&replacement)
            .unwrap()
            .enqueue(|caller| {
                received.push(caller.clone());
                Ok(())
            })
            .unwrap();
        assert_eq!(received, vec![endpoint.clone(), endpoint]);
        assert_ne!(first.owner, replacement.owner);
    }

    #[test]
    fn closed_web_output_keeps_its_original_connection_and_never_selects_a_replacement() {
        let callers = Callers::new(42);
        let endpoint = NativeCaller::Web {
            device_id: "fixture-device".into(),
            conn_id: "original".into(),
            window_id: -9,
        };
        let first = callers.admit_page(endpoint.clone()).unwrap();
        let output = callers.page_output(&first).unwrap();
        let original = output.enqueue(|caller| Ok(caller.clone())).unwrap();
        assert_eq!(original, endpoint);
        callers.close_page(&endpoint).unwrap();
        let replacement = callers
            .admit_page(NativeCaller::Web {
                device_id: "fixture-device".into(),
                conn_id: "replacement".into(),
                window_id: -9,
            })
            .unwrap();
        assert_eq!(
            output.enqueue(|_| Ok(())).unwrap_err().code,
            "caller_closed"
        );
        assert!(
            matches!(callers.page_output(&replacement).unwrap().enqueue(|caller| Ok(caller.clone())).unwrap(), NativeCaller::Web { conn_id, .. } if conn_id == "replacement")
        );
    }

    #[test]
    fn application_stop_revokes_retained_outputs_but_a_peer_never_gets_one() {
        let callers = Callers::new(43);
        let page = callers
            .admit_page(NativeCaller::Desktop {
                win_id: 12,
                wc_id: 24,
            })
            .unwrap();
        let output = callers.page_output(&page).unwrap();
        let peer = callers.admit_peer("fixture-peer".into(), 5).unwrap();
        assert_eq!(
            callers.page_output(&peer).err().unwrap().code,
            "caller_closed"
        );
        callers.stop();
        assert_eq!(
            output.enqueue(|_| Ok(())).unwrap_err().code,
            "caller_closed"
        );
    }

    #[test]
    fn an_output_does_not_keep_a_dropped_authority_live() {
        let callers = Callers::new(44);
        let page = callers.admit_page(NativeCaller::Desktop { win_id: 8, wc_id: 28 }).unwrap();
        let output = callers.page_output(&page).unwrap();
        drop(callers);
        assert_eq!(output.enqueue(|_| Ok(())).unwrap_err().code, "caller_closed");
    }
}
