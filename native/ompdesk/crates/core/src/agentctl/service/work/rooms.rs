//! Bot groups and their rooms (Orca's bot groups, `BotGroupChat.tsx`, `BotGroupReplyPicker.tsx`,
//! `BotGroupMembersDialog.tsx`, `shared/bots/bot-group.ts`, re-implemented; control-tools.md › Bots, items and rooms).
//!
//! - The owner makes a group of bots (`roomCreate {name, bots}`), renames it, changes its members or who replies
//!   (`roomUpdate {id, name?, bots?, replyMode?}`) and deletes it (`roomDelete`): the bots and their chats stay.
//! - The owner's post (`roomPost {id, text, messageId}`; a repeat of one message id posts once) asks the members its
//!   reply mode names: all of them, only those it @mentions, or one bot and any it @mentions. A member is asked in
//!   its bot's home chat by a mail that starts a turn, carrying the room's posts since that member last read it
//!   (`CONTEXT_MAX` characters, the oldest dropped first).
//! - A member answers with `ompdesk_room {"action":"post"}` from its bot's chat, or posts nothing when it has nothing
//!   to add. Its post @mentioning another member asks that one too, while the chain from the owner's post is under
//!   `HOPS_MAX` hand-offs, so two bots never call each other forever.
//! - Stop (`roomStop {id}`) ends every ask still open; a member chat at work is stopped.

use serde_json::{Value, json};

use super::super::AgentControl;
use super::super::fail::{R, fail};
use super::super::host::Deadline;
use super::super::types::{ControlTab, RoomArgs};
use super::bots::new_id;
use super::bots_share::AskedRoom;
use crate::agentctl::journal::bots::BotRecord;
use crate::agentctl::journal::rooms::{HOPS_MAX, MEMBERS_MAX, RoomMessage, RoomRecord, RoomTurn};
use crate::agentctl::rules::mail::{Mail, MailKind};
use crate::aimemory::value::iso;

/// A group's name, at most.
const NAME_MAX: usize = 80;
/// One post, at most.
const POST_MAX: usize = 20_000;
/// The room's earlier posts a member is shown with an ask, at most (Orca's `BOT_GROUP_CONTEXT_MAX`).
const CONTEXT_MAX: usize = 24_000;
/// Posts `read` shows unless told otherwise, and at most.
const READ_DEFAULT: usize = 20;
const READ_MAX: usize = 200;

/// Whether `text` names `name` as `@name` (any case), not as the start of a longer word.
fn mentions(text: &str, name: &str) -> bool {
    let text = text.to_lowercase();
    let needle = format!("@{}", name.to_lowercase());
    text.match_indices(&needle).any(|(at, _)| {
        text[at + needle.len()..]
            .chars()
            .next()
            .is_none_or(|next| !next.is_alphanumeric())
    })
}

/// A group's member: one of this computer's bots, or a paired host's from the copy kept of it (`device`; orca-bots-
/// remote, Orca's `bot-group-remote.ts:57-140`: a group with another computer's bots lives on this one).
#[derive(Clone, Debug)]
struct Member {
    id: String,
    name: String,
    home: Option<String>,
    device: Option<String>,
}

impl Member {
    fn local(bot: &BotRecord) -> Member {
        Member {
            id: bot.id.clone(),
            name: bot.name.clone(),
            home: bot.home.clone(),
            device: None,
        }
    }

    fn remote(device: &str, bot: &Value) -> Option<Member> {
        let text = |key: &str| bot.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(Member {
            id: text("id")?,
            name: text("name")?,
            home: text("home"),
            device: Some(device.to_owned()),
        })
    }
}

/// Who replies to the owner's post under `mode` (`all`, `mentions`, `bot:<id>`).
fn repliers<'a>(mode: &str, members: &'a [Member], text: &str) -> Vec<&'a Member> {
    members
        .iter()
        .filter(|member| match mode {
            "all" => true,
            "mentions" => mentions(text, &member.name),
            other => {
                other.strip_prefix("bot:") == Some(member.id.as_str())
                    || mentions(text, &member.name)
            }
        })
        .collect()
}

/// A post as one line of the room's history.
fn line_of(message: &RoomMessage) -> String {
    let who = if message.author == "owner" {
        "Owner"
    } else {
        message.name.as_str()
    };
    format!("{who}: {}", message.text)
}

/// The newest lines that fit `CONTEXT_MAX`, oldest first.
fn fit(lines: Vec<String>) -> String {
    let mut kept: Vec<String> = Vec::new();
    let mut size = 0;
    for line in lines.into_iter().rev() {
        size += line.chars().count() + 1;
        if size > CONTEXT_MAX && !kept.is_empty() {
            break;
        }
        kept.push(line);
    }
    kept.reverse();
    kept.join("\n")
}

/// A group's question to a member's home chat: a mail that starts a turn and says how to answer in the room.
fn room_mail(id: &str, room: &str, from: &str, text: &str, now: f64) -> Mail {
    let mut mail = Mail::new(id, "ompdesk", from, "", MailKind::Question, text, now);
    mail.instruction = Some(format!(
        "Answer in the room with ompdesk_room {{\"action\":\"post\",\"room\":\"{room}\",\"text\":…}}; post nothing when you have nothing to add."
    ));
    mail
}

impl AgentControl {
    /// The bots `keys` name (ids or names; a paired host's from its copy), each once; refused when one is unknown, there
    /// are too many, or none is this computer's (Orca's `groupNeedsLocalBot`: the group lives where its bots are).
    fn room_members(&self, keys: &[Value]) -> R<Vec<String>> {
        let mut members: Vec<String> = Vec::new();
        let mut local = false;
        for key in keys.iter().filter_map(Value::as_str) {
            let found = self.bots().find(key).map(|bot| bot.id.clone());
            let id = match found {
                Some(id) => {
                    local = true;
                    id
                }
                None => {
                    let remote = self.across().copies.bot(key);
                    match remote.and_then(|(_, bot)| bot.get("id")?.as_str().map(str::to_owned)) {
                        Some(id) => id,
                        None => return fail(format!("No bot \"{key}\".")),
                    }
                }
            };
            if !members.contains(&id) {
                members.push(id);
            }
        }
        if members.is_empty() {
            return fail("A group needs at least one bot.");
        }
        if members.len() > MEMBERS_MAX {
            return fail(format!("A group holds up to {MEMBERS_MAX} bots."));
        }
        if !local {
            return fail(
                "A group needs one of this computer's bots: another computer's bots join beside them.",
            );
        }
        Ok(members)
    }

    /// The owner's group change (`BotsRequest` `roomCreate`, `roomUpdate`, `roomDelete`, `roomPost`, `roomStop`).
    pub(crate) async fn owner_room(&self, request: &Value) -> R<()> {
        let text = |key: &str| {
            request
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        let id = text("id").unwrap_or_default();
        let name = text("name");
        if let Some(name) = &name
            && name.chars().count() > NAME_MAX
        {
            return fail(format!("A group's name is at most {NAME_MAX} characters."));
        }
        let taken = |name: &str, except: &str| {
            self.rooms()
                .all()
                .iter()
                .any(|room| room.id != except && room.name.to_lowercase() == name.to_lowercase())
        };
        match request.get("action").and_then(Value::as_str).unwrap_or("") {
            "roomCreate" => {
                let Some(name) = name else {
                    return fail("A group needs a name.");
                };
                if taken(&name, "") {
                    return fail(format!("There is already a group named \"{name}\"."));
                }
                let keys = request
                    .get("bots")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let members = self.room_members(&keys)?;
                self.rooms().add(RoomRecord {
                    id: new_id("room"),
                    name,
                    members,
                    reply_mode: "all".to_owned(),
                    created_at: iso(self.now().max(0.0) as u64),
                    ..RoomRecord::default()
                });
            }
            "roomUpdate" => {
                let Some(room) = self.rooms().find(&id).cloned() else {
                    return fail("That group is gone.");
                };
                if let Some(name) = &name
                    && taken(name, &room.id)
                {
                    return fail(format!("There is already a group named \"{name}\"."));
                }
                let members = match request.get("bots").and_then(Value::as_array) {
                    Some(keys) => Some(self.room_members(keys)?),
                    None => None,
                };
                let mode = text("replyMode");
                if let Some(mode) = &mode {
                    let known = members.as_ref().unwrap_or(&room.members);
                    let valid = mode == "all"
                        || mode == "mentions"
                        || mode
                            .strip_prefix("bot:")
                            .is_some_and(|bot| known.iter().any(|member| member == bot));
                    if !valid {
                        return fail("replyMode is all, mentions or bot:<a member's id>.");
                    }
                }
                self.rooms().change(&room.id, |record| {
                    if let Some(name) = name {
                        record.name = name;
                    }
                    if let Some(members) = members {
                        record.seen.retain(|bot, _| members.contains(bot));
                        if record
                            .reply_mode
                            .strip_prefix("bot:")
                            .is_some_and(|bot| !members.iter().any(|member| member == bot))
                        {
                            record.reply_mode = "all".to_owned();
                        }
                        record.members = members;
                    }
                    if let Some(mode) = mode {
                        record.reply_mode = mode;
                    }
                });
            }
            "roomDelete" => {
                if self.rooms().remove(&id).is_none() {
                    return fail("That group is gone.");
                }
            }
            "roomPost" => {
                self.room_post(&id, &text("text").unwrap_or_default(), text("messageId"))
                    .await?;
            }
            "roomStop" => self.room_stop(&id).await?,
            other => return fail(format!("bots: no action {other}")),
        }
        self.bots_changed();
        Ok(())
    }

    /// The owner's post: kept, then each member its reply mode names is asked.
    async fn room_post(&self, id: &str, text: &str, message_id: Option<String>) -> R<()> {
        if text.is_empty() {
            return fail("A post needs text.");
        }
        if text.chars().count() > POST_MAX {
            return fail(format!("A post is at most {POST_MAX} characters."));
        }
        let Some(room) = self.rooms().find(id).cloned() else {
            return fail("That group is gone.");
        };
        // A post sent again (its answer lost) is posted once.
        if let Some(message_id) = &message_id
            && room
                .messages
                .iter()
                .any(|message| message.id == *message_id)
        {
            return Ok(());
        }
        let now = self.now();
        let message = RoomMessage {
            id: message_id.unwrap_or_else(|| new_id("post")),
            at: iso(now.max(0.0) as u64),
            author: "owner".to_owned(),
            text: text.to_owned(),
            ..RoomMessage::default()
        };
        let members = self.room_members_of(&room);
        let asked: Vec<Member> = repliers(&room.reply_mode, &members, text)
            .into_iter()
            .cloned()
            .collect();
        self.room_ask(&room.id, message, &asked, now).await
    }

    /// The room's members, in member order: this computer's bots, and a paired host's from the copy kept of it.
    fn room_members_of(&self, room: &RoomRecord) -> Vec<Member> {
        room.members
            .iter()
            .filter_map(|member| {
                let local = self.bots().find(member).map(Member::local);
                local.or_else(|| {
                    let (device, bot) = self.across().copies.bot(member)?;
                    Member::remote(&device, &bot)
                })
            })
            .collect()
    }

    /// Posts `message` and asks each of `asked` to reply to it.
    async fn room_ask(
        &self,
        room_id: &str,
        message: RoomMessage,
        asked: &[Member],
        now: f64,
    ) -> R<()> {
        let Some(room) = self.rooms().change(room_id, |record| {
            record.post(message);
        }) else {
            return fail("That group is gone.");
        };
        let Some(posted) = room.messages.last().cloned() else {
            return Ok(());
        };
        let mut turns: Vec<RoomTurn> = Vec::new();
        for member in asked {
            turns.push(self.ask_member(&room, member, &posted, now).await);
        }
        if !turns.is_empty() {
            self.rooms().change(room_id, |record| {
                for turn in &turns {
                    if turn.state == "asked" {
                        record.seen.insert(turn.bot.clone(), posted.seq);
                    }
                }
                if let Some(message) = record
                    .messages
                    .iter_mut()
                    .find(|message| message.seq == posted.seq)
                {
                    message.turns.extend(turns);
                }
            });
        }
        Ok(())
    }

    /// Asks one member, in its bot's home chat, to reply to `post`: the room's posts since it last read it go along. A
    /// paired host's bot is asked on its host (`roomAsk`), which hands the same question to its home chat there.
    async fn ask_member(
        &self,
        room: &RoomRecord,
        bot: &Member,
        post: &RoomMessage,
        now: f64,
    ) -> RoomTurn {
        let mut turn = RoomTurn {
            bot: bot.id.clone(),
            name: bot.name.clone(),
            state: "asked".to_owned(),
            at: iso(now.max(0.0) as u64),
            error: None,
        };
        let Some(home) = bot.home.clone() else {
            turn.state = "failed".to_owned();
            turn.error = Some(format!(
                "{} has no chat yet: open its home chat once.",
                bot.name
            ));
            return turn;
        };
        let seen = room.seen.get(&bot.id).copied().unwrap_or(0);
        let earlier = fit(room
            .messages
            .iter()
            .filter(|message| {
                message.seq > seen && message.seq < post.seq && message.author != bot.id
            })
            .map(line_of)
            .collect());
        let mut text = format!(
            "In the group “{}” (room {}), {}",
            room.name,
            room.id,
            line_of(post)
        );
        if !earlier.is_empty() {
            text.push_str(&format!(
                "\n\nEarlier in the room since you last read it:\n{earlier}"
            ));
        }
        let mail_id = format!("room-{}-{}-{}", room.id, post.seq, bot.id);
        if let Some(device) = &bot.device {
            let (online, host) = self
                .across()
                .copies
                .host(device)
                .map_or((false, device.clone()), |copy| {
                    (copy.online, copy.name.clone())
                });
            let asked: R<Value> = if online {
                self.host
                    .bots_on(
                        device,
                        &json!({
                            "action": "roomAsk",
                            "id": bot.id,
                            "room": room.id,
                            "roomName": room.name,
                            "mailId": mail_id,
                            "text": text,
                        }),
                    )
                    .await
            } else {
                fail(format!("{host} is offline: {} was not asked.", bot.name))
            };
            if let Err(error) = asked {
                turn.state = "failed".to_owned();
                turn.error = Some(error.message().to_string());
            }
            return turn;
        }
        let from = format!("the group {}", room.name);
        self.mail_session(
            &home,
            room_mail(&mail_id, &room.id, &from, &text, now),
            true,
        )
        .await;
        turn
    }

    /// Stops the turn the chat `home` of this computer runs, if one does.
    async fn stop_home(&self, home: &str) {
        let state = self.host.state();
        let Some(tab) = state.tabs.iter().find(|tab| {
            tab.device.is_none() && tab.session_path.as_deref() == Some(home) && tab.busy
        }) else {
            return;
        };
        let _ = self
            .host
            .command(
                &tab.tab_id,
                &json!({ "type": "abort" }),
                Deadline::Ms(self.tuning.state_timeout_ms),
            )
            .await;
    }

    /// Stops the room: every ask still open ends, and a member chat at work is stopped.
    async fn room_stop(&self, id: &str) -> R<()> {
        let Some(room) = self.rooms().find(id).cloned() else {
            return fail("That group is gone.");
        };
        let open: Vec<String> = room
            .messages
            .iter()
            .flat_map(|message| message.turns.iter())
            .filter(|turn| turn.state == "asked")
            .map(|turn| turn.bot.clone())
            .collect();
        self.rooms().change(&room.id, |record| {
            for turn in record
                .messages
                .iter_mut()
                .flat_map(|message| message.turns.iter_mut())
                .filter(|turn| turn.state == "asked")
            {
                turn.state = "stopped".to_owned();
            }
        });
        for member in self.room_members_of(&room) {
            if !open.contains(&member.id) {
                continue;
            }
            match (&member.device, member.home.as_deref()) {
                (Some(device), _) => {
                    let stop = json!({ "action": "roomAskStop", "id": member.id });
                    let _ = self.host.bots_on(device, &stop).await;
                }
                (None, Some(home)) => self.stop_home(home).await,
                (None, None) => {}
            }
        }
        Ok(())
    }

    /// `ompdesk_room`: a bot's chat lists its groups, reads a room and posts in it. A paired host's chat this computer
    /// holds is that bot's chat here (its copy names the folder); a group on a paired device that asked one of this
    /// computer's bots (`roomAsk`) is listed too, and the bot's post to it goes back to that device.
    pub(crate) async fn room_tool(&self, caller: &ControlTab, args: RoomArgs) -> R<String> {
        let member = match caller.device.as_deref() {
            Some(device) => {
                let bot = self.across().copies.bot_in_folder(device, &caller.cwd);
                bot.and_then(|bot| Member::remote(device, &bot))
            }
            None => self
                .bot_of_folder(&caller.cwd)
                .map(|bot| Member::local(&bot)),
        };
        let Some(bot) = member else {
            return fail("ompdesk_room works in a bot's chat");
        };
        let rooms: Vec<RoomRecord> = self
            .rooms()
            .all()
            .iter()
            .filter(|room| room.members.contains(&bot.id))
            .cloned()
            .collect();
        let away: Vec<AskedRoom> = if bot.device.is_none() {
            let asked = self.across().asked.clone();
            asked
                .into_iter()
                .filter(|asked| asked.bot == bot.id)
                .collect()
        } else {
            Vec::new()
        };
        if args.action == "list" {
            if rooms.is_empty() && away.is_empty() {
                return Ok("You are in no group.".to_owned());
            }
            let lines: Vec<String> = rooms
                .iter()
                .map(|room| {
                    let names: Vec<String> = self
                        .room_members_of(room)
                        .into_iter()
                        .filter(|member| member.id != bot.id)
                        .map(|member| member.name)
                        .collect();
                    format!(
                        "- {} (room {}): with {}; {} posts",
                        room.name,
                        room.id,
                        if names.is_empty() {
                            "nobody else".to_owned()
                        } else {
                            names.join(", ")
                        },
                        room.messages.len()
                    )
                })
                .chain(away.iter().map(|asked| {
                    format!(
                        "- {} (room {}): on {}; each question brings its posts",
                        asked.name, asked.room, asked.device_name
                    )
                }))
                .collect();
            return Ok(lines.join("\n"));
        }
        let Some(key) = args
            .room
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
        else {
            return fail(format!("{} needs room (its id or name).", args.action));
        };
        let named = |id: &str, name: &str| id == key || name.to_lowercase() == key.to_lowercase();
        let Some(room) = rooms
            .iter()
            .find(|room| named(&room.id, &room.name))
            .cloned()
        else {
            if let Some(asked) = away.iter().find(|asked| named(&asked.room, &asked.name)) {
                return self.room_tool_away(&bot, asked, &args).await;
            }
            return fail(format!(
                "You are in no group \"{key}\". ompdesk_room {{\"action\":\"list\"}} lists yours."
            ));
        };
        match args.action.as_str() {
            "read" => {
                let limit = args
                    .limit
                    .map_or(READ_DEFAULT, |limit| limit as usize)
                    .clamp(1, READ_MAX);
                let shown: Vec<String> = room
                    .messages
                    .iter()
                    .skip(room.messages.len().saturating_sub(limit))
                    .map(|message| format!("#{} {}", message.seq, line_of(message)))
                    .collect();
                self.rooms().change(&room.id, |record| {
                    record.seen.insert(bot.id.clone(), record.last_seq);
                });
                if shown.is_empty() {
                    return Ok(format!("Nothing was posted in {} yet.", room.name));
                }
                Ok(shown.join("\n"))
            }
            "post" => {
                let text = post_text(args.text.as_deref())?;
                let handed = self.member_post(&room, &bot, text, None).await?;
                Ok(match handed.len() {
                    0 => format!("Posted in {}.", room.name),
                    _ => format!(
                        "Posted in {}; asked {} to answer.",
                        room.name,
                        handed
                            .iter()
                            .map(|member| member.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                })
            }
            other => fail(format!("ompdesk_room has no action {other}.")),
        }
    }

    /// `ompdesk_room` on a group of a paired device: a post goes back to that device, which holds the room.
    async fn room_tool_away(&self, bot: &Member, asked: &AskedRoom, args: &RoomArgs) -> R<String> {
        match args.action.as_str() {
            "read" => fail(format!(
                "The group {} is on {}: each question to you brings its posts since you last answered.",
                asked.name, asked.device_name
            )),
            "post" => {
                let text = post_text(args.text.as_deref())?;
                let post = json!({
                    "room": asked.room,
                    "bot": bot.id,
                    "text": text,
                    "id": new_id("post"),
                });
                if !self.host.room_post_to(&asked.device, &post).await? {
                    return fail(format!(
                        "{} is not connected: post again once it is.",
                        asked.device_name
                    ));
                }
                Ok(format!(
                    "Posted in {} on {}.",
                    asked.name, asked.device_name
                ))
            }
            other => fail(format!("ompdesk_room has no action {other}.")),
        }
    }

    /// A member's post: the asks it answers end, the post is kept (once by its `id`) and a member it @mentions is asked
    /// next while the chain is short enough. The members asked.
    async fn member_post(
        &self,
        room: &RoomRecord,
        bot: &Member,
        text: &str,
        id: Option<String>,
    ) -> R<Vec<Member>> {
        if let Some(id) = &id
            && room.messages.iter().any(|message| message.id == *id)
        {
            return Ok(Vec::new());
        }
        // The post it answers: the newest that asked this bot and is still open.
        let hops = room
            .messages
            .iter()
            .rev()
            .find(|message| {
                message
                    .turns
                    .iter()
                    .any(|turn| turn.bot == bot.id && turn.state == "asked")
            })
            .map_or(0, |message| message.hops + 1);
        self.rooms().change(&room.id, |record| {
            for turn in record
                .messages
                .iter_mut()
                .flat_map(|message| message.turns.iter_mut())
                .filter(|turn| turn.bot == bot.id && turn.state == "asked")
            {
                turn.state = "replied".to_owned();
            }
        });
        let now = self.now();
        let message = RoomMessage {
            id: id.unwrap_or_else(|| new_id("post")),
            at: iso(now.max(0.0) as u64),
            author: bot.id.clone(),
            name: bot.name.clone(),
            text: text.to_owned(),
            hops,
            ..RoomMessage::default()
        };
        let handed: Vec<Member> = if hops < HOPS_MAX {
            self.room_members_of(room)
                .into_iter()
                .filter(|member| member.id != bot.id && mentions(text, &member.name))
                .collect()
        } else {
            Vec::new()
        };
        self.room_ask(&room.id, message, &handed, now).await?;
        self.rooms().change(&room.id, |record| {
            record.seen.insert(bot.id.clone(), record.last_seq);
        });
        self.bots_changed();
        Ok(handed)
    }

    /// A paired host's bot posted in one of this computer's groups (`host.bots.roomPost`, told by main as
    /// `botsRoomPost {device, room, bot, text, id}`): kept as that member's post, once by its id.
    pub async fn bots_room_post(&self, post: &Value) -> R<Value> {
        let text = |key: &str| post.get(key).and_then(Value::as_str).unwrap_or("");
        let Some(room) = self.rooms().find(text("room")).cloned() else {
            return fail("That group is gone.");
        };
        let Some(member) = self.room_members_of(&room).into_iter().find(|member| {
            member.id == text("bot") && member.device.as_deref() == Some(text("device"))
        }) else {
            return fail("That bot is not in the group.");
        };
        let body = post_text(Some(text("text")))?;
        let id = Some(text("id").to_owned()).filter(|id| !id.is_empty());
        self.member_post(&room, &member, body, id).await?;
        Ok(json!({ "posted": true }))
    }

    /// A paired device's group asks one of this computer's bots (`roomAsk {id, room, roomName, mailId, text}`): the
    /// question goes to the bot's home chat here as the device's own room would put it, and the bot's post to that
    /// room goes back to the device (`AskedRoom`). The same mail id asked again is handed over once.
    pub(crate) async fn room_ask_here(
        &self,
        request: &Value,
        device: &str,
        device_name: &str,
    ) -> R<Value> {
        let text = |key: &str| request.get(key).and_then(Value::as_str).unwrap_or("");
        let bot = self.bot_named(text("id"))?;
        let Some(home) = bot.home.clone() else {
            return fail(format!(
                "{} has no chat yet: open its home chat once.",
                bot.name
            ));
        };
        let (room, name) = (text("room"), text("roomName"));
        if room.is_empty() || text("mailId").is_empty() {
            return fail("roomAsk needs room and mailId.");
        }
        self.across().remember(AskedRoom {
            bot: bot.id.clone(),
            room: room.to_owned(),
            name: name.to_owned(),
            device: device.to_owned(),
            device_name: device_name.to_owned(),
        });
        let from = format!("the group {name} on {device_name}");
        let mail = room_mail(text("mailId"), room, &from, text("text"), self.now());
        self.mail_session(&home, mail, true).await;
        Ok(json!({ "asked": true }))
    }

    /// A paired device stopped its group: the turn this computer's bot runs for it stops (`roomAskStop {id}`).
    pub(crate) async fn room_ask_stop(&self, request: &Value) -> R<Value> {
        let bot = self.bot_named(request.get("id").and_then(Value::as_str).unwrap_or(""))?;
        if let Some(home) = bot.home.as_deref() {
            self.stop_home(home).await;
        }
        Ok(json!({ "stopped": true }))
    }
}

/// A post's text, trimmed: refused when empty or past `POST_MAX`.
fn post_text(text: Option<&str>) -> R<&str> {
    let text = text.map(str::trim).unwrap_or("");
    if text.is_empty() {
        return fail("post needs text.");
    }
    if text.chars().count() > POST_MAX {
        return fail(format!("A post is at most {POST_MAX} characters."));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_at_name_mentions_a_bot_only_as_a_whole_name() {
        assert!(mentions("ask @Ada please", "ada"));
        assert!(mentions("@ada.", "Ada"));
        assert!(!mentions("@adam", "Ada"));
        assert!(!mentions("Ada", "Ada"));
        assert!(mentions("hi @Ada Lovelace!", "Ada Lovelace"));
    }

    #[test]
    fn the_reply_mode_picks_who_answers_the_owner() {
        let bot = |id: &str, name: &str| {
            Member::local(&BotRecord {
                id: id.into(),
                name: name.into(),
                ..BotRecord::default()
            })
        };
        let bots = vec![bot("b1", "Ada"), bot("b2", "Bo")];
        let ids = |mode: &str, text: &str| {
            repliers(mode, &bots, text)
                .into_iter()
                .map(|bot| bot.id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids("all", "hi"), ["b1", "b2"]);
        assert_eq!(ids("mentions", "hi"), Vec::<String>::new());
        assert_eq!(ids("mentions", "hi @bo"), ["b2"]);
        assert_eq!(ids("bot:b1", "hi"), ["b1"]);
        assert_eq!(ids("bot:b1", "hi @Bo"), ["b1", "b2"]);
    }

    #[test]
    fn the_context_keeps_the_newest_lines_that_fit() {
        let lines: Vec<String> = (0..10)
            .map(|n| format!("{n}{}", "x".repeat(5_000)))
            .collect();
        let kept = fit(lines);
        assert!(
            kept.starts_with('6') && kept.ends_with('x'),
            "{}",
            &kept[..2]
        );
        assert_eq!(kept.lines().count(), 4);
    }
}
