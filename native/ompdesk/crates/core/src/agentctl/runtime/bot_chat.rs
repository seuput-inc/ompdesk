//! Identity is issued only to a new local Bots lane. Legacy home/session paths remain delivery records.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};

use super::{RUNTIMES, Runtime, lock, runtime_of};
use crate::agentctl::journal::bots::{BotRecord, Bots};
use crate::agentctl::service::host::HostState;
use crate::server::{Call, Fault, Registry, Reply, at_once};

#[cfg(test)]
mod tests;

fn denied() -> Fault {
    Fault::new("bot_chat_unavailable", "This bot chat cannot be opened.")
}

// The control port is reused when main reconnects. A lane's selector must not survive that reconnect.
pub(super) fn new_port() -> Option<u64> {
    let mut bytes = [0; 8];
    crate::sys::random(&mut bytes).ok()?;
    Some(u64::from_le_bytes(bytes) >> 11) // exactly representable by JavaScript
}

fn current(selector: u64) -> Option<Arc<Runtime>> {
    let runtimes = lock(&RUNTIMES);
    let mut found = runtimes
        .values()
        .filter(|rt| rt.bot_chat_port == Some(selector) && !rt.control.host.port().is_closed());
    let rt = found.next()?;
    found.next().is_none().then(|| Arc::clone(rt))
}

fn stationary_bot<'a>(bots: &'a Bots, id: &str) -> Option<&'a BotRecord> {
    let suffix = id.strip_prefix("bot-")?;
    if suffix.len() != 12
        || !suffix
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut exact = bots.all().iter().filter(|bot| bot.id == id);
    let bot = exact.next()?;
    (exact.next().is_none() && bot.moving.is_none()).then_some(bot)
}

fn eligible<'a>(bots: &'a Bots, id: &str) -> Option<&'a BotRecord> {
    stationary_bot(bots, id).filter(|bot| !bot.paused)
}

#[derive(Clone, Copy)]
enum Target<'a> {
    New,
    Pinned(&'a str),
    Legacy,
}

fn target<'a>(
    bots: &'a Bots,
    state: &HostState,
    bot: &'a BotRecord,
    path: Option<&str>,
) -> Option<Target<'a>> {
    let Some(path) = path else {
        return Some(Target::New);
    };
    if !valid_path(path)
        || deleted_path(state, path)
        || bots.all().iter().any(|other| {
            other.id != bot.id
                && (other.has_session(path) || other.chat_pins.iter().any(|pin| pin.path == path))
        })
    {
        return None;
    }
    if let Some(pin) = bot.chat_pins.iter().find(|pin| pin.path == path) {
        return (!pin.id.is_empty() && state.deleted_at_id(&pin.id).is_none())
            .then_some(Target::Pinned(&pin.id));
    }
    bot.has_session(path).then_some(Target::Legacy)
}

fn valid_path(path: &str) -> bool {
    let path = Path::new(path);
    path.is_absolute()
        && path.extension().is_some_and(|ext| ext == "jsonl")
        && !path
            .components()
            .any(|part| part == std::path::Component::ParentDir)
}

// Accepted paths are absolute and contain no parent traversal. Compare to main's normalized
// tombstones without resolving a path or reading the filesystem during an effect check.
fn deleted_path(state: &HostState, path: &str) -> bool {
    state.deleted.by_path.iter().any(|tombstone| {
        tombstone.device.is_none() && Path::new(&tombstone.path) == Path::new(path)
    })
}

fn journal(path: &str) -> Option<File> {
    if !std::fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    File::open(path).ok()
}

// Stock writes its session header first or after its fixed-width title slot. Never scan the transcript.
fn saved_pair(file: File, id: &str, cwd: &str) -> bool {
    let mut reader = BufReader::new(file.take(32 * 1024));
    let mut line = String::new();
    for _ in 0..2 {
        line.clear();
        if !matches!(reader.read_line(&mut line), Ok(n) if n > 0) {
            break;
        }
        if let Ok(row) = serde_json::from_str::<Value>(&line)
            && row["type"] == "session"
        {
            return row["id"] == id && row["cwd"] == cwd;
        }
    }
    false
}

fn reopen_target<'a>(
    bots: &'a Bots,
    state: &HostState,
    bot: &'a BotRecord,
    path: Option<&str>,
) -> Option<Target<'a>> {
    let target = target(bots, state, bot, path)?;
    if bot.paused && !matches!(target, Target::Legacy) {
        return None;
    }
    if let Target::Pinned(id) = target
        && !saved_pair(journal(path?)?, id, &bot.folder)
    {
        return None;
    }
    Some(target)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Launch {
    port: u64,
    bot_id: String,
    // Require an explicit null for a new chat; a malformed or missing path never requests one.
    session_path: Value,
}

fn launch(params: Launch) -> Result<Value, Fault> {
    let path = match &params.session_path {
        Value::Null => None,
        Value::String(path) => Some(path.as_str()),
        _ => return Err(denied()),
    };
    let rt = runtime_of(params.port)?;
    let selector = rt.bot_chat_port.ok_or_else(denied)?;
    if rt.control.host.port().is_closed() {
        return Err(denied());
    }
    let bots = rt.control.bots();
    let bot = stationary_bot(&bots, &params.bot_id).ok_or_else(denied)?;
    let state = rt.control.host.state();
    let identity = match reopen_target(&bots, &state, bot, path).ok_or_else(denied)? {
        Target::New | Target::Pinned(_) => Some(&bot.id),
        Target::Legacy => {
            path.and_then(journal).ok_or_else(denied)?;
            None
        }
    };
    Ok(json!({"cwd": bot.folder, "sessionPath": path, "botId": identity, "botChatPort": selector}))
}

pub(super) fn register(registry: &mut Registry) {
    fn open(call: &Call) -> Result<Reply, Fault> {
        Reply::json(&launch(call.params()?)?)
    }
    registry.add("agentRuntime.botChatLaunch", |call| at_once(open(&call)));
}

/// The receiving core checks again. A legacy selector never opens an identity-bearing lane.
pub(crate) fn bot_chat_authority(
    port: u64,
    bot_id: &str,
    path: Option<&str>,
) -> Result<(String, Option<String>), Fault> {
    let rt = current(port).ok_or_else(denied)?;
    let bots = rt.control.bots();
    let bot = eligible(&bots, bot_id).ok_or_else(denied)?;
    let id = match reopen_target(&bots, &rt.control.host.state(), bot, path) {
        Some(Target::New) => None,
        Some(Target::Pinned(id)) => Some(id.to_owned()),
        _ => return Err(denied()),
    };
    Ok((bot.folder.clone(), id))
}

/// The lane captures these before a fresh spawn. A generic observation racing its first stock reply
/// may register the new path for delivery, but no previously registered path can be promoted.
pub(crate) fn bot_chat_prior_paths(port: u64, bot_id: &str) -> Result<HashSet<String>, Fault> {
    let rt = current(port).ok_or_else(denied)?;
    let bots = rt.control.bots();
    eligible(&bots, bot_id).ok_or_else(denied)?;
    let state = rt.control.host.state();
    Ok(bots
        .all()
        .iter()
        .flat_map(|bot| {
            bot.home
                .iter()
                .chain(&bot.sessions)
                .chain(bot.chat_pins.iter().map(|pin| &pin.path))
        })
        .chain(state.summaries(None).iter().map(|row| &row.session_path))
        .chain(
            state
                .tabs
                .iter()
                .filter(|tab| tab.device.is_none())
                .filter_map(|tab| tab.session_path.as_ref()),
        )
        .cloned()
        .collect())
}

pub(crate) fn bot_chat_matches(
    port: u64,
    bot_id: &str,
    cwd: &str,
    saved: Option<(&str, &str)>,
) -> bool {
    let Some(rt) = current(port) else {
        return false;
    };
    let bots = rt.control.bots();
    let Some(bot) = eligible(&bots, bot_id).filter(|bot| bot.folder == cwd) else {
        return false;
    };
    saved.is_none_or(|(path, id)| {
        matches!(target(&bots, &rt.control.host.state(), bot, Some(path)), Some(Target::Pinned(want)) if want == id)
    })
}

/// Called only for the lane's own matched get_state on the spawn that received the grant.
pub(crate) fn observe_bot_chat(
    port: u64,
    bot_id: &str,
    cwd: &str,
    expected_path: Option<&str>,
    path: &str,
    stock_id: &str,
) -> bool {
    if let Some(expected) = expected_path {
        return expected == path && bot_chat_matches(port, bot_id, cwd, Some((path, stock_id)));
    }
    let Some(rt) = current(port) else {
        return false;
    };
    let mut bots = rt.control.bots();
    let state = rt.control.host.state();
    if stock_id.trim().is_empty()
        || !valid_path(path)
        || eligible(&bots, bot_id).is_none_or(|bot| bot.folder != cwd)
        || state.deleted_at_id(stock_id).is_some()
        || deleted_path(&state, path)
        || bots.all().iter().any(|bot| {
            (bot.id != bot_id && bot.has_session(path))
                || bot
                    .chat_pins
                    .iter()
                    .any(|pin| pin.path == path || pin.id == stock_id)
        })
        || !journal(path).is_some_and(|file| saved_pair(file, stock_id, cwd))
        || bots.pin_chat(bot_id, path, stock_id).is_err()
    {
        return false;
    }
    drop(bots);
    rt.control.bots_changed();
    true
}
