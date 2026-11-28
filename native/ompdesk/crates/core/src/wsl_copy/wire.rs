use std::borrow::Cow;
use std::fmt;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, Write};

use serde::de::{SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};

use super::catalog::{Status, Summary};
use super::{Checkpoint, invalid};
use crate::schedules::rules::{Local, date_parse};

const FRAME: usize = 4096;
const MAX_BYTES: u64 = 512 * 1024 * 1024;
const CHUNK: usize = 32 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Header {
    v: u8,
    session_key: String,
    spawn_id: String,
    stock_id: String,
    pub bytes: u64,
    pub source: String,
}

fn frame(input: &mut impl BufRead) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    input.take(FRAME as u64).read_until(b'\n', &mut line)?;
    if line.last() != Some(&b'\n') {
        return Err(invalid("missing or oversized checkpoint frame"));
    }
    Ok(line)
}

pub(super) fn header(
    input: &mut impl BufRead,
    key: &str,
    spawn: &str,
    stock: &str,
) -> io::Result<Header> {
    let mut h: Header = serde_json::from_slice(&frame(input)?)
        .map_err(|_| invalid("malformed checkpoint header"))?;
    if h.v != 1 || h.session_key != key || h.spawn_id != spawn || h.stock_id != stock {
        return Err(invalid("checkpoint binding mismatch"));
    }
    if h.bytes == 0 || h.bytes > MAX_BYTES {
        return Err(invalid("invalid checkpoint length"));
    }
    let number = |s: &str| {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid("invalid source identity"));
        }
        s.parse::<u64>()
            .map_err(|_| invalid("invalid source identity"))
    };
    let (dev, ino) = h
        .source
        .split_once(':')
        .ok_or_else(|| invalid("invalid source identity"))?;
    h.source = format!("{}:{}", number(dev)?, number(ino)?);
    Ok(h)
}

pub(super) fn body(input: &mut impl Read, file: &mut File, mut left: u64) -> io::Result<String> {
    let mut sha = Sha256::new();
    let mut buf = [0; CHUNK];
    while left > 0 {
        let cap = left.min(CHUNK as u64) as usize;
        let n = input.read(&mut buf[..cap])?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        file.write_all(&buf[..n])?;
        sha.update(&buf[..n]);
        left -= n as u64;
    }
    Ok(crate::hex(&sha.finalize()))
}

pub(super) fn seal(input: &mut impl BufRead, digest: &str) -> io::Result<()> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Seal {
        sha256: String,
    }
    let seal: Seal =
        serde_json::from_slice(&frame(input)?).map_err(|_| invalid("malformed seal"))?;
    if seal.sha256 != digest || !input.fill_buf()?.is_empty() {
        return Err(invalid("invalid seal or trailing checkpoint bytes"));
    }
    Ok(())
}

pub(super) fn extends(file: &mut File, h: &Header, base: &Checkpoint) -> io::Result<bool> {
    if h.source != base.source || h.bytes <= base.bytes {
        return Ok(false);
    }
    intact_prefix(file, base)
}

pub(super) fn intact_prefix(file: &mut File, base: &Checkpoint) -> io::Result<bool> {
    file.rewind()?;
    let mut input = file.take(base.bytes);
    let mut buf = [0; CHUNK];
    let mut sha = Sha256::new();
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            return Ok(input.limit() == 0 && crate::hex(&sha.finalize()) == base.sha256);
        }
        sha.update(&buf[..n]);
    }
}

pub(super) fn matches_span(mut span: File, snapshot: &mut File) -> io::Result<bool> {
    if span.metadata()?.len() > snapshot.metadata()?.len() {
        return Ok(false);
    }
    snapshot.rewind()?;
    let mut a = [0; CHUNK];
    let mut b = [0; CHUNK];
    loop {
        let n = span.read(&mut a)?;
        if n == 0 {
            return Ok(true);
        }
        snapshot.read_exact(&mut b[..n])?;
        if a[..n] != b[..n] {
            return Ok(false);
        }
    }
}

// Borrow fields from one reusable capped record. A 512 MiB checkpoint never requires a 512 MiB object graph.
#[derive(Deserialize)]
struct Row<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<&'a RawValue>,
    #[serde(borrow)]
    id: Option<&'a RawValue>,
    #[serde(borrow)]
    message: Option<&'a RawValue>,
    #[serde(borrow)]
    title: Option<&'a RawValue>,
    #[serde(borrow)]
    timestamp: Option<&'a RawValue>,
}

fn equals(raw: Option<&RawValue>, expected: &str) -> bool {
    let Some(text) = raw.map(RawValue::get) else {
        return false;
    };
    let Some(inner) = text.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
        return false;
    };
    if !inner.contains('\\') {
        return inner == expected;
    }
    // Even all-escaped UTF-16 cannot exceed six JSON bytes per expected UTF-8 byte.
    inner.len() <= expected.len().saturating_mul(6)
        && serde_json::from_str::<String>(text).is_ok_and(|s| s == expected)
}

fn record<'a>(
    source: &mut impl BufRead,
    buf: &'a mut Vec<u8>,
    limit: u64,
) -> io::Result<(Row<'a>, u64)> {
    buf.clear();
    let n = source.take(limit).read_until(b'\n', buf)?;
    if buf.last() != Some(&b'\n') {
        return Err(invalid("incomplete or oversized journal record"));
    }
    let text = std::str::from_utf8(buf).map_err(|_| invalid("journal is not UTF-8"))?;
    if !text.trim_start_matches([' ', '\t', '\r']).starts_with('{') {
        return Err(invalid("journal record is not an object"));
    }
    let row = serde_json::from_str(text).map_err(|_| invalid("invalid journal JSON"))?;
    Ok((row, n as u64))
}

#[derive(Deserialize)]
#[serde(transparent)]
struct Text<'a>(#[serde(borrow)] Cow<'a, str>);

fn text(raw: Option<&RawValue>) -> Option<Cow<'_, str>> {
    serde_json::from_str::<Text<'_>>(raw?.get())
        .ok()
        .map(|s| s.0)
}

fn date(raw: Option<&RawValue>) -> Option<i64> {
    let raw = raw?.get();
    let ms = raw.parse().ok().or_else(|| {
        let iso = raw.strip_prefix('"')?.strip_suffix('"')?;
        if iso.len() > 32 || !iso.ends_with('Z') {
            return None;
        }
        date_parse(iso, &Local)
    })?;
    (-62_167_219_200_000..=253_402_300_799_999)
        .contains(&ms)
        .then_some(ms)
}

// Render text only, never paths, nested tool input, image data or guest-provided host labels.
fn display(out: &mut String, s: &str, limit: usize) {
    for ch in s.trim().chars() {
        if out.len() + ch.len_utf8() > limit {
            break;
        }
        if ch.is_whitespace() {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
        } else if !ch.is_control()
            && !matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        {
            out.push(ch);
        }
    }
}

fn title(raw: Option<&RawValue>) -> Option<String> {
    let mut out = String::new();
    display(&mut out, text(raw)?.lines().next()?, 256);
    (!out.is_empty()).then_some(out)
}

// A single message may contain a large attachment. Borrow each block, retain only the bounded text.
struct Blocks<'a> {
    prompt: Option<&'a mut String>,
}

impl<'de> Visitor<'de> for Blocks<'_> {
    type Value = bool;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("message content blocks")
    }

    fn visit_seq<A: SeqAccess<'de>>(mut self, mut seq: A) -> Result<bool, A::Error> {
        #[derive(Deserialize)]
        struct Block<'a> {
            #[serde(rename = "type", borrow)]
            kind: Option<&'a RawValue>,
            #[serde(borrow)]
            text: Option<&'a RawValue>,
        }
        let mut tool_call = false;
        while let Some(raw) = seq.next_element::<&RawValue>()? {
            let Ok(block) = serde_json::from_str::<Block<'_>>(raw.get()) else {
                continue;
            };
            tool_call |= equals(block.kind, "toolCall");
            if let Some(out) = self.prompt.as_deref_mut()
                && out.len() < 1024
                && equals(block.kind, "text")
                && let Some(s) = text(block.text)
            {
                if !out.is_empty() {
                    out.push(' ');
                }
                display(out, &s, 1024);
            }
        }
        Ok(tool_call)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message<'a> {
    #[serde(borrow)]
    role: Option<&'a RawValue>,
    #[serde(borrow)]
    stop_reason: Option<&'a RawValue>,
    #[serde(borrow)]
    timestamp: Option<&'a RawValue>,
    #[serde(borrow)]
    content: Option<&'a RawValue>,
}

fn observe(row: &Row<'_>, s: &mut Summary) -> bool {
    let Some(m) = row
        .message
        .filter(|m| m.get().starts_with('{'))
        .and_then(|m| serde_json::from_str::<Message<'_>>(m.get()).ok())
        .filter(|m| m.role.is_some_and(|r| r.get().starts_with('"')))
    else {
        return false;
    };
    s.message_count += 1;
    if let Some(at) = date(m.timestamp).or_else(|| date(row.timestamp)) {
        s.modified = Some(at);
    }
    let user = equals(m.role, "user");
    let assistant = equals(m.role, "assistant");
    let prompt = user && s.first_message.is_empty();
    let mut tool_call = false;
    if let Some(content) = m.content
        && (prompt || assistant)
    {
        if content.get().starts_with('[') {
            let visitor = Blocks {
                prompt: prompt.then_some(&mut s.first_message),
            };
            tool_call = serde_json::Deserializer::from_str(content.get())
                .deserialize_seq(visitor)
                .unwrap_or(false);
        } else if prompt && let Some(value) = text(Some(content)) {
            display(&mut s.first_message, &value, 1024);
        }
    }
    s.status = if assistant {
        if equals(m.stop_reason, "error") {
            Status::Error
        } else if equals(m.stop_reason, "aborted") {
            Status::Aborted
        } else if equals(m.stop_reason, "length") || tool_call {
            Status::Interrupted
        } else {
            Status::Complete
        }
    } else if user {
        Status::Pending
    } else if equals(m.role, "toolResult") {
        Status::Interrupted
    } else {
        Status::Unknown
    };
    assistant
}

pub(super) fn records(
    file: &mut File,
    stock: &str,
    witness: Option<(&str, u64)>,
) -> io::Result<(bool, Summary)> {
    file.rewind()?;
    let mut input = BufReader::new(file);
    let mut buf = Vec::new();
    let header_limit = 64 * 1024;
    let (first, mut offset) = record(&mut input, &mut buf, header_limit)?;
    let has_slot = equals(first.kind, "title");
    let mut summary = Summary::default();
    let header = if has_slot {
        summary.title = title(first.title);
        let (header, n) = record(&mut input, &mut buf, header_limit - offset)?;
        offset += n;
        header
    } else {
        first
    };
    if !equals(header.kind, "session") || !equals(header.id, stock) {
        return Err(invalid("wrong stock session header"));
    }
    if !has_slot {
        summary.title = title(header.title);
    }
    summary.created = date(header.timestamp);
    let mut witnessed = false;
    let mut seen_id = false;
    while !input.fill_buf()?.is_empty() {
        let (row, n) = record(&mut input, &mut buf, 32 * 1024 * 1024)?;
        if equals(row.kind, "session") {
            return Err(invalid("second stock session header"));
        }
        let assistant = equals(row.kind, "message") && observe(&row, &mut summary);
        if let Some((wanted, baseline)) = witness
            && equals(row.id, wanted)
        {
            witnessed = !seen_id && offset >= baseline && assistant;
            seen_id = true;
        }
        offset += n;
    }
    Ok((witnessed, summary))
}
