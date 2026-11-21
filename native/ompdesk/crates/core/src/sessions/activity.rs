use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

use serde::Deserialize;
use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde_json::value::RawValue;

use crate::schedules::rules::{Local, date_parse};

const FIRST_WINDOW: u64 = 64 * 1024;
const LIMIT: u64 = 4 * 1024 * 1024;
const TIME_CLIP: i64 = 8_640_000_000_000_000;

#[derive(Deserialize)]
#[serde(field_identifier, rename_all = "lowercase")]
enum Field {
    Timestamp,
    Message,
    #[serde(other)]
    Other,
}

// Borrow the two fields without allocating the conversation content. Like JSON.parse, keep
// the last occurrence of a key. Both the entry and its message can have a timestamp.
#[derive(Default)]
struct Fields<'a> {
    timestamp: Option<&'a RawValue>,
    message: Option<&'a RawValue>,
}

impl<'de> Deserialize<'de> for Fields<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Object;
        impl<'de> Visitor<'de> for Object {
            type Value = Fields<'de>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a journal object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut fields = Fields::default();
                while let Some(key) = map.next_key()? {
                    match key {
                        Field::Timestamp => fields.timestamp = Some(map.next_value()?),
                        Field::Message => fields.message = Some(map.next_value()?),
                        Field::Other => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(fields)
            }
        }
        deserializer.deserialize_map(Object)
    }
}

fn message_time(line: &[u8]) -> Option<i64> {
    if !line.starts_with(br#"{"type":"message""#) {
        return None;
    }
    let text = String::from_utf8_lossy(line);
    let entry: Fields = serde_json::from_str(&text).ok()?;
    let own = entry
        .message
        .and_then(|raw| serde_json::from_str::<Fields>(raw.get()).ok())
        .and_then(|message| message.timestamp)
        .and_then(|raw| raw.get().parse::<f64>().ok())
        .filter(|ms| ms.is_finite());
    if let Some(ms) = own {
        // Preserve the selected invalid Date rather than reviving a journal or older time.
        let invalid = TIME_CLIP + 1;
        return Some((ms as i64).clamp(-invalid, invalid));
    }
    let raw = entry.timestamp?.get();
    if let Ok(date) = serde_json::from_str::<&str>(raw) {
        date_parse(date, &Local)
    } else {
        date_parse(&serde_json::from_str::<String>(raw).ok()?, &Local)
    }
}

/// Epoch milliseconds of the last dated stock message, or an out-of-TimeClip millisecond
/// for a finite message timestamp that produces an invalid JS Date. Journal dates use the
/// core's ECMAScript date-time parser, not the engine's guesses for nonstandard spellings.
pub(super) fn last_activity(file: &mut File, size: u64) -> io::Result<Option<i64>> {
    let mut buffer = Vec::new();
    let mut end = size;
    for window in [FIRST_WINDOW, FIRST_WINDOW * 4, FIRST_WINDOW * 16, LIMIT] {
        let start = size.saturating_sub(window);
        file.seek(SeekFrom::Start(start))?;
        buffer.clear();
        buffer.reserve_exact((end - start) as usize);
        file.take(end - start).read_to_end(&mut buffer)?;
        let mut lines = buffer.split(|&b| b == b'\n');
        if start != 0 {
            // Even a line-looking prefix may start inside a message. Only this fragment
            // needs reading again when the next window reaches farther back.
            end = start + lines.next().unwrap_or_default().len() as u64;
        }
        if let Some(time) = lines.rev().find_map(message_time) {
            return Ok(Some(time));
        }
        if start == 0 {
            break;
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn activity(journal: &[u8]) -> Option<i64> {
        let dir = crate::fs::disk::make_temp_dir("ompdesk-session-activity-").unwrap();
        let path = dir.join("journal.jsonl");
        fs::write(&path, journal).unwrap();
        let result = last_activity(&mut File::open(path).unwrap(), journal.len() as u64);
        fs::remove_dir_all(dir).unwrap();
        result.unwrap()
    }

    #[test]
    fn uses_the_last_complete_dated_message_in_file_order() {
        let journal = concat!(
            "{\"type\":\"message\",\"message\":{\"timestamp\":900}}\n",
            "{\"type\":\"message\",\"timestamp\":\"1970-01-01\",\"message\":{\"timestamp\":-7.9}}\r\n",
            "{\"type\":\"report\",\"message\":{\"timestamp\":123}}\n",
            "{\"type\":\"message\",\"timestamp\":123}\n",
            "{\"type\":\"message\",\"timestamp\":\"bad\"}\n",
            "{\"type\":\"message\",\"message\":{\"timestamp\":808},",
        );
        assert_eq!(activity(journal.as_bytes()), Some(-7));
        assert_eq!(
            activity(br#"{"type":"message","message":{"timestamp":0}}"#),
            Some(0)
        );
    }

    #[test]
    fn parses_journal_dates_only_when_the_message_has_no_finite_number() {
        let date = "1970-01-01T01:00:00.1234+01:00";
        for message in [
            "null",
            "[]",
            r#"{"timestamp":"17"}"#,
            r#"{"timestamp":1e400}"#,
        ] {
            let line = format!(r#"{{"type":"message","message":{message},"timestamp":"{date}"}}"#);
            assert_eq!(activity(line.as_bytes()), Some(123));
        }
        for ms in [-TIME_CLIP - 1, -TIME_CLIP, TIME_CLIP, TIME_CLIP + 1] {
            let line = format!(
                r#"{{"type":"message","message":{{"timestamp":{ms}}},"timestamp":"{date}"}}"#
            );
            assert_eq!(activity(line.as_bytes()), Some(ms));
        }
    }

    #[test]
    fn grows_windows_but_never_counts_a_cut_first_line() {
        let line = br#"{"type":"message","message":{"timestamp":17}}"#;
        let mut journal = line.to_vec();
        journal.push(b'\n');
        journal.resize(4 * 1024 * 1024, b'x');
        // At the limit, the file's first byte is reachable and the first line is whole.
        assert_eq!(activity(&journal), Some(17));
        // The largest window now starts on something that only looks like a message.
        journal.insert(0, b'x');
        assert_eq!(activity(&journal), None);
        // A newline inside that same final window restores a complete message.
        journal.insert(1, b'\n');
        journal.pop();
        assert_eq!(activity(&journal), Some(17));
    }
}
