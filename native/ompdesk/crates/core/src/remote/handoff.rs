//! A session a paired computer hands to this one (the receiving side of `handOffSession` in
//! `src/main/session-mutations.ts`; the sending side's record is `sessions::deleted`). One transfer per id the sender
//! made, kept in `<userData>/session-handoffs-in.json` (0600) so that every step answers the same after a crash:
//!
//! - `remote.handoff.put` stores one part of the journal, of a file of its artifacts folder, or of a picture blob it
//!   names, under `<userData>/handoff-in/<id>/`. The first part records the transfer `staged`.
//! - `remote.handoff.commit` lands it: the journal's header names this computer's folder (as stock
//!   `SessionManager.moveTo` rewrites `cwd`), the blobs join stock's blob store, the transfer is recorded `committing`
//!   with its target, the artifacts folder moves beside the target, and the journal is renamed into place last, so
//!   the session exists here exactly when its file does. Then `done`.
//! - `remote.handoff.abort` is the sender asking who owns the session: a committed transfer answers `moved` with its
//!   path; anything else is recorded `aborted` before the answer, and every later part or commit of that id is
//!   refused, so a commit that was still on its way can never land after the sender took the session back.
//!
//! Every step of every transfer runs under one lock, so a commit and an abort of the same id never interleave. A
//! `committing` transfer a crash left behind is resolved by whether its target exists. Orca has no counterpart: its
//! hand-over (`bots-take-over.ts:62-68`) only removes the chat it opened when the bot refuses, which is the rule kept
//! here: a refused transfer leaves nothing behind on either side.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::disk::tree::write_atomic_if;
use crate::git::parse::remote_web_base;
use crate::git::run::Git;
use crate::run::Runner;
use crate::server::{Fault, Registry, Reply};

const RECORD: &str = "session-handoffs-in.json";
const STAGING: &str = "handoff-in";
/// One file of a transfer at most (a journal, an artifact, a blob).
const MAX_FILE_BYTES: u64 = 1 << 30;
/// Settled transfers kept; the oldest go first. Pending ones always stay.
const MAX_SETTLED: usize = 2000;
/// Folders a sender's project is looked for in, at most.
const MAX_CANDIDATES: usize = 256;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum State {
    Staged,
    /// The journal is being renamed to `target` from `temp`; the artifacts may already be beside `target`.
    Committing {
        target: String,
        temp: String,
    },
    Done {
        path: String,
    },
    Aborted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Transfer {
    /// The device that sent it: only it may commit or abort it.
    from: String,
    at: f64,
    state: State,
}

struct Record {
    file: PathBuf,
    transfers: BTreeMap<String, Transfer>,
}

impl Record {
    /// A damaged record is refused, never read as empty: it holds the aborted ids a late commit must not pass.
    fn load(user_data: &Path) -> Result<Record, Fault> {
        let file = user_data.join(RECORD);
        let transfers = match fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                Fault::new(
                    "handoff_record",
                    format!("The record of sessions handed to this computer is damaged: {error}"),
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(io_fault(&error, &file)),
        };
        Ok(Record { file, transfers })
    }

    fn set(&mut self, id: &str, from: &str, state: State) {
        self.transfers.insert(
            id.to_owned(),
            Transfer {
                from: from.to_owned(),
                at: now_ms(),
                state,
            },
        );
    }

    /// Written before the step it records is answered; an error means the step did not happen.
    fn save(&mut self) -> Result<(), Fault> {
        let settled =
            |transfer: &Transfer| matches!(transfer.state, State::Done { .. } | State::Aborted);
        let mut old: Vec<(f64, String)> = self
            .transfers
            .iter()
            .filter(|(_, transfer)| settled(*transfer))
            .map(|(id, transfer)| (transfer.at, id.clone()))
            .collect();
        if old.len() > MAX_SETTLED {
            old.sort_by(|a, b| a.0.total_cmp(&b.0));
            for (_, id) in old.iter().take(old.len() - MAX_SETTLED) {
                self.transfers.remove(id);
            }
        }
        let bytes = serde_json::to_vec(&self.transfers)
            .map_err(|error| Fault::new("internal", error.to_string()))?;
        write_atomic_if(&self.file, &bytes, Some(0o600), 0o700, &|| true).map(|_| ())
    }
}

static LOCK: LazyLock<Mutex<()>> = LazyLock::new(Mutex::default);

fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |since| since.as_millis() as f64)
}

fn io_fault(error: &std::io::Error, path: &Path) -> Fault {
    Fault::new("handoff_io", format!("{}: {error}", path.display()))
}

fn unknown() -> Fault {
    Fault::new(
        "handoff_unknown",
        "This computer has no such hand-over from that computer",
    )
}

fn aborted() -> Fault {
    Fault::new("handoff_aborted", "This hand-over was called off")
}

fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn staging(user_data: &Path, id: &str) -> PathBuf {
    user_data.join(STAGING).join(id)
}

/// Where a part lands in the staging folder: the journal, a file of the artifacts folder by its relative path, or a
/// blob by its SHA-256. Anything else (an absolute path, `..`, a separator of another system) is refused.
fn staged_path(rel: &str) -> Result<PathBuf, Fault> {
    let invalid = || Fault::new("invalid_params", format!("Not a part of a session: {rel}"));
    if rel == "session.jsonl" {
        return Ok(PathBuf::from(rel));
    }
    if let Some(hash) = rel.strip_prefix("blobs/") {
        let hex = hash.len() == 64
            && hash
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c));
        return if hex {
            Ok(Path::new("blobs").join(hash))
        } else {
            Err(invalid())
        };
    }
    let rest = rel.strip_prefix("artifacts/").ok_or_else(invalid)?;
    let mut path = PathBuf::from("artifacts");
    for part in rest.split('/') {
        let plain = !part.is_empty()
            && part != "."
            && part != ".."
            && !part.contains(['\\', ':', '\0'])
            && matches!(
                Path::new(part).components().next(),
                Some(Component::Normal(_))
            );
        if !plain {
            return Err(invalid());
        }
        path.push(part);
    }
    Ok(path)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Of {
    user_data: PathBuf,
    /// The sending device, as this computer's link authenticated it.
    from: String,
    id: String,
}

impl Of {
    fn check(&self) -> Result<(), Fault> {
        if valid_id(&self.id) && !self.from.is_empty() && self.user_data.is_absolute() {
            Ok(())
        } else {
            Err(Fault::new(
                "invalid_params",
                "A hand-over needs its id and its sender",
            ))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Put {
    #[serde(flatten)]
    of: Of,
    rel: String,
    offset: u64,
}

fn put(put: &Put, bytes: &[u8]) -> Result<Value, Fault> {
    let Put { of, rel, offset } = put;
    of.check()?;
    let target = staging(&of.user_data, &of.id).join(staged_path(rel)?);
    let _lock = lock();
    let mut record = Record::load(&of.user_data)?;
    match record.transfers.get(&of.id) {
        Some(transfer) if transfer.from != of.from => return Err(unknown()),
        Some(Transfer {
            state: State::Aborted,
            ..
        }) => return Err(aborted()),
        Some(Transfer {
            state: State::Staged,
            ..
        }) => {}
        // A part sent again after the commit landed (its answer was lost): already here.
        Some(_) => return Ok(json!({ "received": offset + bytes.len() as u64 })),
        None => {
            record.set(&of.id, &of.from, State::Staged);
            record.save()?;
        }
    }
    let end = offset + bytes.len() as u64;
    if end > MAX_FILE_BYTES {
        return Err(Fault::new(
            "file_too_large",
            "A file of this session is too large to hand over",
        ));
    }
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|error| io_fault(&error, dir))?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&target)
        .map_err(|error| io_fault(&error, &target))?;
    let had = file
        .metadata()
        .map_err(|error| io_fault(&error, &target))?
        .len();
    // A part sent again lands where it did; one past the end means a part went missing.
    if *offset > had {
        return Err(Fault::new(
            "invalid_params",
            "A part of the session arrived out of order",
        ));
    }
    file.set_len(*offset)
        .map_err(|error| io_fault(&error, &target))?;
    file.seek(SeekFrom::Start(*offset))
        .map_err(|error| io_fault(&error, &target))?;
    file.write_all(bytes)
        .map_err(|error| io_fault(&error, &target))?;
    Ok(json!({ "received": end }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Commit {
    #[serde(flatten)]
    of: Of,
    /// The journal's name on the sender (`<time>_<session id>.jsonl`), kept here.
    file_name: String,
    /// This computer's folder for the session's project (`remote.handoff.folder`).
    cwd: String,
    /// Stock's session folder for `cwd` (`SessionManager.getDefaultSessionDir`) and its blob store (`getBlobsDir`).
    session_dir: PathBuf,
    blobs_dir: PathBuf,
}

/// The artifacts folder stock keeps beside a journal: its path without `.jsonl` (`deleteSessionWithArtifacts`).
fn artifacts_of(target: &Path) -> PathBuf {
    target.with_extension("")
}

/// The journal with its header's `cwd` set to `cwd`, as stock's `SessionManager.moveTo` sets `#header.cwd`; every other
/// line, the title slot stock keeps first at its fixed size among them, stays byte for byte. Refused when no session
/// header follows that slot, or the header names another session than its file (`<time>_<id>.jsonl`, or the fake
/// omp's `<id>.jsonl`).
fn with_cwd(journal: &[u8], cwd: &str, file_name: &str) -> Result<Vec<u8>, Fault> {
    let corrupt = |why: &str| {
        Fault::new(
            "handoff_corrupt",
            format!("The handed session is not whole: {why}"),
        )
    };
    let mut start = 0;
    loop {
        let end = journal[start..]
            .iter()
            .position(|&byte| byte == b'\n')
            .map_or(journal.len(), |at| start + at);
        let mut entry: Value =
            serde_json::from_slice(&journal[start..end]).map_err(|_| corrupt("no header"))?;
        match entry.get("type").and_then(Value::as_str) {
            Some("title") if start == 0 && end < journal.len() => {
                start = end + 1;
                continue;
            }
            Some("session") => {}
            _ => return Err(corrupt("no header")),
        }
        if let Some(id) = entry.get("id").and_then(Value::as_str)
            && !file_name.ends_with(&format!("_{id}.jsonl"))
            && file_name != format!("{id}.jsonl")
        {
            return Err(corrupt("its file names another session"));
        }
        entry["cwd"] = json!(cwd);
        let mut out = journal[..start].to_vec();
        out.extend(
            serde_json::to_vec(&entry)
                .map_err(|error| Fault::new("internal", error.to_string()))?,
        );
        out.extend_from_slice(&journal[end..]);
        return Ok(out);
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

/// A folder moved; across volumes (the profile and `~/.omp` on different disks) copied, then removed.
fn move_dir(from: &Path, to: &Path) -> Result<(), Fault> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_dir(from, to).map_err(|error| io_fault(&error, to))?;
    fs::remove_dir_all(from).map_err(|error| io_fault(&error, from))
}

/// Undoes a commit that did not reach its rename: the temp journal goes, and the artifacts go back to the staging
/// folder (or away, when the transfer is called off).
fn unwind(staged: &Path, target: &Path, temp: &Path, keep: bool) -> Result<(), Fault> {
    match fs::remove_file(temp) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(io_fault(&error, temp));
        }
        _ => {}
    }
    let moved = artifacts_of(target);
    if moved.is_dir() {
        let back = staged.join("artifacts");
        if keep && !back.exists() {
            move_dir(&moved, &back)?;
        } else {
            fs::remove_dir_all(&moved).map_err(|error| io_fault(&error, &moved))?;
        }
    }
    Ok(())
}

/// A `committing` transfer: done when its journal is in place, else unwound to `staged` (or away, `keep` false).
/// Returns the session's path when it landed.
fn resolve(
    record: &mut Record,
    of: &Of,
    target: &str,
    temp: &str,
    keep: bool,
) -> Result<Option<String>, Fault> {
    if Path::new(target).is_file() {
        record.set(
            &of.id,
            &of.from,
            State::Done {
                path: target.to_owned(),
            },
        );
        // The journal in place is what decides; a record not saved now says `committing` and resolves the same.
        let _ = record.save();
        return Ok(Some(target.to_owned()));
    }
    unwind(
        &staging(&of.user_data, &of.id),
        Path::new(target),
        Path::new(temp),
        keep,
    )?;
    record.set(&of.id, &of.from, State::Staged);
    record.save()?;
    Ok(None)
}

fn landed(path: &str) -> Value {
    json!({ "sessionPath": path })
}

fn commit(commit: &Commit) -> Result<Value, Fault> {
    let Commit {
        of,
        file_name,
        cwd,
        session_dir,
        blobs_dir,
    } = commit;
    of.check()?;
    let plain_name = file_name.ends_with(".jsonl")
        && !file_name.starts_with('.')
        && !file_name.contains(['/', '\\', ':', '\0']);
    if !plain_name
        || !session_dir.is_absolute()
        || !blobs_dir.is_absolute()
        || !Path::new(cwd).is_absolute()
    {
        return Err(Fault::new(
            "invalid_params",
            "A hand-over needs a session file name and absolute folders",
        ));
    }
    let _lock = lock();
    let mut record = Record::load(&of.user_data)?;
    let Some(transfer) = record.transfers.get(&of.id).cloned() else {
        return Err(unknown());
    };
    if transfer.from != of.from {
        return Err(unknown());
    }
    match transfer.state {
        State::Aborted => return Err(aborted()),
        State::Done { path } => return Ok(landed(&path)),
        State::Committing { target, temp } => {
            if let Some(path) = resolve(&mut record, of, &target, &temp, true)? {
                return Ok(landed(&path));
            }
        }
        State::Staged => {}
    }
    let staged = staging(&of.user_data, &of.id);
    let target = session_dir.join(file_name);
    let artifacts = artifacts_of(&target);
    if target.exists() || artifacts.exists() {
        return Err(Fault::new(
            "session_exists",
            "This computer already has that session",
        ));
    }
    let journal_file = staged.join("session.jsonl");
    let journal = fs::read(&journal_file).map_err(|_| {
        Fault::new(
            "handoff_incomplete",
            "The session's journal has not arrived",
        )
    })?;
    let journal = with_cwd(&journal, cwd, file_name)?;
    let blobs = staged.join("blobs");
    if blobs.is_dir() {
        for entry in fs::read_dir(&blobs).map_err(|error| io_fault(&error, &blobs))? {
            let entry = entry.map_err(|error| io_fault(&error, &blobs))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let bytes = fs::read(entry.path()).map_err(|error| io_fault(&error, &entry.path()))?;
            if crate::hex(&Sha256::digest(&bytes)) != name {
                return Err(Fault::new(
                    "handoff_corrupt",
                    "A picture of the session arrived damaged",
                ));
            }
            let dest = blobs_dir.join(&name);
            if !dest.exists() {
                write_atomic_if(&dest, &bytes, None, 0o700, &|| true)?;
            }
        }
    }
    let temp = session_dir.join(format!(".{file_name}.{}.handoff", of.id));
    let (target_text, temp_text) = (
        target.to_string_lossy().into_owned(),
        temp.to_string_lossy().into_owned(),
    );
    record.set(
        &of.id,
        &of.from,
        State::Committing {
            target: target_text.clone(),
            temp: temp_text.clone(),
        },
    );
    record.save()?;
    let landing = (|| {
        fs::create_dir_all(session_dir).map_err(|error| io_fault(&error, session_dir))?;
        fs::write(&temp, &journal).map_err(|error| io_fault(&error, &temp))?;
        let staged_artifacts = staged.join("artifacts");
        if staged_artifacts.is_dir() {
            move_dir(&staged_artifacts, &artifacts)?;
        }
        fs::rename(&temp, &target).map_err(|error| io_fault(&error, &target))
    })();
    if let Err(fault) = landing {
        // Nothing of it stays in the session folder; the parts wait for another commit or the abort.
        let _ = resolve(&mut record, of, &target_text, &temp_text, true);
        return Err(fault);
    }
    // A session handed back to a path this computer once left from is listed again.
    crate::sessions::deleted::clear(&target_text);
    record.set(
        &of.id,
        &of.from,
        State::Done {
            path: target_text.clone(),
        },
    );
    let _ = record.save();
    let _ = fs::remove_dir_all(&staged);
    Ok(landed(&target_text))
}

fn abort(of: &Of) -> Result<Value, Fault> {
    of.check()?;
    let _lock = lock();
    let mut record = Record::load(&of.user_data)?;
    match record.transfers.get(&of.id).cloned() {
        Some(transfer) if transfer.from != of.from => return Err(unknown()),
        Some(Transfer {
            state: State::Done { path },
            ..
        }) => {
            return Ok(json!({ "state": "moved", "sessionPath": path }));
        }
        Some(Transfer {
            state: State::Aborted,
            ..
        }) => return Ok(json!({ "state": "aborted" })),
        Some(Transfer {
            state: State::Committing { target, temp },
            ..
        }) => {
            if let Some(path) = resolve(&mut record, of, &target, &temp, false)? {
                return Ok(json!({ "state": "moved", "sessionPath": path }));
            }
        }
        Some(Transfer {
            state: State::Staged,
            ..
        })
        | None => {}
    }
    // Saved before the answer: once the sender hears `aborted` it runs the session again, and no part or commit of
    // this id may land after that.
    record.set(&of.id, &of.from, State::Aborted);
    record.save()?;
    let _ = fs::remove_dir_all(staging(&of.user_data, &of.id));
    Ok(json!({ "state": "aborted" }))
}

/// `origin`'s web base (`https://host/owner/repo`, lower case), the project's identity across computers.
async fn origin_of(git: &Git, cwd: &str) -> Option<String> {
    let output = git
        .capped(cwd, &["config", "--get", "remote.origin.url"], 4096)
        .await
        .ok()
        .filter(|output| output.code == 0 && !output.truncated)?;
    remote_web_base(output.text().trim()).map(|base| base.to_lowercase())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginParams {
    git: Runner,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderParams {
    git: Runner,
    /// The folder the session works in on the sender.
    cwd: String,
    /// The sender's `origin` of that folder (`remote.handoff.origin`); null when it has none.
    origin: Option<String>,
    /// This computer's project folders, in the order to try them.
    candidates: Vec<String>,
}

/// This computer's folder for the sender's project: the same path when it is a folder here (of the same repository
/// when the sender's has an origin), else the first project folder here whose origin is the same. None: the project
/// is not on this computer, and the hand-over is refused before anything moves.
async fn folder(params: FolderParams, git: &Git) -> Option<String> {
    let FolderParams {
        cwd,
        origin,
        candidates,
        ..
    } = params;
    let wanted = origin.map(|origin| origin.to_lowercase());
    let tried = std::iter::once(cwd.clone()).chain(candidates.into_iter().take(MAX_CANDIDATES));
    for candidate in tried {
        if !Path::new(&candidate).is_absolute() || !Path::new(&candidate).is_dir() {
            continue;
        }
        let same = match &wanted {
            None => candidate == cwd,
            Some(wanted) => origin_of(git, &candidate).await.as_deref() == Some(wanted.as_str()),
        };
        if same {
            return Some(candidate);
        }
    }
    None
}

async fn blocking(
    work: impl FnOnce() -> Result<Value, Fault> + Send + 'static,
) -> Result<Reply, Fault> {
    let value = tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))??;
    Reply::json(&value)
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("remote.handoff.put", |call| {
        Box::pin(async move {
            let part: Put = call.params()?;
            let bytes = call.bin.unwrap_or_default();
            blocking(move || put(&part, &bytes)).await
        })
    });
    registry.add("remote.handoff.commit", |call| {
        Box::pin(async move {
            let landing: Commit = call.params()?;
            blocking(move || commit(&landing)).await
        })
    });
    registry.add("remote.handoff.abort", |call| {
        Box::pin(async move {
            let of: Of = call.params()?;
            blocking(move || abort(&of)).await
        })
    });
    registry.add("remote.handoff.origin", |call| {
        Box::pin(async move {
            let OriginParams { git, cwd } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&json!({ "origin": origin_of(&git, &cwd).await }))
        })
    });
    registry.add("remote.handoff.folder", |call| {
        Box::pin(async move {
            let params: FolderParams = call.params()?;
            let git = Git::new(params.git.clone(), call.scope);
            Reply::json(&json!({ "folder": folder(params, &git).await }))
        })
    });
}

#[cfg(test)]
mod tests;
