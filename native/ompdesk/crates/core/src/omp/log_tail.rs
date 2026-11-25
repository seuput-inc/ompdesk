//! The last lines of a slow-starting omp's own log. Stock names these by pid and local calendar day.

use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;

use crate::control::js::is_blank;
use crate::remote::events::js;
use crate::server::Fault;

const TAIL_BYTES: u64 = 16_384;
const TAIL_LINES: usize = 8;
const LINE_UNITS: usize = 240;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Params {
    logs_dir: PathBuf,
    pid: u32,
    today: String,
    spawn_day: String,
}

pub(super) fn read(params: Params) -> Result<Vec<String>, Fault> {
    for day in std::iter::once(&params.today)
        .chain((params.spawn_day != params.today).then_some(&params.spawn_day))
    {
        if !day.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
            continue;
        }
        let path = params
            .logs_dir
            .join(format!("omp.{day}.{}.log", params.pid));
        let Ok(mut file) = File::open(path) else {
            continue;
        };
        let fail = |error: std::io::Error| Fault::new("read_failed", error.to_string());
        let size = file.metadata().map_err(fail)?.len();
        let start = size.saturating_sub(TAIL_BYTES);
        file.seek(SeekFrom::Start(start)).map_err(fail)?;
        let mut bytes = Vec::with_capacity((size - start) as usize);
        file.take(size - start)
            .read_to_end(&mut bytes)
            .map_err(fail)?;
        let text = String::from_utf8_lossy(&bytes);
        // If the entire tail is one unterminated line, keep it as the original reader did.
        let text = if start > 0 {
            text.split_once('\n')
                .map_or(text.as_ref(), |(_, tail)| tail)
        } else {
            &text
        };
        let mut lines: Vec<_> = text
            .rsplit('\n')
            .filter(|s| !is_blank(s))
            .take(TAIL_LINES)
            .map(compact)
            .collect();
        lines.reverse();
        return Ok(lines);
    }
    Ok(Vec::new())
}

fn compact(line: &str) -> String {
    let Ok(Value::Object(fields)) = serde_json::from_str(&crate::json::whole_surrogates(line))
    else {
        return line.to_owned();
    };
    let mut text = String::new();
    if let Some(time) = fields.get("timestamp").and_then(Value::as_str) {
        if time.is_ascii() {
            text.push_str(time.get(11..time.len().min(19)).unwrap_or_default());
        } else {
            let units = time.encode_utf16().skip(11).take(8);
            text.extend(
                char::decode_utf16(units).map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER)),
            );
        }
    }
    for key in ["level", "message"] {
        if let Some(value) = fields.get(key).filter(|v| !v.is_null()) {
            let word = match value {
                Value::String(s) => Cow::Borrowed(s.as_str()),
                _ => Cow::Owned(js::string_of(Some(value))),
            };
            if !word.is_empty() {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(&word);
            }
        }
    }
    for (key, value) in fields {
        if matches!(key.as_str(), "timestamp" | "level" | "pid" | "message") {
            continue;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&key);
        text.push('=');
        match value {
            Value::String(value) => text.push_str(&value),
            value => text.push_str(&js::stringify(&value)),
        }
    }
    if text.len() > LINE_UNITS && text.encode_utf16().nth(LINE_UNITS).is_some() {
        text = crate::json::utf16_prefix(&text, LINE_UNITS - 1);
        text.push('…');
    }
    text
}
