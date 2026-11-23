//! Disk cursor for the single Pace fold in main, where stock's check and poll classifiers run.
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};

use crate::fs::disk::mtime_ms;
use crate::server::{Fault, Reply};

const PAGE: u64 = 1 << 20;
const SEAM: usize = 256;

#[derive(Deserialize, Serialize)]
struct Cursor {
    // An inode can exceed the integer precision of the JavaScript caller.
    file: String,
    size: u64,
    mtime: f64,
    offset: u64,
    seam: [u8; 32],
    more: bool,
}

#[derive(Deserialize)]
pub(super) struct Params {
    path: PathBuf,
    cursor: Option<Cursor>,
}

#[derive(Serialize)]
struct Page {
    reset: bool,
    cursor: Cursor,
}

#[cfg(unix)]
fn identity(_: &File, meta: &std::fs::Metadata) -> io::Result<String> {
    use std::os::unix::fs::MetadataExt;
    Ok(format!("{}:{}", meta.dev(), meta.ino()))
}

#[cfg(windows)]
fn identity(file: &File, _: &std::fs::Metadata) -> io::Result<String> {
    let (volume, index, _) = crate::sys::file_identity(file)?;
    Ok(format!("{volume}:{index}"))
}

// The caller parses the selected JSON fields with JavaScript, including dates, duplicate keys
// (last wins), lone UTF-16 surrogates and numbers outside serde_json::Number's range.
#[derive(Deserialize, Eq, Hash, PartialEq)]
#[serde(transparent)]
struct Text<'a>(#[serde(borrow)] Cow<'a, [u8]>);

#[derive(Deserialize)]
#[serde(transparent)]
struct Object<'a>(#[serde(borrow)] HashMap<Text<'a>, &'a RawValue>);

impl<'a> Object<'a> {
    fn parse(raw: &'a RawValue) -> Option<Self> {
        if !raw.get().starts_with('{') {
            return None;
        }
        serde_json::from_str(raw.get()).ok()
    }

    fn get(&self, key: &'static str) -> Option<&'a RawValue> {
        self.0.get(&Text(Cow::Borrowed(key.as_bytes()))).copied()
    }

    fn is(&self, key: &'static str, value: &[u8]) -> bool {
        self.get(key)
            .filter(|raw| raw.get().starts_with('"'))
            .and_then(|raw| serde_json::from_str::<Text>(raw.get()).ok())
            .is_some_and(|s| s.0.as_ref() == value)
    }
}

#[derive(Clone, Copy)]
enum Keep {
    Raw,
    Fields(&'static [(&'static str, Keep)]),
    Array(&'static Keep),
    Message,
    Calls,
    Receipts,
}

use Keep::{Array, Calls, Fields, Message, Raw, Receipts};

const STAMP: (&str, Keep) = ("timestamp", Raw);
const ROLE: (&str, Keep) = ("role", Raw);
const CALL: &[(&str, Keep)] = &[
    ("type", Raw),
    ("id", Raw),
    ("name", Raw),
    (
        "arguments",
        Fields(&[("command", Raw), ("path", Raw), ("async", Raw)]),
    ),
];
const JOB: Keep = Fields(&[
    ("id", Raw),
    ("type", Raw),
    ("status", Raw),
    ("durationMs", Raw),
    ("settledAtMs", Raw),
]);
const ASSISTANT: &[(&str, Keep)] = &[
    ROLE,
    STAMP,
    ("usage", Fields(&[("output", Raw)])),
    ("content", Calls),
];
const RESULT: &[(&str, Keep)] = &[
    ROLE,
    STAMP,
    ("toolName", Raw),
    ("toolCallId", Raw),
    ("isError", Raw),
    ("useless", Raw),
    (
        "details",
        Fields(&[
            ("op", Raw),
            ("async", Fields(&[("jobId", Raw)])),
            ("jobs", Array(&JOB)),
        ]),
    ),
    ("content", Receipts),
];

fn array(raw: &RawValue) -> Option<Vec<&RawValue>> {
    if !raw.get().starts_with('[') {
        return None;
    }
    serde_json::from_str(raw.get()).ok()
}

// Each check receipt matches within one text line. Keep candidates, not tool output or images;
// CHECK_SAVED in the fold remains the sole parser of the receipt format.
fn receipt_lines(raw: &RawValue, found: &mut String) {
    if !raw.get().starts_with('"') {
        return;
    }
    let Ok(text) = serde_json::from_str::<Text>(raw.get()) else {
        return;
    };
    // Replacing a lone surrogate cannot change a receipt's ASCII id or seconds.
    let text = String::from_utf8_lossy(&text.0);
    let mut rest = text.as_ref();
    while let Some(at) = rest.find("ompdesk check:") {
        let matched = &rest[at..];
        let (line, after) = matched.split_once('\n').unwrap_or((matched, ""));
        found.push_str(line);
        found.push('\n');
        rest = after;
    }
}

fn fields(obj: &Object<'_>, keys: &[(&'static str, Keep)], out: &mut Vec<u8>) {
    out.push(b'{');
    for &(key, nested) in keys {
        if let Some(value) = obj.get(key) {
            if out.last() != Some(&b'{') {
                out.push(b',');
            }
            out.push(b'"');
            out.extend_from_slice(key.as_bytes());
            out.extend_from_slice(b"\":");
            select(value, nested, out);
        }
    }
    out.push(b'}');
}

fn select(raw: &RawValue, keep: Keep, out: &mut Vec<u8>) {
    match keep {
        Raw => out.extend_from_slice(raw.get().as_bytes()),
        Message | Fields(_) => {
            let Some(obj) = Object::parse(raw) else {
                return select(raw, Raw, out);
            };
            let keys = match keep {
                Fields(keys) => keys,
                _ if obj.is("role", b"assistant") => ASSISTANT,
                _ if obj.is("role", b"toolResult") => RESULT,
                _ => &[ROLE, STAMP],
            };
            fields(&obj, keys, out);
        }
        Calls | Array(_) => {
            let Some(parts) = array(raw) else {
                // Assistant prose without a content array is not a call.
                if matches!(keep, Calls) {
                    out.extend_from_slice(b"[]");
                } else {
                    select(raw, Raw, out);
                }
                return;
            };
            out.push(b'[');
            for part in parts {
                if let Array(nested) = keep {
                    select(part, *nested, out);
                } else if part.get() == "null" {
                    // A null part makes the old fold fail instead of reporting incomplete stats.
                    select(part, Raw, out);
                } else if let Some(obj) = Object::parse(part)
                    && obj.is("type", b"toolCall")
                {
                    fields(&obj, CALL, out);
                } else {
                    continue;
                }
                out.push(b',');
            }
            if out.last() == Some(&b',') {
                out.pop();
            }
            out.push(b']');
        }
        Receipts => {
            let mut found = String::new();
            if let Some(parts) = array(raw) {
                for part in parts {
                    if let Some(text) = Object::parse(part).and_then(|obj| obj.get("text")) {
                        receipt_lines(text, &mut found);
                    }
                }
            } else {
                receipt_lines(raw, &mut found);
            }
            serde_json::to_writer(out, &found).expect("writing to a Vec");
        }
    }
}

fn project(obj: &Object<'_>, out: &mut Vec<u8>) {
    let keys: &[(&str, Keep)] = if obj.is("type", b"message") {
        &[("type", Raw), STAMP, ("message", Message)]
    } else if obj.is("type", b"custom") && obj.is("customType", b"tool_execution_start") {
        &[
            ("type", Raw),
            ("customType", Raw),
            STAMP,
            ("data", Fields(&[("toolCallId", Raw)])),
            ("message", Fields(&[STAMP])),
        ]
    } else {
        return;
    };
    fields(obj, keys, out);
    out.push(b'\n');
}

fn seam(file: &mut File, offset: u64) -> io::Result<[u8; 32]> {
    let size = offset.min(SEAM as u64) as usize;
    let mut bytes = [0; SEAM];
    file.seek(SeekFrom::Start(offset - size as u64))?;
    file.read_exact(&mut bytes[..size])?;
    Ok(Sha256::digest(&bytes[..size]).into())
}

fn page(params: Params) -> io::Result<Option<(Page, Vec<u8>)>> {
    let mut file = File::open(params.path)?;
    let meta = file.metadata()?;
    let id = identity(&file, &meta)?;
    let mut size = meta.len();
    let mut mtime = mtime_ms(&meta);
    let mut offset = 0;
    let mut reset = true;
    if let Some(old) = params.cursor
        && old.file == id
        && old.offset <= size
        && old.offset <= old.size
        && (!old.more || size >= old.size)
    {
        if !old.more && size == old.size && mtime == old.mtime {
            return Ok(None);
        }
        if seam(&mut file, old.offset)? == old.seam {
            reset = false;
            offset = old.offset;
            if old.more {
                size = old.size;
                mtime = old.mtime;
            }
        }
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut reader = BufReader::new((&mut file).take(size - offset));
    let stop = size.min(offset.saturating_add(PAGE));
    let mut line = Vec::new();
    let mut rows = Vec::new();
    let mut more = false;
    while offset < stop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        let raw = String::from_utf8_lossy(&line);
        if let Ok(obj) = serde_json::from_str::<Object>(&raw) {
            project(&obj, &mut rows);
        } else if raw.trim_matches([' ', '\t', '\r', '\n']) == "null" {
            // Accessing a property of a JSON null failed the read in TypeScript.
            return Err(io::Error::other("null journal entry"));
        } else if !line.ends_with(b"\n") && serde_json::from_str::<&RawValue>(&raw).is_err() {
            break;
        }
        offset += n as u64;
        more = offset >= stop && offset < size;
    }
    let seam = seam(&mut file, offset)?;
    let cursor = Cursor {
        file: id,
        size,
        mtime,
        offset,
        seam,
        more,
    };
    Ok(Some((Page { reset, cursor }, rows)))
}

pub(super) fn read(params: Params) -> Result<Reply, Fault> {
    match page(params).map_err(|err| Fault::new("pace_read", err.to_string()))? {
        Some((page, rows)) => Ok(Reply::json(&page)?.with_bin(rows)),
        None => Reply::json(&()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn complete_lines_consumed_by_the_typescript_reader() {
        let dir = crate::fs::disk::make_temp_dir("ompdesk-pace-").unwrap();
        let path = dir.join("session.jsonl");
        for (bytes, offset) in [
            (&b""[..], 0),
            (b"bad\n", 4),
            (b"bad", 0),
            (b"{}\r\n{\"type\":", 4),
            (b"{}\r\n{}", 6),
            (b"  1e400", 7),
        ] {
            fs::write(&path, bytes).unwrap();
            let (p, rows) = page(Params {
                path: path.clone(),
                cursor: None,
            })
            .unwrap()
            .unwrap();
            assert!(rows.is_empty());
            assert!(p.reset);
            assert!(!p.cursor.more);
            assert_eq!(p.cursor.offset, offset);
            assert_eq!(
                p.cursor.seam[..],
                Sha256::digest(&bytes[..offset as usize])[..]
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pages_stop_at_the_first_stat_and_do_not_send_conversation_text() {
        let dir = crate::fs::disk::make_temp_dir("ompdesk-pace-").unwrap();
        let path = dir.join("session.jsonl");
        let row = |role, n| {
            format!(
                "{{\"type\":\"message\",\"message\":{{\"timestamp\":0,\"role\":\"{role}\",\"content\":\"{}\"}}}}\n",
                "x".repeat(n)
            )
        };
        let tail = row("user", 200);
        fs::write(&path, row("assistant", PAGE as usize) + &tail).unwrap();
        let take = |cursor| {
            page(Params {
                path: path.clone(),
                cursor,
            })
            .unwrap()
            .unwrap()
        };
        let (first, rows) = take(None);
        assert!(first.cursor.more);
        assert_eq!(
            rows.as_slice(),
            b"{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"timestamp\":0,\"content\":[]}}\n"
        );
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(tail.as_bytes())
            .unwrap();
        let (second, rows) = take(Some(first.cursor));
        assert!(!second.cursor.more && !second.reset);
        assert_eq!(
            rows.as_slice(),
            b"{\"type\":\"message\",\"message\":{\"role\":\"user\",\"timestamp\":0}}\n"
        );
        let (third, appended) = take(Some(second.cursor));
        assert!(!third.reset);
        assert_eq!(appended, rows);
        fs::remove_dir_all(dir).unwrap();
    }
}
