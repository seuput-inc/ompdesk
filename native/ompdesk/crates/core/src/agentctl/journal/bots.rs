//! The bots (`src/shared/bots.ts` `Bot`; the owner's decision of 25 Nov 2026, Orca's local-first bot model on stock omp
//! sessions): a bot is a folder on this computer whose sessions are its chats, its home chat the one this record
//! names. Kept in `<userData>/bots.json` (mode 0o600, one JSON array, written whole on every change).
//!
//! What the record does not hold is read when the state is listed: `specialty` from the folder's `SOUL.md`
//! (`specialty`), the open items and the Needs-you count from `items.rs`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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
    /// New bots accept messages from authenticated peers until the owner sets a reach list.
    /// Older journals have no marker: preserve their list, including an explicit empty list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all_paired: Option<bool>,
    /// None = never stale.
    pub stale_days: Option<f64>,
    /// Its Look around schedule's id.
    pub look_around: Option<String>,
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

impl BotRecord {
    /// Whether `session` is one of its chats.
    pub fn has_session(&self, session: &str) -> bool {
        self.home.as_deref() == Some(session) || self.sessions.iter().any(|known| known == session)
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
