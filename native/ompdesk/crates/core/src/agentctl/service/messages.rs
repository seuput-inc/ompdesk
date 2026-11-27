//! Family 2, messages: what sessions say to each other.
//!
//! Owns these TypeScript methods: `#send` (2574), `#untilDraftSent` (2606), `#deliverSend` (2623), `#handSend`
//! (2649), `#owedDeps` and `redeliverSends` (2765-2798), `#journalMarks` (2800), `#turnStarts` (2809),
//! `#reportFields` (2824), `#report` (2839), `#answer` (3363), `#answerPlan` (3474), the mail
//! side of `childAsked` (1387) and `personTyped` (3739), and the receipts, in-flight sends and `#cardsTold` /
//! `#nudged` state in `Mem`. `#mailbox` is `self.mailbox`, the send outbox
//! `self.send_outbox` (`journal::send_outbox::deliver_owed`, `redeliver_sends`, `OwedDeps`).
//!
//! `redeliverSends(tabOf)` takes no function over the wire: `tabOf(path, device)` is the tab of `HostState::tabs`
//! holding that session on that computer (a tab main runs for a device is in no list of `tabs`, as with `hosted`),
//! started with `host.start` when it reads `asleep`, and the receiver once its omp is up (`ready` or `running`).
//!
//! Already shared: `find`, `open`, `send_target`, `own_closed`, `session_state`, `refuse_hidden`, `mailbox`.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::time::Instant;

use super::AgentControl;
use super::fail::{Fail, R, fail};
use super::host::{Deadline, HostState};
use super::js::{number, one_line, trim, trim_start};
use super::pace::pace_line;
use super::resolve::OpenOptions;
use super::state::SessionState;
use super::text::{
    JournalMarks, OTHER_OPTION, card_text, cleanup_caller, is_agent_card, journal_marks, label,
    named, pick_option, response_data, saved_id_of_path, transcript_page, waits, with_dispatch,
};
use super::types::{
    AnswerArgs, ControlTab, ReportArgs, RpcResponse, SendArgs, StoredSession, UiRequest,
};
use super::util::{Flight, join};
use super::wrap::{dispatch_mark, request_mark, wrap_agent_message};
use crate::agentctl::journal::attachments::{Resolved, image_block, shas_sig, with_attached};
use crate::agentctl::journal::pending_cleanups::CleanupAction;
use crate::agentctl::journal::send_outbox::{
    HandOver, OutboxSend, OwedDeps, SendOutbox, SentAnswer, deliver_owed, receiver_key,
    redeliver_sends,
};
use crate::agentctl::journal::session_fates::FateState;
use crate::agentctl::rules::custody::custody_of;
use crate::agentctl::rules::mail::{
    Mail, MailCheck, MailKind, Posted, delivery_for, mail_details, mail_text,
};

/// The plain prompt of a message, for a receiver idle or too old to know the aside: a card of the person's open there
/// stays open only behind stock's follow-up (a steer closes it: "Ask interrupted by message").
pub(super) fn plain_behavior(card_open: bool) -> &'static str {
    if card_open { "followUp" } else { "steer" }
}

/// `EVIDENCE_MESSAGES`.
const EVIDENCE_MESSAGES: u64 = 200;
const APPROVE_DENY: &str = "Deny";

/// `new Date(at).toISOString().slice(0, 16).replace("T", " ")`.
pub(crate) fn utc_minutes(at: f64) -> String {
    let minutes = (at / 60_000.0).floor() as i64;
    let days = minutes.div_euclid(1440);
    let of_day = minutes.rem_euclid(1440);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted + 2) / 5 + 1;
    let month = if shifted < 10 {
        shifted + 3
    } else {
        shifted - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}",
        of_day / 60,
        of_day % 60
    )
}

/// The "this call only" answer of a stock tool approval card (`approvalChoices(request).once`), or None for any other
/// select (`src/shared/tool-approval.ts`).
fn approval_once(request: &UiRequest) -> Option<String> {
    const SESSION_HEAD: &str = "Approve ";
    const SESSION_TAIL: &str = " for this session";
    const FOLDER_HEAD: &str = "Approve Directory: ";
    if request.method != "select" {
        return None;
    }
    if !request.title.as_deref()?.starts_with("Allow tool: ") {
        return None;
    }
    let mut rest: Vec<&str> = request.options.iter().map(String::as_str).collect();
    if rest.pop() != Some(APPROVE_DENY) {
        return None;
    }
    if let Some(last) = rest.last()
        && last.len() > SESSION_HEAD.len() + SESSION_TAIL.len()
        && last.starts_with(SESSION_HEAD)
        && last.ends_with(SESSION_TAIL)
    {
        rest.pop();
    }
    let once = rest.pop();
    let once_label = if rest.is_empty() {
        "Approve"
    } else {
        "Approve Once"
    };
    if !rest.len().is_multiple_of(2) || once != Some(once_label) {
        return None;
    }
    let count = rest.len() / 2;
    for index in 0..count {
        let name = rest[index];
        let grant = name == "Approve File"
            || name == "Approve"
            || (name.starts_with(FOLDER_HEAD) && name.len() > FOLDER_HEAD.len());
        if !grant || rest[index + count] != format!("Always {name}") {
            return None;
        }
    }
    Some(once_label.to_owned())
}

/// What `#owedDeps` gives `deliver_owed`: how an owed message reaches a receiver's omp. `fixed` is the tab a send
/// hands to; a sweep (`redeliver_sends`) finds the tab holding the session in the snapshot instead.
struct Owed<'a> {
    ctl: &'a AgentControl,
    fixed: Option<String>,
}

impl OwedDeps for Owed<'_> {
    fn tab_of(&self, session_path: &str, device: Option<&str>) -> Option<String> {
        if let Some(tab) = &self.fixed {
            return Some(tab.clone());
        }
        let state = self.ctl.host.state();
        let owner = state.tabs.iter().find(|tab| {
            tab.session_path.as_deref() == Some(session_path)
                && tab.device.as_deref().filter(|d| !d.is_empty())
                    == device.filter(|d| !d.is_empty())
        })?;
        // Restored and never shown: no omp yet. Started here; a later pass hands it the message.
        if owner.status == super::types::TabStatus::Asleep {
            self.ctl.host.start(&owner.tab_id);
        }
        // A working receiver takes it too: a steer goes in as an aside, read at its next step (`hand_over`).
        owner.status.is_up().then(|| owner.tab_id.clone())
    }

    async fn sent(&self, tab_id: &str, marks: &[String]) -> Option<SentAnswer> {
        let answer = self.ctl.host.sent_marks(tab_id, marks).await.ok()??;
        sent_answer(&answer)
    }

    async fn prompt(&self, tab_id: &str, entry: &OutboxSend) -> HandOver {
        // An open's first message to an omp that never had it (a relaunch cut the open short): its setup first, then
        // a goal's objective or the prompt. A step the child refuses keeps it queued and tells the opener once.
        let mut steps: Vec<Value> = entry.before.clone();
        if entry.goal {
            steps.push(json!({ "type": "set_goal", "objective": entry.body, "message": entry.message }));
        }
        for command in &steps {
            let deadline = Deadline::Ms(self.ctl.tuning.prompt_ms);
            let refused = match self.ctl.host.command(tab_id, command, deadline).await {
                Ok(answer) if answer.success => continue,
                // Not answered yet (its omp starting, a slow command): the next pass tries again, nothing to tell.
                Ok(answer) if answer.unanswered() => return HandOver::Refused,
                Err(error) if error.unanswered() => return HandOver::Refused,
                Ok(answer) => answer.error.unwrap_or_else(|| "no reason given".to_owned()),
                Err(error) => error.message(),
            };
            self.ctl
                .host
                .trouble(
                    &entry.from,
                    entry.from_device.as_deref(),
                    &format!("open-{}-{}", entry.mark, entry.session_path),
                    &format!(
                        "The session you opened ({}) lost its first message when OMPdesk quit before it got it, and setting it up again failed ({}: {refused}). OMPdesk keeps trying; if it stays stuck, send it your brief again with ompdesk_session_send.",
                        saved_id_of_path(Some(&entry.session_path))
                            .unwrap_or_else(|| "its session".to_owned()),
                        command["type"].as_str().unwrap_or("a command"),
                    ),
                )
                .await;
            return HandOver::Refused;
        }
        if entry.goal {
            // Stock's goal entry carries no marker the journal check could find: done once stock took it.
            if let Some(outbox) = &self.ctl.send_outbox {
                outbox.settle(&entry.session_path, entry.device.as_deref(), &entry.mark);
            }
            return HandOver::Handed;
        }
        let Ok(command) = self.ctl.owed_command(tab_id, entry).await else {
            return HandOver::Refused;
        };
        let sent = self.ctl.hand_over(tab_id, &command, true).await;
        let (handed, taken) = match sent {
            Ok(response) => (response.success || response.unanswered(), response.success),
            Err(error) => (error.unanswered(), false),
        };
        // As a fresh send: a blocking ompdesk_session_result wait the receiver stands in returns, so it reads the
        // message at its next step instead of when the wait runs out.
        if taken {
            self.ctl.arrive(tab_id);
        }
        if handed {
            HandOver::Handed
        } else {
            HandOver::Refused
        }
    }

    async fn drained(&self, tab_id: &str) -> bool {
        let deadline = Deadline::Ms(self.ctl.tuning.state_timeout_ms);
        let Ok(response) = self
            .ctl
            .host
            .command(tab_id, &json!({ "type": "get_state" }), deadline)
            .await
        else {
            return false;
        };
        if !response.success {
            return false;
        }
        let Some(data) = response.data else {
            return false;
        };
        data.get("isStreaming") == Some(&Value::Bool(false))
            && data.get("queuedMessageCount").and_then(Value::as_f64) == Some(0.0)
    }
}

pub(in crate::agentctl::service) fn sent_answer(value: &Value) -> Option<SentAnswer> {
    Some(SentAnswer {
        instance: value.get("instance")?.as_str()?.to_owned(),
        journaled: value
            .get("journaled")
            .and_then(Value::as_array)
            .map(|marks| {
                marks
                    .iter()
                    .filter_map(|mark| mark.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// The outbox and the session path a send keeps its message under.
struct Kept<'a> {
    outbox: &'a SendOutbox,
    path: &'a str,
}

impl AgentControl {
    /// `ompdesk_session_send` to `target`, resolved by `send_target` (`#send`).
    pub(super) async fn send(
        &self,
        caller: &ControlTab,
        target: &ControlTab,
        args: &SendArgs,
    ) -> R<String> {
        if self.stopping(&caller.tab_id) {
            return fail("Autopilot is ending: start nothing new.");
        }
        self.refuse_hidden(target, caller)?;
        // A paused bot takes no message: who holds the session and what it does stay as they are.
        self.refuse_paused(target)?;
        if caller.tab_id == target.tab_id {
            return fail("A session cannot message itself.");
        }
        // Idempotent: a retried call (a flaky link, a paired device) gets the first receipt, never a second delivery.
        let Some(request_id) = args.request_id.as_deref().filter(|id| !id.is_empty()) else {
            return self.deliver_send(caller, target, args, None).await;
        };
        let key = format!(
            "{}|{}|{request_id}",
            caller.session_path.as_deref().unwrap_or(&caller.tab_id),
            target.session_path.as_deref().unwrap_or(&target.tab_id)
        );
        let again = format!(" (request {request_id} was already delivered; nothing sent again)");
        enum Turn {
            Own(Flight<Result<String, Fail>>),
            Join(Flight<Result<String, Fail>>),
        }
        let turn = {
            let mut mem = self.mem();
            if let Some(known) = mem.receipts.get(&key) {
                return Ok(format!("{known}{again}"));
            }
            // A same-id call arriving while the first is still on its way joins it instead of sending again.
            match mem.inflight.get(&key) {
                Some(pending) => Turn::Join(pending.clone()),
                None => {
                    let flight = Flight::new();
                    mem.inflight.insert(key.clone(), flight.clone());
                    Turn::Own(flight)
                }
            }
        };
        match turn {
            Turn::Join(pending) => match pending.wait().await {
                Some(Ok(receipt)) => Ok(format!("{receipt}{again}")),
                Some(Err(error)) => Err(error),
                None => {
                    self.mem().inflight.remove(&key);
                    fail("The first call of this request did not finish; send it again.")
                }
            },
            Turn::Own(flight) => {
                let _abandoned = flight.guard();
                let result = self.deliver_send(caller, target, args, Some(&key)).await;
                flight.settle(result.clone());
                self.mem().inflight.remove(&key);
                result
            }
        }
    }

    /// `ompdesk_session_send` with `sessions`: one message to each named session, side by side, each with its own
    /// receipt (and dispatch, for a child). `@children` names the caller's open children, `@idle` those of them not
    /// running and not waiting on a card, as at the send (after Orca's group addresses, `addressing/groups/`, MIT).
    pub(super) async fn send_group(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        names: &[String],
        args: &SendArgs,
    ) -> R<String> {
        let mut ids: Vec<String> = Vec::new();
        for name in names {
            let group = match name.as_str() {
                "@children" => Some(false),
                "@idle" => Some(true),
                _ => None,
            };
            let Some(idle_only) = group else {
                if !ids.contains(name) {
                    ids.push(name.clone());
                }
                continue;
            };
            let children = self.children_of(&caller.tab_id);
            for tab in tabs.iter().filter(|tab| children.contains(&tab.tab_id)) {
                if idle_only && (tab.busy || waits(tab)) {
                    continue;
                }
                if !tab.hidden && !ids.contains(&tab.tab_id) {
                    ids.push(tab.tab_id.clone());
                }
            }
        }
        if ids.is_empty() {
            return fail(format!(
                "No session to send to: {} named none (no session you opened is open{}).",
                names.join(", "),
                if names.iter().any(|name| name == "@idle") {
                    " and idle"
                } else {
                    ""
                }
            ));
        }
        let sends = join::all(
            ids.iter()
                .map(|id| {
                    join::boxed(async move {
                        let target = self.send_target(caller, tabs, id).await?;
                        self.send(caller, &target, args).await
                    })
                })
                .collect(),
        )
        .await;
        let failed = sends.iter().filter(|sent| sent.is_err()).count();
        let lines: Vec<String> = ids
            .iter()
            .zip(&sends)
            .map(|(id, sent)| match sent {
                Ok(receipt) => format!("- {receipt}"),
                Err(error) => format!("- {id}: not sent: {}", error.message()),
            })
            .collect();
        let text = format!(
            "Sent to {} of {} sessions:\n{}",
            ids.len() - failed,
            ids.len(),
            lines.join("\n")
        );
        if failed == ids.len() {
            return fail(text);
        }
        Ok(text)
    }

    /// `#untilDraftSent`: a message never starts a turn under the person's hands: while they have a draft in the
    /// target's composer, a send waits for it to be sent or cleared (`draft_wait_ms`), then fails saying so.
    async fn until_draft_sent(&self, caller: &ControlTab, target: &ControlTab) -> R<()> {
        let deadline = Instant::now() + std::time::Duration::from_millis(self.tuning.draft_wait_ms);
        // The live tab, never the listing `target` came from: the person may have started typing since.
        let drafting_now = || -> bool {
            self.host
                .state()
                .tabs(&caller.tab_id)
                .and_then(|tabs| tabs.into_iter().find(|tab| tab.tab_id == target.tab_id))
                .map_or(target.drafting, |tab| tab.drafting)
        };
        while drafting_now() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return fail(format!(
                    "The person is typing in {} (a draft sits in its composer): nothing was sent, so their message and yours do not collide. Try again once they have sent it, or report with ompdesk_report.",
                    label(target)
                ));
            }
            self.host
                .next_change(left.as_millis().min(1000) as u64)
                .await;
        }
        Ok(())
    }

    /// `#deliverSend`.
    async fn deliver_send(
        &self,
        caller: &ControlTab,
        found: &ControlTab,
        args: &SendArgs,
        receipt_key: Option<&str>,
    ) -> R<String> {
        // What the message carries is read first, where the caller's omp runs: one that cannot be read refuses the send.
        let resolved = self
            .resolve_attachments(caller, args.attachments.as_deref())
            .await?;
        // A target still starting is waited for only briefly: the sender's tool call must not hang on another
        // computer's slow start (18 Nov 2026: the hub's send to a starting session on the Mac mini never returned, its
        // person's own messages waited behind that call and they stopped the turn three times). Past the bound the
        // message is kept in the outbox, and the sweep hands it over once the target is up.
        let up = self.started_soon(found, &caller.tab_id).await?;
        // The tab as it is now, never the row it was named by: one woken from asleep has its omp's title, folder, turn
        // and asks only now, and the receipt and the delivery go by those.
        let live = self
            .host
            .state()
            .tabs(&caller.tab_id)
            .and_then(|tabs| tabs.into_iter().find(|tab| tab.tab_id == found.tab_id));
        let target = match live {
            Some(live) => {
                if !live.title.is_empty() || live.task.as_deref().is_some_and(|t| !t.is_empty()) {
                    live
                } else {
                    let mut live = live;
                    live.title = found.name().to_owned();
                    live
                }
            }
            None => found.clone(),
        };
        let (Some(outbox), Some(path)) =
            (self.send_outbox.as_ref(), target.session_path.as_deref())
        else {
            if !up {
                return fail(format!(
                    "Not sent: {} is still starting and has no session file yet to keep the message for. Send it again once it is up (ompdesk_sessions shows its state).",
                    named(&target)
                ));
            }
            return self
                .hand_send(caller, &target, args, receipt_key, None, resolved, true)
                .await;
        };
        // One delivery to a session at a time: what is still owed to it goes first, and the sweep never sends again what
        // this send is handing over.
        outbox
            .lane(
                &receiver_key(path, target.device.as_deref()),
                self.hand_send(
                    caller,
                    &target,
                    args,
                    receipt_key,
                    Some(Kept { outbox, path }),
                    resolved,
                    up,
                ),
            )
            .await
    }

    /// `#startedSoon`: the target's omp is up (started now if it was asleep) within `send_ready_wait_ms`; false while it
    /// is still starting then. A target that stopped is refused as `ensure_started` refuses it.
    async fn started_soon(&self, target: &ControlTab, caller_tab_id: &str) -> R<bool> {
        let wait = std::time::Duration::from_millis(self.tuning.send_ready_wait_ms);
        match tokio::time::timeout(wait, self.ensure_started(target, caller_tab_id)).await {
            Ok(started) => started.map(|()| true),
            Err(_) => Ok(false),
        }
    }

    /// A message handed to a session's omp (`prompt`, the plain command). A steer to a session that works goes in as
    /// stock's aside instead (`agent_control_aside`): its loop hands every aside waiting at a step boundary over
    /// together, where stock's steering queue hands over one steer per boundary, a model request each, and shows them
    /// in the person's queue (`bridge-agent-send-stock.test.ts`). An idle session (`{idle: true}`), and an omp or paired
    /// computer too old to know the command, get the plain prompt.
    async fn hand_over(&self, tab_id: &str, prompt: &Value, aside: bool) -> R<RpcResponse> {
        let deadline = Deadline::Ms(self.tuning.prompt_ms);
        if aside {
            let mut command =
                json!({ "type": "agent_control_aside", "message": prompt["message"] });
            if let Some(images) = prompt.get("images") {
                command["images"] = images.clone();
            }
            match self.host.command(tab_id, &command, deadline).await {
                Ok(answer) if answer.success => {
                    let idle = answer.data.as_ref().and_then(|data| data.get("idle"))
                        == Some(&Value::Bool(true));
                    if !idle {
                        return Ok(answer);
                    }
                }
                Ok(answer) if answer.unanswered() => return Ok(answer),
                Err(error) if error.unanswered() => return Err(error),
                _ => {}
            }
        }
        self.host.command(tab_id, prompt, deadline).await
    }

    /// `#handSend`. `up`: the target's omp answers; a target still starting gets its message kept (`kept` is then
    /// always given), handed over by the sweep once it is up.
    #[allow(clippy::too_many_arguments)]
    async fn hand_send(
        &self,
        caller: &ControlTab,
        target: &ControlTab,
        args: &SendArgs,
        receipt_key: Option<&str>,
        kept: Option<Kept<'_>>,
        resolved: Vec<Resolved>,
        up: bool,
    ) -> R<String> {
        let from = caller
            .session_path
            .clone()
            .unwrap_or_else(|| caller.tab_id.clone());
        let device = target.device.as_deref();
        if let Some(kept) = &kept {
            // Messages an omp before this one held and lost (a relaunch) reach it first, in order.
            if up {
                let owed = Owed {
                    ctl: self,
                    fixed: Some(target.tab_id.clone()),
                };
                deliver_owed(kept.outbox, &owed, kept.path, device).await;
            }
            // A resend of a message still on its way (its first send timed out, say) never runs it twice.
            let sig = shas_sig(resolved.iter().map(|item| item.file.sha256.as_str()));
            if let Some(same) = kept
                .outbox
                .waiting(&from, kept.path, device, &args.message, &sig)
            {
                let dispatch = match same.dispatch {
                    Some(n) if n != 0 => format!(" (dispatch d{n})"),
                    _ => String::new(),
                };
                return Ok(format!(
                    "Sent to {}: this same message is already on its way there{dispatch} and runs once; nothing sent again.",
                    named(target)
                ));
            }
        }
        // The opener gives its child new work: a new dispatch (its older reports turn stale) and its question is answered.
        let own_child = {
            let state = self.host.state();
            state.parent_of(&target.tab_id) == Some(caller.tab_id.as_str())
                || self
                    .opened_by(
                        &state,
                        &caller.tab_id,
                        &state.tabs(&caller.tab_id).unwrap_or_default(),
                    )
                    .contains(&target.tab_id)
        };
        // The target's journal is the durable record: a relaunch (or a retry whose first receipt was lost) finds the
        // request already there, and the last dispatch it was given. A target still starting has no omp to ask, so its
        // saved transcript is read: a dispatch numbered past nothing there would repeat one it holds, and the sweep would
        // then settle the new message as delivered without handing it over.
        let marks = if up {
            self.journal_marks(&target.tab_id).await
        } else {
            let saved = StoredSession {
                path: kept
                    .as_ref()
                    .map_or_else(String::new, |kept| kept.path.to_owned()),
                device: target.device.clone().filter(|device| !device.is_empty()),
                ..StoredSession::default()
            };
            match self.host.stored_messages(&saved).await {
                Ok(messages) => journal_marks(&messages),
                Err(_) if own_child => {
                    return fail(format!(
                        "Not sent: {} is still starting and its saved transcript could not be read, so the dispatch this message would carry is unknown. Send it again once it is up (ompdesk_sessions shows its state).",
                        named(target)
                    ));
                }
                Err(_) => JournalMarks::default(),
            }
        };
        if let Some(id) = args.request_id.as_deref().filter(|id| !id.is_empty())
            && marks.requests.contains(id)
        {
            return Ok(format!(
                "Sent to {}: request {id} was already delivered; nothing sent again.",
                named(target)
            ));
        }
        // Only a send that will deliver waits on the person's draft: a repeat of a delivered request answers at once.
        // A tab still starting holds no draft its omp would take this into.
        if up {
            self.until_draft_sent(caller, target).await?;
        }
        // Files land on the receiver's computer before anything is numbered or kept: a failure leaves nothing behind.
        let carried = self
            .carry(&target.tab_id, device, resolved, true, kept.is_some())
            .await?;
        let running = up
            && (target.busy
                || self
                    .session_state(target)
                    .await
                    .state
                    .is_some_and(|state| state.is_streaming));
        // A running session takes it as an aside (`hand_over`): read at its next step with every other one waiting,
        // never closing a card of the person's.
        let card_open = !target.asks.is_empty();
        // A dispatch still owed from before a relaunch is not in the journal yet: the next one is numbered past it.
        if own_child {
            let owed = kept
                .as_ref()
                .map_or(0, |kept| kept.outbox.last_dispatch(kept.path, device))
                .max(0) as u64;
            self.mailbox.seed(&target.tab_id, marks.dispatch.max(owed));
        }
        let dispatch = own_child.then(|| self.mailbox.dispatch(&target.tab_id));
        // Every message names itself, so the receiver's journal can tell main it arrived.
        let request_id = match &args.request_id {
            Some(id) => Some(id.clone()),
            None if dispatch.is_some() || kept.is_none() => None,
            None => {
                let mut bytes = [0u8; 4];
                crate::sys::random(&mut bytes)
                    .map_err(|error| Fail::other(format!("no random bytes: {error}")))?;
                Some(format!(
                    "m-{}",
                    bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
                ))
            }
        };
        let message = wrap_agent_message(
            &with_dispatch(
                &with_attached(&args.message, &carried.set.files),
                dispatch.as_deref(),
                request_id.as_deref(),
            ),
            &caller.title,
            saved_id_of_path(caller.session_path.as_deref()).as_deref(),
        );
        let dispatch_number = dispatch.as_deref().and_then(|d| d[1..].parse::<i64>().ok());
        let mut entry: Option<OutboxSend> = None;
        let mut instance = format!("tab:{}", target.tab_id);
        if let Some(kept) = &kept {
            let mark = match &dispatch {
                Some(dispatch) => dispatch_mark(dispatch),
                None => request_mark(request_id.as_deref().unwrap_or("")),
            };
            if up {
                instance = match self
                    .host
                    .sent_marks(&target.tab_id, std::slice::from_ref(&mark))
                    .await
                {
                    Ok(Some(answer)) => sent_answer(&answer).map(|answer| answer.instance),
                    _ => None,
                }
                .unwrap_or(instance);
            }
            let mut made = OutboxSend::new(
                mark,
                dispatch_number,
                kept.path.to_owned(),
                target.device.clone(),
                from.clone(),
                args.message.clone(),
                message.clone(),
                self.now(),
            );
            made.from_device = caller.device.clone().filter(|device| !device.is_empty());
            if carried.count > 0 {
                made.attachments = Some(carried.set.clone());
            }
            kept.outbox.keep(made.clone());
            entry = Some(made);
        }
        let dispatch_note = dispatch
            .as_ref()
            .map(|d| format!(" Dispatch {d}: it reports back with ompdesk_report."))
            .unwrap_or_default();
        let attached_note = if carried.count > 0 {
            format!(" {}.", carried.set.summary())
        } else {
            String::new()
        };
        if !up {
            // Kept, never handed: the sweep hands it over once the target's omp is up (`redeliver_sends`).
            let receipt = format!(
                "Sent to {}: kept; it is still starting, so OMPdesk hands this over as soon as its omp is up (it reads it then, at its next step if it is working). Do not send it again.{dispatch_note}{attached_note}",
                named(target)
            );
            if let Some(key) = receipt_key {
                self.mem().receipts.insert(key.to_owned(), receipt.clone());
            }
            return Ok(receipt);
        }
        let settle = |entry: &Option<OutboxSend>| {
            if let (Some(kept), Some(entry)) = (&kept, entry) {
                kept.outbox
                    .settle(&entry.session_path, entry.device.as_deref(), &entry.mark);
            }
        };
        // A command that never answered still reached the omp: one holding its command queue (stock's `login` while a
        // provider sign-in waits) runs the prompt once that ends. Saying it failed made senders send it again. Where
        // the aside cannot go (an older paired computer), a card of the person's open there gets a follow-up, which
        // leaves it open; a steer would close it ("Ask interrupted by message").
        let plain = plain_behavior(card_open);
        let mut command =
            json!({ "type": "prompt", "message": message, "streamingBehavior": plain });
        if !carried.inline.is_empty() {
            command["images"] = Value::Array(
                carried
                    .inline
                    .iter()
                    .map(|item| image_block(&item.file, &item.bytes))
                    .collect(),
            );
        }
        let held;
        // No answer from a paired host's link (`rpc_delivery_unknown`): the host may have delivered it. Never "nothing
        // was sent" (the hub got three copies of one request on 19 Nov 2026): it is kept as handed, with a receipt.
        let mut unconfirmed = None;
        let mut response: Option<RpcResponse> = None;
        match self.hand_over(&target.tab_id, &command, running).await {
            Ok(answer) => {
                held = answer.unanswered();
                if answer.unconfirmed() {
                    unconfirmed = Some(answer.error.clone().unwrap_or_default());
                }
                response = Some(answer);
            }
            Err(error) => {
                if !error.unanswered() {
                    settle(&entry);
                    return Err(error);
                }
                held = true;
            }
        }
        if !held
            && let Some(answer) = &response
            && !answer.success
        {
            settle(&entry);
            // An omp that is not ready runs nothing there: never a success receipt.
            return fail(format!(
                "Not delivered to {}: its omp refused the message ({}). Nothing runs there; nothing was sent.",
                named(target),
                answer.error.as_deref().unwrap_or("no reason given")
            ));
        }
        if let (Some(kept), Some(entry)) = (&kept, &entry) {
            kept.outbox.handed(entry, &instance);
        }
        // It is read at the target's next step, which a blocking wait of its own would hold off: it ends now.
        let woke = running && !held && self.is_blocked(&target.tab_id);
        if !held {
            self.arrive(&target.tab_id);
        }
        let started = !running && !held && self.turn_starts(&caller.tab_id, &target.tab_id).await;
        let how = if let Some(why) = &unconfirmed {
            format!(
                "{} did not answer in time ({why}), so it may already have arrived or still arrive, and runs once; this receipt answers a resend with the same request_id, so do not send it again: check with ompdesk_session_result",
                named(target)
            )
        } else if held {
            "queued: its omp is busy with another command (a provider sign-in, for one), and the message runs once that ends, so do not send it again".to_owned()
        } else if !running {
            if started {
                "it was idle and starts on it".to_owned()
            } else {
                format!(
                    "it was idle, but no turn started within {} s: see ompdesk_session_result before sending it again",
                    number(self.tuning.turn_start_wait_ms as f64 / 1000.0)
                )
            }
        } else if card_open {
            // Its turn stands on a question card, which stays open: the message is read at the step after the answer.
            format!(
                "it is {}, so that card stays open, and it reads this at its first step after the user has answered",
                self.state_line(&self.host.state(), target, &SessionState::default())
            )
        } else if woke {
            "delivered as steer; it is inside a blocking ompdesk_session_result wait, which returns now with a note, so it reads this at once".to_owned()
        } else {
            "delivered as steer (it reads it at its next step, together with every other message waiting for it)"
                .to_owned()
        };
        // What it was waiting through when the message came (after Orca's delivery-hold wording, MIT).
        let waited = match (&target.scheduled_retry, &target.retry_saga) {
            (Some(retry), _) if retry.limit => format!(
                " It was waiting for a provider's usage limit (until about {} UTC): this message starts a turn now, which may stop at the same limit, and then it waits again.",
                utc_minutes(retry.at)
            ),
            (Some(retry), _) => format!(
                " Its last turn had failed and was to try again by itself at {} UTC: this message runs instead.",
                utc_minutes(retry.at)
            ),
            (None, Some(saga)) if running => format!(
                " It is retrying a failed model request (attempt {} of {}: {}), so it may read this late.",
                saga.attempt,
                saga.max_attempts,
                one_line(&saga.error_message, 160)
            ),
            _ => String::new(),
        };
        let receipt = format!(
            "Sent to {}: {}{}; {how}.{waited}{dispatch_note}{attached_note}",
            named(target),
            if unconfirmed.is_some() {
                "not confirmed"
            } else {
                "accepted"
            },
            if started { ", turn started" } else { "" },
        );
        if let Some(key) = receipt_key {
            self.mem().receipts.insert(key.to_owned(), receipt.clone());
        }
        Ok(receipt)
    }

    /// `redeliverSends`: one pass over every session still owed a message.
    pub async fn redeliver_sends(&self) -> R<()> {
        if let Some(outbox) = &self.send_outbox {
            let owed = Owed {
                ctl: self,
                fixed: None,
            };
            redeliver_sends(outbox, &owed).await;
        }
        Ok(())
    }

    /// `#journalMarks` of a session's recent transcript; nothing when it cannot be read (not started, gone).
    pub(super) async fn journal_marks(&self, tab_id: &str) -> JournalMarks {
        let command =
            json!({ "type": "get_transcript_page", "fromEnd": true, "limit": EVIDENCE_MESSAGES });
        let page = self
            .host
            .command(tab_id, &command, Deadline::Ms(self.tuning.state_timeout_ms))
            .await
            .ok()
            .filter(|response| response.success)
            .and_then(|response| response.data)
            .and_then(|data| transcript_page(&data));
        journal_marks(page.as_ref().map_or(&[][..], |page| &page.messages))
    }

    /// `#turnStarts`: receipt stage "turn started": the target is seen running within a few seconds of an accepted
    /// message.
    async fn turn_starts(&self, caller_tab_id: &str, tab_id: &str) -> bool {
        let deadline =
            Instant::now() + std::time::Duration::from_millis(self.tuning.turn_start_wait_ms);
        loop {
            let tab = self
                .host
                .state()
                .tabs(caller_tab_id)
                .and_then(|tabs| tabs.into_iter().find(|tab| tab.tab_id == tab_id));
            let Some(tab) = tab else { return false };
            if tab.busy {
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            self.host
                .next_change(left.as_millis().min(250) as u64)
                .await;
        }
    }

    /// `#reportFields`: the work board's view of a child's mail to its opener: its last report, and whether its
    /// question waits. A question to a sibling or a checkout peer waits on that session, not here; one the child
    /// carried on from (a turn that started after it) waits no longer. Keys `report`, `waiting`; empty when none.
    pub(super) fn report_fields(&self, state: &HostState, tab: &ControlTab) -> Map<String, Value> {
        let mut fields = Map::new();
        let Some(opener) = state.parent_of(&tab.tab_id) else {
            return fields;
        };
        let Some(mail) = self.mailbox.state(&tab.tab_id, opener) else {
            return fields;
        };
        // A turn main stamped other than the one the mail was sent in is one it carried on with.
        let mailed_in = self
            .mem()
            .mailed_in
            .get(&format!("{}\n{opener}", tab.tab_id))
            .copied()
            .flatten();
        let carried_on = tab.busy && tab.busy_since.is_some_and(|since| Some(since) != mailed_in);
        fields.insert(
            "report".into(),
            json!({
                "kind": mail.last.kind.as_str(),
                "text": one_line(&mail.last.text, 240),
                "at": mail.last.at,
            }),
        );
        if mail.waiting && !carried_on {
            fields.insert("waiting".into(), Value::Bool(true));
        }
        fields
    }

    /// `ompdesk_report` (`#report`): an opened session tells its opener (or a sibling) about its work; any session
    /// tells another one working in the same checkout what it is about to do, or asks it to hold or commit.
    pub(super) async fn report(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        args: ReportArgs,
    ) -> R<String> {
        let parent = self
            .host
            .state()
            .parent_of(&caller.tab_id)
            .map(str::to_owned);
        let target = match &args.to {
            Some(to) => Some(match to.strip_prefix("bot:") {
                Some(name) => self.bot_target(caller, tabs, name).await?,
                None => {
                    self.open(tabs, to, caller, "report to", OpenOptions::default())
                        .await?
                }
            }),
            None => None,
        };
        let peer = target.as_ref().is_some_and(|target| {
            Some(target.tab_id.as_str()) != parent.as_deref()
                && self
                    .host
                    .state()
                    .checkout_peers(&caller.tab_id)
                    .contains(&target.tab_id)
        });
        if peer {
            self.refuse_hidden(target.as_ref().expect("a peer is a target"), caller)?;
        } else if parent.is_none() {
            return fail(
                "ompdesk_report goes to the session that opened you, a sibling it opened, or a session working in the same checkout (the <shared-checkout> section names those); nobody opened this one, and it shares no checkout with that session. Use ompdesk_session_send to write to a session.",
            );
        } else if let Some(target) = &target
            && Some(target.tab_id.as_str()) != parent.as_deref()
            && self.host.state().parent_of(&target.tab_id) != parent.as_deref()
        {
            return fail(
                "You can report only to the session that opened you, to a sibling it opened, or to a session working in the same checkout.",
            );
        }
        let to = match (&target, &parent) {
            (Some(target), _) => target.tab_id.clone(),
            (None, Some(parent)) => parent.clone(),
            (None, None) => unreachable!("refused above"),
        };
        let to_parent = Some(to.as_str()) == parent.as_deref();
        // A peer is woken only by a question or a blocker (and only when idle: a busy one gets it as an aside); every
        // other report reaches it as a note with no turn.
        let kind_name = if peer {
            if args.kind == "question" || args.kind == "blocked" {
                args.kind.as_str()
            } else {
                "note"
            }
        } else if to_parent {
            args.kind.as_str()
        } else {
            "note"
        };
        let kind = MailKind::parse(kind_name)
            .ok_or_else(|| Fail::Tool(format!("Unknown report kind \"{kind_name}\".")))?;
        // A worktree child that says it is done reports what its git holds with it (custody.ts).
        let reports_done = to_parent && (kind_name == "done" || kind_name == "review");
        let custody_future = async {
            match (&caller.worktree, reports_done) {
                (Some(worktree), true) => self
                    .host
                    .branch_facts(&worktree.reference(), caller.device.as_deref())
                    .await
                    .ok()
                    .map(|facts| custody_of(&facts, args.files.as_deref().unwrap_or(&[]))),
                _ => None,
            }
        };
        let pace_future = async {
            match (&caller.session_path, reports_done) {
                // How the finished session spent its time; the opener sees waste it can brief away next time.
                (Some(path), true) => self.pace_of(path, caller.device.as_deref()).await,
                _ => None,
            }
        };
        let (custody, pace) = tokio::join!(custody_future, pace_future);
        let resolved = self
            .resolve_attachments(caller, args.attachments.as_deref())
            .await?;
        let to_tab = tabs.iter().find(|tab| tab.tab_id == to);
        // A caller outside OMPdesk has no omp to show a picture to: everything lands as a file on this computer.
        let attached = if resolved.is_empty() {
            None
        } else {
            Some(
                self.carry(
                    &to,
                    to_tab.and_then(|tab| tab.device.as_deref()),
                    resolved.clone(),
                    to_tab.is_some(),
                    true,
                )
                .await?,
            )
        };
        // The id names a report among its sender's own reports to this receiver: the same report re-run (a call stock
        // repeats after a relaunch, its result lost in the crash) has the same id, so the receiver's journal knows it, while
        // another session's report never does, whatever id it chose (every child's first dispatch is d1, and two children
        // that both said `d1-done` lost the second report on 18 Nov 2026: "Delivered.", and nothing arrived).
        let id = {
            let receiver = tabs
                .iter()
                .find(|tab| tab.tab_id == to)
                .and_then(|tab| tab.session_path.clone())
                .unwrap_or_else(|| to.clone());
            let sender = caller
                .session_path
                .clone()
                .unwrap_or_else(|| caller.tab_id.clone());
            let sig = shas_sig(resolved.iter().map(|item| item.file.sha256.as_str()));
            let mut parts = vec![sender.as_str(), receiver.as_str()];
            match &args.id {
                Some(id) => parts.extend(["id", id.as_str()]),
                None => {
                    parts.extend([
                        args.kind.as_str(),
                        args.dispatch.as_deref().unwrap_or(""),
                        args.text.as_str(),
                    ]);
                    if !resolved.is_empty() {
                        parts.push(sig.as_str());
                    }
                }
            }
            let joined = parts.join("\u{0}");
            let digest = Sha256::digest(joined.as_bytes());
            digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()[..24]
                .to_owned()
        };
        let text = [
            Some(args.text.clone()),
            custody.as_ref().map(|c| c.line.clone()),
            pace.as_ref().map(pace_line),
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
        let mut mail = Mail::new(
            &id,
            &caller.tab_id,
            &caller.title,
            &to,
            kind,
            &text,
            self.now(),
        );
        mail.files = args.files.clone();
        mail.attachments = attached
            .as_ref()
            .filter(|carried| carried.count > 0)
            .map(|carried| carried.set.clone());
        mail.checks = args.checks.as_ref().map(|checks| {
            checks
                .iter()
                .map(|check| MailCheck {
                    command: check.command.clone(),
                    passed: check.passed,
                })
                .collect()
        });
        mail.dispatch = args.dispatch.clone().filter(|d| !d.is_empty());
        if !self.mailbox.knows(&caller.tab_id) {
            let seeded = self.journal_marks(&caller.tab_id).await.dispatch;
            self.mailbox.seed(&caller.tab_id, seeded);
        }
        // The turn of the mail the mailbox keeps: taken with the post (a reader during its delivery sees the new mail
        // with it), and given back only when the mailbox refuses a replay, which leaves its state as it was; a mail it
        // took and could not deliver is its newest all the same.
        let turn_key = format!("{}\n{to}", caller.tab_id);
        let before = self
            .mem()
            .mailed_in
            .insert(turn_key.clone(), caller.busy_since);
        let outcome = self.mailbox.post(mail.clone()).await;
        if matches!(outcome, Ok(Posted::Duplicate | Posted::Stale)) {
            let mut mem = self.mem();
            match before {
                Some(turn) => mem.mailed_in.insert(turn_key, turn),
                None => mem.mailed_in.remove(&turn_key),
            };
        }
        let outcome = outcome.map_err(Fail::other)?;
        if outcome == Posted::Delivered {
            self.arrive(&to);
        }
        // A session a bot's item links says how its work ended: the item's Activity shows it.
        if to_parent
            && matches!(outcome, Posted::Delivered | Posted::Queued)
            && (kind_name == "done" || kind_name == "blocked")
        {
            self.item_worker_report(caller, kind_name, &args.text);
        }
        if let Some(parent) = &parent {
            self.host.review_changed(parent);
        }
        let mut waiting = match &attached {
            Some(carried) if outcome != Posted::Duplicate && outcome != Posted::Stale => {
                format!(" {}.", carried.set.summary())
            }
            _ => String::new(),
        };
        if let Some(gap) = custody
            .as_ref()
            .and_then(|c| c.gap.as_deref())
            .filter(|g| !g.is_empty())
            && outcome != Posted::Duplicate
            && outcome != Posted::Stale
        {
            waiting.push_str(&format!(
                " It carries what your git holds, and that disagrees with the report: {gap} Then report again."
            ));
        }
        Ok(match outcome {
            Posted::Duplicate => format!(
                "Report {} was already delivered; nothing sent again.{waiting}",
                args.id.as_deref().unwrap_or(&mail.id)
            ),
            Posted::Stale => format!(
                "Ignored: dispatch {} is no longer current (the session that opened you has since sent dispatch {}). Work on its latest message.{waiting}",
                args.dispatch.as_deref().unwrap_or("undefined"),
                self.mailbox
                    .current(&caller.tab_id)
                    .unwrap_or_else(|| "undefined".to_owned())
            ),
            Posted::Queued => format!(
                "Progress noted; it reaches the session shortly (several progress reports arrive as the latest one).{waiting}"
            ),
            Posted::Delivered => {
                if mail.kind == MailKind::Question || mail.kind == MailKind::Blocked {
                    format!(
                        "Delivered. Wait for the answer: it comes as a message (between your steps while this turn runs); do not guess the decision meanwhile.{waiting}"
                    )
                } else {
                    format!("Delivered.{waiting}")
                }
            }
        })
    }

    /// `ompdesk_session_answer` (`#answer`, `#answerPlan`).
    pub(super) async fn answer(
        &self,
        caller: &ControlTab,
        target: &ControlTab,
        args: &AnswerArgs,
    ) -> R<String> {
        self.refuse_hidden(target, caller)?;
        // A card routed to a bot: only that bot answers it, by its request id; nothing else in its place.
        let routed = self.routed_card(caller, target, args)?;
        if let (Some(ask), Some(true)) = (&routed, args.escalate) {
            return self.escalate(caller, target, ask).await;
        }
        let asks: Vec<_> = target
            .asks
            .iter()
            .filter(|ask| !is_agent_card(ask) && !self.routed_away(&target.tab_id, &ask.id))
            .collect();
        let ask = match &routed {
            Some(ask) => ask,
            None => {
                if asks.is_empty()
                    && let Some(plan) = &target.plan
                {
                    return self.answer_plan(caller, target, plan, args).await;
                }
                if asks.is_empty() {
                    let ours = target.asks.iter().all(is_agent_card);
                    return fail(if target.asks.is_empty() {
                        format!(
                            "{} is not waiting for an answer ({}). See where it is with ompdesk_session_result; only a session ompdesk_sessions lists as waiting can be answered.",
                            label(target),
                            self.state_line(&self.host.state(), target, &SessionState::default())
                        )
                    } else if ours {
                        "That is a confirmation card for the user (OMPdesk asks the person before an agent action); only the user answers it.".to_owned()
                    } else {
                        format!(
                            "{} waits only on a card raised for a bot's request: that bot answers it.",
                            label(target)
                        )
                    });
                }
                let found = match &args.request {
                    Some(wanted) => asks.iter().find(|entry| &entry.id == wanted).copied(),
                    None => asks.first().copied(),
                };
                let Some(found) = found else {
                    return fail(format!(
                        "No pending request \"{}\" there. Pending: {}.",
                        args.request.as_deref().unwrap_or(""),
                        asks.iter()
                            .map(|entry| entry.id.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                };
                found
            }
        };
        let request = &ask.request;
        let resolved = self
            .resolve_attachments(caller, args.attachments.as_deref())
            .await?;
        let title_of = |max| one_line(request.title.as_deref().unwrap_or("undefined"), max);
        let response: Value;
        let summary: String;
        // A tool approval denied with `text`: the reason reaches the session after the denial, as Orca's deny reason does.
        let mut deny_reason: Option<String> = None;
        match request.method.as_str() {
            "select" => {
                let approval = approval_once(request);
                // `approve` answers a tool approval; on a plain choice card it names no option.
                let wanted = match (&args.choice, args.approve, &approval) {
                    (Some(choice), _, _) => Some(choice.clone()),
                    (None, Some(approve), Some(once)) => Some(if approve {
                        once.clone()
                    } else {
                        APPROVE_DENY.to_owned()
                    }),
                    _ => None,
                };
                let Some(wanted) = wanted else {
                    let mut parts = vec![format!(
                        "No choice given: pass `choice` with one of: {}.",
                        request
                            .options
                            .iter()
                            .map(|option| format!("\"{option}\""))
                            .collect::<Vec<_>>()
                            .join(" | ")
                    )];
                    if args.text.is_some() {
                        parts.push("`text` answers a text prompt, not this choice card.".into());
                    }
                    if args.approve.is_some() {
                        parts.push(
                            "`approve` answers a tool approval or a yes/no card, not this choice."
                                .into(),
                        );
                    }
                    if request.options.iter().any(|option| option == OTHER_OPTION) {
                        parts.push(format!(
                            "To give an answer of your own, choose \"{OTHER_OPTION}\": the session then asks for the text, which you answer with `text`."
                        ));
                    }
                    return fail(parts.join(" "));
                };
                let choice = pick_option(&request.options, &wanted)?;
                // Every approving answer (this call, for the session, a remembered folder or file) needs the user's
                // leave; Deny never does.
                if approval.is_some()
                    && choice != APPROVE_DENY
                    && !self.host.state().approve_enabled
                {
                    return fail(
                        "사용자 승인이 필요해요: this is a tool approval in another session and the user has not let agents approve for them (Settings › Tools & extensions). Tell the user, or show the session with ompdesk_tab_focus. Deny is allowed.",
                    );
                }
                response =
                    json!({ "type": "extension_ui_response", "id": ask.id, "value": choice });
                summary = format!("\"{choice}\" to \"{}\"", title_of(100));
                if approval.is_some() && choice == APPROVE_DENY {
                    deny_reason = args
                        .text
                        .as_deref()
                        .map(trim)
                        .filter(|text| !text.is_empty())
                        .map(str::to_owned);
                }
            }
            "confirm" => {
                // A yes or no, however it was given.
                let said = args.choice.as_ref().or(args.text.as_ref());
                if args.approve.is_none() && said.is_none() {
                    return fail(format!(
                        "This is a yes/no card (\"{}\"): pass `approve` true or false.",
                        title_of(100)
                    ));
                }
                let yes = args.approve.unwrap_or_else(|| {
                    let said = trim_start(said.map_or("", String::as_str)).to_lowercase();
                    ["y", "ok", "true", "confirm", "approve", "allow"]
                        .iter()
                        .any(|word| said.starts_with(word))
                });
                response =
                    json!({ "type": "extension_ui_response", "id": ask.id, "confirmed": yes });
                summary = format!(
                    "{} to \"{}\"",
                    if yes { "yes" } else { "no" },
                    title_of(100)
                );
            }
            "input" | "editor" => {
                // The words to type, whichever field carried them.
                let Some(text) = args.text.as_ref().or(args.choice.as_ref()) else {
                    return fail(format!(
                        "This is a text prompt (\"{}\"): pass `text` with the answer to type.",
                        title_of(100)
                    ));
                };
                response = json!({ "type": "extension_ui_response", "id": ask.id, "value": text });
                summary = format!("text to \"{}\"", title_of(100));
            }
            "ask" => {
                let one = request.questions.len() == 1;
                let options_of = |question: &super::types::AskQuestion| {
                    question
                        .options
                        .iter()
                        .map(|option| format!("\"{}\"", option.label))
                        .collect::<Vec<_>>()
                        .join(" | ")
                };
                // One question takes `choice` or `text` as its answer too; several need `answers`, one entry each.
                let given: Vec<super::types::AnswerItem> = match &args.answers {
                    Some(answers) => answers.clone(),
                    None if one && (args.choice.is_some() || args.text.is_some()) => {
                        vec![super::types::AnswerItem {
                            id: None,
                            selected: args.choice.clone().map(|choice| vec![choice]),
                            text: args.text.clone().filter(|text| !text.is_empty()),
                        }]
                    }
                    None => Vec::new(),
                };
                if !one && given.is_empty() {
                    return fail(format!(
                        "This card asks {} questions: pass `answers` with one entry each: [{}] (or \"text\" instead of \"selected\" for an answer of your own).",
                        request.questions.len(),
                        request
                            .questions
                            .iter()
                            .map(|question| format!(
                                "{{\"id\": \"{}\", \"selected\": [<one of {}>]}}",
                                question.id,
                                options_of(question)
                            ))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                let mut answers = Vec::new();
                for question in &request.questions {
                    let mine = given
                        .iter()
                        .find(|entry| entry.id.as_deref() == Some(question.id.as_str()))
                        .or(if one { given.first() } else { None });
                    let Some(mine) = mine else {
                        return fail(format!(
                            "No answer for question \"{}\" ({}): pass `answers` ([{{\"id\": \"{}\", \"selected\": [<one of {}>]}}], or \"text\" instead of \"selected\" for an answer of your own).",
                            question.id,
                            one_line(&question.question, 80),
                            question.id,
                            options_of(question)
                        ));
                    };
                    let labels: Vec<String> = question
                        .options
                        .iter()
                        .map(|option| option.label.clone())
                        .collect();
                    let mut selected = Vec::new();
                    for name in mine.selected.as_deref().unwrap_or(&[]) {
                        selected.push(pick_option(&labels, name)?);
                    }
                    let text = mine.text.as_deref().filter(|text| !text.is_empty());
                    if selected.is_empty() && text.is_none() {
                        return fail(format!(
                            "Question \"{}\": choose an option ({}) or give text.",
                            question.id,
                            labels.join(" | ")
                        ));
                    }
                    if selected.len() > 1 && !question.multi {
                        return fail(format!("Question \"{}\" takes one option.", question.id));
                    }
                    let mut entry = json!({ "id": question.id, "selectedOptions": selected });
                    if let Some(text) = text {
                        entry["customInput"] = json!(text);
                    }
                    answers.push(entry);
                }
                summary = format!("{} answer(s)", answers.len());
                response =
                    json!({ "type": "extension_ui_response", "id": ask.id, "answers": answers });
            }
            // A form only the bot it was routed to answers, through the asking session's own form rules.
            "form" if routed.is_some() => {
                response = self.form_response(target, ask, args).await?;
                summary = "the form".to_owned();
            }
            other => {
                return fail(format!(
                    "That request ({other}) is not a question an agent can answer: show it to the user with ompdesk_tab_focus."
                ));
            }
        }
        // The opener answers a card it was told of: its close is not reported back to it (`child_ask_closed`).
        if self.host.state().parent_of(&target.tab_id) == Some(caller.tab_id.as_str())
            && let Some(told) = self.mem().cards_told.get_mut(&target.tab_id)
        {
            told.remove(&ask.id);
        }
        let about = if matches!(request.method.as_str(), "ask" | "form") {
            "its questions".to_owned()
        } else {
            request
                .title
                .clone()
                .unwrap_or_else(|| "undefined".to_owned())
        };
        // The bot's own answer to a card routed to it: its close is not told back to it.
        if routed.is_some() {
            self.routed_answered(&target.tab_id, &ask.id, true);
        }
        let delivered = match self
            .companion(caller, target, &about, &ask.id, resolved)
            .await
        {
            Ok(Some(companion)) => {
                self.host
                    .answer_with_companion(
                        &target.tab_id,
                        json!({ "askId": ask.id, "response": response }),
                        &companion,
                    )
                    .await
            }
            Ok(None) => self.host.answer(&target.tab_id, &ask.id, &response).await,
            Err(error) => Err(error),
        };
        if let Err(error) = delivered {
            if routed.is_some() {
                self.routed_answered(&target.tab_id, &ask.id, false);
            }
            return Err(error);
        }
        let by = if caller.title.is_empty() {
            &caller.tab_id
        } else {
            &caller.title
        };
        let _ = self.host.mark_answered(&target.tab_id, by).await;
        let Some(reason) = deny_reason else {
            return Ok(format!(
                "Answered {}: {summary}. It continues now.",
                label(target)
            ));
        };
        let told = self
            .send(
                caller,
                target,
                &SendArgs {
                    session: target.tab_id.clone(),
                    message: format!("Denied \"{}\": {reason}", title_of(100)),
                    ..SendArgs::default()
                },
            )
            .await;
        Ok(match told {
            Ok(_) => format!(
                "Answered {}: {summary}, and sent it the reason. It continues now.",
                label(target)
            ),
            Err(error) => format!(
                "Answered {}: {summary}. It continues now, but the reason was not delivered: {}",
                label(target),
                error.message()
            ),
        })
    }

    /// `#answerPlan`: a plan proposal, through the same `plan_approval` command the plan card sends: approve with an
    /// option, or reject (with `text`, stock's feedback turn). Approving follows the tool-approval rule; rejecting
    /// always works.
    async fn answer_plan(
        &self,
        caller: &ControlTab,
        target: &ControlTab,
        plan: &super::types::TabPlan,
        args: &AnswerArgs,
    ) -> R<String> {
        let resolved = self
            .resolve_attachments(caller, args.attachments.as_deref())
            .await?;
        let approve = args.approve.or_else(|| {
            args.choice.as_ref().map(|choice| {
                let lowered = choice.to_lowercase();
                !["reject", "deny", "no"]
                    .iter()
                    .any(|word| lowered.starts_with(word))
            })
        });
        let Some(approve) = approve else {
            return fail(
                "Give approve: true (choice execute, compact or keep_context) or approve: false (text = feedback).",
            );
        };
        let name = format!(
            "\"{}\"",
            one_line(
                if plan.title.is_empty() {
                    "plan"
                } else {
                    &plan.title
                },
                100
            )
        );
        let feedback = args.text.as_deref().map(trim).filter(|f| !f.is_empty());
        let (command, summary) = if approve {
            let option = match args.choice.as_deref() {
                None | Some("Approve") => "execute",
                Some(other) => other,
            };
            if !matches!(option, "execute" | "compact" | "keep_context") {
                return fail(format!(
                    "Plan option \"{option}\": use execute, compact or keep_context."
                ));
            }
            if !self.host.state().approve_enabled {
                return fail(
                    "사용자 승인이 필요해요: approving another session's plan needs the user's permission for agents to approve (Settings › Tools & extensions). Tell the user, or show the session with ompdesk_tab_focus. Rejecting with feedback is allowed.",
                );
            }
            (
                json!({ "type": "plan_approval", "approved": true, "option": option }),
                format!("approved plan {name} ({option})"),
            )
        } else {
            let command = match feedback {
                Some(feedback) => {
                    json!({ "type": "plan_approval", "approved": false, "feedback": feedback })
                }
                None => json!({ "type": "plan_approval", "approved": false }),
            };
            let summary = if feedback.is_some() {
                format!("rejected plan {name} with feedback")
            } else {
                format!("rejected plan {name}")
            };
            (command, summary)
        };
        match self
            .companion(
                caller,
                target,
                if plan.title.is_empty() {
                    "plan"
                } else {
                    &plan.title
                },
                &format!("plan:{}", plan.generation.unwrap_or(0)),
                resolved,
            )
            .await?
        {
            Some(companion) => {
                self.host
                    .answer_with_companion(
                        &target.tab_id,
                        json!({ "plan": command, "planFile": plan.plan_file_path, "planGeneration": plan.generation }),
                        &companion,
                    )
                    .await?
            }
            None => {
                let response = self
                    .host
                    .command(&target.tab_id, &command, Deadline::Default)
                    .await?;
                response_data(&response, "Answering the plan")?;
            }
        }
        let by = if caller.title.is_empty() {
            &caller.tab_id
        } else {
            &caller.title
        };
        let _ = self.host.mark_answered(&target.tab_id, by).await;
        Ok(format!(
            "Answered {}: {summary}.{}",
            label(target),
            if approve || feedback.is_some() {
                " It continues now."
            } else {
                ""
            }
        ))
    }

    /// `childAsked`: a child showed a question card (stock `ask`, a select, confirm or text prompt): its opener hears
    /// of it as one question in its session, as a report the child wrote would arrive, so it can answer with
    /// ompdesk_session_answer or ask the user instead of finding the card by polling. Never OMPdesk's own
    /// confirmation cards, a session hidden from agents, or a session `opener_tab_id` did not open.
    pub async fn child_asked(
        &self,
        opener_tab_id: &str,
        child_tab_id: &str,
        request_id: &str,
    ) -> R<()> {
        let state = self.host.state();
        if !state.enabled {
            return Ok(());
        }
        let Some(tabs) = state.tabs(opener_tab_id) else {
            return Ok(());
        };
        let Some(child) = tabs.iter().find(|tab| tab.tab_id == child_tab_id) else {
            return Ok(());
        };
        if child.hidden {
            return Ok(());
        }
        if state.parent_of(child_tab_id) != Some(opener_tab_id)
            && !self
                .opened_by(&state, opener_tab_id, &tabs)
                .iter()
                .any(|id| id == child_tab_id)
        {
            return Ok(());
        }
        let Some(ask) = child.asks.iter().find(|entry| entry.id == request_id) else {
            return Ok(());
        };
        if is_agent_card(ask) || self.routed_away(child_tab_id, request_id) {
            return Ok(());
        }
        {
            let mut mem = self.mem();
            let told = mem.cards_told.entry(child_tab_id.to_owned()).or_default();
            if !told.insert(request_id.to_owned()) {
                return Ok(());
            }
        }
        let mut mail = Mail::new(
            &format!("ask-{child_tab_id}-{request_id}"),
            child_tab_id,
            if child.title.is_empty() {
                child.task.as_deref().unwrap_or("")
            } else {
                &child.title
            },
            opener_tab_id,
            MailKind::Question,
            &card_text(&ask.request),
            self.now(),
        );
        mail.card = Some(request_id.to_owned());
        let sent = self
            .host
            .mail(
                opener_tab_id,
                &mail_text(&mail),
                &mail_details(&mail),
                delivery_for(mail.kind),
            )
            .await;
        if let Err(error) = sent {
            // Not delivered (the opener's omp restarting): a later announcement of the same card may try again.
            if let Some(told) = self.mem().cards_told.get_mut(child_tab_id) {
                told.remove(request_id);
            }
            return Err(error);
        }
        self.host.review_changed(opener_tab_id);
        self.arrive(opener_tab_id);
        Ok(())
    }

    /// `personTyped`: the person typed a prompt to `tab_id` (main's word for a window's, the phone page's or a paired
    /// device's prompt; never read from the text). When that prompt starts the tab's turn, the cleanups its agent was
    /// refused are listed to it once, as a note ahead of the turn: the calls work in a turn the person started. A
    /// prompt that joins a running turn starts none, so the list waits.
    /// Returns the delivery of the note, when there is one to make, so a caller that wants it told can wait for it.
    pub fn person_typed(&self, tab_id: &str) -> Option<tokio::task::JoinHandle<()>> {
        // The person's own words reach a waiting session at its next step: its blocking wait ends for them too.
        self.arrive(tab_id);
        let state = self.host.state();
        let tabs = state.tabs(tab_id)?;
        let caller = tabs.iter().find(|tab| tab.tab_id == tab_id)?;
        if caller.busy {
            return None;
        }
        let pending = self.cleanups().take(&cleanup_caller(caller));
        let mut lines = Vec::new();
        for entry in &pending {
            let tab = tabs.iter().find(|open| match &entry.path {
                Some(path) => {
                    open.session_path.as_deref() == Some(path.as_str())
                        && open.device == entry.device
                }
                None => open.tab_id == entry.tab_id || open.former_ids.contains(&entry.tab_id),
            });
            // A closed tab leaves only a delete to do, and only while its session is still saved.
            if tab.is_none()
                && (entry.action != CleanupAction::Delete
                    || self.fate_of(&state, &entry.tab_id).map(|fate| fate.state)
                        != Some(FateState::Closed))
            {
                continue;
            }
            let id = tab.map_or(entry.tab_id.as_str(), |tab| tab.tab_id.as_str());
            let mut arguments = Map::new();
            arguments.insert("session".into(), json!(id));
            if entry.action != CleanupAction::Stop {
                arguments.insert(entry.action.as_str().into(), json!(true));
            }
            let call = format!("ompdesk_session_stop {}", Value::Object(arguments));
            lines.push(format!(
                "- {id}{}: {}{}, asked {} UTC: {call}",
                if entry.title.is_empty() {
                    String::new()
                } else {
                    format!(" \"{}\"", one_line(&entry.title, 80))
                },
                entry.action.as_str(),
                if tab.is_some() {
                    ""
                } else {
                    " (its tab is closed since, its session still saved)"
                },
                utc_minutes(entry.at)
            ));
        }
        if lines.is_empty() {
            return None;
        }
        let text = format!(
            "OMPdesk: pending cleanups ({}). You asked for these while the user was in the session, in a turn their own message had not started, and were refused. The user's own message starts this turn, so each call works now: make the ones that are still wanted, and leave a session the user still uses.\n{}",
            lines.len(),
            lines.join("\n")
        );
        let details = json!({
            "id": format!("cleanups:{tab_id}:{}", self.now() as i64),
            "from": tab_id,
            "fromTitle": "OMPdesk",
            "kind": "note",
            "label": "note",
            "text": text,
        });
        // Not told (its omp cannot take a note now): the list waits for the next such turn.
        let control = self.clone();
        let tab_id = tab_id.to_owned();
        Some(tokio::spawn(async move {
            let told = control
                .host
                .mail(&tab_id, &text, &details, delivery_for(MailKind::Note))
                .await;
            if told.is_err() {
                let mut cleanups = control.cleanups();
                for entry in pending {
                    cleanups.add(entry);
                }
            }
        }))
    }
}

#[cfg(test)]
#[path = "messages_tests.rs"]
mod tests;
