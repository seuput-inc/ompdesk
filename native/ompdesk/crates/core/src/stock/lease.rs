use std::collections::HashMap;

const PRESENCE_MS: i64 = 10_000;
const HOLDER_IDLE_MS: i64 = 15_000;

struct Holder {
    viewer: i64,
    seen: i64,
    active: i64,
}

#[derive(Default)]
pub(super) struct Leases(HashMap<String, HashMap<String, Holder>>);

impl Leases {
    pub(super) fn apply(
        &mut self,
        owner: &str,
        id: &str,
        viewer: i64,
        action: &str,
        now: i64,
    ) -> bool {
        match action {
            "claim" | "write" | "resize" => {}
            "close" => {
                self.forget(owner, id);
                return true;
            }
            _ => return true,
        }
        let sessions = match self.0.get_mut(owner) {
            Some(sessions) => sessions,
            None => self.0.entry(owner.to_owned()).or_default(),
        };
        let next = Holder {
            viewer,
            seen: now,
            active: now,
        };
        if let Some(holder) = sessions.get_mut(id) {
            if holder.viewer == viewer {
                holder.seen = now;
                if action != "resize" {
                    holder.active = now;
                }
            } else if action == "claim"
                || now.saturating_sub(holder.seen) >= PRESENCE_MS
                || (action == "write" && now.saturating_sub(holder.active) >= HOLDER_IDLE_MS)
            {
                *holder = next;
            } else {
                return action != "resize";
            }
        } else {
            sessions.insert(id.to_owned(), next);
        }
        true
    }

    pub(super) fn seen(&mut self, owner: &str, id: &str, viewer: i64, now: i64) -> &'static str {
        let Some(holder) = self
            .0
            .get_mut(owner)
            .and_then(|sessions| sessions.get_mut(id))
        else {
            return "free";
        };
        if holder.viewer == viewer {
            holder.seen = now;
            "you"
        } else if now.saturating_sub(holder.seen) < PRESENCE_MS {
            "other"
        } else {
            self.forget(owner, id);
            "free"
        }
    }

    fn forget(&mut self, owner: &str, id: &str) {
        if let Some(sessions) = self.0.get_mut(owner) {
            sessions.remove(id);
            if sessions.is_empty() {
                self.forget_owner(owner);
            }
        }
    }

    pub(super) fn forget_owner(&mut self, owner: &str) {
        self.0.remove(owner);
    }
}

#[cfg(test)]
mod tests {
    use super::Leases;

    #[test]
    fn presence_is_touched_before_expiry_but_not_restored_after_release() {
        for (viewer, now, state) in [(2, 9_999, "other"), (2, 10_000, "free"), (1, 20_000, "you")] {
            let mut leases = Leases::default();
            assert!(leases.apply("a", "t", 1, "claim", 0));
            assert!(leases.apply("a", "t", 1, "unknown", 9_999));
            assert_eq!(leases.seen("a", "t", viewer, now), state);
            if state == "free" {
                assert_eq!(leases.seen("a", "t", 1, 10_001), "free");
                assert!(leases.apply("a", "t", 2, "resize", 10_002));
                assert!(!leases.apply("a", "t", 1, "resize", 10_003));
            }
        }
    }

    #[test]
    fn resize_refreshes_presence_but_only_typing_or_claim_restarts_activity() {
        for (action, now, state) in [
            ("resize", 14_999, "other"),
            ("resize", 15_000, "you"),
            ("write", 15_000, "other"),
            ("claim", 15_000, "other"),
            ("resize", -1, "other"),
        ] {
            let mut leases = Leases::default();
            assert!(leases.apply("a", "t", 1, "resize", 0));
            assert!(leases.apply("a", "t", 1, action, 12_000));
            assert!(leases.apply("a", "t", -2, "write", now));
            assert_eq!(leases.seen("a", "t", -2, now), state);
        }
    }

    #[test]
    fn close_and_owner_release_use_exact_keys() {
        let mut leases = Leases::default();
        for (owner, id) in [("a", "b|c"), ("a", "c"), ("a|b", "c")] {
            assert!(leases.apply(owner, id, 1, "write", 0));
        }
        assert!(leases.apply("a|b", "c", 2, "claim", 1));
        assert!(leases.apply("a", "b|c", 2, "close", 2));
        assert_eq!(leases.seen("a", "b|c", 1, 3), "free");
        assert_eq!(leases.seen("a", "c", 1, 3), "you");
        leases.forget_owner("a");
        assert_eq!(leases.seen("a", "c", 1, 4), "free");
        assert_eq!(leases.seen("a|b", "c", 2, 4), "you");
    }
}
