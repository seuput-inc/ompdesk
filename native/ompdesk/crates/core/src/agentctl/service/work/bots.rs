//! Bots (`ompdesk_bot`, the owner's `BotsRequest`; the owner's decision of 25 Nov 2026, Orca's local-first bot model,
//! control-tools.md › Bots, items and rooms): the registry, pause and resume, delete, a bot's Look around routine,
//! handing a session to a bot, a bot by name (`bot:<name>`) and the context each bot chat's omp is handed.
//!
//! Tells to main: `botsChanged {state}` after every change. A paused bot's chats are in `Host::held`: a report to one
//! is kept in the mail outbox and handed over by the pass its resume runs.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::super::AgentControl;
use super::super::fail::{R, fail};
use super::super::host::{Deadline, Host};
use super::super::resolve::OpenOptions;
use super::super::text::saved_id_of_path;
use super::super::types::{
    BotArgs, ControlTab, ScheduleDraft, ScheduleFrequency, SendArgs, TabStatus,
};
use super::bot_files;
use super::bot_package;
use super::schedule::is_absolute;
use crate::agentctl::journal::attachments::sha256_hex;
use crate::agentctl::journal::bots::{BotRecord, BotWorker, STALE_DAYS, slug, specialty};
use crate::agentctl::journal::items::ItemRecord;
use crate::agentctl::journal::looks::{EVERY_CHOICES, FOCUS_MAX, LookSetting, PER_LOOK, TITLE_MAX};
use crate::agentctl::journal::mail_outbox::{
    MailAnswer, OutboxMail, RedeliverDeps, redeliver_mail,
};
use crate::agentctl::journal::write_text;
use crate::agentctl::rules::mail::{Mail, MailKind, delivery_for, mail_details, mail_text};

/// The longest bot name.
const NAME_MAX: usize = 80;
/// What a bot chat's omp is given to take its context.
const CONTEXT_MS: u64 = 10_000;
/// What a look is told to look for when its owner named nothing (Orca's `bot-look-around-prompt.ts` `DEFAULT_FOCUS`).
const LOOK_DEFAULT_FOCUS: &str = "Anything waiting on your owner: reviews asked of them, failing checks on their work, questions put to them, follow-ups they promised.";
/// The approval modes a bot's chats may start in (`APPROVAL_MODES` of `src/shared/tool-approval.ts`).
const APPROVAL_MODES: [&str; 4] = ["yolo", "write", "always-ask-cached", "always-ask"];
/// Projects whose skills a bot's chats load, at most.
const SKILL_PROJECTS_MAX: usize = 20;
/// What the memory upkeep routine asks of the bot (Orca's bot tidy-up, `BotTidyUpSection.tsx`): a copy of MEMORY.md
/// first, so the owner's Undo puts it back whole, and one line per change beside it for the review.
const TIDY_PROMPT: &str = "Tidy your memory: MEMORY.md in your folder. First copy MEMORY.md as it is now to memory/history/<the local date and time as YYYY-MM-DD-HHMM>.md (make the folder). Then merge repeated lines, mark facts that changed as replaced (keep the newer one), file details into topic files memory/<topic>.md, and move lines that no longer matter to memory/archive.md. Change memory files only: no posts, no edits to projects, no sessions opened. Last, write one line per change to memory/history/<the same name>.changes.md, starting with Learned:, Merged:, Replaced:, Filed: or Archived:. Write nothing and copy nothing when there is nothing to tidy. End with NO_REPLY.";
/// Notification kinds a bot's chats can be quiet about (`Bot.quiet`).
const QUIET_KINDS: [&str; 3] = ["permission", "done", "failed"];

/// A bot's own routine (`bot_routine`).
#[derive(Clone, Copy)]
enum Routine {
    LookAround,
    Tidy,
}

/// What a look asks of the bot (Orca's `bot-look-around-prompt.ts` `lookAroundPrompt`): it reads, and ends in one
/// `ompdesk_bot suggest` that replaces the Suggestions list.
fn look_prompt(focus: &str) -> String {
    let focus = if focus.trim().is_empty() {
        LOOK_DEFAULT_FOCUS
    } else {
        focus.trim()
    };
    format!(
        "Look around: find what is waiting on your owner and suggest up to {PER_LOOK} next steps for their Suggestions list.\n\n\
This look only reads: read files, run read-only commands (gh pr view|list|checks|diff, gh issue view|list, git log|show|diff|status), ompdesk_sessions, ompdesk_item list. Change nothing: no edits, no commits, no sessions opened, no item or MEMORY.md changes.\n\n\
Look for: {focus}\n\n\
Also look at open sessions (ompdesk_sessions) whose work fits your purpose and the focus above and that no bot has taken over. Suggest taking one over only when you can name a concrete next step and what your owner could stop keeping track of; its ask names the session to hand you.\n\n\
First run ompdesk_bot {{\"action\":\"suggestions\"}}: it lists what is still suggested, what your owner started lately (they act on that kind) and what they dismissed (never suggest those again, in any wording).\n\n\
Then call ompdesk_bot {{\"action\":\"suggest\",\"suggestions\":[{{\"title\":\"…\",\"why\":\"…\",\"ask\":\"…\",\"link\":\"…\"}}]}} once with every next step worth it: title says what to do, under {TITLE_MAX} characters; why is one sentence on why now; ask is the message your owner would send you to do it, written as them; link is the thread, issue or pull request it is about, if any. It replaces the list: name a still-true one again with the same title, and pass an empty list when nothing is worth it. Suggest only things with a concrete next step.\n\n\
End with NO_REPLY; one short line for your owner may come before it."
    )
}

/// A new id: `<prefix>-` and 12 hex digits from the system's random generator.
pub(crate) fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 6];
    let _ = crate::sys::random(&mut bytes);
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{prefix}-{hex}")
}

/// `HH:MM`, 00:00 to 23:59.
fn is_time(text: &str) -> bool {
    let Some((hours, minutes)) = text.split_once(':') else {
        return false;
    };
    hours.len() == 2
        && minutes.len() == 2
        && hours.parse::<u8>().is_ok_and(|h| h < 24)
        && minutes.parse::<u8>().is_ok_and(|m| m < 60)
}

/// The outbox pass over the receivers' live tabs on this computer and its paired devices; a paused bot's chat is held.
struct OutboxTabs<'a> {
    host: &'a Host,
}

impl RedeliverDeps for OutboxTabs<'_> {
    fn tab_of(&self, session_path: &str, device: Option<&str>) -> Option<String> {
        let state = self.host.state();
        state
            .tabs
            .iter()
            .find(|tab| {
                tab.session_path.as_deref() == Some(session_path) && tab.device.as_deref() == device
            })
            .map(|tab| tab.tab_id.clone())
    }

    fn held(&self, session_path: &str, device: Option<&str>) -> bool {
        self.host.holds(session_path, device)
    }

    async fn send(&self, tab_id: &str, mail: &OutboxMail) -> Option<MailAnswer> {
        self.host.redeliver_mail(tab_id, mail).await
    }
}

impl AgentControl {
    // ---- the registry ------------------------------------------------------------------------------------------------

    /// Keeps `Host::held` in step with the paused bots.
    pub(crate) fn hold_paused(&self) {
        let paused: HashSet<String> = self.bots().paused_sessions().into_iter().collect();
        *self
            .host
            .held
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = paused;
    }

    /// Something of the bots or their items changed: held mail follows the pauses, and main hears the new state.
    pub(crate) fn bots_changed(&self) {
        self.hold_paused();
        let state = self.bots_state();
        self.host
            .port()
            .tell("botsChanged", &json!({ "state": state }));
    }

    /// `BotsState`: every bot with its specialty, and the items with what is read at this moment.
    pub fn bots_state(&self) -> Value {
        let now = self.now();
        let bots: Vec<BotRecord> = self.bots().all().to_vec();
        let items: Vec<ItemRecord> = self.items().all(now).to_vec();
        let state = self.host.state();
        let looks: Vec<Value> = {
            let looks = self.looks();
            bots.iter()
                .filter(|bot| bot.look().on)
                .filter_map(|bot| looks.get(&bot.id).map(|look| (bot, look)))
                .map(|(bot, look)| {
                    json!({
                        "bot": bot.id,
                        "items": look.open(now),
                        "seenAt": look.seen_at,
                        "lastLookedAt": look.last_looked_at,
                    })
                })
                .collect()
        };
        let bots_json: Vec<Value> = bots
            .iter()
            .map(|bot| {
                let mut value = serde_json::to_value(bot).unwrap_or(Value::Null);
                value["lookSetting"] = serde_json::to_value(bot.look()).unwrap_or(Value::Null);
                if let Some(said) = specialty(Path::new(&bot.folder)) {
                    value["specialty"] = json!(said);
                }
                if let Some(picture) = bot_files::picture_of(Path::new(&bot.folder)) {
                    value["picture"] = json!(picture);
                }
                value["workers"] = json!(
                    bot.workers
                        .iter()
                        .map(|worker| worker_json(worker, &state.tabs))
                        .collect::<Vec<Value>>()
                );
                value["launch"] = json!(self.bot_launch(bot));
                value
            })
            .collect();
        let items_json: Vec<Value> = items
            .iter()
            .map(|item| {
                let bot = bots.iter().find(|bot| bot.id == item.bot);
                serde_json::to_value(self.read_item(&state, bot, item, now)).unwrap_or(Value::Null)
            })
            .collect();
        let rooms_json = serde_json::to_value(self.rooms().all()).unwrap_or_else(|_| json!([]));
        json!({ "bots": bots_json, "items": items_json, "rooms": rooms_json, "looks": looks })
    }

    /// The flags each chat of `bot` starts with (main adds them to every spawn in its folder): the approval mode its
    /// owner picked (`--approval-mode`, stock's runtime override), and a settings overlay naming its skill projects'
    /// skill folders (`--config`, `skills.customDirectories`). Shortcut: the overlay stands in for a global
    /// `skills.customDirectories` in the bot's chats; merge the two when someone needs both.
    fn bot_launch(&self, bot: &BotRecord) -> Vec<String> {
        let mut flags: Vec<String> = Vec::new();
        if let Some(mode) = &bot.chat_approval {
            flags.extend(["--approval-mode".to_owned(), mode.clone()]);
        }
        if !bot.skill_projects.is_empty()
            && let Some(dir) = &self.bot_config_dir
        {
            let file = dir.join(format!("{}.yml", bot.id));
            let folders: Vec<String> = bot
                .skill_projects
                .iter()
                .flat_map(|project| {
                    [".omp", ".claude", ".agents"].map(|kind| {
                        Path::new(project)
                            .join(kind)
                            .join("skills")
                            .to_string_lossy()
                            .into_owned()
                    })
                })
                .collect();
            let text = json!({ "skills": { "customDirectories": folders } }).to_string();
            if std::fs::read_to_string(&file).ok().as_deref() != Some(text.as_str()) {
                let written = std::fs::create_dir_all(dir)
                    .map_err(|error| error.to_string())
                    .and_then(|()| write_text(&file, &text, Some(0o600)));
                if let Err(error) = written {
                    eprintln!("[bots] {}: skill projects not saved: {error}", bot.name);
                    return flags;
                }
            }
            flags.extend(["--config".to_owned(), file.to_string_lossy().into_owned()]);
        }
        flags
    }

    /// The bot `key` names (its name or id).
    pub(crate) fn bot_named(&self, key: &str) -> R<BotRecord> {
        match self.bots().find(key) {
            Some(bot) => Ok(bot.clone()),
            None => fail(format!(
                "No bot \"{key}\". ompdesk_bot {{\"action\":\"list\"}} lists them."
            )),
        }
    }

    /// The bot whose chat runs in `cwd`.
    pub(crate) fn bot_of_folder(&self, cwd: &str) -> Option<BotRecord> {
        self.bots().of_folder(cwd).cloned()
    }

    /// The paused bot `tab` is a chat of, refused by name: a send, a wake or a hand-over to it starts nothing.
    pub(crate) fn refuse_paused(&self, tab: &ControlTab) -> R<()> {
        if tab.device.is_some() {
            return Ok(());
        }
        let Some(path) = tab.session_path.as_deref() else {
            return Ok(());
        };
        match self.paused_bot_of(path) {
            Some(name) => fail(format!("The bot {name} is paused")),
            None => Ok(()),
        }
    }

    /// The name of the paused bot `session_path` is a chat of.
    pub fn paused_bot_of(&self, session_path: &str) -> Option<String> {
        self.bots()
            .of_session(session_path)
            .filter(|bot| bot.paused)
            .map(|bot| bot.name.clone())
    }

    /// Makes a bot: its folder (`~/.omp/bots/<slug>`, made unique, unless one is named) exists afterwards. Nothing is
    /// sent anywhere: the owner writes first.
    pub(crate) fn create_bot(&self, name: &str, folder: Option<&str>) -> R<BotRecord> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > NAME_MAX {
            return fail(format!("A bot's name is 1 to {NAME_MAX} characters."));
        }
        if self.bots().find(name).is_some() {
            return fail(format!("There is already a bot named \"{name}\"."));
        }
        let folder: PathBuf = match folder.map(str::trim).filter(|folder| !folder.is_empty()) {
            Some(folder) => {
                if !Path::new(folder).is_absolute() {
                    return fail("folder must be an absolute path.");
                }
                PathBuf::from(folder)
            }
            None => {
                let Some(root) = self.bots_root.clone() else {
                    return fail("Name the bot's folder: this app has no bots folder.");
                };
                let base = slug(name);
                let taken = |path: &Path| {
                    path.exists() || self.bots().of_folder(&path.to_string_lossy()).is_some()
                };
                let mut n = 1;
                loop {
                    let candidate = root.join(if n == 1 {
                        base.clone()
                    } else {
                        format!("{base}-{n}")
                    });
                    if !taken(&candidate) {
                        break candidate;
                    }
                    n += 1;
                }
            }
        };
        let folder_text = folder.to_string_lossy().into_owned();
        if let Some(other) = self.bots().of_folder(&folder_text) {
            return fail(format!(
                "{folder_text} is already the folder of the bot {}.",
                other.name
            ));
        }
        if let Err(error) = std::fs::create_dir_all(&folder) {
            return fail(format!("Could not make the folder {folder_text}: {error}"));
        }
        let bot = BotRecord {
            id: new_id("bot"),
            name: name.to_owned(),
            folder: folder_text,
            stale_days: Some(STALE_DAYS),
            // A new bot looks around (Orca's `LOOK_AROUND_DEFAULTS`); its schedule is saved once it has a home chat.
            look_setting: Some(LookSetting::default()),
            created_at: crate::aimemory::value::iso(self.now().max(0.0) as u64),
            ..BotRecord::default()
        };
        self.bots().add(bot.clone());
        self.bots_changed();
        Ok(bot)
    }

    /// Pauses or resumes a bot (durable). A resume hands its held mail over at once, each report once.
    pub(crate) async fn set_paused(&self, id: &str, paused: bool) -> R<BotRecord> {
        let Some(bot) = self.bots().change(id, |bot| bot.paused = paused) else {
            return fail("That bot is gone.");
        };
        self.bots_changed();
        if !paused {
            self.redeliver_mail_now().await;
        }
        Ok(bot)
    }

    /// One pass over the mail outbox (the timer's and a resumed bot's): passes never overlap; one asked while another
    /// runs makes that one run once more, so a report kept meanwhile is not missed. Each report has its id, and the
    /// receiver's bridge drops an id it already holds, so a report handed again is never delivered twice.
    pub async fn redeliver_mail_now(&self) {
        let Some(outbox) = self.host.outbox().cloned() else {
            return;
        };
        {
            let mut mem = self.mem();
            if mem.redelivering {
                mem.redeliver_again = true;
                return;
            }
            mem.redelivering = true;
        }
        loop {
            redeliver_mail(&outbox, &OutboxTabs { host: &self.host }).await;
            let mut mem = self.mem();
            if !mem.redeliver_again {
                mem.redelivering = false;
                break;
            }
            mem.redeliver_again = false;
        }
    }

    /// Deletes a bot (the owner's only): its record and items go, its folder and session files stay. Its held mail
    /// is dropped with one quiet note to each session that sent some, and its Look around and every schedule that
    /// wakes one of its chats are deleted.
    pub(crate) async fn delete_bot(&self, id: &str) -> R<()> {
        let Some(bot) = self.bots().remove(id) else {
            return fail("That bot is gone.");
        };
        self.items().remove_bot(&bot.id);
        self.rooms().remove_bot(&bot.id);
        self.looks().remove_bot(&bot.id);
        if let Some(dir) = &self.bot_config_dir {
            let _ = std::fs::remove_file(dir.join(format!("{}.yml", bot.id)));
        }
        let chats: Vec<String> = bot
            .home
            .iter()
            .chain(bot.sessions.iter())
            .cloned()
            .collect();
        if let Some(outbox) = self.host.outbox().cloned() {
            let mut senders: Vec<String> = Vec::new();
            for chat in &chats {
                for mail in outbox.kept_for(chat) {
                    outbox.settle(&mail.id);
                    // A sender is a session file on this computer (a paired device's or a tab-only one is not told).
                    if let Some(from) = mail
                        .from
                        .filter(|from| mail.from_device.is_none() && is_absolute(from))
                        && !chats.contains(&from)
                        && !senders.contains(&from)
                    {
                        senders.push(from);
                    }
                }
            }
            for sender in senders {
                let text = format!(
                    "The bot {} was deleted; what you sent it was not delivered.",
                    bot.name
                );
                self.note_session(&sender, &text).await;
            }
        }
        if let Some(source) = self.schedule_source(None) {
            for schedule in source.schedules().await? {
                let wakes_it = schedule
                    .draft
                    .wake_session
                    .as_ref()
                    .is_some_and(|session| chats.contains(session));
                let own = [bot.look_around.as_deref(), bot.tidy.as_deref()]
                    .contains(&Some(schedule.id.as_str()));
                if wakes_it || own {
                    source.remove(&schedule.id).await?;
                }
            }
        }
        self.bots_changed();
        Ok(())
    }

    /// One quiet note (no turn) into the session file `session_path` on this computer: handed to the tab that holds it
    /// now, else kept in the mail outbox until a tab opens it. Its id comes from the session and the text, so the same
    /// note asked twice is one note.
    pub async fn note_session(&self, session_path: &str, text: &str) {
        let id = format!(
            "note-{}",
            &sha256_hex(format!("{session_path}\n{text}").as_bytes())[..24]
        );
        let mail = Mail::new(
            &id,
            "ompdesk",
            "OMPdesk",
            "",
            MailKind::Note,
            text,
            self.now(),
        );
        self.mail_session(session_path, mail, false).await;
    }

    /// Hands `mail` to the chat `session_path` on this computer. `wake`: like a routine's wake-up, the session is
    /// reached first (an asleep tab started, one no tab holds opened in the background) and the mail starts a turn;
    /// otherwise it goes to the tab that holds the session, or is kept until one does.
    pub(crate) async fn mail_session(&self, session_path: &str, mut mail: Mail, wake: bool) {
        let delivery = delivery_for(mail.kind);
        let holder = |state: &super::super::host::HostState| {
            state
                .tabs
                .iter()
                .find(|tab| {
                    tab.session_path.as_deref() == Some(session_path) && tab.device.is_none()
                })
                .map(|tab| tab.tab_id.clone())
        };
        let tab = if wake {
            match self.host.reach(session_path).await {
                Ok(tab) => tab,
                Err(error) => {
                    eprintln!("[bots] could not reach {session_path}: {}", error.message());
                    None
                }
            }
        } else {
            holder(&self.host.state())
        };
        if let Some(tab) = tab {
            mail.to = tab.clone();
            if let Err(error) = self
                .host
                .mail(&tab, &mail_text(&mail), &mail_details(&mail), delivery)
                .await
            {
                eprintln!(
                    "[bots] mail {} not handed over: {}",
                    mail.id,
                    error.message()
                );
            }
            return;
        }
        // No tab holds it yet: kept, and the outbox pass hands it to the tab that opens it.
        if let Some(outbox) = self.host.outbox() {
            outbox.keep(OutboxMail {
                id: mail.id.clone(),
                session_path: session_path.to_owned(),
                device: None,
                from: None,
                from_device: None,
                content: mail_text(&mail),
                details: mail_details(&mail),
                delivery,
                attachments: None,
                attachments_corrupt: false,
                at: mail.at,
            });
        }
    }

    // ---- what a bot chat's omp is told ------------------------------------------------------------------------------------

    /// One bot pass: chats seen with their files join their bot, and every bot chat's omp is handed its context when it
    /// changed. Passes never overlap; one asked meanwhile runs once more after.
    pub async fn bots_tick(&self) {
        {
            let mut mem = self.mem();
            if mem.bot_ticking {
                mem.bot_tick_again = true;
                return;
            }
            mem.bot_ticking = true;
        }
        loop {
            self.observe_bots();
            self.arm_looks().await;
            self.feed_bots().await;
            let mut mem = self.mem();
            if !mem.bot_tick_again {
                mem.bot_ticking = false;
                break;
            }
            mem.bot_tick_again = false;
        }
    }

    /// A tab on this computer whose folder is a bot's, seen with its session file, is that bot's chat (the first one its
    /// home); a tab a bot's chat opened (or was handed: its opener is the bot's home chat) is that bot's worker; an
    /// item's session link that names a tab names its session file once the tab has one.
    pub(crate) fn observe_bots(&self) {
        let state = self.host.state();
        let since = crate::aimemory::value::iso(self.now().max(0.0) as u64);
        let mut changed = false;
        {
            let mut bots = self.bots();
            for tab in state.tabs.iter().filter(|tab| tab.device.is_none()) {
                if let Some(path) = tab.session_path.as_deref().filter(|path| !path.is_empty()) {
                    changed |= bots.observe(&tab.cwd, path);
                }
                let opener = state
                    .parent_of(&tab.tab_id)
                    .and_then(|opener| state.tabs.iter().find(|entry| entry.tab_id == opener));
                if let Some(opener) = opener.filter(|opener| opener.device.is_none()) {
                    let seen = BotWorker {
                        session: tab
                            .session_path
                            .clone()
                            .filter(|path| !path.is_empty())
                            .unwrap_or_else(|| tab.tab_id.clone()),
                        title: tab.name().to_owned(),
                        cwd: tab.cwd.clone(),
                        branch: tab
                            .worktree
                            .as_ref()
                            .map(|worktree| worktree.branch.clone()),
                        since: since.clone(),
                    };
                    changed |= bots.observe_worker(&opener.cwd, &tab.tab_id, seen);
                }
            }
        }
        changed |= self.settle_item_links(&state);
        if changed {
            self.bots_changed();
        }
    }

    /// The context each bot chat's omp is handed (`BotContext`), sent only when it differs from the last one that
    /// omp took; a tab whose omp is not up forgets what it was sent, so its next omp is told again.
    async fn feed_bots(&self) {
        let state = self.host.state();
        let now = self.now();
        let bots: Vec<BotRecord> = self.bots().all().to_vec();
        let items: Vec<ItemRecord> = self.items().all(now).to_vec();
        let live: HashSet<String> = state.tabs.iter().map(|tab| tab.tab_id.clone()).collect();
        self.mem().bot_sent.retain(|tab, _| live.contains(tab));
        for tab in state.tabs.iter().filter(|tab| tab.device.is_none()) {
            let Some(bot) = bots.iter().find(|bot| bot.folder == tab.cwd) else {
                continue;
            };
            if !matches!(
                tab.status,
                TabStatus::Ready | TabStatus::Running | TabStatus::Waiting
            ) {
                self.mem().bot_sent.remove(&tab.tab_id);
                continue;
            }
            let context = bot_context(bot, &items, &state.tabs, &tab.tab_id, now);
            let text = context.to_string();
            if self.mem().bot_sent.get(&tab.tab_id) == Some(&text) {
                continue;
            }
            let answer = self
                .host
                .command(
                    &tab.tab_id,
                    &json!({ "type": "agent_control_bot", "context": context }),
                    Deadline::Ms(CONTEXT_MS),
                )
                .await;
            let Ok(answer) = answer else { continue };
            if answer.success {
                self.mem().bot_sent.insert(tab.tab_id.clone(), text);
                continue;
            }
            let error = answer.error.clone().unwrap_or_default();
            // An omp or bridge without bots: said once, and never asked again for the same context.
            if answer.code.as_deref() == Some("unsupported_omp")
                || error.contains("Unknown bridge method")
                || error.contains("Unknown command")
            {
                let first = self.mem().bot_unsupported.insert(tab.tab_id.clone());
                if first {
                    eprintln!("[bots] {} cannot take its bot context: {error}", tab.tab_id);
                }
                self.mem().bot_sent.insert(tab.tab_id.clone(), text);
            }
        }
    }

    // ---- the tool and the owner's requests ---------------------------------------------------------------------------

    /// `ompdesk_bot`.
    pub(crate) async fn bot_tool(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        args: BotArgs,
    ) -> R<String> {
        // From a bot's own chat the bot may go unnamed.
        let own = || {
            self.bot_of_folder(&caller.cwd)
                .filter(|_| caller.device.is_none())
        };
        let wanted = || -> R<BotRecord> {
            match args.bot.as_deref().filter(|bot| !bot.trim().is_empty()) {
                Some(key) => self.bot_named(key),
                None => match own() {
                    Some(bot) => Ok(bot),
                    None => fail(format!("{} needs bot (its name or id).", args.action)),
                },
            }
        };
        match args.action.as_str() {
            "create" => {
                let name = args.name.as_deref().unwrap_or("").trim().to_owned();
                if !self.host.state().manage_enabled {
                    let state = self.host.state();
                    let approved = self
                        .host
                        .confirm(
                            &caller.tab_id,
                            &state.text("botTitle", &[]),
                            &state.text(
                                "botMessage",
                                &[
                                    (
                                        "caller",
                                        if caller.title.is_empty() {
                                            "—"
                                        } else {
                                            caller.title.as_str()
                                        },
                                    ),
                                    ("name", &name),
                                ],
                            ),
                        )
                        .await?;
                    if !approved {
                        return Ok(
                            "The user declined the bot. Do not ask again unless they tell you to."
                                .to_owned(),
                        );
                    }
                }
                let bot = self.create_bot(&name, args.folder.as_deref())?;
                Ok(format!(
                    "Made the bot {} in {} (id {}). It has no chat yet: a session opened in that folder is its home chat, and the owner writes first.",
                    bot.name, bot.folder, bot.id
                ))
            }
            // A bot the owner may make (Orca's `bot create --offer`): the chat draws it as a card with Create bot,
            // and nothing is made until the owner presses it.
            "offer" => {
                let name = args.name.as_deref().unwrap_or("").trim();
                if name.is_empty() {
                    return fail("offer needs name.");
                }
                if self.bot_named(name).is_ok() {
                    return fail(format!("A bot named {name} already exists."));
                }
                Ok(format!(
                    "Offered the bot {name}: the owner sees a card with Create bot in this chat. Nothing is made until they press it; do not create it yourself."
                ))
            }
            "list" => Ok(self.bots_text()),
            "pause" | "resume" => {
                let bot = wanted()?;
                let paused = args.action == "pause";
                self.set_paused(&bot.id, paused).await?;
                Ok(if paused {
                    format!(
                        "Paused the bot {}: messages to it are refused and its mail is held until it is resumed.",
                        bot.name
                    )
                } else {
                    format!(
                        "Resumed the bot {}: its held mail is handed over.",
                        bot.name
                    )
                })
            }
            "set" => {
                let bot = wanted()?;
                let reach = match &args.reach {
                    None => None,
                    Some(names) => Some(self.device_ids(names)?),
                };
                let changed = self.change_bot(&bot.id, |record| {
                    if let Some(model) = &args.model {
                        record.model =
                            Some(model.trim().to_owned()).filter(|model| !model.is_empty());
                    }
                    if let Some(auto) = args.auto_approve {
                        record.auto_approve = auto;
                    }
                    if let Some(days) = args.stale_days {
                        record.stale_days = (days > 0.0).then_some(days);
                    }
                    if let Some(reach) = reach {
                        record.reach = reach;
                    }
                })?;
                Ok(format!(
                    "The bot {}: model {}, auto-approve {}, stale after {}, reach {}.",
                    changed.name,
                    changed.model.as_deref().unwrap_or("omp's default"),
                    if changed.auto_approve { "on" } else { "off" },
                    changed
                        .stale_days
                        .map_or_else(|| "never".to_owned(), |days| format!("{days} day(s)")),
                    if changed.reach.is_empty() {
                        "this computer only".to_owned()
                    } else {
                        changed.reach.join(", ")
                    }
                ))
            }
            "look_around" => {
                let bot = wanted()?;
                let patch = LookPatch {
                    on: args.on,
                    every: args.every.clone(),
                    weekdays_only: args.weekdays_only,
                    focus: args.focus.clone(),
                };
                if patch.on.is_none()
                    && patch.every.is_none()
                    && patch.weekdays_only.is_none()
                    && patch.focus.is_none()
                {
                    return fail("look_around needs on, every, weekdays_only or focus.");
                }
                self.look_around(&bot.id, &patch).await
            }
            "suggest" => {
                let Some(bot) = own() else {
                    return fail("Only a bot's own chat can suggest next steps.");
                };
                let Some(suggestions) = &args.suggestions else {
                    return fail(
                        "suggest needs suggestions: a list, empty when nothing is worth it.",
                    );
                };
                let now = self.now();
                let listed = self.looks().change(&bot.id, |look| {
                    look.look(suggestions, now, || new_id("sug"))
                });
                let listed = match listed {
                    Ok(listed) => listed,
                    Err(why) => return fail(why),
                };
                self.bots_changed();
                Ok(if listed == 0 {
                    "Nothing listed: your owner's Suggestions list is empty now.".to_owned()
                } else {
                    format!("Listed {listed} suggestion(s) for your owner. End with NO_REPLY.")
                })
            }
            "suggestions" => {
                let bot = wanted()?;
                let now = self.now();
                let history = self
                    .looks()
                    .get(&bot.id)
                    .map(|look| look.history(now))
                    .unwrap_or_default();
                let block = |heading: &str, titles: &[String]| {
                    if titles.is_empty() {
                        format!("{heading} none")
                    } else {
                        format!(
                            "{heading}\n{}",
                            titles
                                .iter()
                                .map(|title| format!("- {title}"))
                                .collect::<Vec<String>>()
                                .join("\n")
                        )
                    }
                };
                let look = bot.look();
                Ok([
                    format!(
                        "Look around of the bot {}: {}{}.",
                        bot.name,
                        if look.on {
                            look_when(&look)
                        } else {
                            "off".to_owned()
                        },
                        if look.focus.is_empty() {
                            String::new()
                        } else {
                            format!("; looks for: {}", look.focus)
                        }
                    ),
                    block(
                        "Still listed (suggest again with the same title only if still true):",
                        &history.open,
                    ),
                    block(
                        "Your owner started these lately, so they act on this kind:",
                        &history.started,
                    ),
                    block(
                        "They dismissed these: never suggest them again, in any wording:",
                        &history.dismissed,
                    ),
                ]
                .join("\n\n"))
            }
            "hand" => {
                let bot = wanted()?;
                let (Some(session), Some(text)) = (args.session.as_deref(), args.text.as_deref())
                else {
                    return fail("hand needs session and text.");
                };
                let target = self
                    .open(
                        tabs,
                        session,
                        caller,
                        "hand to a bot",
                        OpenOptions::default(),
                    )
                    .await?;
                self.hand_to(&bot, &target, text).await
            }
            other => fail(format!("ompdesk_bot has no action {other}.")),
        }
    }

    /// Changes a bot and tells main.
    fn change_bot(&self, id: &str, change: impl FnOnce(&mut BotRecord)) -> R<BotRecord> {
        let Some(bot) = self.bots().change(id, change) else {
            return fail("That bot is gone.");
        };
        self.bots_changed();
        Ok(bot)
    }

    /// Paired devices by name or id, as their ids.
    fn device_ids(&self, names: &[String]) -> R<Vec<String>> {
        let mut ids = Vec::new();
        for name in names {
            if let Some(device) = self.device(name)?
                && !ids.contains(&device.id)
            {
                ids.push(device.id);
            }
        }
        Ok(ids)
    }

    /// What `ompdesk_bot list` says.
    fn bots_text(&self) -> String {
        let now = self.now();
        let bots: Vec<BotRecord> = self.bots().all().to_vec();
        if bots.is_empty() {
            return "No bots yet. ompdesk_bot {\"action\":\"create\",\"name\":…} makes one."
                .to_owned();
        }
        let items: Vec<ItemRecord> = self.items().all(now).to_vec();
        let mut lines = vec!["Bots:".to_owned()];
        for bot in &bots {
            let open = items
                .iter()
                .filter(|item| item.bot == bot.id && item.is_open())
                .count();
            let needs = items
                .iter()
                .filter(|item| {
                    item.bot == bot.id && item.status == "needs_you" && !item.snoozed(now)
                })
                .count();
            lines.push(format!(
                "- {} (id {}) in {}; home chat {}{}; {open} open item(s), {needs} waiting on the owner{}",
                bot.name,
                bot.id,
                bot.folder,
                bot.home.as_deref().unwrap_or("none yet"),
                if bot.paused { "; paused" } else { "" },
                specialty(Path::new(&bot.folder))
                    .map_or_else(String::new, |said| format!("; {said}"))
            ));
        }
        lines.join("\n")
    }

    /// A change to a bot's Look around (Orca's `patchLookAround`: only the fields named change), saved on the record,
    /// then its schedule (the `every` preset's hours, weekdays or every day, into its home chat) saved again, or
    /// removed when off. While the bot has no home chat the setting waits and `arm_looks` saves the schedule once it has.
    pub(crate) async fn look_around(&self, id: &str, patch: &LookPatch) -> R<String> {
        let Some(bot) = self.bots().find(id).cloned() else {
            return fail("That bot is gone.");
        };
        let mut look = bot.look();
        if let Some(on) = patch.on {
            look.on = on;
        }
        if let Some(every) = &patch.every {
            if !EVERY_CHOICES.contains(&every.as_str()) {
                return fail(format!("every is one of {}.", EVERY_CHOICES.join(", ")));
            }
            look.every = every.clone();
        }
        if let Some(weekdays_only) = patch.weekdays_only {
            look.weekdays_only = weekdays_only;
        }
        if let Some(focus) = &patch.focus {
            if focus.trim().chars().count() > FOCUS_MAX {
                return fail(format!("focus is {FOCUS_MAX} characters at most."));
            }
            look.focus = focus.trim().to_owned();
        }
        let look = look.normalized();
        let bot = self.change_bot(&bot.id, |record| record.look_setting = Some(look.clone()))?;
        self.mem().look_unarmed.remove(&bot.id);
        if !look.on {
            if bot.look_around.is_some() {
                self.bot_routine(&bot, Routine::LookAround, None).await?;
            }
            return Ok(format!(
                "Turned off the Look around of the bot {}.",
                bot.name
            ));
        }
        let when = look_when(&look);
        if bot.home.is_none() {
            return Ok(format!(
                "The bot {} will look around {when} once it has a home chat; what it finds goes to its Suggestions list.",
                bot.name
            ));
        }
        let schedule = self.save_look(&bot).await?;
        Ok(format!(
            "The bot {} looks around {when} (schedule {schedule}); what it finds goes to its Suggestions list.",
            bot.name
        ))
    }

    /// Saves the bot's Look around schedule as its setting says; the schedule's id.
    async fn save_look(&self, bot: &BotRecord) -> R<String> {
        let look = bot.look();
        let frequency = ScheduleFrequency::Cron { expr: look.cron() };
        let schedule = self
            .bot_routine(
                bot,
                Routine::LookAround,
                Some((frequency, look_prompt(&look.focus))),
            )
            .await?;
        Ok(schedule.unwrap_or_default())
    }

    /// A bot whose Look around is on and that has a home chat but no schedule yet (a new bot's first chat) gets it;
    /// one that could not be saved is not tried again this launch until its setting changes.
    pub(crate) async fn arm_looks(&self) {
        let waiting: Vec<BotRecord> = self
            .bots()
            .all()
            .iter()
            .filter(|bot| bot.look().on && bot.look_around.is_none() && bot.home.is_some())
            .cloned()
            .collect();
        for bot in waiting {
            if self.mem().look_unarmed.contains(&bot.id) {
                continue;
            }
            if let Err(error) = self.save_look(&bot).await {
                eprintln!("[bots] {}: Look around not saved: {error:?}", bot.name);
                self.mem().look_unarmed.insert(bot.id.clone());
            }
        }
    }

    /// Turns a bot's memory upkeep routine on (daily at `time`, default 03:00, into its home chat) or off.
    pub(crate) async fn tidy_memory(&self, id: &str, on: bool, time: Option<&str>) -> R<String> {
        let Some(bot) = self.bots().find(id).cloned() else {
            return fail("That bot is gone.");
        };
        if !on {
            self.bot_routine(&bot, Routine::Tidy, None).await?;
            return Ok(format!(
                "Turned off the Memory upkeep of the bot {}.",
                bot.name
            ));
        }
        let time = time.unwrap_or("03:00");
        if !is_time(time) {
            return fail("time is HH:MM, 00:00 to 23:59.");
        }
        let frequency = ScheduleFrequency::Daily {
            time: time.to_owned(),
            days: Vec::new(),
        };
        let schedule = self
            .bot_routine(
                &bot,
                Routine::Tidy,
                Some((frequency, TIDY_PROMPT.to_owned())),
            )
            .await?
            .unwrap_or_default();
        Ok(format!(
            "The bot {} tidies its memory daily at {time} (schedule {schedule}).",
            bot.name
        ))
    }

    /// One of a bot's own routines on (`draft`: when and what to ask) or off (None): one schedule that wakes its home
    /// chat, its id on the record; the one it had goes first. The new schedule's id.
    async fn bot_routine(
        &self,
        bot: &BotRecord,
        routine: Routine,
        draft: Option<(ScheduleFrequency, String)>,
    ) -> R<Option<String>> {
        let Some(source) = self.schedule_source(None) else {
            return fail("Scheduled runs are not available on this computer.");
        };
        let (label, held) = match routine {
            Routine::LookAround => ("Look around", bot.look_around.clone()),
            Routine::Tidy => ("Memory upkeep", bot.tidy.clone()),
        };
        let keep = |record: &mut BotRecord, schedule: Option<String>| match routine {
            Routine::LookAround => record.look_around = schedule,
            Routine::Tidy => record.tidy = schedule,
        };
        // One the owner already deleted in Settings is gone anyway.
        if let Some(old) = held.as_deref() {
            let _ = source.remove(old).await;
        }
        let Some((frequency, prompt)) = draft else {
            self.change_bot(&bot.id, |record| keep(record, None))?;
            return Ok(None);
        };
        let Some(home) = bot.home.clone() else {
            self.change_bot(&bot.id, |record| keep(record, None))?;
            return fail(format!(
                "The bot {} has no home chat yet, so nothing can wake it: open a session in {} first.",
                bot.name, bot.folder
            ));
        };
        let row = source
            .save(&ScheduleDraft {
                name: format!("{}: {label}", bot.name),
                prompt,
                cwd: bot.folder.clone(),
                frequency,
                model: bot.model.clone(),
                auto_approve: bot.auto_approve,
                enabled: true,
                wake_session: Some(home),
                precheck: None,
                results_to: None,
                thinking: None,
                worktree: None,
            })
            .await?;
        self.change_bot(&bot.id, |record| keep(record, Some(row.id.clone())))?;
        Ok(Some(row.id))
    }

    /// Hands `target` to `bot`: the bot's home chat becomes its opener, and `text` goes to it as a message from the bot.
    pub(crate) async fn hand_to(
        &self,
        bot: &BotRecord,
        target: &ControlTab,
        text: &str,
    ) -> R<String> {
        let Some(home) = bot.home.as_deref() else {
            return fail(format!(
                "The bot {} has no home chat yet: open a session in {} first.",
                bot.name, bot.folder
            ));
        };
        if bot.paused {
            return fail(format!("The bot {} is paused", bot.name));
        }
        if target.drafting {
            return fail(format!(
                "The user is typing in \"{}\": nothing was handed. Try again once they sent or cleared it.",
                target.name()
            ));
        }
        if target.session_path.as_deref() == Some(home) {
            return fail("A bot's home chat cannot be handed to it.");
        }
        let holder = |state: &super::super::host::HostState| {
            state
                .tabs
                .iter()
                .find(|tab| tab.session_path.as_deref() == Some(home) && tab.device.is_none())
                .cloned()
        };
        let home_tab = match holder(&self.host.state()) {
            Some(tab) => tab,
            None => {
                self.host.reach(home).await?;
                match self
                    .host
                    .wait_for(Some(self.tuning.close_wait_ms.max(5_000)), holder)
                    .await
                {
                    Some(tab) => tab,
                    None => {
                        return fail(format!(
                            "The home chat of the bot {} did not open.",
                            bot.name
                        ));
                    }
                }
            }
        };
        self.host
            .set_opener(&target.tab_id, &home_tab.tab_id)
            .await?;
        let receipt = self
            .send(
                &home_tab,
                target,
                &SendArgs {
                    session: target.tab_id.clone(),
                    message: text.to_owned(),
                    ..SendArgs::default()
                },
            )
            .await?;
        Ok(format!(
            "Handed \"{}\" to the bot {}. {receipt}",
            target.name(),
            bot.name
        ))
    }

    /// A paired device's `bot:<name>@<this computer>`: the bot's home chat file, refused unless `device` may reach it.
    pub fn bot_home(
        &self,
        name: &str,
        device: Option<&str>,
        device_name: Option<&str>,
    ) -> R<Value> {
        let bot = self.bot_named(name)?;
        if let Some(device) = device
            && !bot.reach.iter().any(|known| known == device)
        {
            return fail(format!(
                "This bot does not take messages from {}",
                device_name.unwrap_or(device)
            ));
        }
        if bot.paused {
            return fail(format!("The bot {} is paused", bot.name));
        }
        match bot.home {
            Some(home) => Ok(json!({ "path": home, "name": bot.name })),
            None => fail(format!("The bot {} has no home chat yet.", bot.name)),
        }
    }

    /// `bot:<name>` on this computer: the tab holding the bot's home chat, reached (an asleep tab started, a closed one
    /// opened in the background) as a message to a closed session would be.
    pub(crate) async fn bot_tab(&self, name: &str) -> R<ControlTab> {
        let bot = self.bot_named(name)?;
        let Some(home) = bot.home.clone() else {
            return fail(format!(
                "The bot {} has no home chat yet: the owner opens one in {} first.",
                bot.name, bot.folder
            ));
        };
        let holder = |state: &super::super::host::HostState| {
            state
                .tabs
                .iter()
                .find(|tab| {
                    tab.session_path.as_deref() == Some(home.as_str()) && tab.device.is_none()
                })
                .cloned()
        };
        if let Some(tab) = holder(&self.host.state())
            && tab.status != TabStatus::Asleep
        {
            return Ok(tab);
        }
        self.host.reach(&home).await?;
        let wait = self.tuning.close_wait_ms.max(5_000);
        match self
            .host
            .wait_for(Some(wait), |state| {
                holder(state).filter(|tab| tab.status != TabStatus::Asleep)
            })
            .await
        {
            Some(tab) => Ok(tab),
            None => fail(format!(
                "The home chat of the bot {} did not open.",
                bot.name
            )),
        }
    }

    /// `bot:<name>` (this computer's bot) or `bot:<name>@<device>` (a paired computer's, which refuses unless this
    /// computer is in that bot's reach): the tab of the bot's home chat, a message to which is the ask.
    pub(crate) async fn bot_target(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        address: &str,
    ) -> R<ControlTab> {
        let (name, device) = match address.rsplit_once('@') {
            Some((name, device)) => (name, Some(device)),
            None => (address, None),
        };
        let device = match device {
            Some(device) => self.device(device)?,
            None => None,
        };
        let Some(device) = device else {
            return self.bot_tab(name).await;
        };
        let device = self.reach(device).await?;
        let path = self.host.bot_home(&device.id, name).await?;
        let Some(saved) = saved_id_of_path(Some(&path)) else {
            return fail(format!(
                "The bot {name} on {} names no saved chat.",
                device.name
            ));
        };
        self.open(tabs, &saved, caller, "send to", OpenOptions::default())
            .await
    }

    /// The owner's `BotsRequest` (Settings, the Bots page): the state after it.
    pub async fn bots_command(&self, request: Value) -> R<Value> {
        let text = |key: &str| request.get(key).and_then(Value::as_str).map(str::to_owned);
        let id = text("id").unwrap_or_default();
        let mut refused: Option<&'static str> = None;
        match request.get("action").and_then(Value::as_str).unwrap_or("") {
            "get" => {}
            "create" => {
                let bot =
                    self.create_bot(&text("name").unwrap_or_default(), text("folder").as_deref())?;
                let skills = request
                    .get("skills")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if let Err(error) = bot_files::seed(
                    Path::new(&bot.folder),
                    &bot.name,
                    text("purpose").as_deref(),
                    text("soul").as_deref(),
                    &skills,
                ) {
                    // A bot whose seed was refused is not made: the owner fixes the purpose and creates again. The
                    // folder this made (still empty: a seed checks everything before it writes) goes with it.
                    self.bots().remove(&bot.id);
                    if text("folder").is_none() {
                        let _ = std::fs::remove_dir(&bot.folder);
                    }
                    self.bots_changed();
                    return Err(error);
                }
                self.bots_changed();
            }
            // One of the bot's own files, read or written (`BotFileRequest`): its answer, not the state.
            "file" => {
                let bot = self.bot_named(&id)?;
                return bot_files::file_request(Path::new(&bot.folder), &request);
            }
            // Other apps' bots on this computer an import can bring over: `{sources}`, not the state.
            "importSources" => {
                let sources = bot_files::home_folder()
                    .map(|home| bot_files::import_sources(&home, &|name| std::env::var(name).ok()))
                    .unwrap_or_default();
                return Ok(json!({ "sources": sources }));
            }
            // The bot as one package file the owner picked (`{file}`, not the state).
            "export" => {
                let bot = self.bot_named(&id)?;
                let file = text("file").unwrap_or_default();
                let package = bot_package::export(&bot)?;
                bot_package::write(&file, &package)?;
                return Ok(json!({ "file": file }));
            }
            // A new bot from a package file: its name made unique, its parts checked before anything is written.
            "importPackage" => {
                let package = bot_package::read(&text("file").unwrap_or_default())?;
                let base = package.name.trim().to_owned();
                let mut name = base.clone();
                let mut n = 2;
                while self.bots().find(&name).is_some() {
                    name = format!("{base} {n}");
                    n += 1;
                }
                let bot = self.create_bot(&name, None)?;
                if let Err(error) = bot_package::seed(Path::new(&bot.folder), &bot.name, &package) {
                    self.bots().remove(&bot.id);
                    let _ = std::fs::remove_dir_all(&bot.folder);
                    self.bots_changed();
                    return Err(error);
                }
                self.change_bot(&bot.id, |record| {
                    if let Some(look) = package.look_around.clone() {
                        record.look_setting = Some(look.normalized());
                    }
                    record.quiet = QUIET_KINDS
                        .iter()
                        .filter(|kind| package.quiet.iter().any(|given| given.as_str() == **kind))
                        .map(|kind| (*kind).to_owned())
                        .collect();
                    record.stale_days = package.stale_days.filter(|days| *days > 0.0);
                })?;
            }
            "update" => {
                let bot = self.bot_named(&id)?;
                if let Some(paused) = request.get("paused").and_then(Value::as_bool)
                    && paused != bot.paused
                {
                    self.set_paused(&bot.id, paused).await?;
                }
                let name = text("name")
                    .map(|name| name.trim().to_owned())
                    .filter(|name| !name.is_empty());
                if let Some(name) = &name
                    && self
                        .bots()
                        .find(name)
                        .is_some_and(|other| other.id != bot.id)
                {
                    return fail(format!("There is already a bot named \"{name}\"."));
                }
                let reach = request.get("reach").and_then(Value::as_array).map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<String>>()
                });
                // The owner's alone: an agent's `ompdesk_bot set` never reaches these.
                let approval = match request.get("chatApproval") {
                    None => None,
                    Some(Value::Null) => Some(None),
                    Some(Value::String(mode)) if APPROVAL_MODES.contains(&mode.as_str()) => {
                        Some(Some(mode.clone()))
                    }
                    Some(_) => {
                        return fail(format!(
                            "chatApproval is one of {}, or null.",
                            APPROVAL_MODES.join(", ")
                        ));
                    }
                };
                let skill_projects = match request.get("skillProjects").and_then(Value::as_array) {
                    None => None,
                    Some(list) => {
                        let mut folders: Vec<String> = Vec::new();
                        for folder in list.iter().filter_map(Value::as_str).map(str::trim) {
                            if !Path::new(folder).is_absolute() {
                                return fail("skillProjects are absolute folders.");
                            }
                            if folder != bot.folder && !folders.iter().any(|known| known == folder)
                            {
                                folders.push(folder.to_owned());
                            }
                        }
                        if folders.len() > SKILL_PROJECTS_MAX {
                            return fail(format!(
                                "A bot takes the skills of {SKILL_PROJECTS_MAX} projects at most."
                            ));
                        }
                        Some(folders)
                    }
                };
                self.change_bot(&bot.id, |record| {
                    if let Some(approval) = approval {
                        record.chat_approval = approval;
                    }
                    if let Some(folders) = skill_projects {
                        record.skill_projects = folders;
                    }
                    if let Some(name) = name {
                        record.name = name;
                    }
                    match request.get("model") {
                        Some(Value::Null) => record.model = None,
                        Some(Value::String(model)) => {
                            record.model = Some(model.trim().to_owned()).filter(|m| !m.is_empty());
                        }
                        _ => {}
                    }
                    if let Some(auto) = request.get("autoApprove").and_then(Value::as_bool) {
                        record.auto_approve = auto;
                    }
                    match request.get("staleDays") {
                        Some(Value::Null) => record.stale_days = None,
                        Some(Value::Number(days)) => {
                            record.stale_days = days.as_f64().filter(|days| *days > 0.0);
                        }
                        _ => {}
                    }
                    if let Some(reach) = reach {
                        record.reach = reach;
                    }
                    if let Some(quiet) = request.get("quiet").and_then(Value::as_array) {
                        record.quiet = QUIET_KINDS
                            .iter()
                            .filter(|kind| quiet.iter().any(|given| given.as_str() == Some(**kind)))
                            .map(|kind| (*kind).to_owned())
                            .collect();
                    }
                })?;
                match request.get("picture") {
                    Some(Value::Null) => bot_files::set_picture(Path::new(&bot.folder), None)?,
                    Some(Value::String(uri)) => {
                        bot_files::set_picture(Path::new(&bot.folder), Some(uri))?;
                    }
                    _ => {}
                }
                if request.get("picture").is_some() {
                    self.bots_changed();
                }
                if let Some(look) = request.get("lookAround").filter(|look| look.is_object()) {
                    self.look_around(&bot.id, &LookPatch::of(look)).await?;
                }
                if let Some(tidy) = request.get("tidy").filter(|tidy| tidy.is_object()) {
                    let on = tidy.get("on").and_then(Value::as_bool).unwrap_or(false);
                    self.tidy_memory(&bot.id, on, tidy.get("time").and_then(Value::as_str))
                        .await?;
                }
            }
            "delete" => self.delete_bot(&id).await?,
            "item" => refused = self.owner_item(&request).await?,
            "itemsOpened" => self.items_opened(&id)?,
            // The owner's Start or Dismiss of a suggestion (Start then puts its ask in the bot's message box).
            "suggestion" => {
                let bot = self.bot_named(&id)?;
                let act = match text("act").as_deref() {
                    Some("start") => "started",
                    Some("dismiss") => "dismissed",
                    _ => return fail("suggestion: act is start or dismiss."),
                };
                let suggestion = text("suggestion").unwrap_or_default();
                let now = self.now();
                let resolved = self
                    .looks()
                    .change(&bot.id, |look| look.resolve(&suggestion, act, now));
                if let Err(why) = resolved {
                    return fail(why);
                }
                self.bots_changed();
            }
            // The owner saw the bot's Suggestions: what is listed now is no longer new.
            "looksSeen" => {
                let bot = self.bot_named(&id)?;
                let now = self.now();
                let changed = self.looks().change(&bot.id, |look| {
                    let unseen = look.unseen(now) > 0;
                    if unseen {
                        look.seen_at = now;
                    }
                    unseen
                });
                if changed {
                    self.bots_changed();
                }
            }
            "roomCreate" | "roomUpdate" | "roomDelete" | "roomPost" | "roomStop" => {
                self.owner_room(&request).await?;
            }
            "handTo" => {
                let bot = self.bot_named(&id)?;
                let session = text("session").unwrap_or_default();
                let state = self.host.state();
                let target = state
                    .tabs
                    .iter()
                    .find(|tab| {
                        tab.tab_id == session
                            || (tab.device.is_none()
                                && tab.session_path.as_deref() == Some(session.as_str()))
                    })
                    .cloned();
                let Some(target) = target else {
                    return fail(
                        "That session is not open in a tab: open it, then hand it to the bot.",
                    );
                };
                self.hand_to(&bot, &target, &text("text").unwrap_or_default())
                    .await?;
            }
            other => return fail(format!("bots: no action {other}")),
        }
        let mut state = self.bots_state();
        // The owner's answer named a question the bot has since replaced: nothing was written.
        if let Some(code) = refused {
            state["refused"] = json!(code);
        }
        Ok(state)
    }
}

/// `BotContext` (`resources/gui-bridge/modes/bots-contracts.ts`) for the chat `tab_id` of `bot`.
fn bot_context(
    bot: &BotRecord,
    items: &[ItemRecord],
    tabs: &[ControlTab],
    tab_id: &str,
    now: f64,
) -> Value {
    let brief = |item: &ItemRecord| {
        let mut value =
            json!({ "number": item.number, "title": item.title, "status": item.status });
        if let Some(question) = &item.question {
            value["question"] = serde_json::to_value(question).unwrap_or(Value::Null);
        }
        value
    };
    let open: Vec<&ItemRecord> = items
        .iter()
        .filter(|item| item.bot == bot.id && item.is_open() && !item.snoozed(now))
        .collect();
    let live: Vec<String> = tabs
        .iter()
        .filter(|tab| {
            tab.tab_id != tab_id && tab.device.is_none() && tab.cwd == bot.folder && tab.busy
        })
        .map(|tab| tab.name().to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    json!({
        "bot": { "id": bot.id, "name": bot.name, "paused": bot.paused, "folder": bot.folder },
        "items": open.iter().map(|item| brief(item)).collect::<Vec<Value>>(),
        "needsYou": open
            .iter()
            .filter(|item| item.status == "needs_you")
            .map(|item| brief(item))
            .collect::<Vec<Value>>(),
        "live": live,
    })
}

/// A change to a bot's Look around: only the fields named change (`BotsRequest` `update.lookAround`, `ompdesk_bot
/// look_around`).
#[derive(Clone, Debug, Default)]
pub(crate) struct LookPatch {
    pub on: Option<bool>,
    pub every: Option<String>,
    pub weekdays_only: Option<bool>,
    pub focus: Option<String>,
}

impl LookPatch {
    /// The owner's `lookAround` object.
    fn of(value: &Value) -> LookPatch {
        LookPatch {
            on: value.get("on").and_then(Value::as_bool),
            every: value
                .get("every")
                .and_then(Value::as_str)
                .map(str::to_owned),
            weekdays_only: value.get("weekdaysOnly").and_then(Value::as_bool),
            focus: value
                .get("focus")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }
}

/// When a Look around runs, as its answers say it (Orca's `LOOK_AROUND_EVERY_LABELS`).
fn look_when(look: &LookSetting) -> String {
    let hours = match look.every.as_str() {
        "every-2h" => "every 2 hours from 8:00 to 20:00",
        "twice-daily" => "twice a day, at 8:00 and 13:00",
        "mornings" => "each morning at 8:00",
        _ => "every 4 hours from 8:00 to 20:00",
    };
    format!(
        "{hours}, {}",
        if look.weekdays_only {
            "on weekdays"
        } else {
            "every day"
        }
    )
}

/// One of a bot's workers as the state carries it (`BotWorker` of `src/shared/bots.ts`): the record, and what its tab on
/// this computer does now (`working`, `idle`, or `closed` when no tab holds it).
fn worker_json(worker: &BotWorker, tabs: &[ControlTab]) -> Value {
    let tab = tabs.iter().find(|tab| {
        tab.device.is_none()
            && (tab.session_path.as_deref() == Some(worker.session.as_str())
                || tab.tab_id == worker.session)
    });
    let mut value = serde_json::to_value(worker).unwrap_or(Value::Null);
    value["state"] = json!(match tab {
        Some(tab) if tab.busy => "working",
        Some(_) => "idle",
        None => "closed",
    });
    if let Some(tab) = tab {
        value["tabId"] = json!(tab.tab_id);
    }
    value
}
