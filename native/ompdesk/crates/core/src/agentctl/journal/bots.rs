//! The bots (`src/shared/bots.ts` `Bot`; the owner's decision of 25 Nov 2026, Orca's local-first bot model on stock omp
//! sessions): a bot is a folder on this computer whose sessions are its chats, its home chat the one this record
//! names. Kept in `<userData>/bots.json` (mode 0o600, one JSON array, written whole on every change).
//!
//! What the record does not hold is read when the state is listed: `specialty` from the folder's `SOUL.md`
//! (`specialty`), the open items and the Needs-you count from `items.rs`.

pub mod receipt;

use std::collections::HashSet;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_receipt: Option<receipt::CreationReceipt>,
    /// Session files of its chats on this computer, oldest first.
    pub sessions: Vec<String>,
    pub paused: bool,
    pub model: Option<String>,
    pub auto_approve: bool,
    /// Paired devices (by id) whose agents may message it.
    pub reach: Vec<String>,
    /// New bots accept messages from authenticated peers until the owner sets a reach list.
    /// Older journals have no marker: preserve their list, including an explicit empty list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all_paired: Option<bool>,
    /// None = never stale.
    pub stale_days: Option<f64>,
    /// Its Look around schedule's id.
    pub look_around: Option<String>,
    /// Its Look around setting; None on a record from before it (`look`).
    pub look_setting: Option<LookSetting>,
    /// The approval mode (`tools.approvalMode`) its chats start in; None starts them as any chat.
    pub chat_approval: Option<String>,
    /// Every linked worker, oldest first. The page shows only the newest `WORKERS_KEPT`.
    pub workers: Vec<BotWorker>,
    /// Project folders whose skills its chats load besides its own.
    pub skill_projects: Vec<String>,
    /// A move of its folder under way, saved before the directory is renamed (`bot_move.rs`).
    pub moving: Option<FolderMove>,
    /// The rename record: the name it had before a rename whose folder has not followed yet (`bot_move.rs`).
    pub renamed_from: Option<String>,
    /// Its memory upkeep schedule's id (`tidy_memory`).
    pub tidy: Option<String>,
    /// Notification kinds the owner turned off for its chats: `permission`, `done`, `failed`.
    pub quiet: Vec<String>,
    pub created_at: String,
    /// The newest item event the owner had seen when they last opened its Items tab (`itemsOpened`): a row changed
    /// by anyone else since reads as new.
    pub items_seen: u64,
    /// Its first run lasts (set at create, `service/work/bot_first_run.rs`): its home chat is sent the kickoff and
    /// carries the first-run rules until the owner's first turn there ends; never ended by `SOUL.md`.
    pub first_run: bool,
    /// The first message OMPdesk sends its home chat when it is not the plain one: a template's or an import's.
    pub kickoff: Option<String>,
    /// The mail ids (send fingerprints) of the kickoffs sent to its home chat, oldest first.
    pub kickoffs: Vec<String>,
    /// The newest kickoff's turn ended without a word: its page offers Try again.
    pub kickoff_silent: bool,
}

/// A bot's folder moving from `from` to `to` (`BotRecord.moving`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FolderMove {
    pub from: String,
    pub to: String,
}

/// Workers shown in the bot's state.
pub const WORKERS_KEPT: usize = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkerOrigin {
    Opened,
    Handed,
}

/// One session a bot's chat opened or was handed (Orca's `bot-work-store.ts` link from a bot's chat to its worker):
/// a link only; what it does now is read from the live tabs.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BotWorker {
    /// Its session file, else its tab id until it has one.
    pub session: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    /// Only a fresh spawn or an explicit hand sets this; a parent link proves neither.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<WorkerOrigin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened_by_session: Option<String>,
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
        if bot.moving.is_some() {
            return false;
        }
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

    /// `owner` identifies an explicit spawn or hand. A passive observation names only an opener.
    pub fn observe_worker(&mut self, owner: Option<&str>, tab_id: &str, seen: BotWorker) -> bool {
        let changed = self.update_worker(owner, tab_id, seen);
        if changed {
            self.save();
        }
        changed
    }

    /// Drop any former bot's authority durably before changing the opener, even on a retry of a failed write.
    pub fn hand_worker(&mut self, id: &str, tab_id: &str, seen: BotWorker) -> Result<bool, String> {
        let changed = self.update_worker(Some(id), tab_id, seen);
        self.save_checked()?;
        Ok(changed)
    }

    fn update_worker(&mut self, owner: Option<&str>, tab_id: &str, seen: BotWorker) -> bool {
        let Some(owner) = self.bots.iter().position(|bot| match owner {
            Some(id) => bot.id == id,
            None => seen
                .opened_by_session
                .as_deref()
                .is_some_and(|file| bot.has_session(file)),
        }) else {
            return false;
        };
        let same = |known: &BotWorker| {
            known.device == seen.device
                && (known.session == seen.session || known.session == tab_id)
        };
        // A stale parent snapshot must never transfer a worker away from its recorded bot.
        if seen.origin.is_none()
            && self
                .bots
                .iter()
                .enumerate()
                .any(|(i, bot)| i != owner && bot.workers.iter().any(&same))
        {
            return false;
        }
        let mut removed = false;
        for (index, other) in self.bots.iter_mut().enumerate() {
            if index == owner {
                continue;
            }
            let before = other.workers.len();
            other.workers.retain(|known| !same(known));
            removed |= before != other.workers.len();
        }
        let bot = &mut self.bots[owner];
        if seen.device.is_none() && seen.cwd == bot.folder {
            return removed;
        }
        let at = bot.workers.iter().position(same);
        // Only the opening operation may turn its pending tab into a deletion authority for a file.
        if seen.origin.is_none()
            && at.is_some_and(|at| {
                let known = &bot.workers[at];
                known.origin == Some(WorkerOrigin::Opened)
                    && known.session == tab_id
                    && seen.session != tab_id
            })
        {
            return false;
        }
        let worker = match at {
            Some(at) => BotWorker {
                origin: seen.origin.or(bot.workers[at].origin),
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
            return removed;
        }
        match at {
            Some(at) => bot.workers[at] = worker,
            None => bot.workers.push(worker),
        }
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

    /// A stale selection must not replace an explicit reach decision made after the dialog opened.
    pub fn allow_legacy_peers(&mut self, ids: &HashSet<&str>) -> bool {
        if ids.is_empty()
            || self
                .bots
                .iter()
                .filter(|bot| {
                    ids.contains(bot.id.as_str())
                        && bot.all_paired.is_none()
                        && bot.reach.is_empty()
                })
                .count()
                != ids.len()
        {
            return false;
        }
        for bot in &mut self.bots {
            if ids.contains(bot.id.as_str()) {
                bot.all_paired = Some(true);
            }
        }
        self.save();
        true
    }

    fn save(&self) {
        if let Err(error) = self.save_checked() {
            eprintln!("[bots] not saved: {error}");
        }
    }

    fn save_checked(&self) -> Result<(), String> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let text = serde_json::to_string(&self.bots).map_err(|error| error.to_string())?;
        write_text(file, &text, Some(0o600))
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
