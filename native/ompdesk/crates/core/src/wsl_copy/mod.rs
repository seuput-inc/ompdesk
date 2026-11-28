//! Host-only checkpoint store. No guest RPC, session-index entry, execution route or Windows stock journal.
//! The caller owns the profile directory and its ACLs. This is not a sandbox against a distro with DrvFS/interop.

mod files;
mod wire;

use std::fs::{self, File};
use std::io::{self, BufReader, Read, Seek};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registration {
    pub distro: String,
    pub parent: Option<String>,
    pub cwd: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Change {
    First,
    Append,
    Replacement,
    Unchanged,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub bytes: u64,
    pub sha256: String,
    pub source: String,
    pub verified_ms: u64,
    pub change: Change,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Turn {
    pub session_key: String,
    pub stock_id: String,
    pub baseline: Checkpoint,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub baseline: Option<Checkpoint>,
    pub source: String,
    pub spawn_id: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Recovery {
    NoPriorSpan,
    Matched,
    Divergent,
}

pub enum TurnDisposition<'a> {
    SnapshotOnly,
    /// The host observed this stock entry ID complete the open turn. Check membership against the sealed journal.
    ConfirmedJournalTurn(&'a str),
}

#[derive(Debug)]
pub struct Receipt {
    pub change: Change,
    pub recovery: Recovery,
    pub turn_resolved: bool,
    pub repaired_host_copy: bool,
    pub checkpoint: Checkpoint,
}

// Only these host-selected filenames ever contain payloads: at most one verified, one pinned and one candidate.
#[derive(PartialEq, Eq, Clone, Copy, Serialize, Deserialize)]
enum Slot {
    A,
    B,
    C,
}

impl Slot {
    const ALL: [Self; 3] = [Self::A, Self::B, Self::C];

    fn name(self) -> &'static str {
        match self {
            Self::A => "copy-a",
            Self::B => "copy-b",
            Self::C => "copy-c",
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Stored<T> {
    slot: Slot,
    info: T,
}

#[derive(Serialize, Deserialize)]
struct State {
    registration: Registration,
    stock_id: Option<String>,
    verified: Option<Stored<Checkpoint>>,
    pending: Option<Stored<Span>>,
    turn: Option<Turn>,
}

impl State {
    fn unused(&self, slot: Slot) -> bool {
        self.verified.as_ref().is_none_or(|v| v.slot != slot)
            && self.pending.as_ref().is_none_or(|v| v.slot != slot)
    }
}

pub struct Store {
    root: PathBuf,
}

pub struct Session {
    dir: PathBuf,
    key: String,
    registration: Registration,
}

pub struct Writer<'a> {
    session: &'a Session,
    spawn: String,
    stock: Option<String>,
    _lease: File,
}

fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}

fn random_id() -> io::Result<String> {
    let mut bytes = [0; 16];
    crate::sys::random(&mut bytes)?;
    Ok(crate::hex(&bytes))
}

fn state(dir: &Path) -> io::Result<State> {
    Ok(serde_json::from_reader(BufReader::new(files::open(
        &dir.join("journal"),
    )?))?)
}

impl Store {
    /// Takes the existing trusted host profile, never a path from a checkpoint or an RPC caller.
    pub fn open(profile: &Path) -> io::Result<Self> {
        files::directory(profile, false)?;
        let root = profile.canonicalize()?.join("wsl-session-copies");
        files::directory(&root, true)?;
        Ok(Self { root })
    }

    pub fn register(&self, registration: Registration) -> io::Result<Session> {
        let key = random_id()?;
        let dir = self.root.join(&key);
        // Exclusive creation, including in the (improbable) event of a random key collision.
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&dir)?;
        files::sync_parent(&dir)?;
        files::create(&dir.join("lease"))?.sync_all()?;
        files::create(&dir.join("gate"))?.sync_all()?;
        let initial = State {
            registration,
            stock_id: None,
            verified: None,
            pending: None,
            turn: None,
        };
        files::commit(&dir, &initial)?;
        Ok(Session {
            dir,
            key,
            registration: initial.registration,
        })
    }

    /// Reopen an existing host key; never create an empty journal when its original/registration is missing.
    pub fn session(&self, key: &str) -> io::Result<Session> {
        if key.len() != 32
            || !key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("invalid session key"));
        }
        let dir = self.root.join(key);
        files::directory(&dir, false)?;
        let registration = state(&dir)?.registration;
        Ok(Session {
            dir,
            key: key.to_owned(),
            registration,
        })
    }
}

impl Session {
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn registration(&self) -> &Registration {
        &self.registration
    }

    /// The host must reconcile the previous guest process before admission; this lease fences host writers only.
    pub fn admit(&self) -> io::Result<Writer<'_>> {
        let lease = files::lease(&self.dir.join("lease"))?;
        Ok(Writer {
            session: self,
            spawn: random_id()?,
            stock: None,
            _lease: lease,
        })
    }

    fn read_slot<T>(&self, slot: Option<Stored<T>>) -> io::Result<Option<(T, File)>> {
        slot.map(|s| Ok((s.info, files::open(&self.dir.join(s.slot.name()))?)))
            .transpose()
    }

    /// Read-only handle to the exact version named by this checkpoint, including across subsequent publications.
    pub fn verified(&self) -> io::Result<Option<(Checkpoint, File)>> {
        let pinned = {
            let _gate = files::lock(&self.dir.join("gate"), false)?;
            self.read_slot(state(&self.dir)?.verified)?
        };
        if let Some((info, mut file)) = pinned {
            if file.metadata()?.len() != info.bytes || !wire::intact_prefix(&mut file, &info)? {
                return Err(invalid("damaged local checkpoint"));
            }
            file.rewind()?;
            return Ok(Some((info, file)));
        }
        Ok(None)
    }

    /// Unsealed transfer bytes, not a transcript. During receive this read-only file may still grow.
    pub fn interrupted(&self) -> io::Result<Option<(Span, File)>> {
        let _gate = files::lock(&self.dir.join("gate"), false)?;
        self.read_slot(state(&self.dir)?.pending)
    }

    pub fn open_turn(&self) -> io::Result<Option<Turn>> {
        Ok(state(&self.dir)?.turn)
    }
}

impl Writer<'_> {
    pub fn spawn_id(&self) -> &str {
        &self.spawn
    }

    /// Called with stock's ID from the admitted launch's get_state, never from a checkpoint header.
    pub fn bind_stock_id(&mut self, id: &str) -> io::Result<()> {
        self.stock = None;
        if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
            return Err(invalid("invalid stock id"));
        }
        let dir = &self.session.dir;
        let mut s = state(dir)?;
        match s.stock_id.as_deref() {
            Some(old) if old != id => return Err(invalid("stock id changed")),
            Some(_) => (),
            None => {
                s.stock_id = Some(id.to_owned());
                files::commit(dir, &s)?;
            }
        }
        self.stock = Some(id.to_owned());
        Ok(())
    }

    /// Persist the interruption marker before sending any live turn input. Seal the initial header first.
    pub fn begin_turn(&mut self) -> io::Result<()> {
        let stock = self
            .stock
            .as_ref()
            .ok_or_else(|| invalid("unbound writer"))?;
        let dir = &self.session.dir;
        let mut s = state(dir)?;
        if s.turn.is_some() || s.pending.is_some() {
            return Err(invalid("previous turn or transfer unresolved"));
        }
        let baseline = s
            .verified
            .as_ref()
            .ok_or_else(|| invalid("no verified turn baseline"))?;
        s.turn = Some(Turn {
            session_key: self.session.key.clone(),
            stock_id: stock.clone(),
            baseline: baseline.info.clone(),
        });
        files::commit(dir, &s)
    }

    /// The reader and exit callback must belong to the host-selected distro/key/spawn subprocess. On protocol
    /// refusal before EOF the caller must terminate/reap it. A successful exit is asked only after a valid seal and EOF.
    /// One unresolved transfer is pinned: subsequent receives are reconciliation attempts, never overwrite its evidence.
    /// Each transfer is capped at 512 MiB, each complete JSONL record at 32 MiB (including LF).
    pub fn receive(
        &mut self,
        reader: impl Read,
        exit: impl FnOnce() -> io::Result<bool>,
        turn: TurnDisposition<'_>,
    ) -> io::Result<Receipt> {
        let stock = self
            .stock
            .as_deref()
            .ok_or_else(|| invalid("unbound writer"))?;
        let mut input = BufReader::new(reader);
        let h = wire::header(&mut input, self.session.key(), &self.spawn, stock)?;
        let dir = &self.session.dir;
        let mut s = state(dir)?;
        let slot = Slot::ALL
            .into_iter()
            .find(|&n| s.unused(n))
            .ok_or_else(|| invalid("no free copy slot"))?;
        let previous_span = s.pending.as_ref().map(|p| p.slot);
        let mut file = {
            let _gate = files::lock(&dir.join("gate"), true)?;
            let file = files::empty_slot(dir, slot.name())?;
            if previous_span.is_none() {
                s.pending = Some(Stored {
                    slot,
                    info: Span {
                        baseline: s.verified.as_ref().map(|p| p.info.clone()),
                        source: h.source.clone(),
                        spawn_id: self.spawn.clone(),
                    },
                });
                files::commit(dir, &s)?;
            }
            file
        };
        let digest = wire::body(&mut input, &mut file, h.bytes);
        file.sync_all()?;
        let digest = digest?;
        wire::seal(&mut input, &digest)?;
        if !exit()? {
            return Err(invalid("checkpoint process failed"));
        }
        let prior = s.verified.as_ref().map(|v| &v.info);
        let change = match prior {
            None => Change::First,
            Some(p) if p.sha256 == digest && p.bytes == h.bytes && p.source == h.source => {
                Change::Unchanged
            }
            Some(p) if wire::extends(&mut file, &h, p)? => Change::Append,
            Some(_) => Change::Replacement,
        };
        let witness = match (&s.turn, turn) {
            (Some(t), TurnDisposition::ConfirmedJournalTurn(id)) if !id.is_empty() => {
                let appended = if prior == Some(&t.baseline) {
                    change == Change::Append
                } else {
                    wire::extends(&mut file, &h, &t.baseline)?
                };
                appended.then_some((id, t.baseline.bytes))
            }
            _ => None,
        };
        let witnessed = wire::records(&mut file, stock, witness)?;
        let recovery = match previous_span {
            None => Recovery::NoPriorSpan,
            Some(p) if wire::matches_span(files::open(&dir.join(p.name()))?, &mut file)? => {
                Recovery::Matched
            }
            Some(_) => Recovery::Divergent,
        };
        let turn_resolved = witnessed && recovery != Recovery::Divergent;
        if turn_resolved {
            s.turn = None;
        }
        if recovery != Recovery::Divergent {
            s.pending = None;
        }
        let repaired_host_copy = if change == Change::Unchanged {
            match self.session.verified() {
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::InvalidData
                    ) =>
                {
                    true
                }
                Err(e) => return Err(e),
                Ok(_) => false,
            }
        } else {
            false
        };
        let checkpoint = match prior {
            Some(p) if change == Change::Unchanged => p.clone(),
            _ => {
                let timestamp = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(io::Error::other)?;
                let info = Checkpoint {
                    bytes: h.bytes,
                    sha256: digest,
                    source: h.source,
                    verified_ms: timestamp.as_millis() as u64,
                    change,
                };
                s.verified = Some(Stored {
                    slot,
                    info: info.clone(),
                });
                info
            }
        };
        if repaired_host_copy && let Some(verified) = &mut s.verified {
            verified.slot = slot;
        }
        let _gate = files::lock(&dir.join("gate"), true)?;
        files::commit(dir, &s)?;
        // Only after the journal commit. If interrupted, even repeated failures leave at most the three fixed slots.
        for unused in Slot::ALL.into_iter().filter(|&n| s.unused(n)) {
            let _ = fs::remove_file(dir.join(unused.name()));
        }
        Ok(Receipt {
            change,
            recovery,
            turn_resolved,
            repaired_host_copy,
            checkpoint,
        })
    }
}

#[cfg(test)]
mod tests;
