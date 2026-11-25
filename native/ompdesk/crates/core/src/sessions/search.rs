use std::collections::{BTreeMap, HashMap};
use std::fs::{File, Metadata, OpenOptions};
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::value::RawValue;
use tokio::sync::Semaphore;
use tokio::task::spawn_blocking;

use super::locked;
use super::snippet::{Query, excerpt, lowercase};
use crate::fs::disk::mtime_ms;

const READ_BYTES: usize = 8 * 1024 * 1024;
const CACHE_UNITS: usize = 64 * 1024 * 1024;
const BATCH: usize = 16;

#[derive(Serialize)]
pub(super) struct Hit {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    snippet: Option<Box<RawValue>>,
}

#[derive(Clone, Copy, PartialEq)]
struct Stamp {
    mtime_ms: f64,
    size: u64,
}

impl From<&Metadata> for Stamp {
    fn from(metadata: &Metadata) -> Self {
        Self {
            mtime_ms: mtime_ms(metadata),
            size: metadata.len(),
        }
    }
}

struct Text {
    raw: String,
    lower: String,
    units: usize,
    same_utf16_len: bool,
}

impl Text {
    fn read(file: &mut impl Read, size: u64) -> Option<Self> {
        let mut bytes = vec![0; size.min(READ_BYTES as u64) as usize];
        // Node decoded its whole zero-filled buffer even when a concurrent truncate made the read short.
        let _bytes_read = file.read(&mut bytes).ok()?;
        let raw = String::from_utf8(bytes)
            .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
        let lower = lowercase(&raw);
        let raw_units = raw.encode_utf16().count();
        let lower_units = lower.encode_utf16().count();
        Some(Self {
            raw,
            lower,
            units: raw_units + lower_units,
            same_utf16_len: raw_units == lower_units,
        })
    }
}

struct Entry {
    stamp: Stamp,
    age: u64,
    text: Arc<Text>,
}

#[derive(Default)]
struct Entries {
    by_path: HashMap<Arc<Path>, Entry>,
    by_age: BTreeMap<u64, Arc<Path>>,
    units: usize,
    clock: u64,
    generation: u64,
}

impl Entries {
    fn get(&mut self, path: &Path, stamp: Stamp) -> Option<Arc<Text>> {
        let entry = self.by_path.get_mut(path).filter(|e| e.stamp == stamp)?;
        let key = self.by_age.remove(&entry.age)?;
        self.clock += 1;
        entry.age = self.clock;
        self.by_age.insert(entry.age, key);
        Some(Arc::clone(&entry.text))
    }

    fn remove(&mut self, path: &Path) {
        if let Some(entry) = self.by_path.remove(path) {
            self.by_age.remove(&entry.age);
            self.units -= entry.text.units;
        }
    }

    fn store(&mut self, path: &Path, stamp: Stamp, text: &Arc<Text>, generation: u64) {
        if generation != self.generation {
            return;
        }
        self.remove(path);
        if text.units == 0 || text.units > CACHE_UNITS {
            return;
        }
        while self.units + text.units > CACHE_UNITS {
            let (_, oldest) = self
                .by_age
                .pop_first()
                .expect("weighted cache has an entry");
            self.units -= self.by_path.remove(&oldest).expect("LRU entry").text.units;
        }
        self.units += text.units;
        self.clock += 1;
        let path: Arc<Path> = Arc::from(path);
        self.by_age.insert(self.clock, Arc::clone(&path));
        self.by_path.insert(
            path,
            Entry {
                stamp,
                age: self.clock,
                text: Arc::clone(text),
            },
        );
    }
}

#[derive(Default)]
pub(super) struct ContentCache {
    entries: Mutex<Entries>,
    slots: OnceLock<Arc<Semaphore>>,
}

impl ContentCache {
    pub(super) fn invalidate(&self, path: &Path) {
        let mut entries = locked(&self.entries);
        entries.generation += 1;
        entries.remove(path);
    }

    pub(super) fn clear(&self) {
        let mut entries = locked(&self.entries);
        *entries = Entries {
            generation: entries.generation + 1,
            ..Default::default()
        };
    }

    fn text(&self, root: &Path, path: &Path) -> Option<Arc<Text>> {
        let generation = locked(&self.entries).generation;
        let (mut file, metadata) = open_journal(root, path)?;
        let stamp = Stamp::from(&metadata);
        if let Some(text) = locked(&self.entries).get(path, stamp) {
            return Some(text);
        }
        let text = Arc::new(Text::read(&mut file, stamp.size)?);
        locked(&self.entries).store(path, stamp, &text, generation);
        Some(text)
    }

    pub(super) async fn search(
        self: &Arc<Self>,
        root: &Path,
        candidates: Vec<String>,
        query: &Query,
    ) -> Vec<Hit> {
        let tokens = query.tokens();
        if candidates.is_empty() || tokens.is_empty() || !root.is_absolute() {
            return Vec::new();
        }
        let Ok(root) = tokio::fs::canonicalize(root).await else {
            return Vec::new();
        };
        let query = Arc::new((root, tokens));
        let slots = self.slots.get_or_init(|| Arc::new(Semaphore::new(BATCH)));
        let mut batch = Vec::with_capacity(BATCH.min(candidates.len()));
        let mut hits = Vec::new();
        let mut candidates = candidates.into_iter();
        while !candidates.as_slice().is_empty() {
            for path in candidates.by_ref().take(BATCH) {
                let permit = Arc::clone(slots)
                    .acquire_owned()
                    .await
                    .expect("private semaphore stays open");
                let cache = Arc::clone(self);
                let query = Arc::clone(&query);
                batch.push(spawn_blocking(move || {
                    let _permit = permit;
                    let (root, tokens) = &*query;
                    let text = cache.text(root, Path::new(&path))?;
                    if !tokens.iter().all(|token| token.contains(&text.lower)) {
                        return None;
                    }
                    Some(Hit {
                        path,
                        snippet: excerpt(&text.raw, &text.lower, text.same_utf16_len, &tokens[0]),
                    })
                }));
            }
            for read in batch.drain(..) {
                if let Ok(Some(hit)) = read.await {
                    hits.push(hit);
                }
            }
        }
        hits
    }
}

/// A regular journal whose resolved path and opened handle both stay under the canonical root.
pub(super) fn open_journal(root: &Path, path: &Path) -> Option<(File, Metadata)> {
    if !path.is_absolute() || !is_jsonl(path) {
        return None;
    }
    let real = path.canonicalize().ok()?;
    if real == root || !real.starts_with(root) || !is_jsonl(&real) {
        return None;
    }
    let file = open_checked(&real)?;
    let metadata = file.metadata().ok()?;
    metadata.is_file().then_some((file, metadata))
}

fn is_jsonl(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        let name = name.as_encoded_bytes();
        name.ends_with(b".jsonl") && !(cfg!(windows) && name.contains(&b':'))
    })
}

/// Open the resolved path, not the candidate alias. A link swapped into an ancestor must not redirect this read.
fn open_checked(real: &Path) -> Option<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")]
        let nofollow = libc::O_NOFOLLOW_ANY;
        #[cfg(not(target_os = "macos"))]
        let nofollow = libc::O_NOFOLLOW;
        options.custom_flags(nofollow | libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    let file = options.open(real).ok()?;
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let opened = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()?;
        if opened != real {
            return None;
        }
    }
    #[cfg(windows)]
    if crate::sys::final_file_path(&file).ok()? != real {
        return None;
    }
    Some(file)
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
