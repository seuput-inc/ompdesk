//! The execution host's receipts. Only the authenticated owner of a receipt can use it.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::fail::{Fail, R, fail};
use super::types::{DeviceState, ItemOpen};
use super::{AgentControl, INSTANCES, lock};

#[derive(Clone, Deserialize, Serialize)]
struct Receipt {
    peer: String,
    tab: String,
    #[serde(flatten)]
    effect: ItemOpen,
    worktree: Option<(String, Option<Worktree>)>,
    opened: bool,
    session: Option<String>,
    first: Option<String>,
    confirmed: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Worktree {
    path: String,
    branch: String,
    base_cwd: String,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub(super) enum Step {
    Ready,
    Accept {
        effect: ItemOpen,
    },
    Read,
    Worktree {
        fingerprint: String,
    },
    TreeCreated {
        fingerprint: String,
        tree: Worktree,
    },
    Open {
        session: Option<String>,
    },
    Bind {
        session: String,
    },
    First {
        session: String,
        fingerprint: String,
    },
    Confirm {
        fingerprint: String,
    },
}

pub(super) struct Receipts {
    file: Option<PathBuf>,
    rows: Option<Vec<Receipt>>,
}

impl Receipts {
    pub(super) fn new(profile_file: Option<&Path>) -> Self {
        let file = profile_file.map(|f| f.with_file_name("paired-item-opens.json"));
        let rows = file.as_deref().and_then(|f| match std::fs::read(f) {
            Ok(bytes) => serde_json::from_slice(&bytes).ok(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(Vec::new()),
            Err(_) => None,
        });
        Self { file, rows }
    }

    fn bound(&self, peer: &str, tab: Option<&str>, session: Option<&str>) -> Option<&Receipt> {
        let mut found = self.rows.as_ref()?.iter().filter(|r| {
            r.peer == peer
                && (tab == Some(r.tab.as_str())
                    || session.is_some() && session == r.session.as_deref())
        });
        let row = found.next()?;
        found.next().is_none().then_some(row)
    }

    pub(super) fn apply(
        &mut self,
        peer: &str,
        tab: &str,
        step: Step,
        deleted: impl Fn(&str) -> bool,
    ) -> R<Value> {
        let rows = self
            .rows
            .as_mut()
            .ok_or_else(|| Fail::Tool("The peer receipt journal is unavailable.".into()))?;
        if matches!(step, Step::Ready) {
            return Ok(json!(true));
        }
        let idx = rows.iter().position(|r| r.peer == peer && r.tab == tab);
        if let Some(i) = idx {
            let row = &rows[i];
            if rows.iter().any(|other| {
                other.peer == peer
                    && other.effect.item == row.effect.item
                    && other.effect.generation > row.effect.generation
            }) {
                return fail("The peer receipt belongs to a retired generation.");
            }
        }
        let (next, result) = match step {
            Step::Accept { effect } => {
                if effect.item.is_empty()
                    || effect.generation == 0
                    || !tab.strip_prefix("item-").is_some_and(|key| {
                        key == effect.effect_key
                            && key.len() == 32
                            && key.bytes().all(|b| b.is_ascii_hexdigit())
                    })
                {
                    return fail("Invalid managed open address.");
                }
                if let Some(i) = idx {
                    let r = &rows[i];
                    return if r.effect.item == effect.item
                        && r.effect.generation == effect.generation
                    {
                        Ok(json!(true))
                    } else {
                        fail("This peer receipt belongs to another open.")
                    };
                }
                if let Some(prior) = rows
                    .iter()
                    .rev()
                    .find(|r| r.peer == peer && r.effect.item == effect.item)
                    && (prior.effect.generation >= effect.generation
                        || !prior.session.as_deref().is_some_and(deleted))
                {
                    return fail(
                        "The prior execution has not been confirmed deleted on this host.",
                    );
                }
                (
                    Receipt {
                        peer: peer.into(),
                        tab: tab.into(),
                        effect,
                        worktree: None,
                        opened: false,
                        session: None,
                        first: None,
                        confirmed: false,
                    },
                    json!(true),
                )
            }
            step => {
                let i = idx.ok_or_else(|| Fail::Tool("No such peer receipt.".into()))?;
                let r = &rows[i];
                if r.session.as_deref().is_some_and(deleted) {
                    return fail("The worker was deleted.");
                }
                match step {
                    Step::Read => {
                        return Ok(json!({
                            "item":r.effect.item, "generation":r.effect.generation,
                            "effectKey":r.effect.effect_key, "session":r.session
                        }));
                    }
                    Step::Worktree { fingerprint } => {
                        if let Some((saved, tree)) = &r.worktree {
                            if saved != &fingerprint {
                                return fail("The worktree request changed.");
                            }
                            return tree.as_ref().map(|t| json!(t)).ok_or_else(|| {
                                Fail::Tool(
                                    "Worktree creation was accepted; its outcome is unknown."
                                        .into(),
                                )
                            });
                        }
                        if r.opened {
                            return fail("The worker tab has already opened.");
                        }
                        let mut next = r.clone();
                        next.worktree = Some((fingerprint, None));
                        (next, json!(true))
                    }
                    Step::TreeCreated { fingerprint, tree } => {
                        if !r
                            .worktree
                            .as_ref()
                            .is_some_and(|(f, t)| f == &fingerprint && t.is_none())
                        {
                            return fail("No matching worktree request.");
                        }
                        let mut next = r.clone();
                        next.worktree = Some((fingerprint, Some(tree)));
                        (next, json!(true))
                    }
                    Step::Open { session } => {
                        if r.worktree.as_ref().is_some_and(|(_, tree)| tree.is_none()) {
                            return fail("The worktree is not confirmed.");
                        }
                        if r.opened {
                            return if session.is_some() && session == r.session {
                                Ok(json!(true))
                            } else {
                                fail(
                                    "The host already accepted this tab. Its saved session must be recovered.",
                                )
                            };
                        }
                        if session.is_some() {
                            return fail("A new managed tab cannot adopt a saved session.");
                        }
                        let mut next = r.clone();
                        next.opened = true;
                        (next, json!(true))
                    }
                    Step::Bind { session } => {
                        if rows
                            .iter()
                            .enumerate()
                            .any(|(j, other)| j != i && other.session.as_ref() == Some(&session))
                        {
                            return fail(
                                "Another managed receipt already owns this saved session.",
                            );
                        }
                        if !r.opened
                            || session.is_empty()
                            || r.session.as_ref().is_some_and(|s| s != &session)
                        {
                            return fail("The worker changed sessions.");
                        }
                        if r.session.is_some() {
                            return Ok(json!(true));
                        }
                        let mut next = r.clone();
                        next.session = Some(session);
                        (next, json!(true))
                    }
                    Step::First {
                        session,
                        fingerprint,
                    } => {
                        if fingerprint.len() != 64
                            || !fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
                        {
                            return fail("Invalid first prompt fingerprint.");
                        }
                        if r.session.as_ref() != Some(&session) {
                            return fail("The first prompt is not bound to this session.");
                        }
                        if let Some(saved) = &r.first {
                            return if saved != &fingerprint {
                                fail("The first prompt changed.")
                            } else if r.confirmed {
                                Ok(json!(false))
                            } else {
                                fail(
                                    "The first prompt was accepted; delivery is unconfirmed and will not be repeated.",
                                )
                            };
                        }
                        let mut next = r.clone();
                        next.first = Some(fingerprint);
                        (next, json!(true))
                    }
                    Step::Confirm { fingerprint } => {
                        if r.first.as_ref() != Some(&fingerprint) {
                            return fail("No matching first prompt.");
                        }
                        let mut next = r.clone();
                        next.confirmed = true;
                        (next, json!(true))
                    }
                    Step::Ready | Step::Accept { .. } => unreachable!(),
                }
            }
        };
        let previous = if let Some(i) = idx {
            Some(std::mem::replace(&mut rows[i], next))
        } else {
            rows.push(next);
            None
        };
        let saved = serde_json::to_vec(rows)
            .map_err(|e| e.to_string())
            .and_then(|bytes| {
                crate::disk::saves::SAVES
                    .commit(
                        self.file.as_deref().ok_or("No peer receipt file.")?,
                        &bytes,
                        0o600,
                    )
                    .map_err(|e| e.message)
            });
        if let Err(error) = saved {
            if let (Some(i), Some(previous)) = (idx, previous) {
                rows[i] = previous;
            } else {
                rows.pop();
            }
            return Err(Fail::Tool(error));
        }
        Ok(result)
    }
}

#[derive(Deserialize, Serialize)]
pub(crate) struct MailCheck {
    pub key: String,
    pub fingerprint: String,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct Check {
    pub item: String,
    pub generation: u64,
    pub session: String,
    pub mail: Option<MailCheck>,
}

impl AgentControl {
    pub(super) fn owner_grants(&self, device: &str, tab: &str, check: &Check) -> bool {
        let state = self.host.state();
        if !state.enabled
            || state
                .device(device)
                .is_none_or(|d| d.state != DeviceState::Online)
            || state
                .deleted_at_path(&check.session, Some(device))
                .is_some()
        {
            return false;
        }
        let mut matches = state.tabs.iter().filter(|t| {
            t.device.as_deref() == Some(device)
                && t.session_path.as_ref() == Some(&check.session)
                && !t.viewing
        });
        let Some(worker) = matches.next() else {
            return false;
        };
        let accepted = self
            .items()
            .get(&check.item)
            .and_then(|i| i.work.as_ref())
            .is_some_and(|w| w.accepted_tab.as_deref() == Some(tab));
        matches.next().is_none()
            && self.holds_item(worker, &check.item, check.generation)
            && accepted
            && self.mail_granted(check, Some(device))
    }

    pub(super) fn mail_granted(&self, check: &Check, device: Option<&str>) -> bool {
        check.mail.as_ref().is_none_or(|m| {
            self.permits_item_mail(
                &check.item,
                check.generation,
                &check.session,
                device,
                &m.key,
                &m.fingerprint,
            )
        })
    }
}

pub(crate) fn assignment(
    file: &Path,
    peer: &str,
    tab: Option<&str>,
    session: Option<&str>,
) -> Option<(String, u64)> {
    let from = |receipts: &Receipts| {
        let row = receipts.bound(peer, tab, session)?;
        Some((row.effect.item.clone(), row.effect.generation))
    };
    let control = lock(&INSTANCES)
        .values()
        .find(|c| c.items().stored_at(file))
        .cloned();
    match control {
        Some(ctl) => from(&lock(&ctl.peer_receipts)),
        None => from(&Receipts::new(Some(file))),
    }
}

pub(crate) async fn permitted(file: &Path, peer: &str, tab: &str, pid: u32, check: &Check) -> bool {
    let control = {
        let instances = lock(&INSTANCES);
        instances
            .values()
            .find(|c| c.items().stored_at(file))
            .cloned()
    };
    let Some(control) = control else { return false };
    let enabled = || {
        let state = control.host.state();
        state.enabled && state.deleted_at_path(&check.session, None).is_none()
    };
    if !enabled() {
        return false;
    }
    let accepted = {
        let receipts = lock(&control.peer_receipts);
        let Some(row) = receipts.bound(peer, Some(tab), Some(&check.session)) else {
            return false;
        };
        if row.session.as_ref() != Some(&check.session)
            || row.effect.item != check.item
            || row.effect.generation != check.generation
        {
            return false;
        }
        row.tab.clone()
    };
    control
        .host
        .ask::<bool>(
            "checkPeerItem",
            json!({"peer":peer,"tab":accepted,"pid":pid,"check":check}),
        )
        .await
        .unwrap_or(false)
        && enabled()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn effect(key: char, generation: u64) -> ItemOpen {
        ItemOpen {
            item: "immutable-9".into(),
            generation,
            effect_key: key.to_string().repeat(32),
        }
    }

    #[test]
    fn peer_claim_open_bind_and_first_survive_restart_without_repeating_unknown_effects() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("items.json");
        let old = effect('a', 1);
        let tab = format!("item-{}", old.effect_key);
        let mut receipts = Receipts::new(Some(&profile));
        assert!(
            receipts
                .apply(
                    "A",
                    &tab,
                    Step::Accept {
                        effect: old.clone()
                    },
                    |_| false
                )
                .is_ok()
        );
        drop(receipts);
        let mut receipts = Receipts::new(Some(&profile));
        assert_eq!(
            receipts
                .apply("A", &tab, Step::Accept { effect: old }, |_| false)
                .unwrap(),
            true
        );
        assert!(receipts.apply("B", &tab, Step::Read, |_| false).is_err());
        let tree = || Step::Worktree {
            fingerprint: "tree-request".into(),
        };
        assert_eq!(receipts.apply("A", &tab, tree(), |_| false).unwrap(), true);
        let mut receipts = Receipts::new(Some(&profile));
        assert!(receipts.apply("A", &tab, tree(), |_| false).is_err());
        assert!(
            receipts
                .apply("A", &tab, Step::Open { session: None }, |_| false)
                .is_err()
        );
        let made = Worktree {
            branch: "item".into(),
            path: "/host/tree".into(),
            base_cwd: "/host".into(),
        };
        assert!(
            receipts
                .apply(
                    "A",
                    &tab,
                    Step::TreeCreated {
                        fingerprint: "tree-request".into(),
                        tree: made
                    },
                    |_| false
                )
                .is_ok()
        );
        assert_eq!(
            receipts.apply("A", &tab, tree(), |_| false).unwrap()["path"],
            "/host/tree"
        );
        assert!(
            receipts
                .apply("A", &tab, Step::Open { session: None }, |_| false)
                .is_ok()
        );
        assert!(
            receipts
                .apply("A", &tab, Step::Open { session: None }, |_| false)
                .is_err()
        );
        let session = "/host/worker.jsonl".to_owned();
        assert!(
            receipts
                .apply(
                    "A",
                    &tab,
                    Step::Bind {
                        session: session.clone()
                    },
                    |_| false
                )
                .is_ok()
        );
        let fingerprint = "f".repeat(64);
        let first = || Step::First {
            session: session.clone(),
            fingerprint: fingerprint.clone(),
        };
        assert_eq!(receipts.apply("A", &tab, first(), |_| false).unwrap(), true);
        let mut receipts = Receipts::new(Some(&profile));
        assert!(receipts.apply("A", &tab, first(), |_| false).is_err());
        assert!(
            receipts
                .apply(
                    "A",
                    &tab,
                    Step::Confirm {
                        fingerprint: fingerprint.clone()
                    },
                    |_| false
                )
                .is_ok()
        );
        assert_eq!(
            receipts.apply("A", &tab, first(), |_| false).unwrap(),
            false
        );
        let next = effect('b', 2);
        let next_tab = format!("item-{}", next.effect_key);
        assert!(
            receipts
                .apply(
                    "A",
                    &next_tab,
                    Step::Accept {
                        effect: next.clone()
                    },
                    |_| false
                )
                .is_err()
        );
        assert!(
            receipts
                .apply("A", &next_tab, Step::Accept { effect: next }, |p| p
                    == session)
                .is_ok()
        );
        assert!(receipts.apply("A", &tab, first(), |_| false).is_err());
        assert!(
            receipts
                .apply(
                    "A",
                    &tab,
                    Step::Accept {
                        effect: effect('a', 1)
                    },
                    |_| false
                )
                .is_err()
        );
    }

    #[test]
    fn commit_failure_and_corrupt_receipts_never_authorize_an_open() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("items.json");
        let file = dir.path().join("paired-item-opens.json");
        let mut receipts = Receipts::new(Some(&profile));
        let old = effect('a', 1);
        let tab = format!("item-{}", old.effect_key);
        std::fs::create_dir(&file).unwrap();
        assert!(
            receipts
                .apply(
                    "A",
                    &tab,
                    Step::Accept {
                        effect: old.clone()
                    },
                    |_| false
                )
                .is_err()
        );
        assert!(
            receipts
                .apply("A", &tab, Step::Open { session: None }, |_| false)
                .is_err()
        );
        std::fs::remove_dir(&file).unwrap();
        std::fs::write(file, b"truncated").unwrap();
        let mut receipts = Receipts::new(Some(&profile));
        assert!(
            receipts
                .apply("A", &tab, Step::Accept { effect: old }, |_| false)
                .is_err()
        );
    }
}
