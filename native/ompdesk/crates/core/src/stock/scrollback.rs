//! One output reader per worker generation. A worker hands off only the chunks since its previous
//! reply; it owns the PTY handles and names only the rows the caller may read. The side panel's saved terminals
//! (`crate::termhistory`) are written here too, from the scrollback this reader keeps, in the worker's order.
mod text;

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::PathBuf;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::server::{Fault, Registry, Reply};
use crate::termhistory::{self, Record};
use text::{Read, State};

const LIMIT: usize = 1_000_000;
/// How much of a terminal's output a checkpoint keeps (UTF-16 units).
const HISTORY: usize = 256 * 1024;

/// Each terminal's retained output, and the terminals whose saved history was removed in this generation: a
/// checkpoint taken before the close never writes one back.
#[derive(Default)]
pub(super) struct Scrollback(HashMap<String, VecDeque<u16>>, HashSet<String>);

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
    #[serde(borrow)]
    read: Option<Read<'a>>,
    history: Option<Kept>,
}

/// What a frame asks of the saved terminals under `<userData>/terminal-history/`: checkpoints to write (each record
/// as the worker knows it, the history added here) and closed terminals whose files go.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Kept {
    user_data: PathBuf,
    #[serde(default)]
    save: Vec<Record>,
    #[serde(default)]
    drop: Vec<String>,
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

pub(super) fn register(registry: &mut Registry) {
    registry.add("terminal.projectLegacy", |call| {
        Box::pin(async move {
            let input = call
                .bin
                .as_deref()
                .ok_or_else(|| Fault::new("invalid_params", "Missing legacy terminal rows"))?;
            let result = text::legacy(input)
                .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
            Ok(Reply::json(&())?.with_bin(result))
        })
    });
}

impl Scrollback {
    pub(super) fn project(&mut self, input: &[u8]) -> Result<Vec<u8>, serde_json::Error> {
        let Frame { id, terminal } = serde_json::from_slice(input)?;
        for removed in terminal.forget.into_iter().flatten() {
            self.0.remove(removed);
        }
        let mut reply = format!("{{\"id\":{id}").into_bytes();
        if terminal.rows.is_some() || terminal.read.is_some() {
            let mut rows = terminal.rows.unwrap_or_default();
            reply.extend_from_slice(b",\"result\":");
            if terminal.read.is_none() {
                reply.push(b'[');
            }
            for (index, row) in rows.iter_mut().enumerate() {
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
                if terminal.read.is_some() {
                    continue;
                }
                if index != 0 {
                    reply.push(b',');
                }
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
                serde_json::to_writer(&mut reply, row)?;
                reply.pop();
                reply.extend_from_slice(b",\"output\":\"");
                if let Some(ring) = ring {
                    write_units(&mut reply, ring.range(start..end).copied());
                }
                reply.extend_from_slice(b"\"}");
            }
            if let Some(read) = terminal.read {
                let ring = read
                    .index()
                    .and_then(|i| rows.get(i))
                    .and_then(|row| self.0.get(row.id));
                let states = rows.iter().map(|row| State {
                    exited: row.exited,
                    exit_code: row.exit_code,
                    error: row.error,
                });
                read.write(&mut reply, states, ring)?;
            } else {
                reply.push(b']');
            }
        }
        if let Some(kept) = terminal.history {
            self.keep(kept);
        }
        reply.push(b'}');
        Ok(reply)
    }

    /// Removes closed terminals' files and writes the checkpoints with each terminal's newest output, here on the
    /// reader, so a removal and a save land in the order the worker wrote them. Best effort: a failure is logged and
    /// the terminal's output still reaches its viewers.
    fn keep(&mut self, kept: Kept) {
        let dir = kept.user_data.join(termhistory::FOLDER);
        self.1.extend(kept.drop.iter().cloned());
        let records: Vec<Record> = kept
            .save
            .into_iter()
            .filter(|record| !self.1.contains(&record.id))
            .map(|record| Record {
                history: self.0.get(&record.id).map(tail).unwrap_or_default(),
                ..record
            })
            .collect();
        let done = termhistory::drop_ids(&dir, &kept.drop)
            .and_then(|()| termhistory::save(&dir, &records));
        if let Err(fault) = done {
            eprintln!(
                "ompdesk-core: couldn't keep terminal history in {}: {}",
                dir.display(),
                fault.message
            );
        }
    }
}

/// The newest `HISTORY` units of `ring`, from a line start where one is in the cut part, never half a pair.
fn tail(ring: &VecDeque<u16>) -> String {
    let mut start = ring.len().saturating_sub(HISTORY);
    if start > 0 {
        if let Some(line) = ring
            .range(start..ring.len() - 1)
            .position(|&unit| unit == u16::from(b'\n'))
        {
            start += line + 1;
        }
        if (0xdc00..=0xdfff).contains(&ring[start]) {
            start += 1;
        }
    }
    String::from_utf16_lossy(&ring.range(start..).copied().collect::<Vec<_>>())
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
    fn a_checkpoint_saves_the_scrollback_tail_and_a_closed_terminal_is_never_written_back() {
        let user_data = std::env::temp_dir().join(format!(
            "ompdesk-core-scrollback-keep-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&user_data);
        let dir = user_data.join(termhistory::FOLDER);
        let user = serde_json::to_string(&user_data).unwrap();
        let saved = || termhistory::list(&dir, "/s/a.jsonl", std::time::SystemTime::now());
        let mut history = Scrollback::default();
        let record = r#"{"session":"/s/a.jsonl","id":"t1","order":1,"cwd":"/w","exited":false}"#;
        let checkpoint = |id: u64| {
            format!(
                r#"{{"id":{id},"terminal":{{"rows":[{{"id":"t1","offset":5,"exited":false,"cols":80,"rows":24,"delta":"$ ls\n"}}],"history":{{"userData":{user},"save":[{record}]}}}}}}"#
            )
        };
        history.project(checkpoint(1).as_bytes()).unwrap();
        let kept = saved();
        assert_eq!(kept.len(), 1);
        assert_eq!(
            (kept[0].cwd.as_str(), kept[0].history.as_str()),
            ("/w", "$ ls\n")
        );
        let close = format!(
            r#"{{"id":2,"terminal":{{"rows":[],"forget":["t1"],"history":{{"userData":{user},"drop":["t1"]}}}}}}"#
        );
        history.project(close.as_bytes()).unwrap();
        assert!(saved().is_empty());
        history.project(checkpoint(3).as_bytes()).unwrap();
        assert!(
            saved().is_empty(),
            "a checkpoint taken before the close wrote it back"
        );
        let _ = std::fs::remove_dir_all(&user_data);
    }

    #[test]
    fn a_checkpoint_keeps_the_newest_output_from_a_line_start_never_half_a_pair() {
        let lines: VecDeque<u16> = format!("{}\n{}\n", "a".repeat(10), "b".repeat(HISTORY - 5))
            .encode_utf16()
            .collect();
        assert_eq!(tail(&lines), format!("{}\n", "b".repeat(HISTORY - 5)));
        let pairs: VecDeque<u16> = format!("{}x", "😀".repeat(HISTORY))
            .encode_utf16()
            .collect();
        let cut = tail(&pairs);
        assert!(cut.starts_with('😀'));
        assert_eq!(cut.encode_utf16().count(), HISTORY - 1);
    }

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

    #[test]
    fn invalid_pick_ingests_deltas_and_read_folds_crs_across_frames() {
        let mut history = Scrollback::default();
        let first = br#"{"id":1,"terminal":{"read":{"pick":"1e+21","lines":2},"rows":[{"id":"a","exited":false,"cols":80,"rows":24,"offset":5,"delta":"old\r\r"},{"id":"b","exited":true,"exitCode":7,"cols":80,"rows":24,"offset":4,"delta":"keep"}]}}"#;
        let invalid: serde_json::Value =
            serde_json::from_slice(&history.project(first).unwrap()).unwrap();
        assert_eq!(
            invalid["result"],
            "Terminal 1: running\nTerminal 2: exited 7\n\nThere is no terminal 1e+21."
        );
        let next = br#"{"id":2,"terminal":{"read":{"pick":"1","lines":2},"rows":[{"id":"a","exited":false,"cols":80,"rows":24,"offset":10,"delta":"\n\u0085\n\ufeff\n"}]}}"#;
        let reply: serde_json::Value =
            serde_json::from_slice(&history.project(next).unwrap()).unwrap();
        assert_eq!(
            reply["result"],
            "Terminal 1: running\n\nTerminal 1, 2 lines:\nold\n\u{85}"
        );
        let other = br#"{"id":3,"terminal":{"read":{"pick":"1","lines":1},"rows":[{"id":"b","exited":true,"cols":80,"rows":24,"offset":4}]}}"#;
        let reply: serde_json::Value =
            serde_json::from_slice(&history.project(other).unwrap()).unwrap();
        assert_eq!(
            reply["result"],
            "Terminal 1: exited ?\n\nTerminal 1, 1 lines:\nkeep"
        );
    }
}
