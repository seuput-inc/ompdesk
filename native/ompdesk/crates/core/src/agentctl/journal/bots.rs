//! The bots (`src/shared/bots.ts` `Bot`; the owner's decision of 25 Nov 2026, Orca's local-first bot model on stock omp
//! sessions): a bot is a folder on this computer whose sessions are its chats, its home chat the one this record
//! names. Kept in `<userData>/bots.json` (mode 0o600, one JSON array, written whole on every change).
//!
//! What the record does not hold is read when the state is listed: `specialty` from the folder's `SOUL.md`
//! (`specialty`), the open items and the Needs-you count from `items.rs`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::looks::LookSetting;
use super::{read_array, write_text};

/// Days an open item may go untouched before it reads as stale, unless the bot says otherwise (`ITEM_STALE_DAYS`).
pub const STALE_DAYS: f64 = 7.0;
/// How long a bot's specialty is, at most (`Bot.specialty`).
pub const SPECIALTY_CHARS: usize = 120;

/// One bot (`Bot` without its read-time `specialty`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BotRecord {
    pub id: String,
    pub name: String,
    /// Absolute folder its chats run in.
    pub folder: String,
    /// Its home chat's session file; None until its first chat.
    pub home: Option<String>,
    /// Session files of its chats on this computer, oldest first.
    pub sessions: Vec<String>,
    pub paused: bool,
    pub model: Option<String>,
    pub auto_approve: bool,
    /// Paired devices (by id) whose agents may message it.
    pub reach: Vec<String>,
    /// None = never stale.
    pub stale_days: Option<f64>,
    /// Its Look around schedule's id.
    pub look_around: Option<String>,
    /// Its Look around setting; None on a record from before it (`look`).
    pub look_setting: Option<LookSetting>,
    /// The approval mode (`tools.approvalMode`) its chats start in; None starts them as any chat.
    pub chat_approval: Option<String>,
    /// Sessions its chats opened or were handed (its workers), oldest first, `WORKERS_KEPT` at most.
    pub workers: Vec<BotWorker>,
    /// Project folders whose skills its chats load besides its own.
    pub skill_projects: Vec<String>,
    /// Its memory upkeep schedule's id (`tidy_memory`).
    pub tidy: Option<String>,
    /// Notification kinds the owner turned off for its chats: `permission`, `done`, `failed`.
    pub quiet: Vec<String>,
    pub created_at: String,
    /// The newest item event the owner had seen when they last opened its Items tab (`itemsOpened`): a row changed
    /// by anyone else since reads as new.
    pub items_seen: u64,
}

/// Workers a bot keeps.
pub const WORKERS_KEPT: usize = 30;

/// One session a bot's chat opened or was handed (Orca's `bot-work-store.ts` link from a bot's chat to its worker):
/// a link only; what it does now is read from the live tabs.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BotWorker {
    /// Its session file, else its tab id until it has one.
    pub session: String,
    pub title: String,
    pub cwd: String,
    /// Its worktree's branch.
    pub branch: Option<String>,
    /// When the bot was first seen with it (ISO).
    pub since: String,
}

impl BotRecord {
    /// Whether `session` is one of its chats.
    pub fn has_session(&self, session: &str) -> bool {
        self.home.as_deref() == Some(session) || self.sessions.iter().any(|known| known == session)
    }

    /// Its Look around setting: a record from before the setting keeps on only while it has the schedule.
    pub fn look(&self) -> LookSetting {
        self.look_setting.clone().unwrap_or_else(|| LookSetting {
            on: self.look_around.is_some(),
            ..LookSetting::default()
        })
    }
}

/// The registry.
pub struct Bots {
    file: Option<PathBuf>,
    bots: Vec<BotRecord>,
}

impl Bots {
    /// Loads `file` (None: memory only); a record without an id, a name or a folder is left out.
    pub fn new(file: Option<PathBuf>) -> Bots {
        let bots = file
            .as_deref()
            .map(read_array)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| serde_json::from_value::<BotRecord>(item).ok())
            .filter(|bot| !bot.id.is_empty() && !bot.name.is_empty() && !bot.folder.is_empty())
            .collect();
        Bots { file, bots }
    }

    pub fn all(&self) -> &[BotRecord] {
        &self.bots
    }

    /// The bot `key` names: its id, else its name in any case.
    pub fn find(&self, key: &str) -> Option<&BotRecord> {
        let key = key.trim();
        self.bots.iter().find(|bot| bot.id == key).or_else(|| {
            self.bots
                .iter()
                .find(|bot| bot.name.to_lowercase() == key.to_lowercase())
        })
    }

    /// The bot whose chats run in `cwd`.
    pub fn of_folder(&self, cwd: &str) -> Option<&BotRecord> {
        self.bots.iter().find(|bot| bot.folder == cwd)
    }

    /// The bot `session` is a chat of.
    pub fn of_session(&self, session: &str) -> Option<&BotRecord> {
        self.bots.iter().find(|bot| bot.has_session(session))
    }

    pub fn add(&mut self, bot: BotRecord) {
        self.bots.push(bot);
        self.save();
    }

    /// Changes the bot `id` and saves; its record as it is now.
    pub fn change(&mut self, id: &str, change: impl FnOnce(&mut BotRecord)) -> Option<BotRecord> {
        let bot = self.bots.iter_mut().find(|bot| bot.id == id)?;
        change(bot);
        let changed = bot.clone();
        self.save();
        Some(changed)
    }

    pub fn remove(&mut self, id: &str) -> Option<BotRecord> {
        let at = self.bots.iter().position(|bot| bot.id == id)?;
        let removed = self.bots.remove(at);
        self.save();
        Some(removed)
    }

    /// A chat of the bot whose folder is `cwd` was seen with its session file: it joins `sessions`, and the first one
    /// becomes the home chat (set once). Whether anything changed.
    pub fn observe(&mut self, cwd: &str, session: &str) -> bool {
        let Some(bot) = self.bots.iter_mut().find(|bot| bot.folder == cwd) else {
            return false;
        };
        let mut changed = false;
        if !bot.sessions.iter().any(|known| known == session) {
            bot.sessions.push(session.to_owned());
            changed = true;
        }
        if bot.home.is_none() {
            bot.home = Some(session.to_owned());
            changed = true;
        }
        if changed {
            self.save();
        }
        changed
    }

    /// A session a chat of the bot whose folder is `opener_cwd` opened (or was handed) was seen: it joins or updates
    /// that bot's `workers`, matched by its session file or, until it has one, its tab id (`tab_id`). `since` is now
    /// (ISO), kept from the first sighting. Whether anything changed.
    pub fn observe_worker(&mut self, opener_cwd: &str, tab_id: &str, seen: BotWorker) -> bool {
        let Some(bot) = self.bots.iter_mut().find(|bot| bot.folder == opener_cwd) else {
            return false;
        };
        // A chat of the bot is its chat, never its worker.
        if seen.cwd == bot.folder {
            return false;
        }
        let at = bot
            .workers
            .iter()
            .position(|known| known.session == seen.session || known.session == tab_id);
        let worker = match at {
            Some(at) => BotWorker {
                since: bot.workers[at].since.clone(),
                title: if seen.title.is_empty() {
                    bot.workers[at].title.clone()
                } else {
                    seen.title
                },
                ..seen
            },
            None => seen,
        };
        if at.is_some_and(|at| bot.workers[at] == worker) {
            return false;
        }
        match at {
            Some(at) => bot.workers[at] = worker,
            None => bot.workers.push(worker),
        }
        let extra = bot.workers.len().saturating_sub(WORKERS_KEPT);
        bot.workers.drain(..extra);
        self.save();
        true
    }

    /// Session files of every paused bot's chats.
    pub fn paused_sessions(&self) -> Vec<String> {
        self.bots
            .iter()
            .filter(|bot| bot.paused)
            .flat_map(|bot| bot.home.iter().chain(bot.sessions.iter()).cloned())
            .collect()
    }

    fn save(&self) {
        let Some(file) = &self.file else { return };
        let text = serde_json::to_string(&self.bots).unwrap_or_else(|_| "[]".to_owned());
        if let Err(error) = write_text(file, &text, Some(0o600)) {
            eprintln!("[bots] not saved: {error}");
        }
    }
}

/// A folder name for `name`: lowercase letters and digits, every other run one `-`; "bot" when nothing is left.
pub fn slug(name: &str) -> String {
    let mut slug = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "bot".to_owned()
    } else {
        slug
    }
}

/// The first paragraph of `<folder>/SOUL.md` that is not a heading, white space collapsed, cut to `SPECIALTY_CHARS`.
pub fn specialty(folder: &Path) -> Option<String> {
    specialty_of(&std::fs::read_to_string(folder.join("SOUL.md")).ok()?)
}

/// `specialty` of a `SOUL.md` text: a heading line ends a paragraph and is never part of one.
pub fn specialty_of(text: &str) -> Option<String> {
    let mut words: Vec<&str> = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            if !words.is_empty() {
                break;
            }
            continue;
        }
        words.extend(line.split_whitespace());
    }
    if words.is_empty() {
        return None;
    }
    let collapsed = words.join(" ");
    let mut cut: String = collapsed.chars().take(SPECIALTY_CHARS).collect();
    if cut.chars().count() < collapsed.chars().count() {
        cut.pop();
        cut.push('…');
    }
    Some(cut)
}
