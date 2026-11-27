//! What an agent's answer holds while its attachments go in (`ompdesk_session_answer` with `attachments`, main's
//! `TargetAnswer`): the question is CLAIMED in the tick that finds it open, and until the claim is released
//! or the answer lands, every other answer to it (the person's card, another agent, a paired device viewing the tab) is
//! refused as `being_answered`. The rule lives here once; the window dispatcher, a device viewing a window's tab and
//! `routeSideChannel` all ask the pool.

use serde_json::Value;

use super::state::{Ctx, R};
use crate::server::Fault;

pub(super) const ASK_HELD: &str = "An agent is answering this question right now";

fn claim_value(claim: Option<u64>) -> Value {
    claim.map_or(Value::Null, Value::from)
}

impl Ctx {
    /// Whether `id` is a question `tab`'s omp still waits on (raised, and not yet answered or cancelled).
    pub(super) fn is_request_open(&self, tab: &str, id: &str) -> bool {
        self.with(|pool| {
            let Some(entry) = pool.entry(tab) else {
                return false;
            };
            pool.request_owners.get(&id.to_string()) == Some(&entry.seq)
        })
    }

    /// Take the question; None when it is not open or already taken.
    pub(super) fn claim_request(&self, tab: &str, id: &str) -> Value {
        claim_value(self.with(|pool| {
            let open = pool
                .entry(tab)
                .is_some_and(|entry| pool.request_owners.get(&id.to_string()) == Some(&entry.seq));
            if !open || pool.claims.contains_key(id) {
                return None;
            }
            pool.claim_serial += 1;
            let claim = pool.claim_serial;
            pool.claims.insert(id.to_owned(), claim);
            Some(claim)
        }))
    }

    /// Give a claimed question back unanswered: it stays open for anyone.
    pub(super) fn release_request(&self, id: &str, claim: u64) {
        self.with(|pool| {
            if pool.claims.get(id) == Some(&claim) {
                pool.claims.remove(id);
            }
        });
    }

    /// Refuses an answer to a claimed question unless it is the holder's (`claim`).
    pub(super) fn guard_ask(&self, id: &str, claim: Option<u64>) -> R<()> {
        let held = self.with(|pool| pool.claims.get(id).copied());
        match held {
            Some(held) if Some(held) != claim => Err(Fault::new("being_answered", ASK_HELD)),
            _ => Ok(()),
        }
    }
}
