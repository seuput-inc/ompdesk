//! Route a worker's question to the bot whose dispatch started its current turn.
//! An approval, sign-in or OMPdesk confirmation is never eligible.

use serde::Deserialize;
use serde_json::{Value, json};

use super::AgentControl;
use super::fail::{R, fail};
use super::host::Deadline;
use super::js::one_line;
use super::text::{card_text, is_agent_card, label, pick_option, response_data, saved_id_of_path};
use super::types::{AnswerArgs, AnswerItem, AskOption, ControlAsk, ControlTab};
use crate::agentctl::rules::mail::{Mail, MailKind, delivery_for, mail_details, mail_text};

/// The request a run serves, as the pool read it from the run's opening message.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct AskOrigin {
    /// The saved id of the session whose message started the run.
    pub session: String,
    /// The dispatch (`d3`) or request id that message carried.
    pub mark: Option<String>,
}

/// One question routed to a bot, by the asking tab and the request id.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Route {
    /// The bot's id.
    pub bot: String,
    /// The bot chat whose message started the run (its session file).
    pub chat: String,
    /// Passed on to the owner (`escalate`).
    pub escalated: bool,
    /// The bot answered it: its close is not told back.
    pub answered: bool,
    /// Answered or withdrawn: kept so a late answer that names it is refused, never taken for another card.
    pub closed: bool,
}

/// One question of a projected form (`resources/gui-bridge/ask-form.ts` `project_ask_form`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct FormQuestion {
    id: String,
    question: String,
    header: Option<String>,
    context: Option<String>,
    options: Vec<AskOption>,
    multi: bool,
}

/// What a bot reads of a form: the text around its fields and each field as a question with its options.
fn form_text(view: &Value) -> String {
    let mut lines = Vec::new();
    if let Some(context) = view["context"].as_str().filter(|text| !text.is_empty()) {
        lines.push(context.to_owned());
    }
    let questions: Vec<FormQuestion> =
        serde_json::from_value(view["questions"].clone()).unwrap_or_default();
    for question in &questions {
        if let Some(context) = question.context.as_deref().filter(|text| !text.is_empty()) {
            lines.push(context.to_owned());
        }
        let header = question
            .header
            .as_deref()
            .filter(|header| !header.is_empty())
            .map_or_else(String::new, |header| format!("{header}: "));
        lines.push(format!("[{}] {header}{}", question.id, question.question));
        if question.options.is_empty() {
            lines.push("a text field".to_owned());
        } else {
            lines.push(format!(
                "options: {}{}",
                question
                    .options
                    .iter()
                    .map(|option| format!("\"{}\"", option.label))
                    .collect::<Vec<_>>()
                    .join(" | "),
                if question.multi {
                    " (several allowed)"
                } else {
                    ""
                }
            ));
        }
    }
    lines.push("answer with: answers ([{\"id\": <question id>, \"selected\": [<option>]}], or \"text\" for a text field or an answer of your own)".to_owned());
    lines.join("\n")
}

/// What the bot is asked to do with the card.
fn routed_instruction(tab_id: &str, request_id: &str, mark: Option<&str>) -> String {
    let work = mark.map_or_else(
        || "your message".to_owned(),
        |mark| format!("your request {mark}"),
    );
    format!(
        "Session {tab_id} raised this card while working on {work}, and waits (request {request_id}). It came to you, not the owner: answer it yourself with ompdesk_session_answer {{\"session\": \"{tab_id}\", \"request\": \"{request_id}\", …}}. When only the owner can make this choice, pass it on with ompdesk_session_answer {{\"session\": \"{tab_id}\", \"request\": \"{request_id}\", \"escalate\": true}}: the owner then answers the card in this chat, and the answer goes straight to that session. Never guess an approval."
    )
}

impl AgentControl {
    /// `agentRuntime.routeAsk`: whose a question of a run another session started is. The bot whose chat sent that
    /// message gets it as a card in that chat (a mail that starts a turn) and the chat's session file is the answer;
    /// None leaves it with the owner (main shows it in the windows and the opener hears of it as before).
    pub async fn route_ask(
        &self,
        tab_id: &str,
        request_id: &str,
        origin: &AskOrigin,
    ) -> Option<String> {
        let state = self.host.state();
        if !state.enabled || origin.session.is_empty() || origin.mark.is_none() {
            return None;
        }
        let target = state.tabs.iter().find(|tab| tab.tab_id == tab_id)?.clone();
        if target.hidden || target.device.is_some() {
            return None;
        }
        let ask = target.asks.iter().find(|ask| ask.id == request_id)?.clone();
        if !matches!(ask.request.method.as_str(), "ask" | "form") || is_agent_card(&ask) {
            return None;
        }
        let (bot, chat) = self.bots().all().iter().find_map(|bot| {
            bot.home
                .iter()
                .chain(bot.sessions.iter())
                .find(|path| {
                    saved_id_of_path(Some(path.as_str())).as_deref()
                        == Some(origin.session.as_str())
                })
                .map(|path| (bot.clone(), path.clone()))
        })?;
        if bot.paused || target.session_path.as_deref() == Some(chat.as_str()) {
            return None;
        }
        let text = if ask.request.method == "form" {
            let html = ask.request.html.as_deref().unwrap_or("");
            form_text(&self.project_form(tab_id, html, None).await.ok()?)
        } else {
            card_text(&ask.request)
        };
        self.host.reach(&chat).await.ok()?;
        let chat_tab = self.host.wait_for(Some(self.tuning.send_ready_wait_ms), |state| {
            let tab = state.tabs.iter().find(|tab| tab.device.is_none() && tab.session_path.as_deref() == Some(chat.as_str()))?;
            tab.status.is_up().then(|| tab.tab_id.clone())
        }).await?;
        if self.bots().find(&bot.id).is_none_or(|bot| bot.paused)
            || !self.host.state().tabs.iter().any(|tab| tab.tab_id == tab_id && tab.asks.iter().any(|ask| ask.id == request_id))
        {
            return None;
        }
        let title = if target.title.is_empty() {
            target.task.as_deref().unwrap_or("")
        } else {
            &target.title
        };
        let mut mail = Mail::new(
            &format!("ask-{tab_id}-{request_id}"),
            tab_id,
            title,
            &chat_tab,
            MailKind::Question,
            &text,
            self.now(),
        );
        mail.card = Some(request_id.to_owned());
        mail.dispatch = origin.mark.clone();
        mail.instruction = Some(routed_instruction(
            tab_id,
            request_id,
            origin.mark.as_deref(),
        ));
        // Kept before the card goes: the bot's answer may come before this returns.
        self.mem()
            .routes
            .entry(tab_id.to_owned())
            .or_default()
            .insert(
                request_id.to_owned(),
                Route {
                    bot: bot.id.clone(),
                    chat: chat.clone(),
                    ..Route::default()
                },
            );
        // A question cannot be queued for later: either the live chat takes it, or the owner gets it.
        if self.host.send_mail(&chat_tab, &mail_text(&mail), &mail_details(&mail), delivery_for(mail.kind)).await.is_err() {
            if let Some(routes) = self.mem().routes.get_mut(tab_id) {
                routes.remove(request_id);
            }
            return None;
        }
        Some(chat)
    }

    /// A routed question closed. The bot hears how once, unless its own answer closed it; a late answer naming it is
    /// refused from now on.
    pub async fn routed_ask_closed(&self, tab_id: &str, request_id: &str, choice: Option<&str>) {
        let route = {
            let mut mem = self.mem();
            let Some(route) = mem
                .routes
                .get_mut(tab_id)
                .and_then(|routes| routes.get_mut(request_id))
            else {
                return;
            };
            if route.closed {
                return;
            }
            route.closed = true;
            route.clone()
        };
        if route.answered {
            return;
        }
        let card = format!("the card of session {tab_id} (request {request_id})");
        let text = match (route.escalated, choice) {
            (true, Some(choice)) => format!(
                "The owner answered {card}, which you passed on: {}. That session goes on with it.",
                one_line(choice, 300)
            ),
            (false, Some(choice)) => format!(
                "{card} was answered in its session: {}.",
                one_line(choice, 300)
            ),
            (_, None) => format!(
                "{card} closed unanswered (withdrawn, timed out, or its session ended): there is nothing to answer now."
            ),
        };
        self.note_session(&route.chat, &text).await;
    }

    /// The card `args` may answer when routing decides it: `Some` the routed card the caller's bot names, `None` for
    /// today's rules (no bot of the caller's has a card routed from `target`), refused otherwise. A bot answers only a
    /// card routed to it, by its request id, while it is open: never a card in its place, a plan or an approval.
    pub(super) fn routed_card(
        &self,
        caller: &ControlTab,
        target: &ControlTab,
        args: &AnswerArgs,
    ) -> R<Option<ControlAsk>> {
        let caller_bot = caller
            .session_path
            .as_deref()
            .filter(|_| caller.device.is_none())
            .and_then(|path| self.bots().of_session(path).map(|bot| bot.id.clone()));
        let mem = self.mem();
        let Some(routes) = mem.routes.get(&target.tab_id).filter(|routes| !routes.is_empty()) else {
            if args.escalate == Some(true) {
                return fail(format!(
                    "{} raised no card for your request: there is nothing to pass on.",
                    label(target)
                ));
            }
            return Ok(None);
        };
        let named = args.request.as_deref().and_then(|id| routes.get(id));
        if named.is_some_and(|route| route.closed) {
            return fail("That card is closed: nothing was answered.");
        }
        let mine = caller_bot
            .as_ref()
            .is_some_and(|bot| routes.values().any(|route| &route.bot == bot));
        if !mine {
            if let Some(route) = named.filter(|route| !route.closed) {
                return fail(format!(
                    "That card was raised for the bot {}'s request: only that bot answers it (or the owner, once it passes it on).", route.bot
                ));
            }
            if args.escalate == Some(true) {
                return fail("Only the bot a card came to passes it on to the owner.");
            }
            return Ok(None);
        }
        let Some(id) = args.request.as_deref() else {
            return fail(format!(
                "Name the card: pass `request` with the request id its card gave ({} raised a card for your request). Nothing was answered.",
                label(target)
            ));
        };
        let Some(route) = named.filter(|route| Some(&route.bot) == caller_bot.as_ref()) else {
            return fail(format!(
                "Request \"{id}\" is no card {} raised for you: nothing was answered.",
                label(target)
            ));
        };
        if route.escalated {
            return fail(format!(
                "You passed that card (request {id}) on to the owner: it is theirs to answer now."
            ));
        }
        match target.asks.iter().find(|ask| ask.id == id) {
            Some(ask) => Ok(Some(ask.clone())),
            None => fail(format!(
                "That card (request {id}) is closed: it was answered or withdrawn, so nothing was answered."
            )),
        }
    }

    /// Whether `request_id` of `tab_id` is a card routed to a bot and still open: no other answer takes it.
    pub(super) fn routed_away(&self, tab_id: &str, request_id: &str) -> bool {
        self.mem()
            .routes
            .get(tab_id)
            .and_then(|routes| routes.get(request_id))
            .is_some_and(|route| !route.closed)
    }

    /// Whether the routed card's bot is answering it (false again when its answer was not delivered): the close its own
    /// answer brings is not told back to it.
    pub(super) fn routed_answered(&self, tab_id: &str, request_id: &str, answered: bool) {
        if let Some(route) = self
            .mem()
            .routes
            .get_mut(tab_id)
            .and_then(|routes| routes.get_mut(request_id))
        {
            route.answered = answered;
        }
    }

    /// `escalate`: the bot passes its card on to the owner, who answers it in the bot's chat (`caller`); the answer
    /// goes straight to the asking session and closes the card once.
    pub(super) async fn escalate(
        &self,
        caller: &ControlTab,
        target: &ControlTab,
        ask: &ControlAsk,
    ) -> R<String> {
        self.mark_escalated(&target.tab_id, &ask.id, true);
        let shown = self
            .host
            .escalate_ask(&target.tab_id, &ask.id, Some(&caller.tab_id))
            .await;
        if !matches!(shown, Ok(true)) {
            self.mark_escalated(&target.tab_id, &ask.id, false);
        }
        if !shown? {
            return fail(format!(
                "That card (request {}) closed meanwhile: nothing was passed on.",
                ask.id
            ));
        }
        Ok(format!(
            "Passed on to the owner: the card of {} shows in this chat for them now, and their answer goes straight to that session. End your turn; you hear how it was answered.",
            label(target)
        ))
    }

    fn mark_escalated(&self, tab_id: &str, request_id: &str, escalated: bool) {
        if let Some(route) = self
            .mem()
            .routes
            .get_mut(tab_id)
            .and_then(|routes| routes.get_mut(request_id))
        {
            route.escalated = escalated;
        }
    }

    pub(super) async fn return_bot_asks(&self, bot: &str) -> R<()> {
        let mut returned = Vec::new();
        {
            let mut mem = self.mem();
            for (tab, asks) in &mut mem.routes {
                for (id, route) in asks {
                    if route.bot == bot && !route.closed && !route.escalated {
                        route.closed = true;
                        returned.push((tab.clone(), id.clone()));
                    }
                }
            }
        }
        for (tab, id) in returned {
            self.host.escalate_ask(&tab, &id, None).await?;
        }
        Ok(())
    }

    /// A routed form's answer: the bot's answers checked by the asking session's bridge with stock's own form rules.
    pub(super) async fn form_response(
        &self,
        target: &ControlTab,
        ask: &ControlAsk,
        args: &AnswerArgs,
    ) -> R<Value> {
        let html = ask.request.html.as_deref().unwrap_or("");
        let view = self.project_form(&target.tab_id, html, None).await?;
        let questions: Vec<FormQuestion> =
            serde_json::from_value(view["questions"].clone()).unwrap_or_default();
        let one = questions.len() == 1;
        let given: Vec<AnswerItem> = match &args.answers {
            Some(answers) => answers.clone(),
            None if one && (args.choice.is_some() || args.text.is_some()) => vec![AnswerItem {
                id: None,
                selected: args.choice.clone().map(|choice| vec![choice]),
                text: args.text.clone(),
            }],
            None => Vec::new(),
        };
        if given.is_empty() {
            return fail(format!(
                "This card is a form: pass `answers` with one entry per field: [{}].",
                questions
                    .iter()
                    .map(|question| format!(
                        "{{\"id\": \"{}\", {}}}",
                        question.id,
                        if question.options.is_empty() {
                            "\"text\": <the field's text>"
                        } else {
                            "\"selected\": [<option>]"
                        }
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        let mut answers = Vec::new();
        for question in &questions {
            let mine = given
                .iter()
                .find(|entry| entry.id.as_deref() == Some(question.id.as_str()))
                .or(if one { given.first() } else { None });
            let labels: Vec<String> = question
                .options
                .iter()
                .map(|option| option.label.clone())
                .collect();
            let mut selected = Vec::new();
            for name in mine
                .and_then(|entry| entry.selected.as_deref())
                .unwrap_or(&[])
            {
                selected.push(pick_option(&labels, name)?);
            }
            if selected.len() > 1 && !question.multi {
                return fail(format!("Field \"{}\" takes one option.", question.id));
            }
            let mut entry = json!({ "id": question.id, "selectedOptions": selected });
            if let Some(text) = mine
                .and_then(|entry| entry.text.as_deref())
                .filter(|text| !text.is_empty())
            {
                entry["customInput"] = json!(text);
            }
            answers.push(entry);
        }
        let reply = self
            .project_form(&target.tab_id, html, Some(answers))
            .await?;
        if let Some(problem) = reply["problem"].as_str() {
            let field = reply["index"]
                .as_u64()
                .and_then(|index| questions.get(index as usize))
                .map_or_else(String::new, |question| format!(" (field {})", question.id));
            return fail(format!(
                "The form took no answer{field}: {problem}. Nothing was answered."
            ));
        }
        if !reply["data"].is_object() {
            return fail("The form returned no answer data. Nothing was answered.");
        }
        Ok(json!({ "type": "extension_ui_response", "id": ask.id, "data": reply["data"] }))
    }

    /// The asking session's bridge projects a form into questions, or checks answers against it (`project_ask_form`).
    async fn project_form(
        &self,
        tab_id: &str,
        html: &str,
        answers: Option<Vec<Value>>,
    ) -> R<Value> {
        let mut command = json!({ "type": "project_ask_form", "html": html });
        if let Some(answers) = answers {
            command["answers"] = Value::Array(answers);
        }
        let response = self
            .host
            .command(tab_id, &command, Deadline::Default)
            .await?;
        response_data(&response, "Reading the form")
    }
}

#[cfg(test)]
#[path = "route_tests.rs"]
mod tests;
