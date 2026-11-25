//! The automatic title shown beside a typed session name. The mutable first-line slot gates the
//! scan; journal entries, not the slot text, decide which two titles to compare.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};

use serde_json::Value;

use crate::fs::order::js_trim;

const SLOT_BYTES: usize = 2048;
const CHUNK_BYTES: usize = 1024 * 1024;
const AUTO_ENTRY: &str = "ompdesk.auto-title";

#[derive(Default)]
pub(super) struct TitleScan {
    size: u64,
    // An unfinished line is reread from here, including any unfinished UTF-8 character.
    offset: u64,
    typed: Option<String>,
    automatic: Option<String>,
}

impl TitleScan {
    pub(super) fn shown(&self) -> Option<&str> {
        let typed = self.typed.as_deref()?;
        self.automatic
            .as_deref()
            .filter(|s| js_trim(s) != js_trim(typed))
    }

    fn entry(&mut self, bytes: &[u8]) {
        let line = String::from_utf8_lossy(bytes);
        if !line.contains("\"title_change\"") && !line.contains(AUTO_ENTRY) {
            return;
        }
        let Ok(mut entry) = serde_json::from_str::<Value>(&line) else {
            return;
        };
        match entry["type"].as_str() {
            Some("title_change") => {
                let automatic = entry["source"] == "auto" || entry["trigger"] == "ompdesk-auto";
                let title = take_title(&mut entry);
                if automatic {
                    self.typed = None;
                    if title.is_some() {
                        self.automatic = title;
                    }
                } else {
                    self.typed = title;
                }
            }
            Some("custom") if entry["customType"] == AUTO_ENTRY => {
                if let Some(title) = entry.get_mut("data").and_then(take_title) {
                    self.automatic = Some(title);
                }
            }
            _ => {}
        }
    }
}

fn take_title(entry: &mut Value) -> Option<String> {
    match entry.get_mut("title")?.take() {
        Value::String(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}

pub(super) fn read_title(
    file: &mut File,
    size: u64,
    previous: Option<TitleScan>,
) -> io::Result<Option<TitleScan>> {
    file.rewind()?;
    let mut head = [0; SLOT_BYTES];
    let limit = size.min(SLOT_BYTES as u64) as usize;
    let n = file.read(&mut head[..limit])?;
    let first = head[..n].split(|&b| b == b'\n').next().unwrap_or_default();
    if !serde_json::from_str::<Value>(&String::from_utf8_lossy(first))
        .is_ok_and(|v| v["type"] == "title" && v["source"] == "user")
    {
        return Ok(None);
    }

    // The caller has already served unchanged stamps. A changed stamp at equal size can be a rewrite.
    let mut scan = previous.filter(|s| s.size < size).unwrap_or_default();
    scan.size = size;
    file.seek(SeekFrom::Start(scan.offset))?;
    let unread = size - scan.offset;
    let mut reader =
        BufReader::with_capacity(unread.min(CHUNK_BYTES as u64) as usize, file.take(unread));
    let mut carry = Vec::new();
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            break;
        }
        for part in chunk.split_inclusive(|&b| b == b'\n') {
            if part.last() != Some(&b'\n') {
                carry.extend_from_slice(part);
                continue;
            }
            scan.offset += (carry.len() + part.len()) as u64;
            if carry.is_empty() {
                scan.entry(part);
            } else {
                carry.extend_from_slice(part);
                scan.entry(&carry);
                carry.clear();
            }
        }
        let consumed = chunk.len();
        reader.consume(consumed);
    }
    Ok(Some(scan))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    const SLOT: &str = "{\"type\":\"title\",\"source\":\"user\"}\n";
    const TYPED: &str = "{\"type\":\"title_change\",\"title\":\"Mine\"}\n";

    struct Journal(PathBuf);

    impl Journal {
        fn new() -> Self {
            Self(crate::fs::disk::make_temp_dir("ompdesk-title-").unwrap())
        }

        fn file(&self, data: &[u8]) -> File {
            let path = self.0.join("session.jsonl");
            fs::write(&path, data).unwrap();
            File::open(path).unwrap()
        }

        fn scan(&self, text: &str, previous: Option<TitleScan>) -> Option<TitleScan> {
            read_title(&mut self.file(text.as_bytes()), text.len() as u64, previous).unwrap()
        }
    }

    impl Drop for Journal {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn beside(s: &str) -> String {
        format!(
            "{}\n",
            json!({"type":"custom", "customType":"ompdesk.auto-title", "data":{"title":s}})
        )
    }

    #[test]
    fn resumes_at_the_last_newline_even_inside_a_utf8_character() {
        let dir = Journal::new();
        let prefix = format!("{SLOT}{TYPED}{}", beside("old"));
        let text = format!("{prefix}{}", beside("한국어"));
        let mut file = dir.file(text.as_bytes());
        let mut previous = None;
        for end in [text.find('한').unwrap() + 1, text.len() - 1, text.len()] {
            let scan = read_title(&mut file, end as u64, previous)
                .unwrap()
                .unwrap();
            let expected = if end == text.len() {
                "한국어"
            } else {
                "old"
            };
            assert_eq!(scan.shown(), Some(expected));
            previous = Some(scan);
        }
    }

    #[test]
    fn decodes_a_character_split_across_two_read_chunks() {
        let dir = Journal::new();
        let custom = beside("🚲");
        let pad = CHUNK_BYTES - 1 - SLOT.len() - TYPED.len() - custom.find('🚲').unwrap();
        let text = format!("{SLOT}{TYPED}{}{custom}", " ".repeat(pad));
        assert_eq!(dir.scan(&text, None).unwrap().shown(), Some("🚲"));
    }

    #[test]
    fn rescans_replacements_and_rechecks_the_slot_on_growth() {
        let dir = Journal::new();
        let mut previous = None;
        for title in ["first", "other", "new"] {
            let text = format!("{SLOT}{TYPED}{}", beside(title));
            previous = dir.scan(&text, previous);
            assert_eq!(previous.as_ref().unwrap().shown(), Some(title));
        }
        let automatic_slot = SLOT.replace("user", "auto");
        let text = format!("{automatic_slot}{TYPED}{}", beside("much longer"));
        assert!(dir.scan(&text, previous).is_none());
        assert!(
            dir.scan(&format!("{}{SLOT}", " ".repeat(SLOT_BYTES)), None)
                .is_none()
        );
    }

    #[test]
    fn compares_only_nonempty_titles_using_javascript_trim_and_preserves_the_text() {
        let dir = Journal::new();
        let mut text = SLOT.to_owned();
        let mut previous = None;
        for (line, shown) in [
            (
                r#"{"type":"title_change","source":"auto","title":"Stock"}"#,
                None,
            ),
            (TYPED.trim_end(), Some("Stock")),
            (
                r#"{"type":"title_change","source":"user","trigger":"ompdesk-auto","title":"Bridge"}"#,
                None,
            ),
            (TYPED.trim_end(), Some("Bridge")),
            (
                r#"{"type":"custom","customType":"ompdesk.auto-title","data":{"title":"\ufeffMine "}}"#,
                None,
            ),
            (
                r#"{"type":"custom","customType":"ompdesk.auto-title","data":{"title":"\u0085Mine "}}"#,
                Some("\u{85}Mine "),
            ),
            (
                r#"{"type":"custom","customType":"ompdesk.auto-title","data":{"title":""}}"#,
                Some("\u{85}Mine "),
            ),
            (
                r#"{"type":"title_change","source":"auto","title":""}"#,
                None,
            ),
            (TYPED.trim_end(), Some("\u{85}Mine ")),
            (r#"{"type":"title_change","title":42}"#, None),
        ] {
            text.push_str(line);
            text.push('\n');
            previous = dir.scan(&text, previous);
            assert_eq!(previous.as_ref().unwrap().shown(), shown);
        }
    }
}
