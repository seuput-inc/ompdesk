//! The newest turn's edit calls and their results, from either a saved transcript or pages of a live one.

use std::borrow::Cow;
use std::collections::HashSet;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use serde_json::{Map, Value};

use crate::server::Fault;
use crate::sidecar::bridge::Bridge;

#[derive(Deserialize, PartialEq)]
struct Text<'a>(#[serde(borrow)] Cow<'a, str>);

fn text(raw: Option<&RawValue>) -> Option<Cow<'_, str>> {
    let raw = raw?.get();
    if !raw.starts_with('"') {
        return None;
    }
    serde_json::from_str::<Text>(raw).ok().map(|s| s.0)
}

// Missing assistant timestamps are omitted, but an explicitly null timestamp stays on the message.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<&'de RawValue>, D::Error> {
    <&RawValue>::deserialize(d).map(Some)
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message<'a> {
    #[serde(borrow)]
    role: Option<&'a RawValue>,
    steering: Option<&'a RawValue>,
    #[serde(default, deserialize_with = "present")]
    timestamp: Option<&'a RawValue>,
    content: Option<&'a RawValue>,
    tool_call_id: Option<&'a RawValue>,
}

enum Role {
    Prompt,
    Assistant,
    Result,
    Other,
}

impl<'a> Message<'a> {
    fn read(raw: &'a RawValue) -> serde_json::Result<Self> {
        if raw.get().starts_with('{') {
            serde_json::from_str(raw.get())
        } else {
            Ok(Self::default())
        }
    }

    fn role(&self) -> Role {
        match text(self.role).as_deref() {
            Some("user") if self.steering.map(RawValue::get) != Some("true") => Role::Prompt,
            Some("assistant") => Role::Assistant,
            Some("toolResult") => Role::Result,
            _ => Role::Other,
        }
    }
}

#[derive(Deserialize)]
struct Block<'a> {
    #[serde(borrow, rename = "type")]
    kind: Option<&'a RawValue>,
    name: Option<&'a RawValue>,
    id: Option<&'a RawValue>,
}

fn keep_call(raw: &RawValue, calls: &mut HashSet<String>) -> bool {
    if !raw.get().starts_with('{') {
        return false;
    }
    let Ok(block) = serde_json::from_str::<Block>(raw.get()) else {
        return false;
    };
    if text(block.kind).as_deref() != Some("toolCall")
        || !matches!(
            text(block.name).as_deref(),
            Some("write" | "edit" | "ast_edit" | "apply_patch")
        )
    {
        return false;
    }
    if let Some(id) = text(block.id) {
        calls.insert(id.into_owned());
    }
    true
}

#[derive(Serialize)]
#[serde(untagged)]
enum Projection<'a> {
    Assistant {
        role: &'static str,
        content: Vec<&'a RawValue>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timestamp: Option<&'a RawValue>,
    },
    Raw(&'a RawValue),
}

fn timestamp(raw: Option<&RawValue>) -> Option<Projection<'_>> {
    raw.filter(|t| matches!(t.get().as_bytes()[0], b'"' | b'-' | b'0'..=b'9'))
        .map(Projection::Raw)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Turn<M> {
    cwd: String,
    started_at: Option<M>,
    ended_at: Option<M>,
    messages: Vec<M>,
}

struct Fold<M> {
    calls: HashSet<String>,
    messages: Vec<M>,
    started: Option<M>,
    ended: Option<M>,
}

impl<M: Clone> Fold<M> {
    fn new() -> Self {
        Self {
            calls: HashSet::new(),
            messages: Vec::new(),
            started: None,
            ended: None,
        }
    }

    fn append(
        &mut self,
        rows: &[&RawValue],
        final_page: bool,
        keep: impl Fn(Projection<'_>) -> serde_json::Result<M>,
    ) -> serde_json::Result<()> {
        for (index, &raw) in rows.iter().enumerate() {
            let message = Message::read(raw)?;
            match message.role() {
                Role::Prompt => {
                    self.started = timestamp(message.timestamp).map(&keep).transpose()?;
                    self.calls.clear();
                    self.messages.clear();
                }
                Role::Assistant => {
                    if let Some(content) = message.content.filter(|c| c.get().starts_with('[')) {
                        let mut blocks: Vec<&RawValue> = serde_json::from_str(content.get())?;
                        blocks.retain(|raw| keep_call(raw, &mut self.calls));
                        if !blocks.is_empty() {
                            self.messages.push(keep(Projection::Assistant {
                                role: "assistant",
                                content: blocks,
                                timestamp: message.timestamp,
                            })?);
                        }
                    }
                }
                Role::Result
                    if text(message.tool_call_id)
                        .is_some_and(|id| !id.is_empty() && self.calls.contains(id.as_ref())) =>
                {
                    self.messages.push(keep(Projection::Raw(raw))?);
                }
                _ => {}
            }
            if final_page && index + 1 == rows.len() {
                self.ended = match message.timestamp.filter(|t| t.get() != "null") {
                    Some(raw) => timestamp(Some(raw)).map(&keep).transpose()?,
                    None => self.started.clone(),
                };
            }
        }
        Ok(())
    }

    fn finish(self, cwd: String) -> Turn<M> {
        Turn {
            cwd,
            started_at: self.started,
            ended_at: self.ended,
            messages: self.messages,
        }
    }
}

pub(crate) fn saved(
    raw: &RawValue,
    cwd: &str,
    epoch: impl Fn(&Value) -> Value,
) -> serde_json::Result<Value> {
    let rows: Vec<&RawValue> = serde_json::from_str(raw.get())?;
    let mut start = 0;
    for (index, &row) in rows.iter().enumerate().rev() {
        if matches!(Message::read(row)?.role(), Role::Prompt) {
            start = index;
            break;
        }
    }
    let mut fold = Fold::new();
    fold.append(&rows[start..], true, |part| {
        part.serialize(serde_json::value::Serializer)
    })?;
    Ok(Value::Object(Map::from_iter([
        ("cwd".into(), Value::String(cwd.to_owned())),
        (
            "startedAt".into(),
            fold.started.as_ref().map_or(Value::Null, &epoch),
        ),
        (
            "endedAt".into(),
            fold.ended.as_ref().map_or(Value::Null, epoch),
        ),
        ("messages".into(), Value::Array(fold.messages)),
    ])))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page<'a> {
    #[serde(borrow)]
    leaf_id: Option<Text<'a>>,
    total: usize,
    start_index: Option<usize>,
    turn_start: Option<usize>,
    #[serde(borrow)]
    messages: Vec<&'a RawValue>,
}

fn bridge_json(error: serde_json::Error) -> Fault {
    Fault::new("bridge_error", error.to_string())
}

fn stale() -> Fault {
    Fault::new("stale_cursor", "Transcript changed while it was read")
}

async fn request(bridge: &Bridge, offset: usize, limit: usize) -> Result<Box<RawValue>, Fault> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Slice {
        offset: usize,
        limit: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_start: Option<bool>,
    }
    let params = Slice {
        offset,
        limit,
        turn_start: (limit == 0).then_some(true),
    };
    bridge
        .request(
            "sessions.transcript",
            Some(to_raw_value(&params).map_err(bridge_json)?),
            None,
        )
        .await?
        .ok_or_else(|| Fault::new("bridge_error", "Missing transcript page"))
}

pub(crate) async fn live(bridge: &Bridge, cwd: String) -> Result<impl Serialize, Fault> {
    let raw = request(bridge, 0, 0).await?;
    let head: Page = serde_json::from_str(raw.get()).map_err(bridge_json)?;
    let mut offset = head
        .turn_start
        .ok_or_else(|| Fault::new("bridge_error", "Missing turnStart in transcript head"))?;
    if offset > head.total.saturating_sub(1) {
        return Err(stale());
    }
    let mut fold = Fold::new();
    while offset < head.total {
        let limit = (head.total - offset).min(256);
        let raw = request(bridge, offset, limit).await?;
        let page: Page = serde_json::from_str(raw.get()).map_err(bridge_json)?;
        if page.leaf_id != head.leaf_id
            || page.total != head.total
            || page.start_index.is_some_and(|start| start != offset)
            || page.messages.len() != limit
        {
            return Err(stale());
        }
        offset += limit;
        fold.append(&page.messages, offset == head.total, |part| {
            to_raw_value(&part)
        })
        .map_err(bridge_json)?;
    }
    Ok(fold.finish(cwd))
}
