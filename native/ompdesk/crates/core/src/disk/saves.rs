//! A store's save that finds the disk or its quota full: the file keeps its old bytes (`write_atomic_if` removes its
//! temp file), the caller still gets the error and keeps its state in memory, and the same content is tried again
//! here on a backoff until it lands or a newer save of that file replaces it. Main hears of it as
//! `store.saveFailed {file}` once per file and `store.saved {file}` when the file is no longer waiting for space, and
//! tells the person once (`src/main/disk-full.ts`, `core-saves.ts`). The TypeScript twin is `writeFileAtomicDeferred`
//! in `src/main/atomic-file.ts`, which waits the same 5 s doubling to a minute.
//!
//! Each file's writes and retries take that file's turn, so a retry never lands older content over a newer save. The
//! bookkeeping lock is never held across a write: `waiting_content` runs on the hub thread (every prefs read), so one
//! store's save on a busy disk must not stall the hub past main's 2 s answer deadline.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::json;

use super::tree::write_atomic_if;
use crate::server::{Events, Fault};

/// Waits between tries while the disk stays full; the last one repeats.
const RETRY_MS: [u64; 5] = [5_000, 10_000, 20_000, 40_000, 60_000];

type Writer = dyn Fn(&Path, &[u8], Option<u32>, u32) -> Result<bool, Fault> + Send + Sync;

/// A disk without room or a writer at its disk quota.
pub(crate) fn disk_full(fault: &Fault) -> bool {
    fault.message.starts_with("ENOSPC:") || fault.message.starts_with("EDQUOT:")
}

struct Kept {
    bytes: Vec<u8>,
    mode: Option<u32>,
    dir_mode: u32,
}

struct State {
    /// The files waiting for space, with what each should hold.
    kept: HashMap<PathBuf, Kept>,
    events: Option<Events>,
}

fn announce(events: &Events, event: &str, file: &Path) {
    events.send(event, &json!({"file": file.to_string_lossy()}));
}

impl State {
    fn tell(&self, event: &str, file: &Path) {
        if let Some(events) = &self.events {
            announce(events, event, file);
        }
    }
}

pub(crate) struct Saves {
    state: Mutex<State>,
    /// One turn per file: its write and its retries run one at a time.
    turns: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    writer: Box<Writer>,
    delays: Vec<u64>,
}

impl Saves {
    fn new(writer: Box<Writer>, delays: Vec<u64>) -> Saves {
        Saves {
            state: Mutex::new(State {
                kept: HashMap::new(),
                events: None,
            }),
            turns: Mutex::new(HashMap::new()),
            writer,
            delays,
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn turn(&self, file: &Path) -> Arc<Mutex<()>> {
        let mut turns = self
            .turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Arc::clone(turns.entry(file.to_path_buf()).or_default())
    }

    fn delay(&self, tries: usize) -> Duration {
        let last = self.delays.len().saturating_sub(1);
        let ms = self.delays.get(tries.min(last)).copied().unwrap_or(60_000);
        Duration::from_millis(ms)
    }

    /// Main is listening: every file already waiting is told again, so a failure from before is not lost.
    pub(crate) fn attach(&self, events: Events) {
        let mut state = self.lock();
        for file in state.kept.keys() {
            announce(&events, "store.saveFailed", file);
        }
        state.events = Some(events);
    }

    /// Writes `bytes` to `file`. A full disk is still returned as the error, and the content is kept and tried again;
    /// any other result means the file no longer waits for space (a newer save replaced what was kept).
    pub(crate) fn write(
        self: &Arc<Self>,
        file: &Path,
        bytes: &[u8],
        mode: Option<u32>,
        dir_mode: u32,
    ) -> Result<bool, Fault> {
        let turn = self.turn(file);
        let _turn = turn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let result = (self.writer)(file, bytes, mode, dir_mode);
        let mut state = self.lock();
        if matches!(&result, Err(fault) if disk_full(fault)) {
            let kept = Kept {
                bytes: bytes.to_vec(),
                mode,
                dir_mode,
            };
            if state.kept.insert(file.to_path_buf(), kept).is_none() {
                state.tell("store.saveFailed", file);
                self.retry(file);
            }
        } else if state.kept.remove(file).is_some() {
            state.tell("store.saved", file);
        }
        result
    }

    /// A rejected proposal must never become a later save. Leave any older ordinary save owed
    /// unless the new bytes actually replaced the file, under the same turn as its retry.
    pub(crate) fn commit(&self, file: &Path, bytes: &[u8], mode: u32) -> Result<(), Fault> {
        let turn = self.turn(file);
        let _turn = turn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !(self.writer)(file, bytes, Some(mode), 0o777)? {
            return Err(Fault::new("not_saved", "The file was not replaced."));
        }
        let mut state = self.lock();
        if state.kept.remove(file).is_some() {
            state.tell("store.saved", file);
        }
        Ok(())
    }

    fn retry(self: &Arc<Self>, file: &Path) {
        #[cfg(test)]
        if self.delays.is_empty() {
            return;
        }
        let saves = Arc::clone(self);
        let file = file.to_path_buf();
        std::thread::spawn(move || {
            let mut tries = 0;
            loop {
                std::thread::sleep(saves.delay(tries));
                tries += 1;
                if saves.retry_once(&file) {
                    return;
                }
            }
        });
    }

    pub(crate) fn waiting_for_space(&self, file: &Path) -> bool {
        self.lock().kept.contains_key(file)
    }

    #[cfg(test)]
    pub(crate) fn manual(writer: Box<Writer>) -> Arc<Self> {
        Arc::new(Self::new(writer, Vec::new()))
    }

    pub(crate) fn retry_once(&self, file: &Path) -> bool {
        let turn = self.turn(file);
        let held = turn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // Only a write of this file changes what it keeps, and that write waits for this turn.
        let Some((bytes, mode, dir_mode)) = self
            .lock()
            .kept
            .get(file)
            .map(|kept| (kept.bytes.clone(), kept.mode, kept.dir_mode))
        else {
            return true;
        };
        let result = (self.writer)(file, &bytes, mode, dir_mode);
        if matches!(&result, Err(fault) if disk_full(fault)) {
            return false;
        }
        let mut state = self.lock();
        let kept = state
            .kept
            .remove(file)
            .expect("kept under this file's turn");
        state.tell("store.saved", file);
        drop(state);
        // `saved_after_retry` takes the visuals catalog's lock, whose holder may be waiting for this file's turn.
        drop(held);
        match result {
            Ok(true) => crate::visuals::saved_after_retry(file, &kept.bytes, self),
            Err(fault) => eprintln!(
                "ompdesk-core: couldn't save {} after the disk was full: {}",
                file.display(),
                fault.message
            ),
            Ok(false) => (),
        }
        true
    }

    /// Deletes `file` and forgets what waited to be written to it, in the file's turn, so no retry brings back a file
    /// its store removed (a closed terminal's history).
    fn remove(&self, file: &Path) -> std::io::Result<()> {
        let turn = self.turn(file);
        let _turn = turn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            let mut state = self.lock();
            if state.kept.remove(file).is_some() {
                state.tell("store.saved", file);
            }
        }
        match std::fs::remove_file(file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}

pub(crate) static SAVES: LazyLock<Arc<Saves>> = LazyLock::new(|| {
    Arc::new(Saves::new(
        Box::new(|file, bytes, mode, dir_mode| {
            write_atomic_if(file, bytes, mode, dir_mode, &|| true)
        }),
        RETRY_MS.to_vec(),
    ))
});

/// `write_atomic_if(file, bytes, mode, dir_mode, &|| true)` for a store that keeps its state in memory and saves it on
/// every change: on a full disk the content waits and is saved when there is room (`Saves::write`).
pub(crate) fn write_kept(
    file: &Path,
    bytes: &[u8],
    mode: Option<u32>,
    dir_mode: u32,
) -> Result<bool, Fault> {
    SAVES.write(file, bytes, mode, dir_mode)
}

pub(crate) fn waiting_content(file: &Path) -> Option<Vec<u8>> {
    SAVES.lock().kept.get(file).map(|kept| kept.bytes.clone())
}

/// Removes a file `write_kept` writes, with any content still waiting for space (`Saves::remove`).
pub(crate) fn remove_kept(file: &Path) -> std::io::Result<()> {
    SAVES.remove(file)
}

/// Where `store.saveFailed` and `store.saved` go: the connection main speaks on.
pub(crate) fn attach(events: Events) {
    SAVES.attach(events);
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;

    use serde_json::Value;
    use tokio::sync::mpsc::UnboundedReceiver;

    use super::*;
    use crate::wire::Frame;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-saves-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn enospc() -> Fault {
        Fault::new("io", "ENOSPC: no space left on device, open 'x.tmp'")
    }

    /// A disk that can be full: while it is, nothing is written and the file keeps its bytes (as `write_atomic_if`
    /// leaves it); otherwise the real atomic write.
    fn disk(full: &Arc<AtomicBool>, other: Option<&'static str>) -> Box<Writer> {
        let full = Arc::clone(full);
        Box::new(move |file, bytes, mode, dir_mode| {
            if let Some(message) = other {
                return Err(Fault::new("io", message));
            }
            if full.load(Ordering::SeqCst) {
                return Err(enospc());
            }
            write_atomic_if(file, bytes, mode, dir_mode, &|| true)
        })
    }

    fn heard(frames: &mut UnboundedReceiver<Frame>) -> Vec<(String, String)> {
        let mut out = Vec::new();
        while let Ok(frame) = frames.try_recv() {
            let value: Value = serde_json::from_slice(frame.parts().0).unwrap();
            out.push((
                value["event"].as_str().unwrap().to_string(),
                value["data"]["file"].as_str().unwrap().to_string(),
            ));
        }
        out
    }

    fn until(what: &str, mut done: impl FnMut() -> bool) {
        let start = Instant::now();
        while !done() {
            assert!(start.elapsed() < Duration::from_secs(5), "{what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_full_disk_keeps_the_old_file_tells_once_and_saves_the_newest_content_when_there_is_room() {
        let dir = temp("retry");
        let file = dir.join("state.json");
        fs::write(&file, "old").unwrap();
        let full = Arc::new(AtomicBool::new(true));
        let saves = Arc::new(Saves::new(disk(&full, None), vec![10]));
        let (events, _keep, mut frames) = Events::capture();
        saves.attach(events);

        let first = saves.write(&file, b"new", Some(0o600), 0o700);
        assert!(first.unwrap_err().message.starts_with("ENOSPC:"));
        assert!(saves.write(&file, b"newer", Some(0o600), 0o700).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "old");
        let name = file.to_string_lossy().to_string();
        assert_eq!(
            heard(&mut frames),
            vec![("store.saveFailed".to_string(), name.clone())]
        );

        full.store(false, Ordering::SeqCst);
        until("the newest content is saved", || {
            fs::read_to_string(&file).unwrap() == "newer"
        });
        until("the file is told as saved", || {
            !saves.lock().kept.contains_key(&file)
        });
        assert_eq!(heard(&mut frames), vec![("store.saved".to_string(), name)]);
        assert!(fs::read_dir(&dir).unwrap().count() == 1, "no temp file");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_disk_quota_error_keeps_the_write_until_quota_is_available() {
        let dir = temp("quota");
        let file = dir.join("state.json");
        fs::write(&file, b"old").unwrap();
        #[cfg(unix)]
        let quota = libc::EDQUOT;
        #[cfg(windows)]
        let quota = 1295; // ERROR_DISK_QUOTA_EXCEEDED
        let full = AtomicBool::new(true);
        let saves = Saves::manual(Box::new(move |file, bytes, mode, dir_mode| {
            if full.swap(false, Ordering::SeqCst) {
                Err(super::super::tree::fault(
                    &std::io::Error::from_raw_os_error(quota),
                    "write",
                    file,
                ))
            } else {
                write_atomic_if(file, bytes, mode, dir_mode, &|| true)
            }
        }));
        let failed = saves.write(&file, b"new", Some(0o600), 0o700).unwrap_err();
        assert!(failed.message.starts_with("EDQUOT:"));
        assert_eq!(fs::read(&file).unwrap(), b"old");
        assert!(saves.waiting_for_space(&file));
        assert!(saves.retry_once(&file));
        assert_eq!(fs::read(&file).unwrap(), b"new");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_newer_save_that_lands_is_never_overwritten_by_the_retry_of_an_older_one() {
        let dir = temp("newer");
        let file = dir.join("state.json");
        let full = Arc::new(AtomicBool::new(true));
        let saves = Arc::new(Saves::new(disk(&full, None), vec![20]));
        let (events, _keep, mut frames) = Events::capture();
        saves.attach(events);

        assert!(saves.write(&file, b"older", None, 0o700).is_err());
        full.store(false, Ordering::SeqCst);
        assert!(saves.write(&file, b"newer", None, 0o700).unwrap());
        assert_eq!(fs::read_to_string(&file).unwrap(), "newer");

        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(fs::read_to_string(&file).unwrap(), "newer");
        let events: Vec<String> = heard(&mut frames)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(events, ["store.saveFailed", "store.saved"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failure_that_is_not_a_full_disk_is_only_returned() {
        let dir = temp("other");
        let file = dir.join("state.json");
        let full = Arc::new(AtomicBool::new(false));
        let saves = Arc::new(Saves::new(
            disk(&full, Some("EACCES: permission denied, open 'x'")),
            vec![10],
        ));
        let (events, _keep, mut frames) = Events::capture();
        saves.attach(events);

        assert!(saves.write(&file, b"x", None, 0o700).is_err());
        assert!(heard(&mut frames).is_empty());
        assert!(saves.lock().kept.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_failed_before_main_listened_is_told_when_it_does() {
        let dir = temp("attach");
        let file = dir.join("state.json");
        let full = Arc::new(AtomicBool::new(true));
        let saves = Arc::new(Saves::new(disk(&full, None), vec![60_000]));
        assert!(saves.write(&file, b"x", None, 0o700).is_err());

        let (events, _keep, mut frames) = Events::capture();
        saves.attach(events);
        let name = file.to_string_lossy().to_string();
        assert_eq!(
            heard(&mut frames),
            vec![("store.saveFailed".to_string(), name)]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_removed_file_is_not_written_back_by_the_retry_of_content_that_waited_for_space() {
        let dir = temp("remove");
        let file = dir.join("history.json");
        fs::write(&file, "old").unwrap();
        let full = Arc::new(AtomicBool::new(true));
        let saves = Arc::new(Saves::new(disk(&full, None), vec![10]));

        assert!(saves.write(&file, b"secret", Some(0o600), 0o700).is_err());
        saves.remove(&file).unwrap();
        assert!(!file.exists());
        saves.remove(&file).unwrap();
        full.store(false, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(100));
        assert!(!file.exists(), "the kept content came back");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_held_up_by_the_disk_never_holds_up_another_file_or_the_waiting_check() {
        use std::sync::mpsc;
        let dir = temp("slow");
        let slow = dir.join("journal.json");
        let quick = dir.join("prefs.json");
        let (entered, writing) = mpsc::channel::<()>();
        let (release, held) = mpsc::channel::<()>();
        let held = Mutex::new(held);
        let slow_name = slow.clone();
        let saves = Saves::manual(Box::new(move |file, bytes, mode, dir_mode| {
            if file == slow_name {
                let _ = entered.send(());
                let _ = held.lock().unwrap().recv();
            }
            write_atomic_if(file, bytes, mode, dir_mode, &|| true)
        }));
        let writer = {
            let saves = Arc::clone(&saves);
            let slow = slow.clone();
            std::thread::spawn(move || saves.write(&slow, b"slow", None, 0o700))
        };
        writing.recv().unwrap();

        let (done, finished) = mpsc::channel();
        {
            let saves = Arc::clone(&saves);
            let quick = quick.clone();
            std::thread::spawn(move || {
                let waiting = saves.waiting_for_space(&quick);
                let saved = saves.write(&quick, b"{}", None, 0o700).is_ok();
                let _ = done.send((waiting, saved));
            });
        }
        let answered = finished.recv_timeout(Duration::from_secs(5));
        release.send(()).unwrap();
        assert!(writer.join().unwrap().unwrap());
        assert_eq!(
            answered,
            Ok((false, true)),
            "the other file waited for the slow save"
        );
        assert_eq!(fs::read_to_string(&slow).unwrap(), "slow");
        let _ = fs::remove_dir_all(&dir);
    }
}
