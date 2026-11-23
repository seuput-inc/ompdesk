use std::collections::{HashMap, VecDeque, vec_deque};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Serialize, Serializer};

use super::checkpoint::{Changes, Checkpoint, Mark};
use crate::fs::order::js_trim;
use crate::server::Fault;

const CAP: usize = 1000;
const ACTIVE: Duration = Duration::from_secs(10 * 60);

pub(super) fn log_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with("omp.")
                && name.ends_with(".log")
                && !(cfg!(windows) && name.contains(':'))
        })
}

fn file_name(path: &Path) -> &str {
    path.file_name()
        .and_then(|name| name.to_str())
        .expect("a matched log name")
}

struct Cursor {
    identity: Identity,
    offset: u64,
    // `offset` is the unfinished line's first byte. Its bytes can be reread without an unbounded checkpoint.
    observed: u64,
    partial: Vec<u8>,
    changed: Option<SystemTime>,
    listed: bool,
}

pub(super) type Identity = (u64, u64);

#[cfg(unix)]
fn unix_id(meta: &Metadata) -> Identity {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

#[cfg(windows)]
fn windows_id(file: &File) -> io::Result<Identity> {
    let (volume, index, _) = crate::sys::file_identity(file)?;
    Ok((u64::from(volume), index))
}

// Stat without opening old logs for reading. Only the root may itself be a directory link.
pub(super) fn stat(path: &Path, root: bool) -> io::Result<(Metadata, Identity)> {
    #[cfg(unix)]
    {
        let meta = if root {
            fs::metadata(path)?
        } else {
            fs::symlink_metadata(path)?
        };
        let id = unix_id(&meta);
        Ok((meta, id))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let flags = if root { 0x0200_0000 } else { 0x0020_0000 };
        let file = OpenOptions::new()
            .access_mode(0)
            .custom_flags(flags)
            .open(path)?;
        Ok((file.metadata()?, windows_id(&file)?))
    }
}

fn open_log(path: &Path) -> io::Result<(File, Metadata, Identity)> {
    let mut open = OpenOptions::new();
    open.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        open.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = open.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::other("not a regular log"));
    }
    #[cfg(unix)]
    let identity = unix_id(&meta);
    #[cfg(windows)]
    let identity = {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("not a regular log"));
        }
        windows_id(&file)?
    };
    Ok((file, meta, identity))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Batch<'a> {
    #[serde(serialize_with = "serialize_lines")]
    lines: vec_deque::Iter<'a, String>,
    next_sequence: u64,
}

fn serialize_lines<S: Serializer>(
    lines: &vec_deque::Iter<'_, String>,
    s: S,
) -> Result<S::Ok, S::Error> {
    s.collect_seq(lines.clone())
}

pub(super) struct Tail {
    files: HashMap<PathBuf, Cursor>,
    changes: Changes,
    // The ring also holds the not-yet-sent suffix, even when a burst exceeds the snapshot's cap.
    lines: VecDeque<String>,
    pending: usize,
    sequence: u64,
}

impl Tail {
    pub(super) fn new(sequence: u64) -> Self {
        Self {
            files: HashMap::new(),
            changes: Changes::new(),
            lines: VecDeque::new(),
            pending: 0,
            sequence,
        }
    }

    pub(super) fn restore(&mut self, root: &Path, saved: Checkpoint) -> Result<(), Fault> {
        let invalid = || Fault::new("invalid_params", "Invalid log checkpoint");
        if saved.lines.len() > CAP || saved.lines.len() as u64 > self.sequence {
            return Err(invalid());
        }
        self.lines = saved.lines;
        for (name, mark) in saved.files {
            let path = Path::new(&name);
            let (identity, offset, observed) = mark.positions();
            if path.file_name() != Some(name.as_ref()) || !log_name(path) || offset > observed {
                return Err(invalid());
            }
            self.files.insert(
                root.join(path),
                Cursor {
                    identity,
                    offset,
                    observed,
                    partial: Vec::new(),
                    changed: None,
                    listed: true,
                },
            );
        }
        Ok(())
    }

    pub(super) fn list(&mut self, root: &Path, initial: bool) -> io::Result<()> {
        let entries = fs::read_dir(root)?;
        for cursor in self.files.values_mut() {
            cursor.listed = false;
        }
        for entry in entries.flatten() {
            let path = entry.path();
            if !log_name(&path) {
                continue;
            }
            if initial {
                if let Ok((meta, identity)) = stat(&path, false)
                    && meta.is_file()
                {
                    self.changes.insert(
                        file_name(&path).into(),
                        Some(Mark::new(identity, meta.len(), meta.len())),
                    );
                    self.files.insert(
                        path,
                        Cursor {
                            identity,
                            offset: meta.len(),
                            observed: meta.len(),
                            partial: Vec::new(),
                            changed: Some(meta.modified().unwrap_or_else(|_| SystemTime::now())),
                            listed: true,
                        },
                    );
                }
                continue;
            }
            if let Some(cursor) = self.files.get_mut(&path) {
                cursor.listed = true;
                if cursor
                    .changed
                    .is_some_and(|at| at.elapsed().unwrap_or_default() >= ACTIVE)
                {
                    continue;
                }
            }
            self.read(path);
        }
        self.files.retain(|path, cursor| {
            if !cursor.listed {
                self.changes.insert(file_name(path).into(), None);
            }
            cursor.listed
        });
        Ok(())
    }

    pub(super) fn read(&mut self, path: PathBuf) {
        let (mut file, meta, identity) = match open_log(&path) {
            Ok(opened) => opened,
            Err(error) => {
                if error.kind() == io::ErrorKind::NotFound && self.files.remove(&path).is_some() {
                    self.changes.insert(file_name(&path).into(), None);
                }
                return;
            }
        };
        use std::collections::hash_map::Entry;
        let mut entry = match self.files.entry(path) {
            Entry::Occupied(e) => e,
            Entry::Vacant(e) => e.insert_entry(Cursor {
                identity,
                offset: 0,
                observed: 0,
                partial: Vec::new(),
                changed: None,
                listed: true,
            }),
        };
        let cursor = entry.get_mut();
        cursor
            .changed
            .get_or_insert_with(|| meta.modified().unwrap_or_else(|_| SystemTime::now()));
        let reset = cursor.identity != identity || meta.len() < cursor.observed;
        if reset {
            cursor.identity = identity;
            cursor.offset = 0;
            cursor.partial.clear();
        }
        let at = cursor.offset + cursor.partial.len() as u64;
        let remaining = meta.len() - at;
        if remaining == 0 && !reset {
            return;
        }
        if file.seek(SeekFrom::Start(at)).is_err() {
            return;
        }
        cursor.observed = meta.len();
        let mut reader = BufReader::new(file.take(remaining));
        cursor.changed = Some(SystemTime::now());
        loop {
            let before = cursor.partial.len();
            match reader.read_until(b'\n', &mut cursor.partial) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => {
                    cursor.partial.truncate(before);
                    break;
                }
            }
            if cursor.partial.last() != Some(&b'\n') {
                break;
            }
            cursor.offset += cursor.partial.len() as u64;
            cursor.partial.pop();
            let line = String::from_utf8(std::mem::take(&mut cursor.partial))
                .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
            if !js_trim(&line).is_empty() {
                if self.lines.len() >= CAP && self.lines.len() > self.pending {
                    self.lines.pop_front();
                }
                self.lines.push_back(line);
                self.pending += 1;
                self.sequence += 1;
            }
        }
        let mark = Mark::new(cursor.identity, cursor.offset, cursor.observed);
        self.changes
            .insert(file_name(entry.key()).into(), Some(mark));
    }

    fn batch(&self, count: usize) -> Batch<'_> {
        Batch {
            lines: self.lines.range(self.lines.len().saturating_sub(count)..),
            next_sequence: self.sequence,
        }
    }

    pub(super) fn snapshot(&self) -> Batch<'_> {
        self.batch(CAP)
    }

    pub(super) fn has_pending(&self) -> bool {
        self.pending != 0 || !self.changes.is_empty()
    }

    pub(super) fn flush(&mut self, send: impl FnOnce(Batch<'_>, &Changes, usize)) {
        send(
            self.batch(self.pending),
            &self.changes,
            CAP.min(self.lines.len()),
        );
        self.changes.clear();
        self.pending = 0;
        self.lines.drain(..self.lines.len().saturating_sub(CAP));
        if self.lines.capacity() > 2 * CAP {
            self.lines.shrink_to(CAP);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use serde_json::json;

    #[test]
    fn a_missed_event_is_recovered_by_listing_without_rereading_cold_logs() {
        let root = crate::fs::disk::make_temp_dir("ompdesk-logs-poll-").unwrap();
        let cold = root.join("omp.old.log");
        let mut old = File::create(&cold).unwrap();
        old.write_all(b"previous\n").unwrap();
        old.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000))
            .unwrap();
        drop(old);
        let mut tail = Tail::new(10);
        tail.list(&root, true).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&cold)
            .unwrap()
            .write_all(b"changed\n")
            .unwrap();
        fs::write(root.join("other.log"), "ignore\n").unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("nested/omp.hidden.log"), "ignore\n").unwrap();
        fs::write(root.join("omp.new.log"), "\u{feff}\n  \r\nfresh\r\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("other.log"), root.join("omp.alias.log")).unwrap();
        tail.list(&root, false).unwrap();
        assert_eq!(
            serde_json::to_value(tail.snapshot()).unwrap(),
            json!({"lines":["fresh\r"], "nextSequence":11})
        );
        tail.read(cold);
        assert_eq!(
            serde_json::to_value(tail.snapshot()).unwrap(),
            json!({"lines":["fresh\r", "changed"], "nextSequence":12})
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_root_created_after_start_reads_new_files_from_their_first_byte() {
        let parent = crate::fs::disk::make_temp_dir("ompdesk-logs-missing-").unwrap();
        let root = parent.join("logs");
        let path = root.join("omp.first.log");
        let mut tail = Tail::new(0);
        assert!(tail.list(&root, true).is_err());
        fs::create_dir(&root).unwrap();
        fs::write(&path, b"first\n\xe2").unwrap();
        tail.list(&root, false).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"\x82\xac\n")
            .unwrap();
        tail.list(&root, false).unwrap();
        assert_eq!(
            serde_json::to_value(tail.snapshot()).unwrap(),
            json!({"lines":["first", "€"], "nextSequence":2})
        );
        fs::remove_dir_all(parent).unwrap();
    }
}
