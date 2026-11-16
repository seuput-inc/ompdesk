use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const JOURNAL: &str = "tauri-local-storage-import.json";
const SOURCE: &str = "file://";
#[cfg(target_os = "windows")]
const DESTINATION: &str = "http://app.localhost";
#[cfg(not(target_os = "windows"))]
const DESTINATION: &str = "app://ompdesk";

type Items = BTreeMap<String, String>;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    destination: String,
    source: String,
    namespace: String,
    id: String,
    state: State,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
enum State {
    Pending { items: Items },
    Done,
}

pub struct Profile {
    path: PathBuf,
    journal: Journal,
}

impl Profile {
    pub fn open(user_data: &Path) -> Result<Self, String> {
        Self::open_with(user_data, || {
            let exported = shell_core::migrate::local_storage::export(
                &user_data.join("Local Storage/leveldb"),
                SOURCE,
            )?;
            strings(exported)
        })
    }

    fn open_with(
        user_data: &Path,
        export: impl FnOnce() -> Result<Items, String>,
    ) -> Result<Self, String> {
        let path = user_data.join(JOURNAL);
        let namespace = format!(
            "{:x}",
            Sha256::digest(user_data.to_string_lossy().as_bytes())
        );
        let journal = match fs::read(&path) {
            Ok(bytes) => {
                let journal: Journal = serde_json::from_slice(&bytes)
                    .map_err(|_| "Invalid local storage migration journal".to_string())?;
                journal.validate(&namespace)?;
                journal
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let items = export()?;
                let journal = Journal {
                    version: 1,
                    destination: DESTINATION.to_string(),
                    source: SOURCE.to_string(),
                    id: identity(&items, &namespace)?,
                    namespace,
                    state: State::Pending { items },
                };
                persist(&path, &journal)?;
                journal
            }
            Err(error) => {
                return Err(format!(
                    "Cannot read local storage migration journal: {error}"
                ));
            }
        };
        Ok(Self { path, journal })
    }

    #[cfg(test)]
    fn open_with_items(user_data: &Path, items: Items) -> Result<Self, String> {
        Self::open_with(user_data, || Ok(items))
    }

    pub fn pending(&self) -> bool {
        matches!(self.journal.state, State::Pending { .. })
    }

    pub fn offer(&self) -> Result<Value, String> {
        match &self.journal.state {
            State::Pending { items } => {
                Ok(serde_json::json!({ "id": self.journal.id, "items": items }))
            }
            State::Done => Err("Local storage migration is already complete".to_string()),
        }
    }

    pub fn acknowledge(&mut self, id: &str, verified_keys: usize) -> Result<(), String> {
        match &self.journal.state {
            State::Pending { items } if id == self.journal.id && verified_keys == items.len() => {}
            _ => return Err("Invalid local storage migration acknowledgment".to_string()),
        }
        let done = Journal {
            version: self.journal.version,
            destination: self.journal.destination.clone(),
            source: self.journal.source.clone(),
            namespace: self.journal.namespace.clone(),
            id: self.journal.id.clone(),
            state: State::Done,
        };
        persist(&self.path, &done)?;
        self.journal = done;
        Ok(())
    }
}

impl Journal {
    fn validate(&self, namespace: &str) -> Result<(), String> {
        if self.version != 1
            || self.destination != DESTINATION
            || self.source != SOURCE
            || self.namespace != namespace
            || self.id.len() != 64
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Invalid local storage migration journal".to_string());
        }
        if let State::Pending { items } = &self.state
            && identity(items, namespace)? != self.id
        {
            return Err("Invalid local storage migration journal identity".to_string());
        }
        Ok(())
    }
}

fn strings(exported: Map<String, Value>) -> Result<Items, String> {
    exported
        .into_iter()
        .map(|(key, value)| match value {
            Value::String(value) => Ok((key, value)),
            _ => Err("Invalid local storage export value".to_string()),
        })
        .collect()
}

fn identity(items: &Items, namespace: &str) -> Result<String, String> {
    let bytes = serde_json::to_vec(&(1, DESTINATION, SOURCE, namespace, items))
        .map_err(|_| "Cannot encode local storage migration identity".to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn persist(path: &Path, journal: &Journal) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid migration journal path".to_string())?;
    let bytes = serde_json::to_vec(journal)
        .map_err(|_| "Cannot encode local storage migration journal".to_string())?;
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|_| "Cannot generate migration journal temporary name".to_string())?;
    let suffix = format!("{:032x}", u128::from_le_bytes(random));
    let temp = parent.join(format!(".{JOURNAL}.{suffix}.tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|e| format!("Cannot create migration journal: {e}"))?;
    let result = (|| -> Result<(), String> {
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| format!("Cannot sync migration journal: {e}"))?;
        drop(file);
        replace(&temp, path)?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| format!("Cannot sync migration journal directory: {e}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(not(windows))]
fn replace(temp: &Path, path: &Path) -> Result<(), String> {
    fs::rename(temp, path).map_err(|e| format!("Cannot replace migration journal: {e}"))
}

#[cfg(windows)]
fn replace(temp: &Path, path: &Path) -> Result<(), String> {
    shell_core::sys::file::replace_durable(temp, path)
        .map_err(|e| format!("Cannot replace migration journal: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let root = std::env::var_os("OMPDESK_PROFILE_TEST_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let mut random = [0_u8; 16];
            getrandom::fill(&mut random).unwrap();
            let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            let path = root.join(format!("profile-{suffix}"));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn items() -> Items {
        [
            ("draft".to_string(), "hello".to_string()),
            ("theme".to_string(), "dark".to_string()),
        ]
        .into()
    }

    #[test]
    #[cfg(unix)]
    fn journal_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TestDir::new();
        Profile::open_with_items(&dir.0, items()).unwrap();
        assert_eq!(
            fs::metadata(dir.0.join(JOURNAL))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn partial_retry_preserves_snapshot_and_rejects_bad_acknowledgments() {
        let dir = TestDir::new();
        let mut profile = Profile::open_with_items(&dir.0, items()).unwrap();
        let offer = profile.offer().unwrap();
        let id = offer["id"].as_str().unwrap();
        assert!(profile.acknowledge("stale", 2).is_err());
        assert!(profile.acknowledge(id, 1).is_err());
        drop(profile);
        let mut reopened = Profile::open_with_items(&dir.0, Items::new()).unwrap();
        assert!(reopened.pending());
        assert_eq!(reopened.offer().unwrap(), offer);
        reopened.acknowledge(id, 2).unwrap();
        assert!(!reopened.pending());
        assert!(reopened.acknowledge(id, 2).is_err());
        let completed = Profile::open_with_items(&dir.0, items()).unwrap();
        assert!(!completed.pending());
        assert!(completed.offer().is_err());
    }

    #[test]
    fn failed_acknowledgment_preserves_pending_journal() {
        let dir = TestDir::new();
        let mut profile = Profile::open_with_items(&dir.0, items()).unwrap();
        let offer = profile.offer().unwrap();
        let original = fs::read(dir.0.join(JOURNAL)).unwrap();
        profile.path = dir.0.join("missing-parent").join(JOURNAL);
        assert!(
            profile
                .acknowledge(offer["id"].as_str().unwrap(), 2)
                .is_err()
        );
        assert!(profile.pending());
        assert_eq!(profile.offer().unwrap(), offer);
        assert_eq!(fs::read(dir.0.join(JOURNAL)).unwrap(), original);
        let reopened = Profile::open_with_items(&dir.0, Items::new()).unwrap();
        assert_eq!(reopened.offer().unwrap(), offer);
    }

    #[test]
    fn copied_journal_rejects_a_different_datastore_namespace() {
        let source = TestDir::new();
        let target = TestDir::new();
        let mut profile = Profile::open_with_items(&source.0, items()).unwrap();
        let offer = profile.offer().unwrap();
        fs::copy(source.0.join(JOURNAL), target.0.join(JOURNAL)).unwrap();
        assert!(Profile::open_with_items(&target.0, Items::new()).is_err());
        profile
            .acknowledge(offer["id"].as_str().unwrap(), 2)
            .unwrap();
        fs::copy(source.0.join(JOURNAL), target.0.join(JOURNAL)).unwrap();
        assert!(Profile::open_with_items(&target.0, Items::new()).is_err());
    }

    #[test]
    fn empty_snapshot_requires_acknowledgment() {
        let dir = TestDir::new();
        let mut profile = Profile::open_with_items(&dir.0, Items::new()).unwrap();
        assert!(profile.pending());
        let offer = profile.offer().unwrap();
        assert_eq!(offer["items"], serde_json::json!({}));
        profile
            .acknowledge(offer["id"].as_str().unwrap(), 0)
            .unwrap();
        assert!(!Profile::open_with_items(&dir.0, items()).unwrap().pending());
    }

    #[test]
    fn damaged_journal_fails_instead_of_reexporting() {
        let dir = TestDir::new();
        Profile::open_with_items(&dir.0, items()).unwrap();
        let path = dir.0.join(JOURNAL);
        let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        record["state"]["items"]["draft"] = Value::String("changed".to_string());
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(Profile::open_with_items(&dir.0, Items::new()).is_err());
        record["state"]["items"]["draft"] = Value::Bool(true);
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(Profile::open_with_items(&dir.0, Items::new()).is_err());
        fs::write(&path, b"{").unwrap();
        assert!(Profile::open_with_items(&dir.0, Items::new()).is_err());
    }
}
