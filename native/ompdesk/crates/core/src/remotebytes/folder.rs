//! A cache folder under a byte bound, the least recently read leaving first: what `transcript-cache.ts` and
//! `image-blob-cache.ts` each carried (`#grew`, `#measure`, `#entries`, `#trim`), one copy for both. Nothing here is
//! ever authoritative: a file that cannot be written, read or removed is the host's to send again.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::disk::tree::write_atomic_if;

/// A trim takes the folder down to this share of the bound, so it does not run again at the next write.
const TRIM_TO: f64 = 0.75;

/// `OMPDESK_CORE_DEBUG` naming `cache` (a comma list): each trim says what it found and removed, in the order it
/// removes, and a page read that finds nothing says why. Off in the app; `transcript-cache.test.ts` turns it on, so
/// its one unexplained Windows failure (main run 44078283149) leaves a trace in the CI log if it comes back.
pub(super) static TRACE: LazyLock<bool> = LazyLock::new(|| {
    std::env::var("OMPDESK_CORE_DEBUG")
        .is_ok_and(|value| value.split(',').any(|part| part.trim() == "cache"))
});

pub struct Folder {
    pub dir: PathBuf,
    state: Mutex<Counted>,
    /// One read of a key at a time (`#serialized`): two windows on one tab never append the same segment twice.
    turns: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Blobs being read, by reference: concurrent reads of one blob share one request.
    pub loading: Mutex<HashMap<String, Vec<tokio::sync::oneshot::Sender<Option<String>>>>>,
}

#[derive(Default)]
struct Counted {
    /// Bytes in the folder, measured at the first write; None until then.
    size: Option<u64>,
    trimming: bool,
}

static FOLDERS: LazyLock<Mutex<HashMap<PathBuf, Arc<Folder>>>> = LazyLock::new(Mutex::default);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The one `Folder` of `dir` in this process (main makes one cache per folder).
pub fn folder(dir: &Path) -> Arc<Folder> {
    locked(&FOLDERS)
        .entry(dir.to_path_buf())
        .or_insert_with(|| {
            Arc::new(Folder {
                dir: dir.to_path_buf(),
                state: Mutex::default(),
                turns: Mutex::default(),
                loading: Mutex::default(),
            })
        })
        .clone()
}

/// A key's turn: held while its read runs; the key is forgotten once nobody waits for it.
pub struct Turn {
    folder: Arc<Folder>,
    key: String,
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

impl Drop for Turn {
    fn drop(&mut self) {
        let mut turns = locked(&self.folder.turns);
        // The map's and this turn's own: nobody else holds or waits for the key.
        if turns
            .get(&self.key)
            .is_some_and(|lock| Arc::strong_count(lock) <= 2)
        {
            turns.remove(&self.key);
        }
    }
}

/// When a file was last read, for the least recently read to go first.
struct Entry {
    file: PathBuf,
    size: u64,
    read: f64,
}

impl Folder {
    /// Waits for the reads of `key` before this one (in the order asked), then holds the key.
    pub async fn turn(self: &Arc<Self>, key: &str) -> Turn {
        let lock = locked(&self.turns)
            .entry(key.to_owned())
            .or_default()
            .clone();
        Turn {
            folder: self.clone(),
            key: key.to_owned(),
            _guard: lock.lock_owned().await,
        }
    }

    /// Through the shared atomic writer (Windows retries a held rename): a reader never sees part of a file. False
    /// when the disk refused it (full, read-only); the refusal is logged, the caller reads from the host again.
    pub fn write(self: &Arc<Self>, file: &Path, bytes: &[u8], limit: u64) -> bool {
        let written = match write_atomic_if(file, bytes, None, 0o777, &|| true) {
            Ok(written) => written,
            Err(fault) => {
                eprintln!(
                    "ompdesk-core: cache file not written {}: {} {}",
                    file.display(),
                    fault.code,
                    fault.message
                );
                false
            }
        };
        if written {
            touch(file);
            self.grew(bytes.len() as u64, limit);
        }
        written
    }

    /// One more line at the end of `file` (made if missing); false when it could not be written, which is logged.
    pub fn append(self: &Arc<Self>, file: &Path, bytes: &[u8], limit: u64) -> bool {
        use std::io::Write;
        let appended = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(file)
            .and_then(|mut opened| {
                opened.write_all(bytes)?;
                stamped(&opened);
                Ok(())
            });
        if let Err(error) = &appended {
            eprintln!(
                "ompdesk-core: cache file not appended {}: {:?} {}",
                file.display(),
                error.kind(),
                error
            );
            return false;
        }
        self.grew(bytes.len() as u64, limit);
        true
    }

    /// The first write measures the folder (this one included); later ones add theirs. A trim measures it again and
    /// runs beside the request, as the TypeScript's `void this.#trim()` did.
    fn grew(self: &Arc<Self>, bytes: u64, limit: u64) {
        let over = {
            let mut state = locked(&self.state);
            let size = match state.size {
                None => entries(&self.dir).iter().map(|entry| entry.size).sum(),
                Some(size) => size + bytes,
            };
            state.size = Some(size);
            size > limit
        };
        if over {
            let folder = self.clone();
            tokio::task::spawn_blocking(move || folder.trim(limit));
        }
    }

    /// Removes the least recently read files (and any temporary file left by a crash) until the folder fits again.
    /// A file it cannot remove (Windows: one being read) stays and counts.
    fn trim(&self, limit: u64) {
        {
            let mut state = locked(&self.state);
            if state.trimming {
                return;
            }
            state.trimming = true;
        }
        let mut kept = entries(&self.dir);
        kept.sort_by(|a, b| a.read.total_cmp(&b.read));
        let mut total: u64 = kept.iter().map(|entry| entry.size).sum();
        if *TRACE {
            eprintln!(
                "ompdesk-core: cache trim {}: {} files, {total} bytes, bound {limit}, down to {}",
                self.dir.display(),
                kept.len(),
                (limit as f64 * TRIM_TO) as u64
            );
        }
        for entry in kept {
            let outcome = if total as f64 <= limit as f64 * TRIM_TO {
                if !*TRACE {
                    break;
                }
                "kept"
            } else if remove(&entry.file) {
                total -= entry.size;
                "removed"
            } else {
                "not removed"
            };
            if *TRACE {
                eprintln!(
                    "ompdesk-core: cache trim   {} read {:.4} size {} {outcome}",
                    entry.file.file_name().unwrap_or_default().to_string_lossy(),
                    entry.read,
                    entry.size
                );
            }
        }
        let mut state = locked(&self.state);
        state.size = Some(total);
        state.trimming = false;
    }
}

/// `rm(file, { force: true })`: a file already gone counts as removed.
pub fn remove(file: &Path) -> bool {
    match fs::remove_file(file) {
        Ok(()) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Read again: the least recently read go first when the folder is full (`utimes(file, stamp, stamp)`).
pub fn touch(file: &Path) {
    if let Ok(opened) = fs::OpenOptions::new().write(true).open(file) {
        stamped(&opened);
    }
}

/// Leaves a fresh `stamp()` as the file's read and write time; a file that refuses it keeps its own.
fn stamped(opened: &fs::File) {
    let now = stamp();
    let _ = opened.set_times(fs::FileTimes::new().set_accessed(now).set_modified(now));
}

/// The least step between two stamps: every file system the cache lives on keeps it (NTFS 100 ns, APFS and ext4 1 ns),
/// and `Entry::read`'s milliseconds as an f64 tell it apart.
const STAMP_STEP: Duration = Duration::from_millis(1);

/// The time a write or read leaves on its file: now, or a step past the last stamp of this process when the clock has
/// not moved that far, so a later write or read always sorts after an earlier one. The file system's own write time is
/// its clock tick's (Windows: 1 to 15.6 ms), so writes within one tick shared it and a write could even sort before the
/// read just before it. Files from an earlier run keep the times they were left with.
fn stamp() -> SystemTime {
    static LAST: Mutex<Option<SystemTime>> = Mutex::new(None);
    let mut last = locked(&LAST);
    let now = SystemTime::now();
    let next = last.map_or(now, |last| now.max(last + STAMP_STEP));
    *last = Some(next);
    next
}

fn entries(dir: &Path) -> Vec<Entry> {
    let Ok(names) = fs::read_dir(dir) else {
        return Vec::new();
    };
    names
        .flatten()
        .filter_map(|name| {
            let file = name.path();
            let info = fs::metadata(&file).ok()?;
            if !info.is_file() {
                return None;
            }
            let read = info
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0.0, |since| since.as_secs_f64() * 1000.0);
            Some(Entry {
                file,
                size: info.len(),
                read,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::{TRIM_TO, folder, touch};

    /// Writes and reads back to back, as a device keeping pages does: on Windows the file system's own write time is
    /// its clock tick's, so several of them shared one time and a trim took the page just written first.
    #[test]
    fn a_trim_removes_the_least_recently_written_or_read_even_within_one_clock_tick() {
        let dir = super::super::tests::temp_dir("folder-ties");
        let folder = folder(&dir);
        // Written newest-last under names that sort newest-first, the order NTFS lists files with equal times in.
        let names: Vec<String> = (0..20).rev().map(|n| format!("p{n:02}")).collect();
        for name in &names {
            assert!(folder.write(&dir.join(name), &[b'x'; 100], u64::MAX));
        }
        // The oldest read again: now the most recent.
        touch(&dir.join("p19"));
        let mut recency: Vec<&str> = names[1..].iter().map(String::as_str).collect();
        recency.push("p19");
        for keep in (1..recency.len()).rev() {
            // The bound whose three quarters hold exactly `keep` of the 100-byte pages.
            folder.trim((((keep * 100 + 50) as f64) / TRIM_TO).ceil() as u64);
            let mut left: Vec<String> = std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            left.sort();
            let mut expected: Vec<&str> = recency[recency.len() - keep..].to_vec();
            expected.sort();
            assert_eq!(left, expected, "keeping {keep}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A burst of writes leaves stamps ahead of the clock, and a clock that went back leaves them far ahead; a core
    /// started again must still stamp past them, or the page it writes first sorts oldest and a trim removes it.
    #[test]
    fn a_page_written_after_a_restart_sorts_after_an_earlier_runs_stamps_ahead_of_the_clock() {
        for ahead in [Duration::from_millis(500), Duration::from_secs(24 * 3600)] {
            let dir = super::super::tests::temp_dir("folder-restart");
            let time = SystemTime::now() + ahead;
            for name in ["p0", "p1", "p2"] {
                std::fs::write(dir.join(name), [b'x'; 100]).unwrap();
                std::fs::File::options()
                    .write(true)
                    .open(dir.join(name))
                    .unwrap()
                    .set_times(
                        std::fs::FileTimes::new()
                            .set_accessed(time)
                            .set_modified(time),
                    )
                    .unwrap();
            }
            // A folder this process has not stamped in, as after a restart.
            let folder = folder(&dir);
            assert!(folder.write(&dir.join("p3"), &[b'x'; 100], u64::MAX));
            folder.trim(((150_f64) / TRIM_TO).ceil() as u64);
            let left: Vec<String> = std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            assert_eq!(left, ["p3"], "stored {ahead:?} ahead");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
