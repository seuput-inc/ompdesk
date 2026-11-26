//! Bot groups and their rooms (`src/shared/bots.ts` `Room`; Orca's bot groups, `bot-group-schema.ts`, re-implemented):
//! a named set of bots and the one room they talk in with the owner. Kept in `<userData>/rooms.json` beside the items
//! (mode 0o600, one JSON array, written whole on every change); a room keeps its newest `MESSAGES_KEPT` posts.
//!
//! A post records which members it asked to reply (`turns`) and how each one went; a member's own chat is its bot's
//! home chat, so `seen` says up to which post each member has been shown the room.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{read_array, write_text};

/// Posts a room keeps.
pub const MESSAGES_KEPT: usize = 200;
/// Members a group holds, at most (Orca's `BotGroupCreate.botIds`).
pub const MEMBERS_MAX: usize = 32;

/// One member asked to reply to a post.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RoomTurn {
    /// The bot's id.
    pub bot: String,
    /// Its name when it was asked.
    pub name: String,
    /// `asked`, `replied`, `stopped` or `failed`.
    pub state: String,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RoomMessage {
    pub id: String,
    /// Per room, from 1.
    pub seq: u64,
    pub at: String,
    /// `owner`, or the bot's id.
    pub author: String,
    /// The bot's name when it posted; empty for the owner.
    pub name: String,
    pub text: String,
    /// The members this post asked to reply.
    pub turns: Vec<RoomTurn>,
    /// Hand-offs from the owner's post to this one: a bot's @mention asks another member only while it is under
    /// `HOPS_MAX`, so two bots never call each other forever.
    pub hops: u32,
}

/// Hand-offs one owner post may set off.
pub const HOPS_MAX: u32 = 3;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RoomRecord {
    pub id: String,
    pub name: String,
    /// Its bots' ids.
    pub members: Vec<String>,
    /// Who replies to the owner's post: `all`, `mentions` (only those it @mentions) or `bot:<id>` (that one, and any
    /// it @mentions).
    pub reply_mode: String,
    pub created_at: String,
    pub messages: Vec<RoomMessage>,
    /// The newest `seq` given.
    pub last_seq: u64,
    /// Per member (bot id): the newest post it has been shown.
    pub seen: BTreeMap<String, u64>,
}

impl RoomRecord {
    /// Adds a post with the next `seq` (newest `MESSAGES_KEPT` kept); its `seq`.
    pub fn post(&mut self, mut message: RoomMessage) -> u64 {
        self.last_seq += 1;
        message.seq = self.last_seq;
        self.messages.push(message);
        let extra = self.messages.len().saturating_sub(MESSAGES_KEPT);
        self.messages.drain(..extra);
        self.last_seq
    }
}

/// The rooms.
pub struct Rooms {
    file: Option<PathBuf>,
    rooms: Vec<RoomRecord>,
}

impl Rooms {
    /// Loads `file` (None: memory only); a record without an id or a name is left out.
    pub fn new(file: Option<PathBuf>) -> Rooms {
        let rooms = file
            .as_deref()
            .map(read_array)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|room| serde_json::from_value::<RoomRecord>(room).ok())
            .filter(|room| !room.id.is_empty() && !room.name.is_empty())
            .collect();
        Rooms { file, rooms }
    }

    pub fn all(&self) -> &[RoomRecord] {
        &self.rooms
    }

    /// The room `key` names: its id, else its name in any case.
    pub fn find(&self, key: &str) -> Option<&RoomRecord> {
        let key = key.trim();
        self.rooms.iter().find(|room| room.id == key).or_else(|| {
            self.rooms
                .iter()
                .find(|room| room.name.to_lowercase() == key.to_lowercase())
        })
    }

    pub fn add(&mut self, room: RoomRecord) {
        self.rooms.push(room);
        self.save();
    }

    /// Changes the room `id` and saves; its record as it is now.
    pub fn change(&mut self, id: &str, change: impl FnOnce(&mut RoomRecord)) -> Option<RoomRecord> {
        let room = self.rooms.iter_mut().find(|room| room.id == id)?;
        change(room);
        let changed = room.clone();
        self.save();
        Some(changed)
    }

    pub fn remove(&mut self, id: &str) -> Option<RoomRecord> {
        let at = self.rooms.iter().position(|room| room.id == id)?;
        let removed = self.rooms.remove(at);
        self.save();
        Some(removed)
    }

    /// A deleted bot leaves every group it was in.
    pub fn remove_bot(&mut self, bot: &str) {
        let mut changed = false;
        for room in &mut self.rooms {
            if room.members.iter().any(|member| member == bot) {
                room.members.retain(|member| member != bot);
                room.seen.remove(bot);
                if room.reply_mode == format!("bot:{bot}") {
                    room.reply_mode = "all".to_owned();
                }
                changed = true;
            }
        }
        if changed {
            self.save();
        }
    }

    fn save(&self) {
        let Some(file) = &self.file else { return };
        let text = serde_json::to_string(&self.rooms).unwrap_or_else(|_| "[]".to_owned());
        if let Err(error) = write_text(file, &text, Some(0o600)) {
            eprintln!("[rooms] not saved: {error}");
        }
    }
}
