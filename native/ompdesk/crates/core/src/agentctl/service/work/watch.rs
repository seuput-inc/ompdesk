//! What an opener hears of the sessions it opened besides their own reports (`rules::child_watch`): run by the
//! auto-close pass for each child, by a child's card closing (`child_ask_closed`) and by a child's tab closing
//! (`tell_closed`, from `released`).

use serde_json::{Value, json};

use super::super::AgentControl;
use super::super::host::Deadline;
use super::super::js::{cut, one_line};
use super::super::messages::utc_minutes;
use super::super::text::{is_agent_card, label, saved_id_of_path};
use super::super::types::{ControlTab, ReleasedSession, TabStatus};
use crate::agentctl::rules::child_watch::{Armed, Phase, Tell, WatchFacts};
use crate::agentctl::rules::mail::{Mail, MailKind, delivery_for, mail_details, mail_text};

/// The longest error or answer a note quotes.
const QUOTE_CHARS: usize = 600;

/// A quiet note's details (`id` makes a repeat a no-op), from `from` titled `from_title`.
fn note(id: &str, from: &str, from_title: &str, text: &str) -> Value {
    json!({
        "id": id,
        "from": from,
        "fromTitle": from_title,
        "kind": "note",
        "label": "note",
        "text": text,
    })
}

impl AgentControl {
    /// One pass's look at a child `caller` opened: tells the opener (and, for an unanswered question, the child and
    /// the person) what `ChildWatch::step` says is new. Never a session the person typed into, one hidden from agents,
    /// or an Autopilot run's (those are not `auto_closable`).
    pub(super) async fn watch_child(
        &self,
        caller: &ControlTab,
        tab: &ControlTab,
        opener_idle: bool,
    ) {
        if !tab.auto_closable || tab.hidden || tab.user_touched {
            return;
        }
        let dispatch = self.mailbox.current(&tab.tab_id).unwrap_or_default();
        let failed = tab
            .last_run
            .as_ref()
            .filter(|run| run.stop_reason == "error")
            .map(|run| {
                run.error_message
                    .clone()
                    .filter(|error| !error.trim().is_empty())
                    .unwrap_or_else(|| "no error text".to_owned())
            });
        let down = match tab.status {
            TabStatus::Exited => Some(()),
            TabStatus::Error if !tab.session_held => Some(()),
            _ => None,
        }
        .map(|()| {
            tab.failure
                .clone()
                .unwrap_or_else(|| "no reason given".to_owned())
        });
        let question = {
            let mem = self.mem();
            let told = mem.cards_told.get(&tab.tab_id);
            tab.asks
                .iter()
                .filter(|ask| !is_agent_card(ask))
                .find(|ask| told.is_some_and(|told| told.contains(&ask.id)))
                .map(|ask| format!("card:{}", ask.id))
        }
        .or_else(|| {
            self.mailbox
                .state(&tab.tab_id, &caller.tab_id)
                .filter(|state| state.waiting)
                .map(|state| {
                    format!(
                        "mail:{}:{}:{}",
                        state.last.dispatch.as_deref().unwrap_or(""),
                        state.last.kind.as_str(),
                        state.last.at
                    )
                })
        });
        let facts = WatchFacts {
            phase: match (tab.busy, tab.settling) {
                (true, true) => Phase::Settling,
                (true, false) => Phase::Running,
                (false, _) => Phase::Idle,
            },
            dispatch: dispatch.clone(),
            down,
            failed,
            retrying: tab
                .retry_saga
                .as_ref()
                .filter(|_| tab.busy)
                .map(|saga| (saga.attempt, saga.max_attempts, saga.error_message.clone())),
            armed: tab.scheduled_retry.as_ref().map(|retry| Armed {
                at: retry.at,
                attempt: retry.attempt,
                limit: retry.limit,
            }),
            continues: tab.resuming || tab.awaiting_connection,
            question: question.clone(),
            opener_busy: caller.busy,
            opener_idle,
            now: self.now(),
            failure_settle_ms: self.tuning.failure_settle_ms as f64,
            background_note_ms: self.tuning.background_note_ms as f64,
        };
        let tells = self
            .mem()
            .watched
            .entry(tab.tab_id.clone())
            .or_default()
            .step(&facts);
        for tell in tells {
            self.tell(caller, tab, &dispatch, question.as_deref(), tell)
                .await;
        }
    }

    async fn tell(
        &self,
        caller: &ControlTab,
        tab: &ControlTab,
        dispatch: &str,
        question: Option<&str>,
        tell: Tell,
    ) {
        let child = tab.name().to_owned();
        let key = format!(
            "{}:{dispatch}:{}",
            tab.session_path.as_deref().unwrap_or(&tab.tab_id),
            self.now() as i64
        );
        let (kind, text) = match tell {
            Tell::Failed(error) => {
                let answer = tab
                    .last_run
                    .as_ref()
                    .and_then(|run| run.reply.as_deref())
                    .map(str::trim)
                    .filter(|reply| !reply.is_empty())
                    .map(|reply| format!(" Its last answer: {}", cut(reply, QUOTE_CHARS)))
                    .unwrap_or_default();
                (
                    MailKind::Blocked,
                    format!(
                        "OMPdesk: its turn ended with an error, and nothing retries it: {}.{answer} Decide what it does next: send it the work again or a corrected instruction (ompdesk_session_send), or stop it.",
                        cut(&error, QUOTE_CHARS)
                    ),
                )
            }
            Tell::Down(why) => (
                MailKind::Blocked,
                format!(
                    "OMPdesk: its omp stopped and did not come back ({}). Nothing runs there now: close it (ompdesk_session_stop with close) and give the work to a new session, or tell the user.",
                    cut(&why, QUOTE_CHARS)
                ),
            ),
            Tell::Retrying { attempt, of, error } => (
                MailKind::Note,
                format!(
                    "OMPdesk: its model request failed ({}), and omp retries it by itself (attempt {attempt} of {of}). Nothing to do unless it ends failed.",
                    cut(&error, QUOTE_CHARS)
                ),
            ),
            Tell::Limit { at, error } => (
                MailKind::Note,
                format!(
                    "OMPdesk: its turn stopped at a provider's usage limit ({}). It goes on by itself at {} UTC, or sooner once the limit lifts. Wait for it, or stop it and give the work to a session on another model (ompdesk_session_open with model).",
                    cut(&error, QUOTE_CHARS),
                    utc_minutes(at)
                ),
            ),
            Tell::Backoff { at, attempt, error } => (
                MailKind::Note,
                format!(
                    "OMPdesk: its turn failed ({}), and OMPdesk tries it again by itself at {} UTC (attempt {attempt}).",
                    cut(&error, QUOTE_CHARS),
                    utc_minutes(at)
                ),
            ),
            Tell::Background { minutes } => {
                let jobs = self.running_jobs(tab).await;
                (
                    MailKind::Note,
                    format!(
                        "OMPdesk: its turn ended {minutes} min ago, but its own background work still runs{}. It goes on once that ends; look with ompdesk_session_result if it should have finished by now.",
                        if jobs.is_empty() {
                            String::new()
                        } else {
                            format!(" ({})", jobs.join("; "))
                        }
                    ),
                )
            }
            Tell::Unanswered => {
                self.tell_unanswered(caller, tab, question.unwrap_or(""))
                    .await;
                return;
            }
        };
        let mut mail = Mail::new(
            &format!("watch-{key}-{}", kind.as_str()),
            &tab.tab_id,
            &child,
            &caller.tab_id,
            kind,
            &text,
            self.now(),
        );
        if !dispatch.is_empty() {
            mail.dispatch = Some(dispatch.to_owned());
        }
        // Kept by the mail outbox: an opener whose omp cannot take it now gets it on the next pass.
        let _ = self
            .host
            .mail(
                &caller.tab_id,
                &mail_text(&mail),
                &mail_details(&mail),
                delivery_for(kind),
            )
            .await;
        if kind == MailKind::Blocked {
            self.host.review_changed(&caller.tab_id);
            self.arrive(&caller.tab_id);
        }
    }

    /// The labels of a child's background jobs still running (`get_jobs`), at most three.
    async fn running_jobs(&self, tab: &ControlTab) -> Vec<String> {
        let Ok(response) = self
            .host
            .command(
                &tab.tab_id,
                &json!({ "type": "get_jobs" }),
                Deadline::Ms(self.tuning.state_timeout_ms),
            )
            .await
        else {
            return Vec::new();
        };
        let rows = response
            .data
            .filter(|_| response.success)
            .and_then(|data| data.get("rows").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        rows.iter()
            .filter_map(|row| row.get("job"))
            .filter(|job| job.get("status").and_then(Value::as_str) == Some("running"))
            .filter_map(|job| job.get("label").and_then(Value::as_str))
            .take(3)
            .map(|label| one_line(label, 80))
            .collect()
    }

    /// The opener ended its turn with a question or blocker of `tab` unanswered: the person is notified, and a child
    /// that reported it (no card of its own to hold it) hears that nobody answered yet, so it does not wait in a turn
    /// for an answer that is not coming (after Orca's question reconciler, `mailbox/questions/`, MIT).
    async fn tell_unanswered(&self, caller: &ControlTab, tab: &ControlTab, question: &str) {
        let card = question.strip_prefix("card:");
        let asked = match card {
            Some(id) => tab
                .asks
                .iter()
                .find(|ask| ask.id == id)
                .and_then(|ask| ask.request.title.clone())
                .unwrap_or_default(),
            None => self
                .mailbox
                .state(&tab.tab_id, &caller.tab_id)
                .map(|state| state.last.text)
                .unwrap_or_default(),
        };
        let asked = one_line(&asked, 160);
        let opener = caller.name().to_owned();
        let state = self.host.state();
        let title = state.text("unansweredTitle", &[("child", tab.name())]);
        let body = state.text(
            "unansweredMessage",
            &[("opener", &opener), ("question", &asked)],
        );
        self.host.notify(&tab.tab_id, &title, &body);
        if card.is_some() {
            return;
        }
        let text = format!(
            "OMPdesk: {} ended its turn without answering your {} ({asked}). The user was told. Wait for the answer as a message; do not guess it, and end your turn if there is nothing else to do.",
            label(caller),
            self.mailbox
                .state(&tab.tab_id, &caller.tab_id)
                .map_or("report", |state| state.last.kind.as_str())
        );
        let id = format!(
            "unanswered:{}:{question}",
            tab.session_path.as_deref().unwrap_or(&tab.tab_id)
        );
        let _ = self
            .host
            .mail(
                &tab.tab_id,
                &text,
                &note(&id, &caller.tab_id, &opener, &text),
                delivery_for(MailKind::Note),
            )
            .await;
    }

    /// `childAskClosed`: a child's card its opener was told of closed. Answered by the opener itself (its
    /// `ompdesk_session_answer` dropped it from `cards_told`): nothing. Answered by the person or another session: the
    /// opener hears with what, once, so it does not answer a card that is gone. Withdrawn while the child's omp is up
    /// (its turn ended or was stopped): the opener hears that. Closed because its omp went away (restarting, its tab
    /// closing): nothing, since a restart raises the card again and a close tells the opener itself.
    pub async fn child_ask_closed(
        &self,
        opener_tab_id: &str,
        child_tab_id: &str,
        request_id: &str,
        choice: Option<&str>,
    ) {
        if !self
            .mem()
            .cards_told
            .get_mut(child_tab_id)
            .is_some_and(|told| told.remove(request_id))
        {
            return;
        }
        let state = self.host.state();
        let Some(child) = state
            .tabs
            .iter()
            .find(|tab| tab.tab_id == child_tab_id)
            .cloned()
        else {
            return;
        };
        let text = match choice {
            Some(choice) => format!(
                "OMPdesk: the question it asked you was answered in its session (by the user or another session): \"{}\". Do not answer it again.",
                one_line(choice, 200)
            ),
            None if child.status.is_up() => {
                "OMPdesk: the question it asked you was withdrawn (its turn ended or was stopped before an answer). Do not answer it; see where it stands with ompdesk_session_result.".to_owned()
            }
            None => return,
        };
        let id = format!("ask-closed-{child_tab_id}-{request_id}");
        let _ = self
            .host
            .mail(
                opener_tab_id,
                &text,
                &note(&id, child_tab_id, child.name(), &text),
                delivery_for(MailKind::Note),
            )
            .await;
    }

    /// The person or its window closed a child an agent opened: one quiet note to its opener, when the opener's tab is
    /// open (`released`).
    pub(in crate::agentctl::service) fn tell_closed(
        &self,
        tab_id: &str,
        session: &ReleasedSession,
    ) -> Option<tokio::task::JoinHandle<()>> {
        let opener_path = session.opened_by_session.as_deref()?;
        let opener = self
            .host
            .state()
            .tabs
            .iter()
            .find(|tab| tab.session_path.as_deref() == Some(opener_path))
            .map(|tab| tab.tab_id.clone())?;
        let saved = saved_id_of_path(Some(&session.path))
            .map(|id| format!(" (saved id {id})"))
            .unwrap_or_default();
        let title = if session.title.is_empty() {
            "A session you opened".to_owned()
        } else {
            format!("\"{}\"", one_line(&session.title, 80))
        };
        let text = format!(
            "OMPdesk: {title} was closed by the user or its window, not by you or OMPdesk. Its session is saved{saved}: ompdesk_session_read reads it, and a message to it (ompdesk_session_send) opens it again."
        );
        let details = note(
            &format!("closed:{}", session.path),
            tab_id,
            &session.title,
            &text,
        );
        let control = self.clone();
        Some(tokio::spawn(async move {
            let _ = control
                .host
                .mail(&opener, &text, &details, delivery_for(MailKind::Note))
                .await;
        }))
    }
}
