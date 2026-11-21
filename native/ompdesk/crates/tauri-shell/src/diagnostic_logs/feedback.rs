use super::reader::{Selection, lines};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// Match main's `path.resolve` for an explicit valued switch and `path.join` for the log.
/// Resolve spelling only: canonicalizing would follow links or add a Windows device prefix.
pub(crate) fn feedback_profile(user_data: &Path, args: &[String]) -> std::io::Result<PathBuf> {
    let explicit = args.iter().rev().find_map(|arg| {
        let (key, value) = arg.split_once('=').unwrap_or((arg, ""));
        (key == "--user-data-dir").then_some(value)
    });
    let resolved;
    let profile = if let Some(value) = explicit.filter(|value| !value.is_empty()) {
        resolved = std::path::absolute(value)?;
        resolved.as_path()
    } else {
        user_data
    };
    let mut path = PathBuf::new();
    for part in profile.components() {
        match part {
            Component::CurDir => (),
            Component::ParentDir if path.file_name().is_some() => {
                path.pop();
            }
            Component::ParentDir if path.has_root() => (),
            _ => path.push(part),
        }
    }
    Ok(path)
}

pub(crate) enum FeedbackRead {
    Path,
    Tail(usize),
}

impl FeedbackRead {
    pub(crate) fn parse(channel: &str, args: &Value) -> Option<Self> {
        match channel {
            "runtime:log-path" => Some(Self::Path),
            "runtime:log-tail" => {
                let count = args.get(0).and_then(Value::as_f64).filter(|n| *n > 0.0);
                Some(Self::Tail(
                    count.map_or(20, |n| n.clamp(1.0, 50.0) as usize),
                ))
            }
            _ => None,
        }
    }

    pub(crate) fn read(self, profile: &Path) -> Value {
        match self {
            Self::Path => Value::String(
                profile
                    .join("logs")
                    .join("gui-runtime.jsonl")
                    .to_string_lossy()
                    .into_owned(),
            ),
            Self::Tail(count) => {
                let profile = if profile.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    profile
                };
                lines(profile, Selection::Feedback(count)).into()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn feedback_path_uses_the_node_spelling_not_a_canonical_target() {
        let relative = feedback_profile(Path::new("one/../two"), &[]).unwrap();
        let path = FeedbackRead::parse("runtime:log-path", &json!(["ignored"])).unwrap();
        assert_eq!(
            path.read(&relative),
            json!(Path::new("two").join("logs").join("gui-runtime.jsonl"))
        );
        let explicit =
            feedback_profile(Path::new("unused"), &["--user-data-dir=one/../two".into()]).unwrap();
        assert_eq!(explicit, std::env::current_dir().unwrap().join("two"));
        assert!(FeedbackRead::parse("log:snapshot", &Value::Null).is_none());
    }

    #[test]
    fn feedback_tail_caps_bytes_and_rows_without_changing_diagnostics() {
        let profile = tempdir().unwrap();
        let logs = profile.path().join("logs");
        fs::create_dir(&logs).unwrap();
        let file = logs.join("gui-runtime.jsonl");
        let tail = |args: Value| {
            FeedbackRead::parse("runtime:log-tail", &args)
                .unwrap()
                .read(profile.path())
        };
        assert_eq!(tail(json!([])), json!([]));
        fs::write(&file, []).unwrap();
        assert_eq!(tail(json!([20])), json!([]));
        let rows: Vec<_> = (0..60).map(|n| n.to_string()).collect();
        fs::write(&file, rows.join("\n\n") + "\n").unwrap();
        for (args, count) in [
            (json!([]), 20),
            (json!([0]), 20),
            (json!(["50"]), 20),
            (json!([0.5]), 1),
            (json!([2.8]), 2),
            (json!([999]), 50),
        ] {
            assert_eq!(tail(args), json!(&rows[60 - count..]));
        }
        let mut large = vec![b'x'; 256 * 1024 - 7];
        large.splice(0..0, [0xe2, 0x82, 0xac]);
        large.extend_from_slice(b"\n\r\n\xe2\x82!");
        fs::write(&file, &large).unwrap();
        assert_eq!(tail(json!([50])), json!(["\r", "�!"]));
        assert!(lines(profile.path(), Selection::Current)[0].starts_with('€'));
    }

    #[cfg(unix)]
    #[test]
    fn feedback_never_reads_through_a_linked_log() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("logs")).unwrap();
        fs::write(dir.path().join("other"), "outside").unwrap();
        std::os::unix::fs::symlink("../other", dir.path().join("logs/gui-runtime.jsonl")).unwrap();
        assert_eq!(FeedbackRead::Tail(20).read(dir.path()), json!([]));
    }
}
