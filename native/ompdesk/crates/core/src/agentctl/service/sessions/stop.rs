//! `ompdesk_session_stop`: `#stop`, `#stopStored`, `#personTurn`, `#abort`, `#within`, `#deleteWhenIdle`,
//! `#journalClose`, `#dropWorktree`, `#whenGone`, `#closeTab`, `#fated`, `#rememberClosed`.

use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::json;

use crate::agentctl::journal::send_outbox::receiver_key;
use crate::agentctl::journal::session_fates::FatedSession;
use crate::agentctl::rules::mail::{MailKind, delivery_for};
use crate::agentctl::rules::tab_close::{
    TabCloseFacts, TabCloseStep, needs_person_turn, tab_close_step,
};
use crate::agentctl::service::AgentControl;
use crate::agentctl::service::fail::{R, fail};
use crate::agentctl::service::host::Deadline;
use crate::agentctl::service::js::{number, one_line};
use crate::agentctl::service::text::{
    StopFlags, by_caller, cleanup_of, ids_of, label, stored_title, waits,
};
use crate::agentctl::service::types::{
    CloseOutcome, ControlTab, SafeRemoval, StopArgs, StoredSession, WorktreeRef, WorktreeRemoval,
};
use crate::agentctl::service::util::join;

/// How a close of one tab ended (`TabClose`): `Kept`: the tab is still open (main kept a page's tab it was asked to
/// release, or a window let go of it and main still lists it); `Dirty`: not touched, its paired page's unsaved Files
/// edits in it are the person's; `Refused`: its window answered why it keeps it; `Unanswered`: its window said
/// nothing within the wait, so its page is not running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabClose {
    Closed,
    Kept,
    Dirty,
    Refused(CloseOutcome),
    Unanswered,
}

/// The id of the next close a window is asked to make: unique across a core's restarts too, because main keeps a
/// window's last answer while a new core starts counting (ids start from the clock).
fn next_close_id() -> u64 {
    static NEXT: LazyLock<AtomicU64> = LazyLock::new(|| {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_millis() as u64);
        AtomicU64::new(ms * 1000)
    });
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// What a close of one tab is told (`closeTab`'s `how`): `auto` marks the window's close as the app's own; `cleared`:
/// the caller checked the in-use rule for this close (`needs_person_turn`) and it lets it go.
#[derive(Clone, Copy, Debug)]
pub struct CloseHow {
    pub auto: bool,
    pub(crate) expected_turn: Option<crate::pool::AutoCloseTurn>,
    pub wait_ms: u64,
    pub cleared: bool,
}

/// What `tab_close_step` and `needs_person_turn` read of a tab.
fn facts(tab: &ControlTab) -> TabCloseFacts {
    TabCloseFacts {
        web_edits: tab.web_edits.map(|edits| edits.to_rules()),
        looked: tab.looked,
        user_touched: tab.user_touched,
    }
}

/// What a close of a view says: the view went, the tab it viewed (another computer's window, or a paired device's
/// tab this computer runs) stays open with its omp. `stopped`: its turn was asked to stop first.
fn view_kept(target: &ControlTab, stopped: bool) -> String {
    let holder = match target.device_name.as_deref().or(target.device.as_deref()) {
        Some(computer) => format!(
            "in a tab on {computer} (that computer's own window, or a tab it runs for another device)"
        ),
        None => "in a tab this computer runs for a paired device (that device's window)".to_owned(),
    };
    format!(
        "{} is still open {holder}: this app only viewed that tab, so the close ended this app's view and left that tab {}. A tab another computer's window holds closes only there: ask the user to close it there; its session is saved either way.",
        label(target),
        if stopped {
            "open (its turn was asked to stop)"
        } else {
            "and its omp running"
        }
    )
}

/// What a close that left `target` open says: its window's own answer, or that its window did not answer.
fn kept_text(target: &ControlTab, outcome: TabClose, waited_ms: u64) -> String {
    let name = label(target);
    let saved = "its session is saved either way.";
    match outcome {
        TabClose::Refused(CloseOutcome::LastTab) => format!(
            "{name} is still open: it is its window's last tab, and a window keeps its last tab. Ask the user to close it or open another tab there; {saved}"
        ),
        TabClose::Refused(CloseOutcome::UnsavedEdits) => format!(
            "{name} is still open: its Files editor holds unsaved edits, so its window asked the user to save or discard them before the tab closes. Ask the user to answer that; {saved}"
        ),
        TabClose::Refused(CloseOutcome::InUse) => format!(
            "{name} is still open: the user is at it in its window. Ask the user to close it; {saved}"
        ),
        TabClose::Refused(CloseOutcome::NotHere) => format!(
            "{name} is still open: its window does not list that tab (it may still be adding it). Call again in a moment; {saved}"
        ),
        TabClose::Dirty => format!(
            "{name} is still open: its page holds unsaved edits in the Files editor of this tab, and closing it would lose them. Ask the user to save or discard them, then close it again; {saved}"
        ),
        TabClose::Unanswered => format!(
            "{name} is still open: its window did not answer the close within {} s, so its page is not running (a stuck window closes nothing and shows nothing new). Ask the user to look at that window; {saved}",
            number(waited_ms as f64 / 1000.0)
        ),
        TabClose::Kept | TabClose::Refused(CloseOutcome::Closing) | TabClose::Closed => format!(
            "{name} is still open: its window let go of the tab but the app still holds it. Ask the user to close it; {saved}"
        ),
    }
}

impl AgentControl {
    /// `#within`: `future`'s value, or None once `ms` passed. The future is dropped then: what it already sent to main
    /// stays sent, but nothing more is waited for (the TypeScript let the promise run on).
    pub(in crate::agentctl::service) async fn within<T>(
        &self,
        future: impl Future<Output = T>,
        ms: u64,
    ) -> Option<T> {
        tokio::time::timeout(Duration::from_millis(ms), future)
            .await
            .ok()
    }

    /// `#fated`: a tab's session as a fate records it; `opened_by_session`: its opener's session file, when known.
    pub(in crate::agentctl::service) fn fated(
        &self,
        tab: &ControlTab,
        opened_by_session: Option<&str>,
    ) -> FatedSession {
        FatedSession {
            ids: ids_of(tab),
            path: tab.session_path.clone().filter(|path| !path.is_empty()),
            device: tab.device.clone().filter(|device| !device.is_empty()),
            title: if tab.hidden {
                String::new()
            } else if !tab.title.is_empty() {
                tab.title.clone()
            } else {
                tab.task.clone().unwrap_or_default()
            },
            hidden: tab.hidden,
            cwd: tab.cwd.clone(),
            opened_by_session: opened_by_session
                .filter(|opened| !opened.is_empty())
                .map(str::to_owned),
        }
    }

    /// `#rememberClosed`: a tab the control tools closed keeps naming its saved session (`fates`); `opener`: the
    /// caller, when it opened it.
    pub(in crate::agentctl::service) fn remember_closed(
        &self,
        tab: &ControlTab,
        opener: Option<&ControlTab>,
        by: &str,
    ) {
        let Some(path) = tab.session_path.as_deref().filter(|path| !path.is_empty()) else {
            return;
        };
        let fated = self.fated(
            tab,
            opener.and_then(|opener| opener.session_path.as_deref()),
        );
        self.fates().closed(fated, by);
        if let Some(opener) = opener {
            self.mem().closed_openers.insert(
                receiver_key(path, tab.device.as_deref()),
                opener.tab_id.clone(),
            );
        }
    }

    /// `#whenGone`: resolves once no window of the app lists the tab and its omp has exited, or after a few seconds.
    /// The omp outlives its tab by a moment, and where it works is no folder to remove or hand on while it does
    /// (Windows).
    async fn when_gone(&self, tab_id: &str, wait_ms: u64) {
        // Every snapshot main pushes is looked at, so a tab that was gone only between two pushes counts.
        let gone = self
            .host
            .wait_for(Some(wait_ms), |state| {
                (!state.tabs.iter().any(|tab| tab.tab_id == tab_id)).then_some(())
            })
            .await;
        // The window kept the tab: its omp runs on.
        if gone.is_none() {
            return;
        }
        let _ = self
            .within(self.host.exited(tab_id), self.tuning.omp_exit_wait_ms)
            .await;
    }

    /// `#closeTab`: close one open tab and wait for it to be gone, as `tab_close_step` decides from the tab now.
    pub(in crate::agentctl::service) async fn close_tab(
        &self,
        caller_tab_id: &str,
        tab_id: &str,
        how: CloseHow,
    ) -> R<TabClose> {
        let Some(tabs) = self.host.state().tabs(caller_tab_id) else {
            return Ok(TabClose::Kept);
        };
        let Some(tab) = tabs.iter().find(|entry| entry.tab_id == tab_id) else {
            return Ok(if how.expected_turn.is_some() {
                TabClose::Kept
            } else {
                TabClose::Closed
            });
        };
        if how.expected_turn.is_some_and(|turn| {
            tab.close_turn != Some(turn) || tab.busy || tab.resuming || waits(tab)
        }) {
            return Ok(TabClose::Kept);
        }
        match tab_close_step(&facts(tab), how.cleared) {
            TabCloseStep::Keep(reason) => {
                return Ok(if reason.as_str() == "dirty" {
                    TabClose::Dirty
                } else {
                    TabClose::Kept
                });
            }
            TabCloseStep::AskWindow => {
                return Ok(self.ask_window_close(caller_tab_id, tab_id, how).await);
            }
            TabCloseStep::Release => {
                if !self
                    .host
                    .release(caller_tab_id, tab_id, how.expected_turn)
                    .await?
                {
                    return Ok(TabClose::Kept);
                }
            }
        }
        self.when_gone(tab_id, how.wait_ms).await;
        // Read from every tab of the app, not the caller's view of them: a caller that went meanwhile (its window
        // closed, its tab released) has no view, and that says nothing of whether the target closed.
        let still = self
            .host
            .state()
            .tabs
            .iter()
            .any(|entry| entry.tab_id == tab_id);
        Ok(if still {
            TabClose::Kept
        } else {
            TabClose::Closed
        })
    }

    /// A desktop window closes its own tab (its renderer applies the person's guards) and answers the close with
    /// what it did. Waits until the tab is gone (then for its omp's exit) or the window answered that it keeps it;
    /// no answer within the wait is a window whose page is not running.
    async fn ask_window_close(&self, caller_tab_id: &str, tab_id: &str, how: CloseHow) -> TabClose {
        let close_id = next_close_id();
        self.host
            .close_view(caller_tab_id, tab_id, how.auto, close_id, how.expected_turn);
        let answer_of =
            |state: &crate::agentctl::service::host::HostState| -> Option<Option<CloseOutcome>> {
                let Some(tab) = state.tabs.iter().find(|entry| entry.tab_id == tab_id) else {
                    return Some(None);
                };
                tab.close_answer
                    .filter(|answer| answer.close_id == close_id)
                    .map(|answer| Some(answer.outcome))
            };
        // Every snapshot main pushes is looked at, so a tab that was gone only between two pushes counts.
        let seen = self
            .host
            .wait_for(Some(how.wait_ms), |state| match answer_of(state) {
                Some(Some(CloseOutcome::Closing)) => None,
                other => other,
            })
            .await;
        match seen {
            Some(None) => {
                let _ = self
                    .within(self.host.exited(tab_id), self.tuning.omp_exit_wait_ms)
                    .await;
                TabClose::Closed
            }
            Some(Some(outcome)) => TabClose::Refused(outcome),
            None => match answer_of(&self.host.state()) {
                Some(None) => TabClose::Closed,
                Some(Some(_)) => TabClose::Kept,
                None => TabClose::Unanswered,
            },
        }
    }

    /// `#personTurn`: whether the person's own typed message started the caller's current run, as its omp's bridge
    /// says (gui-bridge turn-origin.ts, from main's `typed_prompt` word, never the text). Another agent's message, a
    /// report, a schedule, Autopilot or a relaunch's continuation did not; an outside process has no omp to ask, and
    /// an omp that cannot say counts as not.
    async fn person_turn(&self, caller: &ControlTab) -> bool {
        let response = self
            .host
            .command(
                &caller.tab_id,
                &json!({ "type": "agent_control_turn" }),
                Deadline::Ms(self.tuning.person_turn_wait_ms),
            )
            .await
            .ok();
        response
            .filter(|response| response.success)
            .and_then(|response| response.data)
            .and_then(|data| data.get("person").and_then(serde_json::Value::as_bool))
            == Some(true)
    }

    /// Whether `tab` may be stopped, closed or deleted in this turn; asks the caller's omp once (`by_person`).
    async fn allowed(
        &self,
        caller: &ControlTab,
        tab: &ControlTab,
        own: bool,
        by_person: &mut Option<bool>,
    ) -> bool {
        if !needs_person_turn(&facts(tab), own) {
            return true;
        }
        if by_person.is_none() {
            *by_person = Some(self.person_turn(caller).await);
        }
        by_person.unwrap_or(false)
    }

    /// `#abort`: stock's abort, answered within `wait_ms` (true) or not yet (false); it is sent either way and never
    /// fails.
    async fn abort(&self, caller: &ControlTab, target: &ControlTab, wait_ms: u64) -> bool {
        let answered = async {
            self.host
                .command(
                    &target.tab_id,
                    &json!({ "type": "abort", "origin": { "agentControl": caller.tab_id } }),
                    Deadline::Ms(wait_ms),
                )
                .await
                .map(|response| response.success)
                .unwrap_or(false)
        };
        self.within(answered, wait_ms).await == Some(true)
    }

    /// `#deleteWhenIdle`: main deletes a session only while no turn runs in it (`session_running`); an abort's turn
    /// ends a moment after it was sent, so the delete is tried again until `stop_wait_ms` passed.
    async fn delete_when_idle(&self, caller: &ControlTab, target: &ControlTab) -> R<()> {
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(self.tuning.stop_wait_ms);
        loop {
            match self
                .host
                .delete_session(&caller.tab_id, &target.tab_id)
                .await
            {
                Ok(()) => return Ok(()),
                Err(error) => {
                    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                    if !error.has_code("session_running") {
                        return Err(error);
                    }
                    if left.is_zero() {
                        return fail(format!(
                            "{} is still finishing its turn after {} s, so it was not deleted. Close it first (ompdesk_session_stop {{\"session\":\"{}\",\"close\": true}}), then delete its saved session by its saved id from ompdesk_sessions {{\"scope\":\"stored\"}}.",
                            label(target),
                            number(self.tuning.stop_wait_ms as f64 / 1000.0),
                            target.tab_id
                        ));
                    }
                    self.host
                        .next_change(
                            left.as_millis()
                                .min(u128::from(self.tuning.link_poll_ms * 4))
                                as u64,
                        )
                        .await;
                }
            }
        }
    }

    /// `#journalClose`: a close is journaled as one quiet line in both sessions (best effort: a line never blocks the
    /// close).
    async fn journal_close(&self, caller: &ControlTab, target: &ControlTab, deleted: bool) {
        let at = self.now();
        let line = |from: &ControlTab, text: &str| {
            json!({
                "id": format!(
                    "close:{}:{}:{}",
                    target.session_path.as_deref().unwrap_or(&target.tab_id),
                    number(at),
                    from.tab_id
                ),
                "from": from.tab_id,
                "fromTitle": from.title,
                "kind": "note",
                "label": "note",
                "text": text,
            })
        };
        let quiet = delivery_for(MailKind::Note);
        let closed = format!(
            "{} {}{}.",
            if deleted { "Deleted" } else { "Closed" },
            label(target),
            if deleted {
                ""
            } else {
                " (its session stays saved)"
            }
        );
        let told = format!(
            "{} closed this session's tab.",
            if caller.title.is_empty() {
                "Another session"
            } else {
                &caller.title
            }
        );
        let (mine, theirs) = (line(caller, &closed), line(caller, "closed this tab"));
        let _ = join::all(vec![
            join::boxed(self.host.mail(&caller.tab_id, &closed, &mine, quiet)),
            join::boxed(self.host.mail(&target.tab_id, &told, &theirs, quiet)),
        ])
        .await;
    }

    /// `#dropWorktree`: a deleted child's worktree and branch go only when nothing would be lost (clean tree,
    /// untracked files included, branch tip in the parent's HEAD or upstream); otherwise both stay and the answer says
    /// what is unlanded. The answer ends with what became of the branch's copy on `origin`.
    async fn drop_worktree(&self, worktree: &WorktreeRef, device: Option<&str>) -> String {
        let removal = self
            .host
            .remove_safe_worktree(worktree, device)
            .await
            .ok()
            .flatten();
        let Some(SafeRemoval { removal, remote }) = removal else {
            return self.kept_worktree(worktree, device).await;
        };
        let remote = remote.map_or_else(String::new, |remote| format!(" {}", remote.message));
        match removal {
            WorktreeRemoval::Removed => format!(
                "Removed its worktree {} and branch {}.{remote}",
                worktree.path, worktree.branch
            ),
            WorktreeRemoval::BranchKept => format!(
                "Removed its worktree {}; kept branch {}: it moved after its work was checked as landed, so it may hold new commits.{remote}",
                worktree.path, worktree.branch
            ),
        }
    }

    /// Why `drop_worktree` kept a worktree and its branch: what is unlanded.
    async fn kept_worktree(&self, worktree: &WorktreeRef, device: Option<&str>) -> String {
        let facts = self.host.branch_facts(worktree, device).await.ok();
        let mut unlanded: Vec<String> = Vec::new();
        if let Some(facts) = facts {
            if !facts.merged {
                unlanded.push(format!(
                    "{} commit(s) not in the base or its upstream",
                    number(facts.commits_ahead as f64)
                ));
            }
            if facts.uncommitted != 0 {
                unlanded.push(format!(
                    "{} uncommitted file(s)",
                    number(facts.uncommitted as f64)
                ));
            }
            if facts.untracked != 0 {
                unlanded.push(format!(
                    "{} untracked file(s)",
                    number(facts.untracked as f64)
                ));
            }
        }
        format!(
            "Kept its worktree {} and branch {}{}. Land it with git there, or remove it yourself if the work is not wanted.",
            worktree.path,
            worktree.branch,
            if unlanded.is_empty() {
                String::new()
            } else {
                format!(": {}", unlanded.join(", "))
            }
        )
    }

    /// `ompdesk_session_stop` of an open session (`#stop`). Own children: free. Others: one confirmation card unless
    /// the user let agents manage other sessions (default on). Deleting a saved session another session opened always
    /// asks: a delete cannot be undone. A session the person typed into, or one the caller did not open that the
    /// person looks at, is stopped, closed or deleted only in a turn their own message started (`needs_person_turn`,
    /// `person_turn`); the caller's own session is never held back because the person looks at it.
    pub(in crate::agentctl::service) async fn stop(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        target: &ControlTab,
        args: &StopArgs,
    ) -> R<String> {
        let own = self
            .opened_by(&self.host.state(), &caller.tab_id, tabs)
            .contains(&target.tab_id);
        self.stop_as(caller, tabs, target, args, own).await
    }

    /// `ompdesk_session_stop` of a saved session open in a tab elsewhere, through the tab `rejoin` opened on it: this
    /// computer's own tab on a paired host taken over again (its close ends that host's omp), or a view of a tab a
    /// paired host's window or another device holds. A view opened only to reach the turn is left again.
    pub(in crate::agentctl::service) async fn stop_joined(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        joined: &ControlTab,
        row: &StoredSession,
        args: &StopArgs,
    ) -> R<String> {
        let own = self.own_closed(&self.host.state(), caller, &row.path, row.device.as_deref());
        let answer = self.stop_as(caller, tabs, joined, args, own).await;
        if joined.viewing && args.close != Some(true) {
            let _ = self
                .close_tab(
                    &caller.tab_id,
                    &joined.tab_id,
                    CloseHow {
                        auto: true,
                        expected_turn: None,
                        wait_ms: self.tuning.close_wait_ms,
                        cleared: true,
                    },
                )
                .await;
        }
        answer
    }

    async fn stop_as(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        target: &ControlTab,
        args: &StopArgs,
        own: bool,
    ) -> R<String> {
        self.refuse_hidden(target, caller)?;
        let flags = StopFlags {
            close: args.close.unwrap_or(false),
            delete: args.delete.unwrap_or(false),
        };
        let caller_name = if caller.title.is_empty() {
            "—"
        } else {
            &caller.title
        };
        let target_name = if target.title.is_empty() {
            &target.tab_id
        } else {
            &target.title
        };
        let params = [("caller", caller_name), ("target", target_name)];
        let mut by_person: Option<bool> = None;
        if !self.allowed(caller, target, own, &mut by_person).await {
            return self.refuse_in_use(caller, tabs, target, flags);
        }
        // Closing the tab of a session that rests (no turn, no question, the person neither looks at it nor typed
        // into it since) loses nothing: its session stays saved and reopens as it was. That needs no card, whoever
        // opened it.
        let resting = !target.busy && !waits(target) && !needs_person_turn(&facts(target), false);
        let harmless = args.close == Some(true) && args.delete != Some(true) && resting;
        let (full, manage) = {
            let state = self.host.state();
            (state.full_enabled, state.manage_enabled)
        };
        if !own && !harmless && !full && (args.delete == Some(true) || !manage) {
            let state = self.host.state();
            let message = if flags.delete {
                "deleteMessage"
            } else if flags.close {
                "closeMessage"
            } else {
                "stopMessage"
            };
            let approved = self
                .host
                .confirm(
                    &caller.tab_id,
                    &state.text("stopTitle", &params),
                    &state.text(message, &params),
                )
                .await?;
            if !approved {
                return Ok(format!(
                    "The user declined: {} keeps running. Do not ask again unless they tell you to.",
                    label(target)
                ));
            }
        }
        self.mem().closing.insert(target.tab_id.clone());
        let running = target.busy && target.status.is_up();
        let mut confirmed = !running;
        let carried = async {
            // Stock answers an abort once the turn unwound; a close never waits on that (closing ends the omp), a
            // stop and a delete (which needs the turn over) wait a bounded while and say what they saw.
            if running {
                let wait = if flags.close && !flags.delete {
                    self.tuning.abort_before_close_ms
                } else {
                    self.tuning.stop_wait_ms
                };
                confirmed = self.abort(caller, target, wait).await;
            }
            if flags.delete {
                // The card and the lines took time: the person may have opened it meanwhile.
                let now = self.live(&caller.tab_id, &target.tab_id);
                if let Some(now) = now
                    && !self.allowed(caller, &now, own, &mut by_person).await
                {
                    return self.refuse_in_use::<()>(caller, tabs, target, flags);
                }
                self.delete_when_idle(caller, target).await?;
                let fated = self.fated(
                    target,
                    own.then_some(caller.session_path.as_deref()).flatten(),
                );
                self.fates().deleted(fated, &by_caller(caller), None);
            } else if flags.close {
                let now = self.live(&caller.tab_id, &target.tab_id);
                if let Some(now) = now
                    && !self.allowed(caller, &now, own, &mut by_person).await
                {
                    return self.refuse_in_use::<()>(caller, tabs, target, flags);
                }
                // Checked just above: the in-use rule lets this close go.
                let outcome = self
                    .close_tab(
                        &caller.tab_id,
                        &target.tab_id,
                        CloseHow {
                            auto: false,
                            expected_turn: None,
                            wait_ms: self.tuning.close_wait_ms,
                            cleared: true,
                        },
                    )
                    .await?;
                if outcome != TabClose::Closed {
                    return fail(kept_text(target, outcome, self.tuning.close_wait_ms));
                }
                if target.viewing {
                    // Only this app's view went: the tab it viewed holds the session's omp and stays open there.
                    return fail(view_kept(target, running));
                }
                self.remember_closed(target, own.then_some(caller), &by_caller(caller));
            }
            // Told only once the tab is gone: a close that did not happen sends no note.
            if flags.close || flags.delete {
                let _ = self
                    .within(
                        self.journal_close(caller, target, flags.delete),
                        self.tuning.abort_before_close_ms,
                    )
                    .await;
            }
            Ok(())
        }
        .await;
        self.mem().closing.remove(&target.tab_id);
        carried?;
        // What was asked is done: nothing of it waits for the caller's next turn of the person's.
        self.cleanups()
            .drop_cleanup(&cleanup_of(caller, target, flags, self.now()));
        if flags.delete {
            let done = format!("Stopped, closed and deleted {}.", label(target));
            return Ok(match (&target.worktree, own) {
                (Some(worktree), true) => format!(
                    "{done} {}",
                    self.drop_worktree(&worktree.reference(), target.device.as_deref())
                        .await
                ),
                _ => done,
            });
        }
        if flags.close {
            return Ok(format!(
                "Closed {} (its session stays saved).",
                label(target)
            ));
        }
        if !running {
            return Ok(format!(
                "{} was not running; nothing to stop.",
                label(target)
            ));
        }
        if confirmed
            || !self
                .live(&caller.tab_id, &target.tab_id)
                .is_some_and(|tab| tab.busy)
        {
            return Ok(format!("Stopped {}.", label(target)));
        }
        Ok(format!(
            "Asked {} to stop; it has not confirmed after {} s (a tool or subagent is still unwinding) and stops once that ends. Check it with ompdesk_session_result {{\"session\":\"{}\"}}, or end it now with ompdesk_session_stop {{\"session\":\"{}\",\"close\": true}} (closing ends its omp; the session stays saved).",
            label(target),
            number(self.tuning.stop_wait_ms as f64 / 1000.0),
            target.tab_id,
            target.tab_id
        ))
    }

    /// The tab `tab_id` as the caller's window lists it now.
    fn live(&self, caller_tab_id: &str, tab_id: &str) -> Option<ControlTab> {
        self.host
            .state()
            .tabs(caller_tab_id)?
            .into_iter()
            .find(|tab| tab.tab_id == tab_id)
    }

    /// `ompdesk_session_stop` of a saved session no tab holds (`#stopStored`): nothing runs to stop or close; a delete
    /// removes its file on the device it is saved on (the sidebar's delete). One the caller opened (its tab closed
    /// this launch, or main recorded closing it under the caller's session) is deleted without a card, as an open one
    /// it opened is; any other asks unless full control is on.
    pub(in crate::agentctl::service) async fn stop_stored(
        &self,
        caller: &ControlTab,
        row: &StoredSession,
        args: &StopArgs,
    ) -> R<String> {
        if row.hidden {
            return fail("The user hid that session from other agents.");
        }
        let name = format!(
            "\"{}\" (saved{})",
            one_line(&stored_title(row), 80),
            row.device_name
                .as_deref()
                .filter(|name| !name.is_empty())
                .map_or_else(String::new, |name| format!(" on {name}"))
        );
        if args.delete != Some(true) {
            return Ok(format!(
                "{name} is not open in any tab: nothing to stop or close."
            ));
        }
        let state = self.host.state();
        let own = self.own_closed(&state, caller, &row.path, row.device.as_deref());
        if !own && !state.full_enabled {
            let title = stored_title(row);
            let target = if title.is_empty() { &row.id } else { &title };
            let caller_name = if caller.title.is_empty() {
                "—"
            } else {
                &caller.title
            };
            let params = [("caller", caller_name), ("target", target.as_str())];
            let approved = self
                .host
                .confirm(
                    &caller.tab_id,
                    &state.text("stopTitle", &params),
                    &state.text("deleteMessage", &params),
                )
                .await?;
            if !approved {
                return Ok(format!(
                    "The user declined: {name} stays saved. Do not ask again unless they tell you to."
                ));
            }
        }
        self.host.delete_stored(row).await?;
        {
            let mut mem = self.mem();
            mem.stored.delete(&row.id);
            mem.closed_openers
                .remove(&receiver_key(&row.path, row.device.as_deref()));
        }
        self.fates().deleted(
            FatedSession {
                ids: vec![row.id.clone()],
                path: Some(row.path.clone()),
                device: row.device.clone().filter(|device| !device.is_empty()),
                title: stored_title(row),
                hidden: false,
                cwd: row.cwd.clone(),
                opened_by_session: None,
            },
            &by_caller(caller),
            None,
        );
        Ok(format!("Deleted {name}."))
    }
}
