//! A new bot's first run (Orca's `bot-kickoff-retry.ts:20-103`, `bot-new-record.ts:36`, `bots-create.ts:62-70`,
//! `bots-kickoff.ts:44-77`, `bot-controller.ts:311-322`; control-tools.md › Bots, items and rooms): the bot speaks
//! first. Once its home chat exists, OMPdesk sends that chat the kickoff (a mail that starts a turn) unless the owner
//! already wrote there; the chat's `BotContext` says `firstRun`, so its section carries the first-run rules. First run
//! ends when the owner's first turn in the home chat ends, never because `SOUL.md` exists (a bot made with a purpose
//! has one from the start). A kickoff whose turn ended without a word is sent again once when the bot's page opens,
//! and on the owner's Try again.
//!
//! Each kickoff is a mail whose id is its send fingerprint (home chat, text, attempt): the bridge drops an id its
//! journal holds, and the record keeps every id it sent, claimed under the registry's lock before the send, so two
//! passes never both send the same attempt.

use serde_json::{Value, json};

use super::super::AgentControl;
use super::super::fail::R;
use super::super::host::Deadline;
use super::super::types::{ControlTab, TabStatus};
use super::bots::bot_context;
use crate::agentctl::journal::attachments::sha256_hex;
use crate::agentctl::journal::bots::BotRecord;
use crate::agentctl::rules::mail::{Mail, MailKind};

/// The plain kickoff (Orca's `BOT_CREATED_KICKOFF`); a template's or an import's comes with the create.
pub(crate) const KICKOFF: &str = "OMPdesk: you were just created. Start your first-run setup.";
/// What the kickoff mail asks of the bot, in place of a question's "answer the sender" line.
const KICKOFF_ASK: &str = "Answer the owner in this chat, as your first-run rules say.";
/// What a bot chat's omp is given to answer.
const FACTS_MS: u64 = 10_000;
/// How long a retry waits for the home chat's omp to start.
const START_MS: u64 = 60_000;

/// What became of the newest kickoff in the home chat, as its bridge reads the branch.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum KickoffSeen {
    /// The journal does not hold it (not handed over yet, or no kickoff named).
    None,
    /// Held, with no answer after it yet.
    Queued,
    /// Answered, with no word in any answer.
    Silent,
    Spoke,
}

/// The bridge's answer to `agent_control_bot` about the chat's branch.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ChatFacts {
    /// Messages the owner typed there.
    pub owner_turns: u64,
    /// A turn runs now.
    pub streaming: bool,
    pub kickoff: KickoffSeen,
}

impl ChatFacts {
    /// None from a bridge that does not say (an older one).
    pub(crate) fn of(data: Option<&Value>) -> Option<ChatFacts> {
        let data = data?;
        Some(ChatFacts {
            owner_turns: data.get("ownerTurns")?.as_u64()?,
            streaming: data.get("streaming")?.as_bool()?,
            kickoff: match data.get("kickoff").and_then(Value::as_str) {
                Some("queued") => KickoffSeen::Queued,
                Some("silent") => KickoffSeen::Silent,
                Some("spoke") => KickoffSeen::Spoke,
                _ => KickoffSeen::None,
            },
        })
    }
}

/// The kickoff's mail id: its send fingerprint (the home chat, the text and which attempt it is).
pub(crate) fn kickoff_id(home: &str, text: &str, attempt: usize) -> String {
    let print = sha256_hex(format!("{home}\n{text}").as_bytes());
    format!("kickoff-{}-{attempt}", &print[..16])
}

/// Whether `tab` is the home chat of a bot in its first run.
pub(crate) fn first_run_home(bot: &BotRecord, tab: &ControlTab) -> bool {
    bot.first_run && bot.home.is_some() && tab.session_path == bot.home
}

/// The command that hands a bot chat its context, naming the newest kickoff its bridge is asked about.
pub(crate) fn bot_command(bot: &BotRecord, context: Value) -> Value {
    let mut command = json!({ "type": "agent_control_bot", "context": context });
    if let Some(kickoff) = bot.kickoffs.last() {
        command["kickoff"] = json!(kickoff);
    }
    command
}

impl AgentControl {
    /// Whether the bot pass must ask the first-run home chat `tab` again although its context did not change: a turn
    /// ended there since it was last asked (main's `lastRun` serial moved), or its last answer could not tell (a turn
    /// still ran, the kickoff waited for its answer). Never while main says it is at work.
    pub(crate) fn first_run_due(&self, tab: &ControlTab) -> bool {
        let last = tab.last_run.as_ref().and_then(|run| run.id);
        !tab.busy && self.mem().bot_first_asked.get(&tab.tab_id) != Some(&last)
    }

    /// What the first-run home chat `tab` of `bot` said of itself, while no turn runs there: the owner's first turn
    /// has ended (first run ends), the kickoff is owed (sent), or the kickoff's turn ended without a word (Try again).
    pub(crate) async fn first_run_seen(&self, bot: &BotRecord, tab: &ControlTab, facts: ChatFacts) {
        let unsure = facts.streaming || facts.kickoff == KickoffSeen::Queued;
        {
            let mut mem = self.mem();
            if unsure {
                mem.bot_first_asked.remove(&tab.tab_id);
            } else {
                let last = tab.last_run.as_ref().and_then(|run| run.id);
                mem.bot_first_asked.insert(tab.tab_id.clone(), last);
            }
        }
        if facts.streaming {
            return;
        }
        if facts.owner_turns > 0 {
            self.end_first_run(&bot.id);
            return;
        }
        if bot.kickoffs.is_empty() {
            if self.send_kickoff(bot, 0).await {
                self.mem().bot_first_asked.remove(&tab.tab_id);
            }
            return;
        }
        let silent = facts.kickoff == KickoffSeen::Silent;
        if silent != bot.kickoff_silent
            && self
                .bots()
                .change(&bot.id, |record| record.kickoff_silent = silent)
                .is_some()
        {
            self.bots_changed();
        }
    }

    /// The owner's first turn in the home chat ended: the first-run rules stop, and the chat is told on the next pass.
    fn end_first_run(&self, id: &str) {
        let mut ended = false;
        self.bots().change(id, |record| {
            ended = record.first_run;
            record.first_run = false;
            record.kickoff_silent = false;
        });
        if ended {
            self.bots_changed();
            let control = self.clone();
            tokio::spawn(async move { control.bots_tick().await });
        }
    }

    /// Sends the kickoff numbered `sent + 1` to the bot's home chat, once: claimed in the record (only while it still
    /// holds `sent` kickoffs and its first run lasts) before the mail goes. Whether this call sent it.
    async fn send_kickoff(&self, bot: &BotRecord, sent: usize) -> bool {
        let Some(home) = bot.home.clone() else {
            return false;
        };
        let text = bot.kickoff.clone().unwrap_or_else(|| KICKOFF.to_owned());
        let id = kickoff_id(&home, &text, sent + 1);
        let mut claimed = false;
        self.bots().change(&bot.id, |record| {
            if record.first_run && record.kickoffs.len() == sent {
                record.kickoffs.push(id.clone());
                record.kickoff_silent = false;
                claimed = true;
            }
        });
        if !claimed {
            return false;
        }
        self.bots_changed();
        let mut mail = Mail::new(
            &id,
            "ompdesk",
            "OMPdesk",
            "",
            MailKind::Question,
            &text,
            self.now(),
        );
        mail.instruction = Some(KICKOFF_ASK.to_owned());
        self.mail_session(&home, mail, true).await;
        true
    }

    /// The bot's page opened (`asked` false: at most the one retry Orca makes by itself), or the owner pressed Try
    /// again (`asked`): the kickoff is sent again when its turn ended without a word and the owner wrote nothing there.
    /// The home chat is reached (an asleep tab started) to ask its bridge. Whether it was sent.
    pub(crate) async fn kickoff_retry(&self, key: &str, asked: bool) -> R<bool> {
        let bot = self.bot_named(key)?;
        let sent = bot.kickoffs.len();
        if !bot.first_run || sent == 0 || (!asked && sent != 1) {
            return Ok(false);
        }
        let reached = self.bot_tab(&bot.id).await?;
        let Some(tab) = self
            .host
            .wait_for(Some(START_MS), |state| {
                state
                    .tabs
                    .iter()
                    .find(|tab| {
                        tab.tab_id == reached.tab_id
                            && matches!(
                                tab.status,
                                TabStatus::Ready | TabStatus::Running | TabStatus::Waiting
                            )
                    })
                    .cloned()
            })
            .await
        else {
            return Ok(false);
        };
        let state = self.host.state();
        let now = self.now();
        let items = self.items().all(now).to_vec();
        let context = bot_context(&bot, &items, &state.tabs, &tab.tab_id, now);
        let text = context.to_string();
        let answer = self
            .host
            .command(
                &tab.tab_id,
                &bot_command(&bot, context),
                Deadline::Ms(FACTS_MS),
            )
            .await?;
        if !answer.success {
            return Ok(false);
        }
        self.mem().bot_sent.insert(tab.tab_id.clone(), text);
        let Some(facts) = ChatFacts::of(answer.data.as_ref()) else {
            return Ok(false);
        };
        if facts.streaming || facts.owner_turns > 0 || facts.kickoff != KickoffSeen::Silent {
            return Ok(false);
        }
        Ok(self.send_kickoff(&bot, sent).await)
    }
}
