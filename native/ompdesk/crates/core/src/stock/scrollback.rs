//! One output reader per worker generation. A worker hands off only the chunks since its previous
//! reply; it owns the PTY handles and names only the rows the caller may read.
use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::io::Write;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

const LIMIT: usize = 1_000_000;

#[derive(Default)]
pub(super) struct Scrollback(HashMap<String, VecDeque<u16>>);

#[derive(Deserialize)]
struct Frame<'a> {
    id: u64,
    #[serde(borrow)]
    terminal: Transfer<'a>,
}

#[derive(Deserialize)]
struct Transfer<'a> {
    #[serde(borrow)]
    rows: Option<Vec<Row<'a>>>,
    forget: Option<Vec<&'a str>>,
    budget: Option<usize>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Delta<'a> {
    Text(#[serde(borrow)] Cow<'a, str>),
    Units { utf16: &'a str },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Row<'a> {
    id: &'a str,
    offset: u64,
    exited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
    #[serde(borrow, skip_serializing_if = "Option::is_none")]
    error: Option<&'a RawValue>,
    cols: u32,
    rows: u32,
    #[serde(skip_serializing)]
    from: Option<u64>,
    #[serde(borrow, skip_serializing)]
    delta: Option<Delta<'a>>,
}

impl Scrollback {
    pub(super) fn project(&mut self, input: &[u8]) -> Result<Vec<u8>, serde_json::Error> {
        let Frame { id, terminal } = serde_json::from_slice(input)?;
        for removed in terminal.forget.into_iter().flatten() {
            self.0.remove(removed);
        }
        let mut reply = format!("{{\"id\":{id}").into_bytes();
        if let Some(rows) = terminal.rows {
            reply.extend_from_slice(b",\"result\":[");
            for (index, mut row) in rows.into_iter().enumerate() {
                if index != 0 {
                    reply.push(b',');
                }
                if let Some(delta) = row.delta.take() {
                    let ring = if self.0.contains_key(row.id) {
                        self.0.get_mut(row.id).expect("present")
                    } else {
                        self.0.entry(row.id.to_owned()).or_default()
                    };
                    let mut append = |unit| {
                        if ring.len() == LIMIT {
                            ring.pop_front();
                        }
                        ring.push_back(unit);
                    };
                    match delta {
                        Delta::Text(text) => text.encode_utf16().for_each(append),
                        Delta::Units { utf16 } => {
                            let bytes = STANDARD.decode(utf16).map_err(serde::de::Error::custom)?;
                            for &pair in bytes.as_chunks::<2>().0 {
                                append(u16::from_le_bytes(pair));
                            }
                        }
                    }
                }
                let ring = self.0.get(row.id);
                let len = ring.map_or(0, VecDeque::len);
                let base = row.offset.checked_sub(len as u64).ok_or_else(|| {
                    <serde_json::Error as serde::de::Error>::custom("invalid terminal offset")
                })?;
                let from = row.from.unwrap_or(row.offset).clamp(base, row.offset);
                let start = (from - base) as usize;
                let mut end = len;
                if let Some(budget) = terminal.budget.filter(|&budget| budget < len - start) {
                    end = start + budget;
                    if end > start && ring.is_some_and(|r| (0xd800..=0xdbff).contains(&r[end - 1]))
                    {
                        end -= 1;
                    }
                }
                row.offset = base + end as u64;
                serde_json::to_writer(&mut reply, &row)?;
                reply.pop();
                reply.extend_from_slice(b",\"output\":\"");
                if let Some(ring) = ring {
                    write_units(&mut reply, ring.range(start..end).copied());
                }
                reply.extend_from_slice(b"\"}");
            }
            reply.push(b']');
        }
        reply.push(b'}');
        Ok(reply)
    }
}

fn write_units(out: &mut Vec<u8>, units: impl Iterator<Item = u16>) {
    for ch in char::decode_utf16(units) {
        match ch {
            Ok('"') => out.extend_from_slice(br#"\""#),
            Ok('\\') => out.extend_from_slice(br"\\"),
            Ok(ch) if ch >= ' ' => out.extend_from_slice(ch.encode_utf8(&mut [0; 4]).as_bytes()),
            Ok(control) => write!(out, "\\u{:04x}", control as u32).expect("Vec write"),
            Err(lone) => write!(out, "\\u{:04x}", lone.unpaired_surrogate()).expect("Vec write"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_lone_units_even_when_the_budget_or_an_offset_starts_inside_a_pair() {
        let mut history = Scrollback::default();
        let mut read = |fields: &str, budget| {
            let line = format!(
                r#"{{"terminal":{{"rows":[{{"id":"t","offset":6,"exited":false,"cols":80,"rows":24,{fields}}}],"budget":{budget}}},"id":4}}"#
            );
            let bytes = history.project(line.as_bytes()).unwrap();
            String::from_utf8(bytes).unwrap()
        };
        let first = read(r#""delta":"ab😀cd","from":0"#, 3);
        assert!(first.contains(r#""output":"ab""#));
        assert!(first.contains(r#""offset":2"#));
        let second = read(r#""from":2"#, 3);
        assert!(second.contains(r#""output":"😀c""#));
        assert!(second.contains(r#""offset":5"#));
        assert!(read(r#""from":3"#, 1).contains(r#""output":"\ude00""#));
        assert!(read(r#""from":2"#, 1).contains(r#""offset":2"#));
    }
}
