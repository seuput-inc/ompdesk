use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;

use serde_json::{Number, Value};

use super::reader::{Selection, lines};

const ENTRIES: usize = 100;

struct Event<'a> {
    line: &'a str,
    key: Cow<'a, str>,
    first: Option<String>,
}

fn array_index(key: &str) -> u32 {
    if key.len() > 1 && key.starts_with('0') {
        return u32::MAX;
    }
    if !key.as_bytes().first().is_some_and(u8::is_ascii_digit) {
        return u32::MAX;
    }
    key.parse().unwrap_or(u32::MAX)
}

// Only equality is observable here: JSON.parse creates doubles, and JSON.stringify visits integer keys first.
fn normalize(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(normalize),
        Value::Object(map) => {
            if map.keys().any(|key| array_index(key) != u32::MAX) {
                let mut pairs: Vec<_> = std::mem::take(map).into_iter().collect();
                pairs.sort_by_key(|(key, _)| array_index(key));
                map.extend(pairs);
            }
            map.values_mut().for_each(normalize);
        }
        Value::Number(n) => {
            if let Some(v) = n.as_f64() {
                *n = Number::from_f64(if v == 0.0 { 0.0 } else { v }).unwrap();
            }
        }
        _ => {}
    }
}

impl<'a> Event<'a> {
    fn parse(line: &'a str) -> Self {
        let Ok(Value::Object(mut map)) = serde_json::from_str::<Value>(line) else {
            return Self {
                line,
                key: Cow::Borrowed(line),
                first: None,
            };
        };
        let first = match map.shift_remove("timestamp") {
            Some(Value::String(t)) => Some(t),
            _ => None,
        };
        let mut key = Value::Object(map);
        normalize(&mut key);
        Self {
            line,
            key: Cow::Owned(key.to_string()),
            first,
        }
    }

    fn periodic(&self) -> bool {
        self.line.contains(r#""source":"app-update""#)
            && self.line.contains(r#""message":"check""#)
            && self.line.contains(r#""no-update""#)
    }
}

#[derive(Clone, Copy)]
struct Group<'a> {
    latest: &'a Event<'a>,
    first: Option<&'a str>,
    count: usize,
}

fn fold<'a>(events: impl Iterator<Item = &'a Event<'a>> + Clone) -> Vec<Group<'a>> {
    let mut periodic: HashMap<&str, Group<'a>> = HashMap::new();
    for event in events.clone().filter(|e| e.periodic()) {
        let group = periodic.entry(&event.key).or_insert(Group {
            latest: event,
            first: event.first.as_deref(),
            count: 0,
        });
        group.latest = event;
        group.count += 1;
    }
    let mut groups: Vec<Group<'a>> = Vec::new();
    for event in events {
        if let Some(group) = periodic.get(event.key.as_ref()) {
            if std::ptr::eq(group.latest, event) {
                groups.push(*group);
            }
        } else if let Some(last) = groups.last_mut().filter(|g| g.latest.key == event.key) {
            last.latest = event;
            last.count += 1;
        } else {
            groups.push(Group {
                latest: event,
                first: event.first.as_deref(),
                count: 1,
            });
        }
    }
    groups
}

fn newest(groups: &[Group<'_>]) -> Vec<String> {
    let mut out = Vec::new();
    for group in &groups[groups.len().saturating_sub(ENTRIES)..] {
        out.push(group.latest.line.to_owned());
        if group.count > 1 {
            let mut text = format!("… the line above {} times", group.count);
            if let Some(first) = group.first.filter(|t| !t.is_empty()) {
                text.push_str(", the first at ");
                text.push_str(first);
            }
            out.push(text);
        }
    }
    out
}

pub(super) fn read(profile: &Path) -> Vec<String> {
    let current = lines(profile, Selection::Current);
    let current: Vec<_> = current.iter().map(|s| Event::parse(s)).collect();
    let groups = fold(current.iter());
    if groups.len() >= ENTRIES {
        return newest(&groups);
    }
    let archive = lines(profile, Selection::Archive);
    if archive.is_empty() {
        return newest(&groups);
    }
    let older: Vec<_> = archive.iter().map(|s| Event::parse(s)).collect();
    newest(&fold(older.iter().chain(&current)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn folds_across_rotation_without_hiding_a_state_transition() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        fs::create_dir(&logs).unwrap();
        assert!(read(dir.path()).is_empty());
        let a = r#"{"timestamp":"a","message":"stop","details":{"1":2,"0":1.0}}"#;
        let b = r#"{"timestamp":"b","message":"stop","details":{"0":1,"1":2}}"#;
        let check = r#"{"timestamp":"c","source":"app-update","message":"check","details":{"event":"no-update"}}"#;
        let latest = check.replace("\"c\"", "\"d\"");
        fs::write(logs.join("gui-runtime.jsonl.1"), format!("start\n{a}\n")).unwrap();
        fs::write(
            logs.join("gui-runtime.jsonl"),
            format!("{b}\n{check}\nready\nfailed\nready\n{latest}\n"),
        )
        .unwrap();
        assert_eq!(
            read(dir.path()),
            [
                "start",
                b,
                "… the line above 2 times, the first at a",
                "ready",
                "failed",
                "ready",
                &latest,
                "… the line above 2 times, the first at c"
            ]
        );
        fs::write(
            logs.join("gui-runtime.jsonl"),
            (0..120).map(|n| format!("{n}\n")).collect::<String>(),
        )
        .unwrap();
        assert_eq!(
            read(dir.path()),
            (20..120).map(|n| n.to_string()).collect::<Vec<_>>()
        );
    }
}
