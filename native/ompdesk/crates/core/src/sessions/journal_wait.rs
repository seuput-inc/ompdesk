//! Evidence for a stalled turn. Only the last message and its still-open tool names leave the core.
use std::collections::HashSet;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use super::activity::read_window;
use super::raw::{Object, Text};
use crate::server::{Fault, Reply};

const BYTES: u64 = 1024 * 1024;
const LINES: usize = 400;
const TOOLS: usize = 8;

#[derive(Deserialize)]
pub(super) struct Params {
    path: PathBuf,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Evidence<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools_at: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    journal: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    journal_at: Option<&'a RawValue>,
}

// Join JSON string literals without losing escaped lone surrogates in the diagnostic text.
fn joined<'a>(parts: impl Iterator<Item = &'a RawValue>, separator: &str) -> Box<RawValue> {
    let mut literal = String::from("\"");
    for (i, part) in parts.enumerate() {
        if i != 0 {
            literal.push_str(separator);
        }
        let quoted = part.get();
        literal.push_str(&quoted[1..quoted.len() - 1]);
    }
    literal.push('"');
    RawValue::from_string(literal).expect("joined JSON strings")
}

fn evidence(text: &str, truncated: bool) -> Evidence<'_> {
    let mut lines = text.split('\n');
    if truncated {
        lines.next();
    }
    let mut result = Evidence::default();
    let mut closed = HashSet::new();
    for line in lines.rev().filter(|s| !s.is_empty()).take(LINES) {
        let Ok(entry) = serde_json::from_str::<Object>(line) else {
            continue;
        };
        if !entry.is(b"type", b"message") {
            continue;
        }
        let Some(message) = entry.get(b"message").and_then(Object::parse) else {
            continue;
        };
        let time = entry.string(b"timestamp");
        if result.journal.is_none() {
            let parts = [message.string(b"role"), message.string(b"stopReason")];
            result.journal = Some(joined(parts.into_iter().flatten(), "/"));
            result.journal_at = time;
        }
        if message.is(b"role", b"toolResult") {
            if let Some(id) = message.decoded(b"toolCallId") {
                closed.insert(id);
            }
            continue;
        }
        // No call before this reply or prompt is still open. At most eight unresolved ids are named.
        if message.is(b"role", b"assistant")
            && let Some(blocks) = message
                .get(b"content")
                .and_then(|c| serde_json::from_str::<Vec<&RawValue>>(c.get()).ok())
        {
            let mut calls: Vec<(Text<'_>, &RawValue)> = Vec::new();
            for block in blocks {
                let Some(call) = Object::parse(block) else {
                    continue;
                };
                if call.is(b"type", b"toolCall")
                    && let Some(id) = call.decoded(b"id")
                    && !closed.contains(&id)
                    && let Some(name) = call.string(b"name")
                {
                    if let Some((_, old)) = calls.iter_mut().find(|(key, _)| *key == id) {
                        *old = name;
                    } else if calls.len() < TOOLS {
                        calls.push((id, name));
                    }
                }
            }
            if !calls.is_empty() {
                result.tools = Some(joined(calls.into_iter().map(|(_, name)| name), ", "));
                result.tools_at = time;
            }
        }
        break;
    }
    result
}

fn tail(path: &Path, bytes: &mut Vec<u8>) -> io::Result<bool> {
    let mut file = File::open(path)?;
    let end = file.metadata()?.len();
    let start = end.saturating_sub(BYTES);
    read_window(&mut file, start, end, bytes)?;
    Ok(start != 0)
}

pub(super) fn read(params: Params) -> Result<Reply, Fault> {
    let mut bytes = Vec::new();
    let Ok(truncated) = tail(&params.path, &mut bytes) else {
        return Reply::json(&Evidence::default());
    };
    Reply::json(&evidence(&String::from_utf8_lossy(&bytes), truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn captured_waits() {
        let call = |id, name: String| json!({"type":"toolCall","id":id,"name":name});
        let mut calls: Vec<_> = (0..10)
            .map(|i| call(i.to_string(), format!("t{i}")))
            .collect();
        calls.push(call("0".into(), "updated".into()));
        let at = "2026-11-20T00:00:00Z";
        let reply = json!({
            "type": "message", "timestamp": at,
            "message": {"role": "assistant", "stopReason": "toolUse", "content": calls}
        });
        let later = "2026-11-20T00:00:01Z";
        let result = json!({
            "type": "message", "timestamp": later,
            "message": {"role": "toolResult", "toolCallId": "1"}
        });
        let reset = json!({"type":"message","message":{"role":42,"stopReason":"later"}});
        let no_role = json!({"type":"message","timestamp":at,"message":{}});
        for (lines, want) in [
            (vec![], json!({})),
            (
                vec![&reply],
                json!({
                    "tools": "updated, t1, t2, t3, t4, t5, t6, t7", "toolsAt": at,
                    "journal": "assistant/toolUse", "journalAt": at
                }),
            ),
            (
                vec![&reply, &result],
                json!({
                    "tools": "updated, t2, t3, t4, t5, t6, t7, t8", "toolsAt": at,
                    "journal": "toolResult", "journalAt": later
                }),
            ),
            (vec![&reply, &result, &reset], json!({"journal":"later"})),
            (vec![&no_role], json!({"journal":"","journalAt":at})),
        ] {
            let text = lines
                .into_iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n");
            assert_eq!(serde_json::to_value(evidence(&text, false)).unwrap(), want);
        }
    }
}
