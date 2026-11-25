//! Session search works on JavaScript strings. The wire carries a snippet as a JSON string literal
//! because clipping at a UTF-16 offset can leave a surrogate that no Rust `String` can hold.
use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::Write;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::fs::order::is_js_space;

#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum Query {
    Text(String),
    Units(Vec<u16>),
}

pub(super) fn lowercase(text: &str) -> String {
    text.to_lowercase()
}

fn lower_units(units: &[u16]) -> Vec<u16> {
    let mut lower = Vec::with_capacity(units.len());
    let mut run = String::new();
    for c in char::decode_utf16(units.iter().copied()) {
        match c {
            Ok(c) => run.push(c),
            Err(lone) => {
                lower.extend(lowercase(&run).encode_utf16());
                run.clear();
                lower.push(lone.unpaired_surrogate());
            }
        }
    }
    lower.extend(lowercase(&run).encode_utf16());
    lower
}

impl Query {
    pub(super) fn tokens(&self) -> Vec<Token> {
        match self {
            Self::Text(query) => query
                .split(is_js_space)
                .filter(|s| !s.is_empty())
                .map(|s| Token(Needle::Text(lowercase(s), OnceLock::new())))
                .collect(),
            Self::Units(query) => query
                .split(|&u| char::from_u32(u.into()).is_some_and(is_js_space))
                .filter(|s| !s.is_empty())
                .map(|s| match String::from_utf16(s) {
                    Ok(s) => Token(Needle::Text(lowercase(&s), OnceLock::new())),
                    Err(_) => Token(Needle::Units(UnitPattern::new(lower_units(s)))),
                })
                .collect(),
        }
    }
}

pub(super) struct Token(Needle);

enum Needle {
    Text(String, OnceLock<UnitPattern>),
    Units(UnitPattern),
}

// KMP searches even a lone half of an emoji in linear time without converting cached files to UTF-16.
struct UnitPattern {
    units: Vec<u16>,
    prefix: Vec<usize>,
}

impl UnitPattern {
    fn new(units: Vec<u16>) -> Self {
        let mut prefix = vec![0; units.len()];
        let mut n = 0;
        for i in 1..units.len() {
            while n > 0 && units[i] != units[n] {
                n = prefix[n - 1];
            }
            n += usize::from(units[i] == units[n]);
            prefix[i] = n;
        }
        Self { units, prefix }
    }

    fn advance(&self, n: &mut usize, unit: u16) -> bool {
        while *n > 0 && self.units[*n] != unit {
            *n = self.prefix[*n - 1];
        }
        *n += usize::from(self.units[*n] == unit);
        *n == self.units.len()
    }

    fn find(&self, mut text: impl Iterator<Item = u16>) -> Option<usize> {
        let mut n = 0;
        text.position(|unit| self.advance(&mut n, unit))
            .map(|end| end + 1 - self.units.len())
    }
}

impl Token {
    pub(super) fn contains(&self, lower: &str) -> bool {
        match &self.0 {
            Needle::Text(s, _) => lower.contains(s),
            Needle::Units(p) => p.find(lower.encode_utf16()).is_some(),
        }
    }

    fn pattern(&self) -> &UnitPattern {
        match &self.0 {
            Needle::Text(s, units) => {
                units.get_or_init(|| UnitPattern::new(s.encode_utf16().collect()))
            }
            Needle::Units(p) => p,
        }
    }
}

// serde_json's byte-string decoder borrows unescaped strings and keeps lone escapes as WTF-8.
#[derive(Deserialize)]
#[serde(transparent)]
struct JsonString<'a>(#[serde(borrow)] Cow<'a, [u8]>);

fn runs(mut bytes: &[u8]) -> impl Iterator<Item = (&str, Option<u16>)> {
    std::iter::from_fn(move || {
        if bytes.is_empty() {
            return None;
        }
        match std::str::from_utf8(bytes) {
            Ok(text) => {
                bytes = &[];
                Some((text, None))
            }
            Err(e) => {
                let (valid, rest) = bytes.split_at(e.valid_up_to());
                let lone = 0xd000 | (u16::from(rest[1] & 63) << 6) | u16::from(rest[2] & 63);
                bytes = &rest[3..];
                Some((
                    std::str::from_utf8(valid).expect("valid UTF-8 prefix"),
                    Some(lone),
                ))
            }
        }
    })
}

fn contains_value(bytes: &[u8], token: &Token) -> bool {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return token.contains(&lowercase(s));
    }
    let pattern = token.pattern();
    let mut n = 0;
    runs(bytes).any(|(s, lone)| {
        lowercase(s)
            .encode_utf16()
            .chain(lone)
            .any(|unit| pattern.advance(&mut n, unit))
    })
}

type Hit<'a> = Option<Cow<'a, [u8]>>;

enum Frame<'a> {
    Array(Hit<'a>),
    Object {
        key: Option<Cow<'a, [u8]>>,
        fields: HashMap<Cow<'a, [u8]>, (usize, Hit<'a>)>,
    },
}

fn array_index(key: &[u8]) -> Option<u32> {
    if !key.first()?.is_ascii_digit() || (key.len() > 1 && key[0] == b'0') {
        return None;
    }
    std::str::from_utf8(key)
        .ok()?
        .parse()
        .ok()
        .filter(|n| *n != u32::MAX)
}

// RawValue validates the whole line, including trailing bytes, without rounding numbers or rejecting
// surrogate escapes. Fold each container to its first matching string without recursive stack use.
fn line_hit<'a>(line: &'a str, token: &Token) -> Option<(bool, Cow<'a, [u8]>)> {
    let mut rest = serde_json::from_str::<&RawValue>(line).ok()?.get();
    let mut stack = Vec::new();
    loop {
        let first = *rest.as_bytes().first()?;
        let mut message = false;
        let hit = match first {
            b'[' | b'{' => {
                stack.push(if first == b'[' {
                    Frame::Array(None)
                } else {
                    Frame::Object {
                        key: None,
                        fields: HashMap::new(),
                    }
                });
                rest = &rest[1..];
                continue;
            }
            b']' | b'}' => {
                rest = &rest[1..];
                match stack.pop()? {
                    Frame::Array(hit) => hit,
                    Frame::Object { mut fields, .. } => {
                        if stack.is_empty()
                            && let Some((_, hit)) = fields.remove(b"message".as_slice())
                        {
                            message = true;
                            hit
                        } else {
                            fields
                                .into_iter()
                                .filter_map(|(key, (order, hit))| {
                                    Some(((array_index(&key).unwrap_or(u32::MAX), order), hit?))
                                })
                                .min_by_key(|(order, _)| *order)
                                .map(|(_, hit)| hit)
                        }
                    }
                }
            }
            b'"' => {
                let mut strings =
                    serde_json::Deserializer::from_str(rest).into_iter::<JsonString<'_>>();
                let text = strings.next()?.ok()?.0;
                rest = &rest[strings.byte_offset()..];
                if let Some(Frame::Object { key, .. }) = stack.last_mut()
                    && key.is_none()
                {
                    *key = Some(text);
                    continue;
                }
                contains_value(&text, token).then_some(text)
            }
            b',' | b':' | b' ' | b'\t' | b'\r' | b'\n' => {
                rest = &rest[1..];
                continue;
            }
            _ => {
                // A validated number or literal. Its value is never quoted.
                let end = rest
                    .find([',', ']', '}', ' ', '\t', '\r', '\n'])
                    .unwrap_or(rest.len());
                rest = &rest[end..];
                None
            }
        };
        match stack.last_mut() {
            Some(Frame::Array(first @ None)) => *first = hit,
            Some(Frame::Array(Some(_))) => {}
            Some(Frame::Object { fields, key }) => {
                let order = fields.len();
                fields.entry(key.take()?).or_insert((order, None)).1 = hit;
            }
            None => return hit.map(|hit| (message, hit)),
        }
    }
}

// ECMAScript whitespace breaks case context, so lowercasing each scalar run before collapsing
// whitespace gives the same offsets as lowercasing the flat string. Never copy the whole message
// to UTF-16 just to keep a small window.
fn scan_flat(bytes: &[u8], lower: bool, mut next: impl FnMut(u16) -> bool) {
    let mut started = false;
    let mut space = false;
    for (s, lone) in runs(bytes) {
        let folded;
        let text = if lower {
            folded = lowercase(s);
            &folded
        } else {
            s
        };
        for unit in text.encode_utf16().chain(lone) {
            if char::from_u32(unit.into()).is_some_and(is_js_space) {
                space = started;
                continue;
            }
            if (space && !next(32)) || !next(unit) {
                return;
            }
            started = true;
            space = false;
        }
    }
}

fn clip(bytes: &[u8], token: &Token) -> Box<RawValue> {
    const CONTEXT: usize = 70;
    let needle = token.pattern();
    let mut matched = 0;
    let mut end_of_hit = 0;
    scan_flat(bytes, true, |unit| {
        end_of_hit += 1;
        !needle.advance(&mut matched, unit)
    });
    let (start, end) = if matched == needle.units.len() {
        (
            (end_of_hit - matched).saturating_sub(CONTEXT),
            end_of_hit + CONTEXT,
        )
    } else {
        // `indexOf` returned -1.
        (0, needle.units.len() + CONTEXT - 1)
    };
    let mut middle = Vec::new();
    let mut length = 0;
    scan_flat(bytes, false, |unit| {
        if (start..end).contains(&length) {
            middle.push(unit);
        }
        length += 1;
        length <= end
    });
    let middle = middle.strip_prefix(&[32]).unwrap_or(&middle);
    let middle = middle.strip_suffix(&[32]).unwrap_or(middle);
    let mut json = String::from("\"");
    if start > 0 {
        json.push('…');
    }
    for unit in char::decode_utf16(middle.iter().copied()) {
        match unit {
            Ok('"') => json.push_str("\\\""),
            Ok('\\') => json.push_str("\\\\"),
            Ok(c) if c >= ' ' => json.push(c),
            Ok(c) => write!(json, "\\u{:04x}", u32::from(c)).unwrap(),
            Err(e) => write!(json, "\\u{:04x}", e.unpaired_surrogate()).unwrap(),
        }
    }
    if length > end {
        json.push('…');
    }
    json.push('"');
    RawValue::from_string(json).expect("quoted UTF-16 slice")
}

pub(super) fn excerpt(
    raw: &str,
    lower: &str,
    same_utf16_len: bool,
    token: &Token,
) -> Option<Box<RawValue>> {
    if !same_utf16_len {
        return None;
    }
    let mut fallback = None;
    for (line, _) in raw
        .split('\n')
        .zip(lower.split('\n'))
        .filter(|(_, s)| token.contains(s))
        .take(50)
    {
        if let Some((message, hit)) = line_hit(line, token) {
            if message {
                return Some(clip(&hit, token));
            }
            fallback.get_or_insert(hit);
        }
    }
    fallback.map(|hit| clip(&hit, token))
}

#[cfg(test)]
#[path = "snippet_tests.rs"]
mod tests;
