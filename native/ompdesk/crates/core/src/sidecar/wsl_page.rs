//! Hydration reads a pinned verified version, not live RPC or guest-provided filenames.
use super::wsl_boundary;
use crate::{server::Fault, wsl_copy::Session};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Seek, SeekFrom},
};

fn invalid() -> Fault {
    Fault::new(
        "wsl_transcript_unavailable",
        "The verified WSL transcript cannot be read.",
    )
}
fn stale() -> Fault {
    Fault::new("stale_cursor", "The verified WSL transcript has changed.")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record<'a> {
    #[serde(rename = "type")]
    ty: &'a str,
    id: Option<&'a str>,
    parent_id: Option<&'a str>,
    #[serde(borrow)]
    message: Option<Message<'a>>,
}
#[derive(Deserialize)]
struct Message<'a> {
    role: Option<&'a str>,
}
struct Node {
    parent: Option<usize>,
    text_at: Option<u64>,
}

pub(super) fn read(session: &Session, request: &Value) -> Result<Value, Fault> {
    let (version, file) = session
        .verified()
        .map_err(|_| invalid())?
        .ok_or_else(invalid)?;
    let version = version.sha256;
    let cursor = request["cursor"].as_str();
    let (back, offset) = match cursor {
        None => (request["fromEnd"] == true, None),
        Some(s) => {
            let mut parts = s.split(':');
            if parts.next() != Some(version.as_str()) {
                return Err(stale());
            }
            let back = match parts.next() {
                Some("b") => true,
                Some("f") => false,
                _ => return Err(stale()),
            };
            let n = parts
                .next()
                .and_then(|n| n.parse::<usize>().ok())
                .ok_or_else(stale)?;
            if parts.next().is_some() {
                return Err(stale());
            }
            (back, Some(n))
        }
    };
    let mut reader = BufReader::new(file);
    let mut bytes = Vec::new();
    let mut at = 0;
    let mut nodes: Vec<Node> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    loop {
        bytes.clear();
        let n = reader
            .read_until(b'\n', &mut bytes)
            .map_err(|_| invalid())?;
        if n == 0 {
            break;
        }
        let row: Record = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let start = at;
        at += n as u64;
        if matches!(row.ty, "session" | "title") {
            continue;
        }
        let Some(id) = row.id else {
            continue;
        };
        if id.len() > 128 || nodes.len() >= 1_000_000 {
            return Err(invalid());
        }
        let parent = row
            .parent_id
            .map(|id| by_id.get(id).copied().ok_or_else(invalid))
            .transpose()?;
        let text_at = (row.ty == "message"
            && matches!(row.message.and_then(|m| m.role), Some("user" | "assistant")))
        .then_some(start);
        if by_id.insert(id.to_owned(), nodes.len()).is_some() {
            return Err(invalid());
        }
        nodes.push(Node { parent, text_at });
    }
    let mut leaf = nodes.len().checked_sub(1);
    let mut offsets = Vec::new();
    while let Some(i) = leaf {
        let n = &nodes[i];
        if let Some(at) = n.text_at {
            offsets.push(at);
        }
        leaf = n.parent;
    }
    offsets.reverse();
    let total = offsets.len();
    if cursor.is_none() && back && request["ifVersion"].as_str() == Some(&version) {
        return Ok(json!({"version":version,"unchanged":true,"totalMessages":total,"messages":[]}));
    }
    let offset = offset.unwrap_or(if back { total } else { 0 });
    if offset > total {
        return Err(stale());
    }
    let limit = request["limit"].as_u64().unwrap_or(100).clamp(1, 256) as usize;
    let (mut start, mut end) = if back {
        (offset.saturating_sub(limit), offset)
    } else {
        (offset, total.min(offset + limit))
    };
    let mut messages = Vec::new();
    let mut size = 0;
    for n in 0..end - start {
        let i = if back { end - 1 - n } else { start + n };
        reader
            .seek(SeekFrom::Start(offsets[i]))
            .map_err(|_| invalid())?;
        bytes.clear();
        reader
            .read_until(b'\n', &mut bytes)
            .map_err(|_| invalid())?;
        let row: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let mut m = wsl_boundary::message(&row["message"]).ok_or_else(invalid)?;
        if let Some(id) = wsl_boundary::token(&row["id"]) {
            m["entryId"] = id.into();
        }
        size += serde_json::to_vec(&m).map_err(|_| invalid())?.len();
        if size > 4 * 1024 * 1024 {
            if messages.is_empty() {
                return Err(invalid());
            }
            if back {
                start = i + 1;
            } else {
                end = i;
            }
            break;
        }
        messages.push(m);
    }
    if back {
        messages.reverse();
    }
    let mut page =
        json!({"version":version,"totalMessages":total,"startIndex":start,"messages":messages});
    if back && start > 0 {
        page["prevCursor"] = format!("{version}:b:{start}").into();
    }
    if !back && end < total {
        page["nextCursor"] = format!("{version}:f:{end}").into();
    }
    Ok(page)
}
