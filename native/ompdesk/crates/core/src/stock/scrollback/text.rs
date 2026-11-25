//! The text `gui_terminal_read` returns. Only the selected terminal supplies scrollback.
use std::borrow::Cow;
use std::collections::VecDeque;
use std::io::Write;
use std::ops::Range;

use serde::Deserialize;
use serde::de::Error;
use serde_json::value::RawValue;

use super::write_units;
use crate::fs::order::is_js_space;
use crate::remote::codec::scan::unescape;
use crate::sidecar::strip_vt_control_characters;

#[derive(Deserialize)]
pub(super) struct Read<'a> {
    pick: &'a str,
    lines: u16,
}

pub(super) struct State<'a> {
    pub(super) exited: bool,
    pub(super) exit_code: Option<i64>,
    pub(super) error: Option<&'a RawValue>,
}

fn string_inner(value: &RawValue) -> Result<&str, serde_json::Error> {
    value
        .get()
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .ok_or_else(|| serde_json::Error::custom("expected terminal text"))
}

impl Read<'_> {
    pub(super) fn index(&self) -> Option<usize> {
        self.pick.parse::<usize>().ok()?.checked_sub(1)
    }

    pub(super) fn write<'a>(
        &self,
        out: &mut Vec<u8>,
        rows: impl ExactSizeIterator<Item = State<'a>>,
        ring: Option<&VecDeque<u16>>,
    ) -> Result<(), serde_json::Error> {
        if !(1..=2000).contains(&self.lines) {
            return Err(serde_json::Error::custom("invalid terminal line count"));
        }
        let count = rows.len();
        if count == 0 {
            out.extend_from_slice(b"null");
            return Ok(());
        }
        out.push(b'"');
        for (i, row) in rows.enumerate() {
            if i > 0 {
                out.extend_from_slice(br"\n");
            }
            write!(out, "Terminal {}: ", i + 1).expect("Vec write");
            if let Some(error) = row
                .error
                .map(string_inner)
                .transpose()?
                .filter(|s| !s.is_empty())
            {
                out.extend_from_slice(b"failed: ");
                out.extend_from_slice(error.as_bytes());
            } else if row.exited {
                out.extend_from_slice(b"exited ");
                if let Some(code) = row.exit_code {
                    write!(out, "{code}").expect("Vec write");
                } else {
                    out.push(b'?');
                }
            } else {
                out.extend_from_slice(b"running");
            }
        }
        out.extend_from_slice(br"\n\n");
        if self.index().is_none_or(|index| index >= count) {
            out.extend_from_slice(b"There is no terminal ");
            write_units(out, self.pick.encode_utf16());
            out.extend_from_slice(b".\"");
            return Ok(());
        }
        out.extend_from_slice(b"Terminal ");
        write_units(out, self.pick.encode_utf16());
        out.extend_from_slice(b", ");
        let empty = VecDeque::new();
        let ring = ring.unwrap_or(&empty);
        let wanted = usize::from(self.lines);
        if ring.iter().any(|&u| matches!(u, 0x1b | 0x9b)) {
            // One scalar per JS unit. Surrogates use a disjoint plane, so an OSC can span them
            // and newlines without a lossy UTF-8 conversion or a second VT matcher.
            let encoded: String = ring.iter().map(|&u| encode_unit(u)).collect();
            if let Cow::Owned(clean) = strip_vt_control_characters(&encoded) {
                write_tail(
                    out,
                    wanted,
                    clean.len(),
                    clean
                        .char_indices()
                        .rev()
                        .map(|(at, c)| (at, decode_unit(c))),
                    |out, range| write_units(out, clean[range].chars().map(decode_unit)),
                );
                return Ok(());
            }
        }
        write_tail(
            out,
            wanted,
            ring.len(),
            ring.iter().copied().enumerate().rev(),
            |out, range| write_units(out, ring.range(range).copied()),
        );
        Ok(())
    }
}

fn encode_unit(unit: u16) -> char {
    char::from_u32(u32::from(unit)).unwrap_or_else(|| {
        char::from_u32(0x10000 + u32::from(unit - 0xd800)).expect("surrogate carrier")
    })
}

fn decode_unit(c: char) -> u16 {
    let scalar = u32::from(c);
    if scalar >= 0x10000 {
        (scalar - 0x10000) as u16 + 0xd800
    } else {
        scalar as u16
    }
}

// The offsets address either a wrapped UTF-16 ring or the stripped string. Keep just the
// visible spans of requested lines. Once those are found only the older LF count matters.
fn write_tail(
    out: &mut Vec<u8>,
    wanted: usize,
    mut end: usize,
    backwards: impl Iterator<Item = (usize, u16)>,
    emit: impl Fn(&mut Vec<u8>, Range<usize>),
) {
    let mut units = backwards.peekable();
    let mut spans = Vec::new();
    let mut total = 0;
    loop {
        let mut start = end;
        let mut blank = true;
        while let Some((at, unit)) = units.next_if(|&(_, u)| u != 10 && u != 13) {
            start = at;
            blank = blank && char::from_u32(u32::from(unit)).is_some_and(is_js_space);
        }
        if total > 0 || !blank {
            spans.push(start..end);
            total += 1;
        }
        let Some((lf, _)) = units.find(|&(_, u)| u == 10) else {
            break;
        };
        if spans.len() == wanted {
            total += 1 + units.filter(|&(_, u)| u == 10).count();
            break;
        }
        end = lf;
        while let Some((cr, _)) = units.next_if(|&(_, u)| u == 13) {
            end = cr;
        }
    }
    if total > spans.len() {
        write!(out, "last {} of ", spans.len()).expect("Vec write");
    }
    write!(out, "{total} lines:\\n").expect("Vec write");
    for (i, span) in spans.into_iter().rev().enumerate() {
        if i > 0 {
            out.extend_from_slice(br"\n");
        }
        emit(out, span);
    }
    out.push(b'"');
}

#[derive(Deserialize)]
struct Legacy<'a> {
    #[serde(borrow)]
    read: Read<'a>,
    #[serde(borrow)]
    rows: Vec<LegacyRow<'a>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRow<'a> {
    exited: bool,
    exit_code: Option<i64>,
    #[serde(borrow)]
    error: Option<&'a RawValue>,
    #[serde(borrow)]
    output: Option<&'a RawValue>,
}

pub(super) fn legacy(input: &[u8]) -> Result<Vec<u8>, serde_json::Error> {
    let Legacy { read, rows } = serde_json::from_slice(input)?;
    let selected = read.index().and_then(|i| rows.get(i));
    let ring = if let Some(row) = selected {
        let raw = row
            .output
            .ok_or_else(|| serde_json::Error::custom("missing selected terminal output"))?;
        Some(VecDeque::from(unescape(string_inner(raw)?.as_bytes())))
    } else {
        None
    };
    let mut result = Vec::new();
    let states = rows.into_iter().map(|row| State {
        exited: row.exited,
        exit_code: row.exit_code,
        error: row.error,
    });
    read.write(&mut result, states, ring.as_ref())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_keeps_lone_units_but_drops_the_whole_multiline_osc() {
        let input = br#"{"read":{"pick":"2","lines":1},"rows":[{"exited":true,"error":"bad\ud800"},{"exited":true,"output":"old\n\udc00\u001b]hidden\ud802\ntext\u001b\\\ud801\n\ufeff"}]}"#;
        let actual = legacy(input).unwrap();
        assert_eq!(
            actual.as_slice(),
            br#""Terminal 1: failed: bad\ud800\nTerminal 2: exited ?\n\nTerminal 2, last 1 of 2 lines:\n\udc00\ud801""#
        );
    }

    #[test]
    fn agent_reads_the_tail_of_a_full_ring_of_colored_status_lines() {
        let output = "\u{1b}[32mready\u{1b}[0m!\n".repeat(62_500);
        assert_eq!(output.len(), super::super::LIMIT);
        let input = serde_json::json!({
            "id": 1,
            "terminal": {
                "read": { "pick": "1", "lines": 2 },
                "rows": [{ "id": "t", "exited": false, "offset": output.len(),
                    "cols": 80, "rows": 24, "delta": output }]
            }
        });
        let mut history = super::super::Scrollback::default();
        let bytes = history
            .project(&serde_json::to_vec(&input).unwrap())
            .unwrap();
        let reply: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            reply["result"],
            "Terminal 1: running\n\nTerminal 1, last 2 of 62500 lines:\nready!\nready!"
        );
    }
}
