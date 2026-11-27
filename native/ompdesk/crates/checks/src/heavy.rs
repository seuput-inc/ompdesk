//! The computer's heavy slots: one counting pool per user and computer that every heavy command (a test suite, a
//! build, a type check) takes a place in, so several projects and sessions never run more of them at once than the
//! machine holds.
//!
//! The pool is a folder of files any program can join (`pool_dir`): `slot.<i>` for `0 ≤ i < size`, each held by an
//! exclusive OS file lock (`flock`, Windows `LockFileEx`) for as long as its holder lives, so a holder that dies or is
//! killed gives its place back at once and nothing has to judge a stale owner. `slot.<i>.owner` says who holds it (JSON,
//! read only while the lock is held). `counter` serializes publishing tickets and claiming slots. A waiter locks
//! `queue/<number>.<pid>` until admitted or cancelled. A release may pass older normal tickets once; the number of
//! the admitted release protects those tickets from every subsequent release. Legacy FIFO tickets are barriers.
//! A ticket whose lock is free belongs to a waiter that died.
//!
//! Size (`pool_size`): one slot per 8 GB of RAM over the first 8 GB (which stay for the system, OMPdesk and its
//! sessions), at least 1, at most half the cores and at most 7: a 16 GB computer runs one heavy command at a time, a
//! 24 GB one two, 64 GB with 16 cores seven. `OMPDESK_HEAVY_SLOTS` sets it for measuring.
//!
//! Nesting: a holder puts `OMPDESK_HEAVY_HELD` (its own pid) in its command's environment; a heavy command started
//! under it (a check script that wraps each step) runs inside its holder's place instead of waiting on itself.
//!
//! Known writes reserve incremental bytes by volume. Recognized supervised jobs with no estimate reserve their
//! enrolled volumes exclusively. Detached holders retain the legacy free-space floor. `admission-off` disables
//! start checks, not the running command's emergency disk watcher.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const DIR_ENV: &str = "OMPDESK_HEAVY_DIR";
pub const SLOTS_ENV: &str = "OMPDESK_HEAVY_SLOTS";
pub const HELD_ENV: &str = "OMPDESK_HEAVY_HELD";
pub const MIN_FREE_ENV: &str = "OMPDESK_HEAVY_MIN_FREE_GB";
pub const WRITES_ENV: &str = "OMPDESK_WRITE_BYTES";
/// Free space under which a running heavy command is stopped, in GB (default `watch::DANGER`); for tests.
pub const DANGER_ENV: &str = "OMPDESK_HEAVY_DANGER_GB";

const GIB: u64 = 1024 * 1024 * 1024;
const MAX_SLOTS: usize = 7;
const POLL: Duration = Duration::from_millis(250);
/// A ticket still being made (`.tmp`, locked before it is renamed into the queue) older than this was left by a
/// waiter that died in between.
const TMP_STALE: Duration = Duration::from_secs(60);

/// Slots for a computer with `ram` bytes and `cores` cores.
pub fn pool_size(ram: u64, cores: usize) -> usize {
    let gb = (ram as f64 / GIB as f64).round() as u64;
    let by_ram = (gb.saturating_sub(8) / 8) as usize;
    by_ram.min((cores / 2).max(1)).clamp(1, MAX_SLOTS)
}

/// This computer's pool size, or `OMPDESK_HEAVY_SLOTS`.
pub fn machine_size(env: &dyn Fn(&str) -> Option<String>) -> usize {
    if let Some(n) = env(SLOTS_ENV)
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
    {
        return n;
    }
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    pool_size(crate::sys::physical_memory().unwrap_or(16 * GIB), cores)
}

/// The pool's folder: `OMPDESK_HEAVY_DIR`, else `~/.cache/ompdesk/heavy` (`$XDG_CACHE_HOME` when set) on macOS and
/// Linux, `%LOCALAPPDATA%\ompdesk\heavy` on Windows. Fixed per user, never per app profile, so a development or test
/// OMPdesk and a plain shell script share one pool with the installed app.
pub fn pool_dir(env: &dyn Fn(&str) -> Option<String>) -> PathBuf {
    if let Some(dir) = env(DIR_ENV).filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    if cfg!(windows) {
        if let Some(local) = env("LOCALAPPDATA").filter(|d| !d.is_empty()) {
            return Path::new(&local).join("ompdesk").join("heavy");
        }
        let profile = env("USERPROFILE").unwrap_or_default();
        return Path::new(&profile)
            .join("AppData")
            .join("Local")
            .join("ompdesk")
            .join("heavy");
    }
    let cache = env("XDG_CACHE_HOME")
        .filter(|d| d.starts_with('/'))
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(&env("HOME").unwrap_or_default()).join(".cache"));
    cache.join("ompdesk").join("heavy")
}

/// Who holds a slot, as `slot.<i>.owner` says.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Owner {
    pub pid: u32,
    pub command: String,
    pub cwd: String,
    /// Milliseconds since the epoch the slot was taken.
    pub since: u64,
    /// Slots this holder took at once (`--all` takes every one).
    pub weight: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
enum Claim {
    Bytes(u64),
    Exclusive,
    Unmetered,
}

impl Claim {
    fn conflicts(self, other: Self) -> bool {
        !matches!(
            (self, other),
            (Self::Bytes(_), Self::Bytes(_)) | (Self::Unmetered, Self::Unmetered)
        )
    }
}

#[cfg(unix)]
pub(crate) type Cpu = bool;

#[cfg(windows)]
#[derive(Clone, Copy, Default)]
pub(crate) struct Cpu {
    pub idle: u64,
    pub total: u64,
}

#[derive(Clone, Copy)]
pub(crate) struct Pressure {
    pub cpu: Cpu,
    pub critical: bool,
    pub warning: bool,
    pub swap: u64,
}

impl Pressure {
    fn hold(self, before: Self) -> Option<&'static str> {
        #[cfg(unix)]
        let busy = self.cpu;
        #[cfg(windows)]
        let busy = self.cpu.total > before.cpu.total && self.cpu.idle == before.cpu.idle;
        if self.critical {
            Some("critical memory pressure")
        } else if self.warning && self.swap > before.swap {
            Some("memory pressure with growing swap")
        } else if busy {
            Some("CPU saturated")
        } else {
            None
        }
    }
}

#[derive(Serialize)]
struct SlotRecord<'a> {
    #[serde(flatten)]
    owner: &'a Owner,
    remaining: &'a BTreeMap<u64, Claim>,
}

#[derive(Deserialize)]
struct Reservations {
    remaining: BTreeMap<u64, Claim>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Free space a heavy command needs on a volume of `total` bytes before it starts: a tenth of the volume, at least
/// 10 GB and at most 20 GB. A tenth follows the disk's size; under 10 GB macOS and Windows start failing their own
/// writes (swap, updates, an app's settings file); past 20 GB a big disk would idle work with plenty left, and the
/// heaviest measured check (a Playwright suite with traces and a build) wrote under 10 GB.
pub fn min_free(total: u64) -> u64 {
    (total / 10).clamp(10 * GIB, 20 * GIB)
}

/// Free and total bytes of the volume holding a path.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Disk {
    pub volume: Option<u64>,
    pub path: String,
    pub free: u64,
    pub total: u64,
    /// What a new heavy command needs free there.
    pub need: u64,
}

impl Disk {
    pub fn low(&self) -> bool {
        self.free < self.need
    }
}

pub type Probe = std::sync::Arc<dyn Fn(&Path) -> Option<(Option<u64>, u64, u64)> + Send + Sync>;

/// The volumes a heavy command writes to: its own folder, the temp folder it is given (`TMPDIR`, Windows `TEMP`/`TMP`)
/// and every folder its arguments name (`--output test-results`, `--outputFile=/Volumes/BACKUP/r.json`), each read on
/// the volume that holds it, so work on an external disk is judged by that disk.
#[derive(Clone)]
pub struct Volumes {
    pub paths: Vec<PathBuf>,
    /// `OMPDESK_HEAVY_MIN_FREE_GB` in bytes; `None` is `min_free` of each volume.
    pub need: Option<u64>,
    /// Free bytes under which a running command is stopped.
    pub danger: u64,
    probe: Probe,
    claims: Result<Option<BTreeMap<PathBuf, u64>>, String>,
    undeclared: Claim,
    pressure: fn() -> io::Result<Pressure>,
}

/// The nearest folder of `path` that exists (an output folder is often made by the command itself).
fn existing(path: &Path) -> Option<PathBuf> {
    for parent in path.ancestors() {
        match fs::metadata(parent) {
            Ok(meta) if meta.is_dir() => return Some(parent.to_owned()),
            Ok(_) => {
                let actual = fs::canonicalize(parent).ok()?;
                return actual.parent().map(Path::to_owned);
            }
            // The volume of a blocked mkdir is known; let the operation report the non-directory.
            Err(e) if e.kind() == io::ErrorKind::NotADirectory => continue,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if fs::symlink_metadata(parent).is_ok() {
                    return None;
                }
            }
            Err(_) => return None,
        }
    }
    None
}

impl Volumes {
    pub fn of_work(cwd: &Path, argv: &[String], env: &dyn Fn(&str) -> Option<String>) -> Volumes {
        let mut paths = vec![cwd.to_path_buf()];
        let temp = if cfg!(windows) {
            env("TEMP").or_else(|| env("TMP"))
        } else {
            env("TMPDIR")
        };
        paths.push(
            temp.filter(|t| !t.is_empty())
                .map_or_else(std::env::temp_dir, PathBuf::from),
        );
        for arg in argv.iter().skip(1) {
            let value = match arg.split_once('=') {
                Some((flag, value)) if flag.starts_with('-') => value,
                _ if arg.starts_with('-') => continue,
                _ => arg.as_str(),
            };
            if value.contains(['/', '\\']) || value.starts_with('.') {
                paths.push(cwd.join(value));
            }
        }
        let home = env("HOME")
            .or_else(|| env("USERPROFILE"))
            .map(PathBuf::from);
        let exe = argv
            .first()
            .and_then(|s| Path::new(s).file_stem())
            .and_then(|s| s.to_str());
        let detected = crate::runner::detect(argv, cwd);
        let kind = detected.kind;
        let cargo = exe == Some("cargo") || kind == crate::runner::Kind::Cargo;
        let bun = matches!(exe, Some("bun" | "bunx"));
        if cargo {
            if let Some(cache) = env("CARGO_HOME")
                .map(PathBuf::from)
                .or_else(|| home.as_ref().map(|p| p.join(".cargo")))
            {
                paths.push(cwd.join(cache));
            }
            if let Some(target) = env("CARGO_TARGET_DIR") {
                paths.push(cwd.join(target));
            }
        }
        if bun {
            if let Some(cache) = env("electron_config_cache") {
                paths.push(cwd.join(cache));
            }
            let cache = env("BUN_INSTALL_CACHE_DIR").map(PathBuf::from).or_else(|| {
                env("BUN_INSTALL")
                    .map(PathBuf::from)
                    .or_else(|| home.as_ref().map(|p| p.join(".bun")))
                    .map(|p| p.join("install/cache"))
            });
            if let Some(cache) = cache {
                paths.push(cwd.join(cache));
            }
        }
        let bootstrap = kind != crate::runner::Kind::Command
            || cargo
                && matches!(
                    argv.get(1).map(String::as_str),
                    Some("build" | "check" | "clippy")
                )
            || bun
                && matches!(
                    argv.get(1).map(String::as_str),
                    Some("install" | "build" | "test")
                );
        let claims = env(WRITES_ENV)
            .map(|s| serde_json::from_str::<BTreeMap<PathBuf, u64>>(&s))
            .transpose()
            .map_err(|e| format!("{WRITES_ENV}: {e}"));
        if let Ok(Some(writes)) = &claims {
            for path in writes.keys() {
                if !paths.contains(path) {
                    paths.push(path.clone());
                }
            }
        }
        let gb_of = |name: &str| {
            env(name)
                .and_then(|v| v.trim().parse::<f64>().ok())
                .filter(|gb| *gb >= 0.0)
                .map(|gb| (gb * GIB as f64) as u64)
        };
        let need = gb_of(MIN_FREE_ENV);
        let danger = gb_of(DANGER_ENV).unwrap_or(crate::watch::DANGER);
        Volumes {
            paths,
            need,
            claims,
            undeclared: if bootstrap || detected.script.is_some() {
                Claim::Exclusive
            } else {
                Claim::Unmetered
            },
            pressure: crate::sys::pressure,
            danger,
            probe: std::sync::Arc::new(|path| {
                let dir = existing(path)?;
                let (free, total) = crate::sys::disk_space(&dir)?;
                Some((crate::sys::volume_id(&dir), free, total))
            }),
        }
    }

    /// The same volumes read another way (tests).
    #[cfg(test)]
    pub fn with_probe(mut self, probe: Probe) -> Volumes {
        self.probe = probe;
        self.pressure = || {
            Ok(Pressure {
                cpu: Cpu::default(),
                critical: false,
                warning: false,
                swap: 0,
            })
        };
        self
    }

    fn measure(&self, for_admission: bool) -> io::Result<Vec<Disk>> {
        let mut out: Vec<Disk> = Vec::new();
        for path in &self.paths {
            let Some((volume, free, total)) = (self.probe)(path) else {
                if for_admission {
                    return Err(io::Error::other(format!(
                        "free space unknown for {}",
                        path.display()
                    )));
                }
                continue;
            };
            if for_admission && volume.is_none() {
                return Err(io::Error::other(format!(
                    "volume identity unknown for {}",
                    path.display()
                )));
            }
            if volume.is_some() && out.iter().any(|d| d.volume == volume) {
                continue;
            }
            out.push(Disk {
                volume,
                path: path.display().to_string(),
                free,
                total,
                need: self.need.unwrap_or_else(|| min_free(total)),
            });
        }
        Ok(out)
    }

    /// A detached holder cannot stop the workload. Its enrolled paths retain the legacy floor.
    pub(crate) fn of_hold(cwd: &Path, env: &dyn Fn(&str) -> Option<String>) -> io::Result<Self> {
        let argv: Vec<String> = env("OMPDESK_HEAVY_ARGV")
            .map(|text| serde_json::from_str(&text))
            .transpose()?
            .unwrap_or_default();
        let mut volumes = Self::of_work(cwd, &argv, env);
        volumes.undeclared = Claim::Unmetered;
        Ok(volumes)
    }

    pub fn with_writes(mut self, writes: BTreeMap<PathBuf, u64>) -> Self {
        self.paths.extend(writes.keys().cloned());
        self.claims = Ok(Some(writes));
        self
    }

    /// Native work that owns the write targets, not paths guessed from a command line.
    pub fn for_targets(paths: Vec<PathBuf>, writes: Option<BTreeMap<PathBuf, u64>>) -> Self {
        let mut volumes = Self::of_work(&paths[0], &[], &|k| std::env::var(k).ok());
        volumes.paths = paths;
        volumes.claims = Ok(writes);
        volumes.undeclared = Claim::Exclusive;
        volumes
    }

    fn demand(&self, disks: &[Disk]) -> io::Result<BTreeMap<u64, Claim>> {
        let claims = self
            .claims
            .as_ref()
            .map_err(|e| io::Error::other(e.clone()))?;
        let Some(paths) = claims else {
            return Ok(disks
                .iter()
                .filter_map(|d| d.volume.map(|id| (id, self.undeclared)))
                .collect());
        };
        let mut claims = BTreeMap::<u64, u64>::new();
        for (path, bytes) in paths {
            if !path.is_absolute() {
                return Err(io::Error::other(format!(
                    "expected absolute write path: {}",
                    path.display()
                )));
            }
            let (Some(id), _, _) = (self.probe)(path).ok_or_else(|| {
                io::Error::other(format!("free space unknown for {}", path.display()))
            })?
            else {
                return Err(io::Error::other(format!(
                    "volume identity unknown for {}",
                    path.display()
                )));
            };
            let total = claims.entry(id).or_default();
            *total = total
                .checked_add(*bytes)
                .ok_or_else(|| io::Error::other("write demand overflow"))?;
        }
        Ok(claims
            .into_iter()
            .map(|(id, n)| (id, Claim::Bytes(n)))
            .collect())
    }

    /// Status and the emergency watcher keep observing the remaining disks even if one disappears.
    pub fn read(&self) -> Vec<Disk> {
        self.measure(false).expect("best-effort disk reading")
    }
}

pub struct Pool {
    pub dir: PathBuf,
    pub size: usize,
    pub volumes: Volumes,
}

/// Slots held for as long as this value lives (or its process does).
pub struct Lease {
    slots: Vec<(usize, File)>,
    dir: PathBuf,
    /// How long the holder waited in the queue.
    pub waited: Duration,
    pub acquired_at: u64,
}

impl Lease {
    pub fn has_slots(&self) -> bool {
        !self.slots.is_empty()
    }

    pub fn slots(&self) -> Vec<usize> {
        self.slots.iter().map(|(i, _)| *i).collect()
    }

    /// A completed phase no longer competes for future bytes. Only shrink a claim already owned by this lease.
    pub fn remaining_on(&self, path: &Path, bytes: u64) -> io::Result<()> {
        let Some((first, _)) = self.slots.first() else {
            return Ok(());
        };
        let id = existing(path)
            .and_then(|p| crate::sys::volume_id(&p))
            .ok_or_else(|| {
                io::Error::other(format!("volume identity unknown for {}", path.display()))
            })?;
        let gate = open_rw(&self.dir.join("counter"))?;
        gate.lock()?;
        let path = self.dir.join(format!("slot.{first}.owner"));
        let record = fs::read(&path)?;
        let owner: Owner = serde_json::from_slice(&record)?;
        let held: Reservations = serde_json::from_slice(&record)?;
        if !matches!(held.remaining.get(&id), Some(Claim::Exclusive))
            && !matches!(held.remaining.get(&id), Some(Claim::Bytes(n)) if *n >= bytes)
        {
            return Err(io::Error::other("next phase exceeds checkout reservation"));
        }
        let remaining = BTreeMap::from([(id, Claim::Bytes(bytes))]);
        fs::write(
            path,
            serde_json::to_vec(&SlotRecord {
                owner: &owner,
                remaining: &remaining,
            })?,
        )
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        for (i, file) in self.slots.drain(..) {
            // The owner record goes first, while the lock still says it is ours.
            let _ = fs::remove_file(self.dir.join(format!("slot.{i}.owner")));
            let _ = file.unlock();
        }
    }
}

/// What waiting looks like, for the line a waiter prints.
pub struct Waiting {
    pub ahead: usize,
    pub holders: Vec<Owner>,
    /// The volumes too full to start: waiting is for disk space, not (only) for a slot.
    pub low_disk: Vec<Disk>,
    pub pressure: Option<&'static str>,
}

/// A slot of the pool, as `status` shows it.
#[derive(Serialize, Debug)]
pub struct SlotView {
    pub slot: usize,
    pub owner: Option<Owner>,
    /// Held, but its owner record is not there (being written, or a holder outside this tool).
    pub held: bool,
}

#[derive(Serialize, Debug)]
pub struct Status {
    pub dir: String,
    pub size: usize,
    #[serde(rename = "admissionLimited")]
    pub admission_limited: bool,
    pub slots: Vec<SlotView>,
    /// Live waiters' pids in admission order if nobody else joins or cancels.
    pub queue: Vec<u32>,
    /// The volumes this process's heavy commands would write to; a `low` one holds new heavy commands back.
    pub disk: Vec<Disk>,
}

fn try_lock(file: &File) -> io::Result<bool> {
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(e)) => Err(e),
    }
}

fn open_rw(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Legacy,
    Normal,
    Release,
}

// Windows locks the ticket's data bytes. Its length can still be read without disturbing the lock.
const NORMAL: &[u8] = b"normal";
const RELEASE: &[u8] = b"release";

struct Turn {
    number: u64,
    pid: u32,
    class: Class,
}

struct Ticket {
    number: u64,
    path: PathBuf,
    _lock: File,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.path.with_added_extension("blocked"));
        let _ = fs::remove_file(&self.path);
    }
}

fn cancelled_wait() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "cancelled while waiting")
}

fn admission_order(turns: &mut [Turn], protected: u64) {
    // Rotate each unprotected run of normals behind the first release that follows it.
    let mut start = 0;
    for i in 0..turns.len() {
        match turns[i].class {
            Class::Normal if turns[i].number > protected => continue,
            Class::Release => turns[start..=i].rotate_right(1),
            Class::Normal | Class::Legacy => {}
        }
        start = i + 1;
    }
}

impl Pool {
    pub fn new(dir: PathBuf, size: usize) -> io::Result<Pool> {
        fs::create_dir_all(dir.join("queue"))?;
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
        Ok(Pool {
            dir,
            size: size.max(1),
            volumes: Volumes::of_work(&cwd, &[], &|k| std::env::var(k).ok()),
        })
    }

    pub fn admission_limited(&self) -> io::Result<bool> {
        match fs::symlink_metadata(self.dir.join("admission-off")) {
            Ok(m) if m.is_file() => Ok(false),
            Ok(_) => Err(io::Error::other("admission-off is not a regular file")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(true),
            Err(e) => Err(e),
        }
    }

    pub fn set_admission_limited(&self, limited: bool) -> io::Result<()> {
        let _gate = self.queue_lock()?;
        if limited == self.admission_limited()? {
            return Ok(());
        }
        let marker = self.dir.join("admission-off");
        if limited {
            fs::remove_file(marker)
        } else {
            File::create_new(marker).map(drop)
        }
    }

    pub fn disks(&self) -> Vec<Disk> {
        self.volumes.read()
    }

    fn slot_path(&self, i: usize) -> PathBuf {
        self.dir.join(format!("slot.{i}"))
    }

    fn owner_path(&self, i: usize) -> PathBuf {
        self.dir.join(format!("slot.{i}.owner"))
    }

    fn queue_lock(&self) -> io::Result<File> {
        let file = open_rw(&self.dir.join("counter"))?;
        file.lock()?;
        Ok(file)
    }

    fn protected(&self) -> io::Result<u64> {
        match fs::read_to_string(self.dir.join("protected-through")) {
            Ok(text) => text.parse().map_err(io::Error::other),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(0),
            Err(e) => Err(e),
        }
    }

    fn protect(&self, through: u64) -> io::Result<()> {
        let tmp = self.dir.join("protected-through.tmp");
        fs::write(&tmp, through.to_string())?;
        fs::rename(tmp, self.dir.join("protected-through"))
    }

    fn enqueue(&self, release: bool) -> io::Result<Ticket> {
        let mut counter = self.queue_lock()?;
        let mut text = String::new();
        counter.read_to_string(&mut text)?;
        // A legacy writer could die after truncating its counter.
        let live = self.live_tickets(None)?;
        let last = live.last().map_or(0, |t| t.number);
        let number = text
            .trim()
            .parse::<u64>()
            .unwrap_or(0)
            .max(last)
            .max(self.protected()?)
            .checked_add(1)
            .ok_or_else(|| io::Error::other("heavy ticket numbers exhausted"))?;
        counter.seek(SeekFrom::Start(0))?;
        write!(counter, "{number}")?;
        let name = format!("{number:020}.{}", std::process::id());
        let dir = self.dir.join("queue");
        let tmp = dir.join(format!("{name}.tmp"));
        let mut file = open_rw(&tmp)?;
        file.lock()?;
        file.set_len(0)?;
        file.write_all(if release { RELEASE } else { NORMAL })?;
        let path = dir.join(name);
        fs::rename(tmp, &path)?;
        Ok(Ticket {
            number,
            path,
            _lock: file,
        })
    }

    /// Live tickets in arrival order. An unreadable queue cannot grant admission.
    fn live_tickets(&self, own: Option<&Path>) -> io::Result<Vec<Turn>> {
        let entries = fs::read_dir(self.dir.join("queue"))?;
        let mut live = Vec::new();
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".tmp") {
                let old = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > TMP_STALE);
                if old
                    && let Ok(file) = File::open(&path)
                    && try_lock(&file)?
                {
                    let _ = fs::remove_file(&path);
                }
                continue;
            }
            let Some((number, pid)) = parse_ticket(&name) else {
                continue;
            };
            let file = match File::open(&path) {
                Ok(file) => file,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            if Some(path.as_path()) != own && try_lock(&file)? {
                let _ = fs::remove_file(path.with_added_extension("blocked"));
                let _ = fs::remove_file(&path);
                continue;
            }
            let len = file.metadata()?.len();
            let class = if len == NORMAL.len() as u64 {
                Class::Normal
            } else if len == RELEASE.len() as u64 {
                Class::Release
            } else {
                Class::Legacy
            };
            live.push(Turn { number, pid, class });
        }
        live.sort_unstable_by_key(|t| (t.number, t.pid));
        Ok(live)
    }

    fn read_owner(&self, i: usize) -> Option<Owner> {
        let text = fs::read_to_string(self.owner_path(i)).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn reservations(&self) -> io::Result<Option<BTreeMap<u64, Claim>>> {
        let mut totals = BTreeMap::<u64, Claim>::new();
        for i in 0..self.size {
            let slot = open_rw(&self.slot_path(i))?;
            if try_lock(&slot)? {
                continue;
            }
            let record = fs::read(self.owner_path(i)).and_then(|bytes| {
                serde_json::from_slice::<Reservations>(&bytes).map_err(io::Error::other)
            });
            let record = match record {
                Ok(record) => record,
                Err(_) if try_lock(&slot)? => continue,
                // A legacy holder, or a lease between unlink and unlock. Both stop competing on unlock.
                Err(_) => return Ok(None),
            };
            for (id, claim) in record.remaining {
                let combined = match (totals.get(&id).copied(), claim) {
                    (None, c) => c,
                    (Some(Claim::Bytes(a)), Claim::Bytes(b)) => Claim::Bytes(
                        a.checked_add(b)
                            .ok_or_else(|| io::Error::other("reserved bytes overflow"))?,
                    ),
                    (Some(Claim::Unmetered), Claim::Unmetered) => Claim::Unmetered,
                    _ => Claim::Exclusive,
                };
                totals.insert(id, combined);
            }
        }
        Ok(Some(totals))
    }

    /// Attempts one all-or-nothing claim under the queue lock.
    fn take_free(&self, held: &mut Vec<(usize, File)>, want: usize) -> io::Result<bool> {
        for i in 0..self.size {
            let file = open_rw(&self.slot_path(i))?;
            if try_lock(&file)? {
                held.push((i, file));
                if held.len() == want {
                    return Ok(true);
                }
            }
        }
        // A later release can become head. Never leave a partial --all claim in its way.
        held.clear();
        Ok(false)
    }

    /// Takes `weight` slots (clamped to the pool's size) as a normal waiter.
    /// `on_wait` is called when the slots are not free at once and again when the reason changes.
    pub fn acquire(
        &self,
        weight: usize,
        owner: Owner,
        on_wait: impl FnMut(&Waiting),
    ) -> io::Result<Lease> {
        self.acquire_unless(weight, owner, false, on_wait, &|| false)
    }

    /// `acquire` that gives up its place, with `ErrorKind::Interrupted`, once `cancelled` says so (a cancelled check
    /// that still waits never starts later).
    pub fn acquire_unless(
        &self,
        weight: usize,
        mut owner: Owner,
        release: bool,
        mut on_wait: impl FnMut(&Waiting),
        cancelled: &dyn Fn() -> bool,
    ) -> io::Result<Lease> {
        let want = weight.clamp(1, self.size);
        let started = Instant::now();
        let unrestricted = || {
            if cancelled() {
                return Err(cancelled_wait());
            }
            Ok(Lease {
                slots: Vec::new(),
                dir: PathBuf::new(),
                waited: started.elapsed(),
                acquired_at: now_ms(),
            })
        };
        if !self.admission_limited()? {
            return unrestricted();
        }
        let demand = self.volumes.demand(&self.volumes.measure(true)?)?;
        let measure = || -> io::Result<Vec<Disk>> {
            let disks = self.volumes.measure(true)?;
            for disk in &disks {
                if !disk.volume.is_some_and(|id| demand.contains_key(&id)) {
                    return Err(io::Error::other(format!(
                        "write demand unknown on {} (volume {:?}); include this volume in {WRITES_ENV}",
                        disk.path, disk.volume
                    )));
                }
            }
            Ok(disks)
        };
        let mut before = (self.volumes.pressure)()?;
        measure()?;
        let ticket = self.enqueue(release)?;
        let mut held = Vec::new();
        let mut told = None;
        std::thread::sleep(POLL);
        let mut published_block = false;
        loop {
            let now = (self.volumes.pressure)()?;
            let mut pressure = now.hold(before);
            before = now;
            let gate = self.queue_lock()?;
            if !self.admission_limited()? {
                return unrestricted();
            }
            if cancelled() {
                return Err(cancelled_wait());
            }
            let mut tickets = self.live_tickets(Some(&ticket.path))?;
            let protected = self.protected()?;
            admission_order(&mut tickets, protected);
            let ahead = tickets
                .iter()
                .position(|t| t.number == ticket.number && t.pid == std::process::id())
                .ok_or_else(|| io::Error::other("heavy queue ticket disappeared"))?;
            let mut low_disk = Vec::new();
            let reserved = self.reservations()?;
            // FIFO except for an older request still blocked by a live, disjoint volume reservation.
            let can_try = tickets[..ahead].iter().all(|t| {
                if t.class == Class::Legacy {
                    return false;
                }
                let path = self
                    .dir
                    .join("queue")
                    .join(format!("{:020}.{}.blocked", t.number, t.pid));
                fs::read(path)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<BTreeMap<u64, Claim>>(&b).ok())
                    .is_some_and(|older| {
                        older.keys().all(|id| !demand.contains_key(id))
                            && older.iter().any(|(id, c)| {
                                reserved
                                    .as_ref()
                                    .and_then(|r| r.get(id))
                                    .is_some_and(|other| c.conflicts(*other))
                            })
                    })
            });
            if can_try {
                if reserved.is_none() {
                    pressure = Some("waiting for a holder with unknown reservations to finish");
                }
                for mut disk in measure()? {
                    let id = disk
                        .volume
                        .expect("admission requires an identified volume");
                    let floor = if matches!(demand.get(&id), Some(Claim::Unmetered)) {
                        disk.need
                    } else {
                        0
                    };
                    let headroom = self
                        .volumes
                        .need
                        .unwrap_or(self.volumes.danger)
                        .max(self.volumes.danger)
                        .max(floor);
                    let need = match (
                        demand[&id],
                        reserved.as_ref().and_then(|r| r.get(&id)).copied(),
                    ) {
                        (Claim::Bytes(n), None) => headroom.checked_add(n),
                        (Claim::Bytes(n), Some(Claim::Bytes(r))) => {
                            headroom.checked_add(n).and_then(|v| v.checked_add(r))
                        }
                        (Claim::Exclusive, None) => Some(headroom),
                        (Claim::Unmetered, None | Some(Claim::Unmetered)) => {
                            Some(disk.need.max(headroom))
                        }
                        _ => {
                            pressure = Some("write volume reserved by another job");
                            if !published_block {
                                fs::write(
                                    ticket.path.with_added_extension("blocked"),
                                    serde_json::to_vec(&demand)?,
                                )?;
                                published_block = true;
                            }
                            continue;
                        }
                    };
                    if need.is_none_or(|bytes| disk.free < bytes) {
                        disk.need = need.unwrap_or(u64::MAX);
                        low_disk.push(disk);
                    }
                }
                if low_disk.is_empty() && pressure.is_none() {
                    if self.take_free(&mut held, want)? {
                        if cancelled() {
                            return Err(cancelled_wait());
                        }
                        let overtook = release
                            && tickets
                                .iter()
                                .skip(ahead + 1)
                                .any(|t| t.number < ticket.number);
                        owner.since = now_ms();
                        owner.weight = want;
                        let empty = BTreeMap::new();
                        let lease = Lease {
                            slots: held,
                            dir: self.dir.clone(),
                            waited: started.elapsed(),
                            acquired_at: owner.since,
                        };
                        for (index, (i, _)) in lease.slots.iter().enumerate() {
                            let remaining = if index == 0 { &demand } else { &empty };
                            fs::write(
                                self.owner_path(*i),
                                serde_json::to_vec(&SlotRecord {
                                    owner: &owner,
                                    remaining,
                                })?,
                            )?;
                        }
                        if overtook {
                            self.protect(ticket.number)?;
                        }
                        drop(ticket);
                        return Ok(lease);
                    }
                } else if !release && ticket.number > protected {
                    // A normal already waiting for disk space keeps the line.
                    self.protect(ticket.number)?;
                }
            }
            drop(gate);
            // Told again when the reason changes (the disk filled or freed, the queue moved).
            let reason = (!low_disk.is_empty(), ahead, pressure);
            if told != Some(reason) {
                told = Some(reason);
                on_wait(&Waiting {
                    ahead,
                    holders: self.slots().into_iter().filter_map(|s| s.owner).collect(),
                    low_disk,
                    pressure,
                });
            }
            std::thread::sleep(POLL);
        }
    }

    fn slots(&self) -> Vec<SlotView> {
        (0..self.size)
            .map(|i| {
                let held = match File::open(self.slot_path(i)) {
                    Ok(file) => !try_lock(&file).unwrap_or(false),
                    Err(_) => false,
                };
                SlotView {
                    slot: i,
                    owner: if held { self.read_owner(i) } else { None },
                    held,
                }
            })
            .collect()
    }

    pub fn status(&self) -> Status {
        let queue = (|| -> io::Result<_> {
            let _gate = self.queue_lock()?;
            let mut tickets = self.live_tickets(None)?;
            admission_order(&mut tickets, self.protected()?);
            Ok(tickets.into_iter().map(|t| t.pid).collect())
        })()
        .unwrap_or_default();
        Status {
            dir: self.dir.display().to_string(),
            size: self.size,
            admission_limited: self.admission_limited().unwrap_or(true),
            slots: self.slots(),
            queue,
            disk: self.disks(),
        }
    }

    /// How long the oldest live waiter has waited (its ticket's age); 0 with nobody waiting.
    pub fn oldest_wait_ms(&self) -> u64 {
        let Ok(_gate) = self.queue_lock() else {
            return 0;
        };
        self.live_tickets(None)
            .ok()
            .and_then(|tickets| {
                let Turn { number, pid, .. } = tickets.first()?;
                fs::metadata(self.dir.join("queue").join(format!("{number:020}.{pid}"))).ok()
            })
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .map_or(0, |age| age.as_millis() as u64)
    }
}

fn parse_ticket(name: &str) -> Option<(u64, u32)> {
    let (number, pid) = name.split_once('.')?;
    Some((number.parse().ok()?, pid.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn owner(command: &str) -> Owner {
        Owner {
            pid: std::process::id(),
            command: command.into(),
            cwd: String::new(),
            since: 0,
            weight: 1,
            run_id: None,
            session: None,
        }
    }

    fn temp_pool(size: usize) -> (PathBuf, Pool) {
        let dir = std::env::temp_dir().join(format!(
            "ompdesk-heavy-test-{}-{}",
            std::process::id(),
            now_ms() ^ (size as u64) << 40 ^ rand_bits()
        ));
        let pool = synthetic_pool(&dir, size);
        (dir, pool)
    }

    fn rand_bits() -> u64 {
        use std::hash::{BuildHasher, RandomState};
        RandomState::new().hash_one(0u8)
    }

    #[test]
    fn admission_setting_is_local_persistent_and_reversible() {
        let (dir, pool) = temp_pool(1);
        let (other_dir, other) = temp_pool(1);
        assert!(pool.admission_limited().unwrap());
        pool.set_admission_limited(false).unwrap();
        let reopened = Pool::new(dir.clone(), 1).unwrap();
        reopened.set_admission_limited(false).unwrap();
        assert!(!reopened.status().admission_limited);
        assert!(other.admission_limited().unwrap());
        reopened.set_admission_limited(true).unwrap();
        pool.set_admission_limited(true).unwrap();
        assert!(pool.status().admission_limited);
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(other_dir).unwrap();
    }

    #[test]
    fn disabling_admission_releases_waiters_without_claiming_slots() {
        let (dir, mut pool) = temp_pool(1);
        let holder = pool.acquire(1, owner("holder"), |_| panic!()).unwrap();
        let older = pool.enqueue(false).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let lease = pool
            .acquire_unless(
                1,
                owner("queued"),
                false,
                |w| {
                    assert_eq!(w.ahead, 1);
                    pool.set_admission_limited(false).unwrap();
                },
                &|| Instant::now() >= deadline,
            )
            .unwrap();
        assert!(lease.slots().is_empty());
        assert_eq!(fs::read_dir(dir.join("queue")).unwrap().count(), 1);
        pool.volumes = pool
            .volumes
            .with_probe(Arc::new(|_| panic!("start probed disk")));
        let next = pool.acquire(1, owner("new"), |_| panic!("waited")).unwrap();
        assert!(next.slots().is_empty());
        assert_eq!(pool.slots()[0].owner.as_ref().unwrap().command, "holder");
        assert_eq!(
            pool.acquire_unless(1, owner("cancel"), false, |_| panic!(), &|| true)
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::Interrupted
        );
        drop(older);
        drop(holder);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_admission_marker_cannot_grant_admission() {
        let (dir, pool) = temp_pool(1);
        fs::create_dir(dir.join("admission-off")).unwrap();
        assert!(pool.admission_limited().is_err());
        assert!(pool.acquire(1, owner("invalid"), |_| panic!()).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sizes_from_ram_and_cores() {
        assert_eq!(pool_size(16 * GIB, 10), 1);
        assert_eq!(pool_size(17_179_869_184, 10), 1);
        assert_eq!(pool_size(24 * GIB, 15), 2);
        assert_eq!(pool_size(32 * GIB, 16), 3);
        assert_eq!(pool_size(64 * GIB, 16), 7);
        assert_eq!(pool_size(64 * GIB, 4), 2);
        assert_eq!(pool_size(128 * GIB, 64), 7);
        assert_eq!(pool_size(8 * GIB, 8), 1);
    }

    #[test]
    fn pressure_holds_even_the_first_request_and_recovery_admits_a_fourth() {
        thread_local! { static CRITICAL: std::cell::Cell<bool> = const { std::cell::Cell::new(true) }; }
        let (dir, mut pool) = temp_pool(4);
        pool.volumes.pressure = || {
            Ok(Pressure {
                critical: CRITICAL.get(),
                warning: false,
                cpu: Cpu::default(),
                swap: 0,
            })
        };
        let mut leases = Vec::new();
        for name in ["one", "two", "three", "four"] {
            let deadline = Instant::now() + Duration::from_secs(5);
            leases.push(
                pool.acquire_unless(
                    1,
                    owner(name),
                    false,
                    |w| {
                        assert_eq!(name, "one");
                        assert_eq!(w.pressure, Some("critical memory pressure"));
                        assert!(w.holders.is_empty());
                        assert!(CRITICAL.replace(false));
                    },
                    &|| Instant::now() >= deadline,
                )
                .unwrap(),
            );
        }
        assert!(!CRITICAL.get());
        assert_eq!(
            pool.slots()
                .into_iter()
                .map(|slot| slot.owner.unwrap().command)
                .collect::<Vec<_>>(),
            ["one", "two", "three", "four"]
        );
        drop(leases);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_full_pool_makes_the_next_wait_until_a_slot_is_given_back() {
        let (dir, pool) = temp_pool(2);
        let a = pool.acquire(1, owner("a"), |_| panic!("a waited")).unwrap();
        let b = pool.acquire(1, owner("b"), |_| panic!("b waited")).unwrap();
        assert_ne!(a.slots(), b.slots());
        let status = pool.status();
        assert!(status.slots.iter().all(|s| s.held));
        assert_eq!(status.slots[0].owner.as_ref().unwrap().command, "a");

        let pool2 = synthetic_pool(&dir, 2);
        let waited = Arc::new(Mutex::new(None));
        let seen = waited.clone();
        let c = std::thread::spawn(move || {
            pool2
                .acquire(1, owner("c"), |w| {
                    *seen.lock().unwrap() = Some(w.holders.len());
                })
                .unwrap()
                .slots()
        });
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(*waited.lock().unwrap(), Some(2));
        let freed = a.slots();
        drop(a);
        assert_eq!(c.join().unwrap(), freed);
        drop(b);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn waiters_take_slots_in_the_order_they_came() {
        let (dir, pool) = temp_pool(1);
        let first = pool.acquire(1, owner("first"), |_| {}).unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut joins = Vec::new();
        for name in ["one", "two", "three"] {
            let dir = dir.clone();
            let order = order.clone();
            joins.push(std::thread::spawn(move || {
                let pool = synthetic_pool(&dir, 1);
                let lease = pool.acquire(1, owner(name), |_| {}).unwrap();
                order.lock().unwrap().push(name);
                std::thread::sleep(Duration::from_millis(50));
                drop(lease);
            }));
            // Each joins the queue before the next.
            std::thread::sleep(Duration::from_millis(100));
        }
        drop(first);
        for j in joins {
            j.join().unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec!["one", "two", "three"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_large_waiter_is_not_overtaken_by_small_ones_behind_it() {
        let (dir, pool) = temp_pool(2);
        let small = pool.acquire(1, owner("small"), |_| {}).unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let spawn = |name: &'static str, weight: usize| {
            let dir = dir.clone();
            let order = order.clone();
            std::thread::spawn(move || {
                let pool = synthetic_pool(&dir, 2);
                let lease = pool.acquire(weight, owner(name), |_| {}).unwrap();
                order.lock().unwrap().push((name, lease.slots().len()));
                std::thread::sleep(Duration::from_millis(50));
            })
        };
        let all = spawn("all", 2);
        std::thread::sleep(Duration::from_millis(100));
        let later = spawn("later", 1);
        // One slot is free the whole time, yet `later` waits behind `all`.
        std::thread::sleep(Duration::from_millis(600));
        assert!(order.lock().unwrap().is_empty());
        drop(small);
        all.join().unwrap();
        later.join().unwrap();
        assert_eq!(*order.lock().unwrap(), vec![("all", 2), ("later", 1)]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn needs_a_tenth_of_the_volume_between_10_and_20_gb() {
        assert_eq!(min_free(256 * GIB), 20 * GIB);
        assert_eq!(min_free(128 * GIB), 128 * GIB / 10);
        assert_eq!(min_free(64 * GIB), 10 * GIB);
        assert_eq!(min_free(2000 * GIB), 20 * GIB);
    }

    #[test]
    fn reads_the_volumes_the_work_writes_to() {
        let cwd = std::env::temp_dir();
        let outside = cwd.join(format!("ompdesk-vol-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        let argv: Vec<String> = ["bunx", "playwright", "test", "--grep", "x"]
            .iter()
            .map(|s| s.to_string())
            .chain([
                format!("--output={}/results", outside.display()),
                "./e2e/a.spec.ts".into(),
            ])
            .collect();
        let v = Volumes::of_work(&cwd, &argv, &|k| {
            matches!(k, "TMPDIR" | "TEMP").then(|| "/".to_string())
        });
        assert_eq!(v.paths[0], cwd);
        assert_eq!(v.paths[1], PathBuf::from("/"));
        assert!(v.paths.contains(&outside.join("results")));
        assert_eq!(existing(&outside.join("results")), Some(outside.clone()));
        assert!(!v.paths.iter().any(|p| p.ends_with("x")));
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn equal_space_is_not_volume_identity() {
        let mut volumes = Volumes::of_work(&std::env::temp_dir(), &[], &|_| None);
        volumes.paths = ["work", "temp", "cache"].map(PathBuf::from).to_vec();
        let volumes = volumes.with_probe(Arc::new(|path| {
            Some(match path.to_str()? {
                "work" => (Some(1), 100, 200),
                "temp" => (Some(2), 100, 200),
                "cache" => (Some(1), 99, 200),
                _ => return None,
            })
        }));
        let disks = volumes.read();
        assert_eq!(
            disks.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(),
            ["work", "temp"]
        );
    }

    #[test]
    fn new_heavy_work_waits_while_the_disk_is_low_and_says_why() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let (dir, pool) = temp_pool(1);
        let free = Arc::new(AtomicU64::new(5 * GIB));
        let probe_free = free.clone();
        let pool = Pool {
            volumes: pool.volumes.with_probe(Arc::new(move |_| {
                Some((Some(1), probe_free.load(Ordering::Relaxed), 100 * GIB))
            })),
            ..pool
        };
        let status = pool.status();
        assert!(status.disk[0].low());
        assert_eq!(status.disk[0].need, 10 * GIB);
        let said = Arc::new(Mutex::new(Vec::new()));
        let said2 = said.clone();
        let waiter = std::thread::spawn(move || {
            pool.acquire(1, owner("w"), |w| {
                said2.lock().unwrap().push(w.low_disk.len())
            })
            .unwrap()
            .slots()
        });
        std::thread::sleep(Duration::from_millis(600));
        assert!(
            !waiter.is_finished(),
            "a free slot is not taken while the disk is low"
        );
        free.store(50 * GIB, Ordering::Relaxed);
        assert_eq!(waiter.join().unwrap(), vec![0]);
        assert_eq!(said.lock().unwrap()[0], 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn small_writes_fit_below_the_old_floor_and_competing_reservations_wait_for_release() {
        let (dir, mut pool) = temp_pool(2);
        pool.volumes.need = None;
        pool.volumes = pool
            .volumes
            .with_probe(Arc::new(|_| Some((Some(1), 14 * GIB, 500 * GIB))));
        pool.volumes = pool
            .volumes
            .with_writes(BTreeMap::from([(dir.clone(), 8 * GIB)]));
        let mut holder = Some(
            pool.acquire(1, owner("first"), |_| panic!("first should fit"))
                .unwrap(),
        );
        pool.volumes = pool
            .volumes
            .with_writes(BTreeMap::from([(dir.clone(), 4 * GIB)]));
        let next = pool
            .acquire(1, owner("second"), |w| {
                assert_eq!(w.low_disk[0].need, 15 * GIB);
                drop(holder.take().expect("one wait before release"));
            })
            .unwrap();
        assert!(holder.is_none());
        drop(next);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unknown_command_waits_for_the_legacy_floor() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let (dir, mut pool) = temp_pool(1);
        let low = Arc::new(AtomicBool::new(true));
        let disk = low.clone();
        let probe: Probe = Arc::new(move |_| {
            let free = if disk.load(Ordering::Relaxed) { 9 } else { 11 };
            Some((Some(1), free * GIB, 100 * GIB))
        });
        pool.volumes = Volumes::of_work(&dir, &["opaque-tool".into()], &|_| None).with_probe(probe);
        let lease = pool
            .acquire(1, owner("opaque"), |w| {
                assert_eq!(w.low_disk[0].need, 10 * GIB);
                low.store(false, Ordering::Relaxed);
            })
            .unwrap();
        assert!(!low.load(Ordering::Relaxed));
        drop(lease);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn first_use_bootstrap_excludes_a_writer() {
        let (dir, mut pool) = temp_pool(2);
        let probe = pool.volumes.probe.clone();
        pool.volumes = Volumes::of_work(&dir, &["bun".into(), "install".into()], &|k| {
            (k == "BUN_INSTALL_CACHE_DIR").then(|| dir.join("cache").display().to_string())
        })
        .with_probe(probe);
        assert!(pool.volumes.paths.contains(&dir.join("cache")));
        let mut holder = Some(pool.acquire(1, owner("bootstrap"), |_| panic!()).unwrap());
        pool.volumes = pool
            .volumes
            .with_writes(BTreeMap::from([(dir.clone(), 1024)]));
        let next = pool
            .acquire(1, owner("small"), |w| {
                assert_eq!(w.pressure, Some("write volume reserved by another job"));
                let mut other = synthetic_pool(&dir, 2);
                other.volumes = other
                    .volumes
                    .with_probe(Arc::new(|_| Some((Some(2), 50 * GIB, 100 * GIB))));
                let independent = other
                    .acquire(1, owner("other volume"), |_| {
                        panic!("blocked by a different volume")
                    })
                    .unwrap();
                drop(independent);
                drop(holder.take().unwrap());
            })
            .unwrap();
        assert!(holder.is_none());
        drop(next);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn warning_alone_does_not_hold_work_but_growing_swap_or_saturation_does() {
        let base = Pressure {
            cpu: Cpu::default(),
            critical: false,
            warning: true,
            swap: 9,
        };
        assert_eq!(base.hold(base), None);
        assert_eq!(
            Pressure { swap: 10, ..base }.hold(base),
            Some("memory pressure with growing swap")
        );
        assert_eq!(
            Pressure {
                #[cfg(unix)]
                cpu: true,
                #[cfg(windows)]
                cpu: Cpu { idle: 0, total: 1 },
                ..base
            }
            .hold(base),
            Some("CPU saturated")
        );
        assert_eq!(
            Pressure {
                critical: true,
                ..base
            }
            .hold(base),
            Some("critical memory pressure")
        );
    }

    const WORKER_DIR: &str = "OMPDESK_TEST_QUEUE_WORKER_DIR";

    fn synthetic_pool(dir: &Path, size: usize) -> Pool {
        let mut pool = Pool::new(dir.to_owned(), size).unwrap();
        pool.volumes.paths = vec![dir.to_owned()];
        pool.volumes.need = Some(10 * GIB);
        pool.volumes.claims = Ok(Some(BTreeMap::from([(dir.to_owned(), 0)])));
        pool.volumes = pool
            .volumes
            .with_probe(Arc::new(|_| Some((Some(1), 50 * GIB, 100 * GIB))));
        pool
    }

    fn queue_worker(dir: &Path) {
        let pool = synthetic_pool(dir, 2);
        let release = std::env::var("OMPDESK_TEST_QUEUE_CLASS").unwrap() == "release";
        let weight = std::env::var("OMPDESK_TEST_QUEUE_WEIGHT")
            .unwrap()
            .parse()
            .unwrap();
        let cancel = dir.join(format!("cancel-{}", std::process::id()));
        let mut told = false;
        match pool.acquire_unless(
            weight,
            owner("worker"),
            release,
            |_| {
                if !told {
                    println!("queue-worker:waiting");
                    told = true;
                }
            },
            &|| cancel.exists(),
        ) {
            Ok(_lease) => {
                println!("queue-worker:held");
                io::copy(&mut io::stdin().lock(), &mut io::sink()).unwrap();
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => println!("queue-worker:cancelled"),
            Err(e) => panic!("{e}"),
        }
    }

    struct Worker {
        child: std::process::Child,
        events: std::sync::mpsc::Receiver<String>,
    }

    impl Worker {
        fn waiting(dir: &Path, class: &str, weight: usize) -> Self {
            use std::io::{BufRead, BufReader};
            use std::process::Stdio;
            let mut child = crate::sys::child_command(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "heavy::tests::release_queue_with_two_slots",
                    "--nocapture",
                ])
                .env(WORKER_DIR, dir)
                .env("OMPDESK_TEST_QUEUE_CLASS", class)
                .env("OMPDESK_TEST_QUEUE_WEIGHT", weight.to_string())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let stdout = child.stdout.take().unwrap();
            let (tx, events) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some((_, event)) = line.split_once("queue-worker:")
                        && tx.send(event.to_owned()).is_err()
                    {
                        break;
                    }
                }
            });
            let worker = Self { child, events };
            worker.expect("waiting");
            worker
        }

        fn expect(&self, phase: &str) {
            assert_eq!(
                self.events.recv_timeout(Duration::from_secs(30)).unwrap(),
                phase
            );
        }

        fn pid(&self) -> u32 {
            self.child.id()
        }
    }

    impl Drop for Worker {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    fn release_queue_with_two_slots() {
        if let Some(dir) = std::env::var_os(WORKER_DIR) {
            return queue_worker(Path::new(&dir));
        }
        let (dir, pool) = temp_pool(2);
        let a = pool.acquire(1, owner("a"), |_| panic!()).unwrap();
        let b = pool.acquire(1, owner("b"), |_| panic!()).unwrap();
        let mut normal = Worker::waiting(&dir, "normal", 2);
        drop(Worker::waiting(&dir, "release", 1)); // Dies while queued.
        let cancelled = Worker::waiting(&dir, "release", 1);
        let first = Worker::waiting(&dir, "release", 1);
        let second = Worker::waiting(&dir, "release", 1);
        assert_eq!(
            pool.status().queue,
            [cancelled.pid(), normal.pid(), first.pid(), second.pid()]
        );
        fs::write(dir.join(format!("cancel-{}", cancelled.pid())), []).unwrap();
        cancelled.expect("cancelled");
        assert_eq!(
            pool.status().queue,
            [first.pid(), normal.pid(), second.pid()]
        );

        drop(a);
        first.expect("held");
        assert_eq!(
            pool.status().slots[b.slots()[0]]
                .owner
                .as_ref()
                .unwrap()
                .command,
            "b"
        );
        let third = Worker::waiting(&dir, "release", 1);
        assert_eq!(
            pool.status().queue,
            [normal.pid(), second.pid(), third.pid()]
        );
        drop(first); // A crashed holder returns its OS lock without touching the queue.
        drop(b);
        normal.expect("held");
        assert!(
            pool.status()
                .slots
                .iter()
                .all(|s| s.owner.as_ref().unwrap().pid == normal.pid())
        );
        drop(normal.child.stdin.take());
        second.expect("held");
        third.expect("held");
        assert!(pool.status().queue.is_empty());
        drop((normal, cancelled, second, third));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_empty_legacy_ticket_is_a_fifo_barrier_until_its_lock_is_returned() {
        let (dir, pool) = temp_pool(2);
        let legacy = open_rw(&dir.join("queue/00000000000000000001.4242")).unwrap();
        legacy.lock().unwrap();
        let release = Worker::waiting(&dir, "release", 1);
        assert_eq!(pool.status().queue, [4242, release.pid()]);
        drop(legacy);
        release.expect("held");
        drop(release);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_dead_waiters_ticket_is_skipped() {
        let (dir, pool) = temp_pool(1);
        // A ticket ahead of everyone whose lock nobody holds: its waiter died.
        fs::write(dir.join("queue").join(format!("{:020}.{}", 0, 999_999)), "").unwrap();
        let lease = pool.acquire(1, owner("next"), |_| panic!("waited on a dead ticket"));
        assert!(lease.is_ok());
        assert!(fs::read_dir(dir.join("queue")).unwrap().next().is_none());
        let _ = fs::remove_dir_all(dir);
    }
}
