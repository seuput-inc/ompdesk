use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::saves::{waiting_content, write_kept};
use crate::git::read::blocking;
use crate::server::{Fault, Registry, Reply};

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct RunState {
    usage: Value,
    last_run: Value,
}

#[derive(Deserialize)]
struct Location {
    profile: PathBuf,
}

#[derive(Deserialize)]
struct Save {
    profile: PathBuf,
    state: RunState,
}

fn file(profile: &Path) -> PathBuf {
    profile.join("disk-care").join("state.json")
}

fn read(profile: &Path) -> RunState {
    let path = file(profile);
    waiting_content(&path)
        .or_else(|| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save(profile: &Path, state: &RunState) -> Result<(), Fault> {
    let mut bytes =
        serde_json::to_vec(state).map_err(|e| Fault::new("invalid_state", e.to_string()))?;
    bytes.push(b'\n');
    write_kept(&file(profile), &bytes, None, 0o700).map(|_| ())
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("disk.readRunState", |call| {
        Box::pin(async move {
            let Location { profile } = call.params()?;
            Reply::json(&blocking(move || read(&profile)).await?)
        })
    });
    registry.add("disk.saveRunState", |call| {
        Box::pin(async move {
            let Save { profile, state } = call.params()?;
            blocking(move || {
                super::tree::live(&call.scope)?;
                save(&profile, &state)
            })
            .await??;
            Reply::json(&())
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_previous_runs_and_reads_an_unusable_file_as_empty() {
        let profile = tempfile::tempdir().unwrap();
        let dir = profile.path();
        let capture = br#"{"usage":{"parts":[{"kind":"stats","bytes":17}],"totalBytes":17},"lastRun":{"trigger":"user","startedAt":10,"endedAt":25,"actions":[]}}"#;
        let state: RunState = serde_json::from_slice(capture).unwrap();
        save(dir, &state).unwrap();
        let stored = std::fs::read(file(dir)).unwrap();
        assert_eq!(stored.strip_suffix(b"\n"), Some(capture.as_slice()));
        assert_eq!(read(dir).last_run["endedAt"], 25);
        for raw in ["{}", "not-json", r#"{"lastRun":null}"#] {
            std::fs::write(file(dir), raw).unwrap();
            let restored = read(dir);
            assert!(restored.usage.is_null() && restored.last_run.is_null());
        }
    }
}
