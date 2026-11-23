use serde::{Deserialize, de::IgnoredAny};
use serde_json::{Value, json, value::RawValue};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
};

pub(super) struct LogTail {
    bytes: Vec<u8>,
    truncated: bool,
}

impl LogTail {
    pub(super) fn read(mut file: File, limit: u64) -> io::Result<Self> {
        let size = file.metadata()?.len();
        let length = size.min(limit);
        if size > length {
            file.seek(SeekFrom::Start(size - length))?;
        }
        let mut bytes = Vec::with_capacity(length as usize);
        file.take(length).read_to_end(&mut bytes)?;
        Ok(Self {
            bytes,
            truncated: size > length,
        })
    }

    pub(super) fn newest(&self) -> impl Iterator<Item = &[u8]> {
        let mut rows = self.bytes.split(|&b| b == b'\n');
        if self.truncated {
            rows.next();
        }
        rows.rev().filter(|line| !line.is_empty())
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Row<'a> {
    pid: Value,
    #[serde(borrow)]
    source: Option<&'a RawValue>,
    #[serde(borrow)]
    details: Option<&'a RawValue>,
}

fn row(text: &str) -> Option<Row<'_>> {
    let first = text
        .trim_start_matches([' ', '\t', '\r'])
        .as_bytes()
        .first()?;
    match first {
        b'{' => serde_json::from_str(text).ok(),
        // JSON.parse treated an array as an object with no pid or source.
        b'[' => serde_json::from_str::<IgnoredAny>(text)
            .ok()
            .map(|_| Row::default()),
        _ => None,
    }
}

#[derive(Deserialize)]
struct End {
    end: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct LastLine {
    timestamp: Value,
    app_version: Value,
}

fn previous_end(tail: &LogTail, own_pid: u32) -> Option<Value> {
    let mut rows = tail.newest().take(400).filter_map(|line| {
        let text = String::from_utf8_lossy(line);
        let row = row(&text)?;
        let pid = row.pid.as_f64();
        if pid == Some(f64::from(own_pid)) {
            return None;
        }
        let quit = row.source.is_some_and(|raw| {
            let source = raw.get();
            source == r#""app-quit""#
                || (source.contains('\\')
                    && serde_json::from_str::<String>(source).is_ok_and(|s| s == "app-quit"))
        });
        let end = quit
            && row.details.is_some_and(|raw| {
                raw.get().starts_with('{')
                    && serde_json::from_str::<End>(raw.get()).is_ok_and(|r| r.end)
            });
        Some((line, pid, quit, end))
    });
    let last = rows.next()?;
    let last_line = last.0;
    let pid = last.1?;
    let mut same_run = true;
    let mut has_quit = false;
    for (_, row_pid, quit, end) in std::iter::once(last).chain(rows) {
        same_run &= row_pid == Some(pid);
        if !quit {
            continue;
        }
        has_quit = true;
        if !same_run {
            break;
        }
        if end {
            return None;
        }
    }
    if !has_quit {
        return None;
    }
    let last: LastLine = serde_json::from_str(&String::from_utf8_lossy(last_line)).ok()?;
    let at = last.timestamp.as_str();
    Some(json!({
        "source": "app-quit",
        "message": format!("The previous run (pid {pid}) ended without a reason: no end line, so it was killed (force quit, SIGKILL), crashed or lost power; its last line was at {}", at.unwrap_or("an unknown time")),
        "details": {"previousPid": pid, "lastLineAt": at, "previousVersion": last.app_version.as_str()}
    }))
}

pub(crate) fn previous_run_end(file: io::Result<File>, own_pid: u32) -> Value {
    file.and_then(|file| LogTail::read(file, 256 * 1024))
        .ok()
        .and_then(|tail| previous_end(&tail, own_pid))
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(lines: &str) -> Option<Value> {
        previous_end(
            &LogTail {
                bytes: lines.as_bytes().to_vec(),
                truncated: false,
            },
            300,
        )
    }

    #[test]
    fn the_window_counts_nonempty_lines_before_parsing_or_skipping_own_pid() {
        let old = "{\"pid\":100,\"source\":\"app-quit\"}\n";
        let own = "\n{\"pid\":300,\"source\":\"app-quit\"}\n";
        let last = "{\"pid\":200}\n";
        let log = format!("{old}{}{last}", own.repeat(398));
        assert_eq!(
            read(&log).unwrap()["details"]["previousPid"].as_f64(),
            Some(200.0)
        );
        assert!(read(&format!("{log}not-json\n")).is_none());
        assert!(read(&format!("{own}{last}")).is_none());
    }

    #[test]
    fn a_reused_pid_has_no_end_from_its_earlier_run() {
        let old = r#"{"pid":200,"source":"app-quit","details":{"end":true}}"#;
        let last = r#"{"pid":200,"timestamp":123,"appVersion":null,"stack":"\ud83d"}"#;
        let log = format!("{old}\n{{\"pid\":100}}\n{last}\ninvalid");
        let report = read(&log).unwrap();
        assert_eq!(report["details"]["previousPid"].as_f64(), Some(200.0));
        assert!(report["details"]["lastLineAt"].is_null());
        assert!(report["details"]["previousVersion"].is_null());
        assert!(
            report["message"]
                .as_str()
                .unwrap()
                .ends_with("an unknown time")
        );
        assert!(read(&format!("{log}\n[]")).is_none());
    }

    #[test]
    fn only_a_boolean_end_field_marks_the_last_run_clean() {
        for details in [r#"{"end":"true"}"#, r#"[true]"#, "null"] {
            assert!(
                read(&format!(
                    r#"{{"pid":200,"source":"app-quit","details":{details}}}"#
                ))
                .is_some()
            );
        }
        let cut_reason =
            r#"{"pid":200,"source":"app-quit","details":{"reason":"\ud83d","end":true}}"#;
        assert!(read(cut_reason).is_none());
    }
}
