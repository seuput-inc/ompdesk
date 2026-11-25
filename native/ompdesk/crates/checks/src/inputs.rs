//! A check's input set and its digest: a previous result is reused only while every input it depended on is proven
//! unchanged, and without knowing which inputs each test read, that is all of them:
//!
//! - every file of the checkout (product code, test code, dependency manifests and lockfiles, configuration, the
//!   check's own scripts, `node_modules`, build output such as `out/` that an end-to-end test runs against), by
//!   content: a file whose size, modification and change times and inode are what the stat cache last saw keeps its
//!   hash, any other is hashed again, so an edit that is not committed counts and a touch that changes nothing does
//!   not;
//! - except Git metadata and the check's outputs. By default only ignored tagged caches and the usual ignored
//!   cache/report folders are excluded. A matching `.ompdesk/checks.json` declaration replaces those defaults;
//! - the executable and files the command names outside the checkout (including a wrapper script);
//! - the environment, every variable but a terminal's or OMPdesk's own plumbing (`volatile_env`), each by a hash of
//!   its value, so the evidence names a variable without showing it;
//! - the tools: `node`, `bun` and, for cargo, `rustc` and `cargo` by their version, the operating system, this
//!   program's own version and its reporters.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::sys::child_command;

/// A repository may declare generated outputs for one exact invocation. Everything else stays an input.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckPolicies {
    checks: Vec<Boundary>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Boundary {
    cwd: String,
    argv: Vec<String>,
    inputs: Vec<String>,
    outputs: Vec<String>,
}

const POLICY: &str = ".ompdesk/checks.json";

fn invalid(message: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("{POLICY}: {message}"))
}

fn under(path: &str, parent: &str) -> bool {
    path.eq_ignore_ascii_case(parent)
        || path
            .get(..parent.len())
            .is_some_and(|p| p.eq_ignore_ascii_case(parent))
            && path.as_bytes().get(parent.len()) == Some(&b'/')
}

fn overlaps(a: &str, b: &str) -> bool {
    under(a, b) || under(b, a)
}

/// Literal paths only. A symlink or a platform-specific spelling would change what a declaration covers.
fn literal(root: &Path, rel: &str) -> io::Result<()> {
    let mut path = root.to_owned();
    for part in rel.split('/') {
        let device = part.split('.').next().unwrap_or(part);
        let reserved = ["con", "prn", "aux", "nul", "conin$", "conout$"]
            .iter()
            .any(|s| device.eq_ignore_ascii_case(s))
            || (device.len() == 4
                && device.as_bytes()[3].is_ascii_digit()
                && device.get(..3).is_some_and(|p| {
                    p.eq_ignore_ascii_case("com") || p.eq_ignore_ascii_case("lpt")
                }));
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || reserved
            || part.contains('~')
            || part.eq_ignore_ascii_case(".git")
            || part
                .chars()
                .any(|c| c.is_control() || "\\:*?\"<>|[]".contains(c))
        {
            return Err(invalid(format!(
                "expected a literal project-relative path, got {rel:?}"
            )));
        }
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.is_symlink() => return Err(invalid(format!("symlink in {rel:?}"))),
            Ok(m) if m.is_dir() && path.join(".git").try_exists()? => {
                return Err(invalid(format!("nested checkout in {rel:?}")));
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn lockfile(name: &str) -> bool {
    name.ends_with(".lock")
        || matches!(
            name,
            "bun.lockb" | "package-lock.json" | "npm-shrinkwrap.json" | "pnpm-lock.yaml"
        )
}

impl Boundary {
    pub(crate) fn load(root: &Path, cwd: &Path, argv: &[String]) -> io::Result<Option<Self>> {
        let path = root.join(POLICY);
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        literal(root, POLICY)?;
        let policies: CheckPolicies = serde_json::from_slice(&fs::read(path)?).map_err(invalid)?;
        let mut selected = None;
        for check in policies.checks {
            if check.cwd != "." {
                literal(root, &check.cwd)?;
            }
            if check.argv != argv || root.join(&check.cwd) != cwd {
                continue;
            }
            if selected.is_some() || check.outputs.is_empty() {
                return Err(invalid(
                    "expected one matching check with at least one output",
                ));
            }
            for path in check.inputs.iter().chain(&check.outputs) {
                literal(root, path)?;
            }
            for (i, input) in check.inputs.iter().enumerate() {
                if check.inputs[..i].iter().any(|p| overlaps(input, p)) {
                    return Err(invalid(format!("overlapping input {input:?}")));
                }
            }
            for (i, out) in check.outputs.iter().enumerate() {
                if overlaps(out, ".ompdesk")
                    || out
                        .split('/')
                        .any(|p| p.eq_ignore_ascii_case("node_modules"))
                    || lockfile(out.rsplit('/').next().unwrap_or(out))
                    || check
                        .inputs
                        .iter()
                        .chain(&check.outputs[..i])
                        .any(|p| overlaps(p, out))
                {
                    return Err(invalid(format!("overlapping or protected output {out:?}")));
                }
            }
            let tracked = git(root, &["ls-files", "--cached", "-z"])
                .ok_or_else(|| invalid("cannot verify outputs against the Git index"))?;
            for name in tracked.split(|b| *b == 0).filter(|p| !p.is_empty()) {
                let name = std::str::from_utf8(name).map_err(invalid)?;
                if check.outputs.iter().any(|p| overlaps(name, p)) {
                    return Err(invalid(format!("output overlaps tracked input {name:?}")));
                }
            }
            selected = Some(check);
        }
        Ok(selected)
    }

    fn output(&self, child: &str) -> bool {
        // An exact spelling is conservative on both case-sensitive and case-insensitive filesystems.
        self.outputs.iter().any(|p| Path::new(child).starts_with(p))
    }
}

/// Cache and report folders that are never inputs, when git ignores them (or the folder is no git checkout).
const CACHE_NAMES: &[&str] = &[
    ".cache",
    ".vite",
    ".vitest",
    ".turbo",
    ".parcel-cache",
    ".nyc_output",
    ".pytest_cache",
    "__pycache__",
    "test-results",
    "playwright-report",
    "blob-report",
    "coverage",
];

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn git(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = child_command("git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

/// The checkout `cwd` is in (git's top level), else `cwd` itself.
pub fn root_of(cwd: &Path) -> PathBuf {
    git(cwd, &["rev-parse", "--show-toplevel"])
        .and_then(|out| String::from_utf8(out).ok())
        .map(|s| PathBuf::from(s.trim_end_matches(['\n', '\r'])))
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| cwd.to_path_buf())
}

/// HEAD and whether the work tree has changes, for people reading a verdict.
pub fn head(root: &Path) -> (Option<String>, bool) {
    let head = git(root, &["rev-parse", "--short=12", "HEAD"])
        .and_then(|o| String::from_utf8(o).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let dirty = git(root, &["status", "--porcelain", "--untracked-files=normal"])
        .is_some_and(|o| !o.is_empty());
    (head, dirty)
}

/// What git ignores under `root` (folders end in `/`), `None` outside a git checkout.
pub fn ignored(root: &Path) -> Option<Vec<String>> {
    let out = git(
        root,
        &[
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
        ],
    )?;
    Some(
        out.split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect(),
    )
}

pub fn is_ignored(ignored: Option<&[String]>, path: &str) -> bool {
    match ignored {
        None => true,
        Some(list) => list.iter().any(|entry| match entry.strip_suffix('/') {
            Some(dir) => path == dir || path.starts_with(entry.as_str()),
            None => path == entry,
        }),
    }
}

/// The stat a file is judged unchanged by.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Stat {
    size: u64,
    mtime: i128,
    ctime: i128,
    ino: u64,
    exec: bool,
}

#[cfg(unix)]
fn stat_of(meta: &fs::Metadata) -> Stat {
    use std::os::unix::fs::MetadataExt;
    Stat {
        size: meta.size(),
        mtime: i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
        ctime: i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec()),
        ino: meta.ino(),
        exec: meta.mode() & 0o111 != 0,
    }
}

#[cfg(windows)]
fn stat_of(meta: &fs::Metadata) -> Stat {
    use std::os::windows::fs::MetadataExt;
    Stat {
        size: meta.file_size(),
        mtime: i128::from(meta.last_write_time()),
        ctime: i128::from(meta.creation_time()),
        ino: 0,
        exec: false,
    }
}

/// Per checkout, what each input file's stat was when it was last hashed.
pub struct StatCache {
    path: PathBuf,
    map: HashMap<String, (Stat, String)>,
}

fn stat_row(line: &str) -> Option<(&str, Stat, &str)> {
    let mut fields = line.split('\t');
    let path = fields.next()?;
    let stat = Stat {
        size: fields.next()?.parse().ok()?,
        mtime: fields.next()?.parse().ok()?,
        ctime: fields.next()?.parse().ok()?,
        ino: fields.next()?.parse().ok()?,
        exec: match fields.next()? {
            "0" => false,
            "1" => true,
            _ => return None,
        },
    };
    let hash = fields.next()?;
    (!path.is_empty() && hex(hash, 64) && fields.next().is_none()).then_some((path, stat, hash))
}

pub(super) fn hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(super) fn stat_cache_path(store: &Path, root: &str) -> PathBuf {
    let hash = sha256_hex(root.as_bytes());
    store.join("inputs").join(format!("{}.tsv", &hash[..16]))
}

pub(super) fn stat_cache_row(line: &str) -> bool {
    stat_row(line).is_some()
}

pub(super) fn run_input_row(line: &str) -> bool {
    let mut fields = line.split('\t');
    let (Some(kind), Some(key), Some(value), None) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return false;
    };
    !key.is_empty()
        && match kind {
            "F" if value == "directory" => true,
            "F" if value.starts_with("link:") => hex(&value[5..], 64),
            "X" if key == "@executable" => !value.is_empty(),
            "F" | "X" => hex(value.strip_suffix('x').unwrap_or(value), 64),
            "E" => hex(value, 16),
            "T" => !value.is_empty(),
            _ => false,
        }
}

impl StatCache {
    pub fn load(store: &Path, root: &Path) -> StatCache {
        let path = stat_cache_path(store, &root.to_string_lossy());
        let mut map = HashMap::new();
        if let Ok(text) = fs::read_to_string(&path) {
            for line in text.lines() {
                if let Some((path, stat, hash)) = stat_row(line) {
                    map.insert(path.to_owned(), (stat, hash.to_owned()));
                }
            }
        }
        StatCache { path, map }
    }

    pub fn save(&self) -> io::Result<()> {
        let mut out = Vec::with_capacity(self.map.len() * 120);
        for (p, (s, h)) in &self.map {
            if p.contains(['\t', '\n']) {
                continue;
            }
            writeln!(
                out,
                "{p}\t{}\t{}\t{}\t{}\t{}\t{h}",
                s.size,
                s.mtime,
                s.ctime,
                s.ino,
                u8::from(s.exec)
            )?;
        }
        let tmp = self.path.with_extension("tsv.tmp");
        fs::write(&tmp, out)?;
        fs::rename(tmp, &self.path)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum Outputs {
    #[default]
    Undeclared,
    Missing,
    Present(String),
}

impl Outputs {
    pub(crate) fn matches_proof(&self, proof: &Path) -> bool {
        matches!(self, Self::Present(hash) if fs::read_to_string(proof).is_ok_and(|saved| saved == *hash))
    }
}

fn digest_entry(hasher: &mut Sha256, path: &str, hash: &str) {
    hasher.update(path.as_bytes());
    hasher.update([0]);
    hasher.update(hash.as_bytes());
    hasher.update(b"\n");
}

fn finish_sha256(hasher: Sha256) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for byte in hasher.finalize().iter().copied() {
        out.push(HEX[usize::from(byte >> 4)] as char);
        out.push(HEX[usize::from(byte & 15)] as char);
    }
    out
}

/// The files of the input set, by path relative to the root (`/`-separated), each with its content hash.
#[derive(Clone, Debug, Default)]
pub struct Files {
    pub files: Vec<(String, String)>,
    pub(crate) outputs: Outputs,
}

impl Files {
    pub fn digest(&self) -> String {
        let mut hasher = Sha256::new();
        for (p, h) in &self.files {
            digest_entry(&mut hasher, p, h);
        }
        finish_sha256(hasher)
    }
}

fn excluded_dir(dir: &Path, rel: &str, name: &str, ignored: Option<&[String]>) -> bool {
    name == ".git"
        || ((CACHE_NAMES.contains(&name) || dir.join("CACHEDIR.TAG").is_file())
            && is_ignored(ignored, rel))
}

fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(finish_sha256(hasher))
}

/// A file modified this close to the moment it was hashed may change again within the same timestamp tick (Windows
/// updates a write time at the clock's 1-16 ms resolution, HFS+ and FAT keep whole seconds), leaving size and times
/// as the cache saw them with new bytes: git's "racy clean" case. Its hash is not cached, so the next look hashes it.
const RACY: Duration = Duration::from_secs(3);

type Found = Vec<(String, PathBuf, Option<Stat>, Option<String>)>;

/// A file of the input set: its stat, and its hash when the cache vouches for it (an older stat-equal hash).
fn record_file(
    found: &mut Found,
    racy: &mut std::collections::HashSet<String>,
    cache: &StatCache,
    racy_after: std::time::SystemTime,
    child: String,
    path: PathBuf,
    meta: &fs::Metadata,
) {
    let stat = stat_of(meta);
    if meta.modified().map_or(true, |m| m >= racy_after) {
        racy.insert(child.clone());
    }
    let known = cache
        .map
        .get(&child)
        .filter(|(s, _)| *s == stat)
        .map(|(_, h)| h.clone());
    found.push((child, path, Some(stat), known));
}

/// Walks the checkout and hashes what the cache cannot vouch for; the cache learns the new hashes.
pub(crate) fn snapshot(
    root: &Path,
    ignored: Option<&[String]>,
    boundary: Option<&Boundary>,
    cache: &mut StatCache,
) -> io::Result<Files> {
    let racy_after = std::time::SystemTime::now()
        .checked_sub(RACY)
        .unwrap_or(std::time::UNIX_EPOCH);
    let mut racy: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut found: Found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    let mut followed: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    while let Some((dir, rel)) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name().into_string().map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "input path is not UTF-8")
            })?;
            if name == ".git" && boundary.is_some_and(|b| b.output(&rel)) {
                return Err(invalid(format!("nested checkout inside output {rel:?}")));
            }
            if name == ".git" {
                continue;
            }
            let path = entry.path();
            let child = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if boundary.is_none() && name == ".DS_Store" && is_ignored(ignored, &child) {
                continue;
            }
            let kind = entry.file_type()?;
            let output = boundary.is_some_and(|b| b.output(&child));
            if kind.is_dir() {
                if boundary.is_some() || !excluded_dir(&path, &child, &name, ignored) {
                    if boundary.is_some() {
                        found.push((child.clone(), path.clone(), None, Some("directory".into())));
                    }
                    stack.push((path, child));
                }
            } else if kind.is_symlink() {
                if output {
                    return Err(invalid(format!("symlink in generated output {child:?}")));
                }
                // The link itself (a retargeted link is a change) and what it points to, by content: a linked
                // `node_modules` or config is as much an input as a real one.
                let target = fs::read_link(&path)?;
                found.push((
                    format!("{child}@link"),
                    path.clone(),
                    None,
                    Some(format!(
                        "link:{}",
                        sha256_hex(target.as_os_str().as_encoded_bytes())
                    )),
                ));
                match fs::metadata(&path) {
                    Ok(meta) if meta.is_dir() => {
                        let real = fs::canonicalize(&path)?;
                        let loops = fs::canonicalize(&dir)?.starts_with(&real);
                        if !loops
                            && (boundary.is_some() || !excluded_dir(&path, &child, &name, ignored))
                            && followed.insert(real)
                        {
                            stack.push((path, child));
                        }
                    }
                    Ok(meta) => {
                        record_file(&mut found, &mut racy, cache, racy_after, child, path, &meta)
                    }
                    // A dangling link: its text is all there is.
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
            } else if kind.is_file() {
                let meta = entry.metadata()?;
                record_file(&mut found, &mut racy, cache, racy_after, child, path, &meta);
            } else if boundary.is_some() {
                return Err(invalid(format!("unsupported file type at {child:?}")));
            }
        }
    }
    // Hash what the cache could not vouch for, on every core.
    let todo: Vec<usize> = found
        .iter()
        .enumerate()
        .filter(|(_, f)| f.3.is_none())
        .map(|(i, _)| i)
        .collect();
    if !todo.is_empty() {
        let workers = std::thread::available_parallelism()
            .map_or(4, |n| n.get())
            .min(8);
        let chunk = todo.len().div_ceil(workers);
        let hashed: Vec<(usize, Option<String>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = todo
                .chunks(chunk.max(1))
                .map(|part| {
                    let found = &found;
                    scope.spawn(move || {
                        part.iter()
                            .map(|&i| (i, hash_file(&found[i].1).ok()))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|h| h.join().unwrap_or_default())
                .collect()
        });
        for (i, hash) in hashed {
            found[i].3 = hash;
        }
    }
    let mut files = Vec::with_capacity(found.len());
    for (rel, _, stat, hash) in found {
        let hash = hash.ok_or_else(|| io::Error::other(format!("could not hash input {rel:?}")))?;
        if let Some(stat) = stat {
            if racy.contains(&rel) {
                cache.map.remove(&rel);
            } else {
                cache.map.insert(rel.clone(), (stat, hash.clone()));
            }
            let mark = if stat.exec { "x" } else { "" };
            files.push((rel, format!("{hash}{mark}")));
        } else {
            files.push((rel, hash));
        }
    }
    files.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    let keep: std::collections::HashSet<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
    cache
        .map
        .retain(|p, _| Path::new(p).is_absolute() || keep.contains(p.as_str()));
    let outputs = boundary.map_or(Outputs::Undeclared, |b| {
        let complete = b
            .outputs
            .iter()
            .all(|o| files.binary_search_by(|(p, _)| p.cmp(o)).is_ok());
        let mut hasher = Sha256::new();
        files.retain(|(p, h)| {
            if !b.output(p) {
                return true;
            }
            digest_entry(&mut hasher, p, h);
            // A generated executable must be named itself, not just sit somewhere under an output directory.
            if b.outputs.contains(p) {
                return false;
            }
            let path = Path::new(p);
            lockfile(p.rsplit('/').next().unwrap_or(p))
                || h.ends_with('x')
                || path.extension().is_some_and(|ext| {
                    ["exe", "bat", "cmd", "com"]
                        .iter()
                        .any(|e| ext.eq_ignore_ascii_case(e))
                })
        });
        if complete {
            Outputs::Present(finish_sha256(hasher))
        } else {
            Outputs::Missing
        }
    });
    Ok(Files { files, outputs })
}

/// Variables that differ between terminals, sessions and agents without changing what a test does. Only named
/// plumbing: any other variable, `OMP_GUI_*` and `OMPDESK_*` included (`OMP_GUI_REAL_WORK` turns tests on), is an
/// input, so a session other than the one that ran the check reruns it rather than trust a guess.
pub fn volatile_env(name: &str) -> bool {
    const EXACT: &[&str] = &[
        // A tab's process tag and the check's own nesting markers: a new value per tab or per hold.
        "OMP_GUI_SESSION_TAG",
        "OMPDESK_HEAVY_HELD",
        "OMPDESK_CHECK_RUN",
        "OMPDESK_BUILD_LOCK_HELD",
        "OMPDESK_SOCKET",
        "OMPDESK_CONTROL_DIR",
        "OMPDESK_CALLER",
        "PWD",
        "OLDPWD",
        "SHLVL",
        "_",
        "COLUMNS",
        "LINES",
        "WINDOWID",
        "SECURITYSESSIONID",
        "LaunchInstanceID",
        "Apple_PubSub_Socket_Render",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "GPG_TTY",
        "SSH_AUTH_SOCK",
        "SSH_AGENT_PID",
        "SSH_CLIENT",
        "SSH_CONNECTION",
        "SSH_TTY",
        "TERM_SESSION_ID",
        "COLORTERM",
        "GIT_ASKPASS",
        "VSCODE_GIT_ASKPASS_NODE",
        "VSCODE_GIT_ASKPASS_MAIN",
        "VSCODE_GIT_IPC_HANDLE",
    ];
    const PREFIXES: &[&str] = &[
        "TERM_PROGRAM",
        "ITERM_",
        "TMUX",
        "KITTY_",
        "WEZTERM_",
        "XPC_",
        "__CF",
        "XDG_SESSION_",
        "VSCODE_INJECTION",
    ];
    EXACT.contains(&name) || PREFIXES.iter().any(|p| name.starts_with(p))
}

fn version_of(program: &str, args: &[&str]) -> Option<String> {
    let mut child = child_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(10) => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let line = out.lines().next()?.trim().to_string();
    (!line.is_empty()).then_some(line)
}

/// The tools a check's results depend on beyond the checkout.
pub fn tools(cargo: bool) -> BTreeMap<String, String> {
    let mut tools = BTreeMap::new();
    tools.insert(
        "os".into(),
        format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
    );
    #[cfg(unix)]
    if let Some(v) = version_of("uname", &["-sr"]) {
        tools.insert("kernel".into(), v);
    }
    let mut programs = vec![("node", "--version"), ("bun", "--version")];
    if cargo {
        programs.extend([("rustc", "-V"), ("cargo", "-V")]);
    }
    for (program, flag) in programs {
        tools.insert(
            program.into(),
            version_of(program, &[flag]).unwrap_or_else(|| "absent".into()),
        );
    }
    tools.insert(
        "ompdesk".into(),
        format!(
            "{} reporters {}",
            env!("CARGO_PKG_VERSION"),
            &crate::runner::reporters_digest()[..12]
        ),
    );
    tools
}

/// The whole input set of one run of a check.
#[derive(Clone, Debug, Default)]
pub struct InputSet {
    pub files: Files,
    /// Files the command names outside the checkout.
    pub outside: BTreeMap<String, String>,
    pub env: BTreeMap<String, String>,
    pub tools: BTreeMap<String, String>,
    pub argv: Vec<String>,
}

impl InputSet {
    pub fn env_hashes(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
        env.iter()
            .filter(|(k, _)| !volatile_env(k))
            .map(|(k, v)| (k.clone(), sha256_hex(v.as_bytes())[..16].to_string()))
            .collect()
    }

    /// Command/script arguments stay inputs even outside the checkout or behind an ignored directory.
    pub(crate) fn command_files(
        cwd: &Path,
        argv: &[String],
        env: &BTreeMap<String, String>,
        root: &Path,
        boundary: Option<&Boundary>,
        files: &Files,
        cache: &mut StatCache,
    ) -> io::Result<BTreeMap<String, String>> {
        let mut out = BTreeMap::new();
        let Some(program) = argv.first() else {
            return Ok(out);
        };
        #[cfg(windows)]
        let executable = if program.contains(['/', '\\']) {
            crate::cli::resolve_windows(&cwd.join(program).to_string_lossy(), env)
        } else {
            crate::cli::resolve_windows(program, env)
        };
        #[cfg(unix)]
        let executable = if program.contains('/') {
            Some(cwd.join(program))
        } else {
            env.get("PATH").and_then(|value| {
                std::env::split_paths(value)
                    .map(|dir| cwd.join(dir).join(program))
                    .find(|p| fs::metadata(p).is_ok_and(|m| m.is_file() && stat_of(&m).exec))
            })
        };
        let real_root = fs::canonicalize(root)?;
        for (program, path) in
            executable
                .into_iter()
                .map(|p| (true, p))
                .chain(argv.iter().skip(1).map(|arg| {
                    let value = arg
                        .strip_prefix('-')
                        .and_then(|a| a.split_once('='))
                        .map_or(arg.as_str(), |(_, v)| v);
                    (false, cwd.join(value))
                }))
        {
            if !path.is_file() {
                continue;
            }
            let path = fs::canonicalize(path)?;
            let key = path.display().to_string();
            if program {
                out.insert("@executable".into(), key.clone());
            }
            if let Ok(rel) = path.strip_prefix(&real_root) {
                let rel = rel
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/");
                if boundary.is_some_and(|b| b.outputs.iter().any(|o| under(&rel, o))) {
                    return Err(invalid(format!("output overlaps command argument {rel:?}")));
                }
                if files
                    .files
                    .binary_search_by(|(p, _)| p.as_str().cmp(&rel))
                    .is_ok()
                {
                    continue;
                }
            }
            let meta = fs::metadata(&path)?;
            let stat = stat_of(&meta);
            let cacheable = meta.modified()?.elapsed().is_ok_and(|age| age >= RACY);
            let hash = match cache.map.get(&key) {
                Some((old, hash)) if cacheable && old == &stat => hash.clone(),
                _ => {
                    let hash = hash_file(&path)?;
                    if cacheable {
                        cache.map.insert(key.clone(), (stat, hash.clone()));
                    } else {
                        cache.map.remove(&key);
                    }
                    hash
                }
            };
            out.insert(key, if stat.exec { format!("{hash}x") } else { hash });
        }
        cache
            .map
            .retain(|p, _| !Path::new(p).is_absolute() || out.contains_key(p));
        Ok(out)
    }

    pub(crate) fn changed_during(&self, end: &Self) -> Vec<String> {
        let mut changed = if self.files.files == end.files.files {
            Vec::new()
        } else {
            changed_paths(&self.files, &end.files)
        };
        for (label, before, after) in [
            ("command file", &self.outside, &end.outside),
            ("environment variable", &self.env, &end.env),
            ("tool", &self.tools, &end.tools),
        ] {
            for (key, value) in before {
                if after.get(key) != Some(value) {
                    changed.push(format!("{label}: {key}"));
                }
            }
            for key in after.keys().filter(|key| !before.contains_key(*key)) {
                changed.push(format!("{label}: {key}"));
            }
        }
        changed
    }

    pub fn digest(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.files.digest().as_bytes());
        for (k, v) in self
            .outside
            .iter()
            .chain(&self.env)
            .chain(&self.tools)
            .map(|(k, v)| (k.as_str(), v.as_str()))
        {
            hasher.update(k.as_bytes());
            hasher.update([0]);
            hasher.update(v.as_bytes());
            hasher.update(b"\n");
        }
        for a in &self.argv {
            hasher.update(a.as_bytes());
            hasher.update([0]);
        }
        finish_sha256(hasher)
    }

    /// `F`, `X`, `E`, `T` lines: files, outside files, environment, tools.
    pub fn to_tsv(&self) -> String {
        let mut out = String::new();
        for (p, h) in &self.files.files {
            if !p.contains(['\t', '\n']) {
                out.push_str(&format!("F\t{p}\t{h}\n"));
            }
        }
        for (kind, map) in [("X", &self.outside), ("E", &self.env), ("T", &self.tools)] {
            for (k, v) in map {
                out.push_str(&format!(
                    "{kind}\t{}\t{}\n",
                    k.replace(['\t', '\n'], " "),
                    v.replace(['\t', '\n'], " ")
                ));
            }
        }
        out
    }
}

/// What differs between an earlier input list (`inputs.tsv`) and now, as lines of evidence (at most `limit` paths).
pub fn differences(earlier: &str, now: &InputSet, limit: usize) -> Vec<String> {
    let mut before: [BTreeMap<&str, &str>; 4] = Default::default();
    for line in earlier.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(kind), Some(k), Some(v)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let at = match kind {
            "F" => 0,
            "X" => 1,
            "E" => 2,
            "T" => 3,
            _ => continue,
        };
        before[at].insert(k, v);
    }
    let after: [BTreeMap<&str, &str>; 4] = [
        now.files
            .files
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect(),
        now.outside
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect(),
        now.env
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect(),
        now.tools
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect(),
    ];
    let labels = ["file", "outside file", "environment variable", "tool"];
    let mut lines = Vec::new();
    for at in 0..4 {
        let mut changed = Vec::new();
        for (k, v) in &after[at] {
            match before[at].get(k) {
                Some(old) if old == v => {}
                Some(old) if at == 3 => changed.push(format!("{k} {old} → {v}")),
                Some(_) => changed.push(format!("{k} changed")),
                None => changed.push(format!("{k} added")),
            }
        }
        for k in before[at].keys() {
            if !after[at].contains_key(k) {
                changed.push(format!("{k} removed"));
            }
        }
        if changed.is_empty() {
            continue;
        }
        let total = changed.len();
        let shown: Vec<String> = changed.into_iter().take(limit).collect();
        let more = if total > shown.len() {
            format!(" (+{} more)", total - shown.len())
        } else {
            String::new()
        };
        lines.push(format!(
            "{total} {}{} changed: {}{more}",
            labels[at],
            if total == 1 { "" } else { "s" },
            shown.join(", ")
        ));
    }
    lines
}

/// Paths whose hash differs between two file lists, the paths of `a` order.
pub fn changed_paths(a: &Files, b: &Files) -> Vec<String> {
    let before: HashMap<&str, &str> = a
        .files
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let after: HashMap<&str, &str> = b
        .files
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let mut out: Vec<String> = after
        .iter()
        .filter(|(k, v)| before.get(*k) != Some(*v))
        .map(|(k, _)| k.to_string())
        .chain(
            before
                .keys()
                .filter(|k| !after.contains_key(*k))
                .map(|k| k.to_string()),
        )
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(root: &Path, ignored: Option<&[String]>, cache: &mut StatCache) -> Files {
        super::snapshot(root, ignored, None, cache).unwrap()
    }

    fn temp(name: &str) -> PathBuf {
        use std::hash::{BuildHasher, RandomState};
        let dir = std::env::temp_dir().join(format!(
            "ompdesk-inputs-{name}-{}-{:x}",
            std::process::id(),
            RandomState::new().hash_one(0u8)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn policy(root: &Path, checks: serde_json::Value) {
        fs::create_dir_all(root.join(".ompdesk")).unwrap();
        fs::write(
            root.join(POLICY),
            serde_json::json!({"checks": checks}).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn only_the_declared_producers_generated_files_are_not_inputs() {
        let base = temp("build-boundary");
        let root = base.join("repo");
        fs::create_dir_all(root.join("src")).unwrap();
        git(&root, &["init", "-q"]).unwrap();
        fs::write(root.join(".gitignore"), ".next/\n.env.local\n").unwrap();
        for p in ["src/page.js", "package-lock.json", "build.js", ".env.local"] {
            fs::write(root.join(p), "before").unwrap();
        }
        git(&root, &["add", "src", "package-lock.json", "build.js"]).unwrap();
        let argv = vec!["../tool.cmd".to_string(), "build.js".to_string()];
        fs::write(base.join("tool.cmd"), "tool v1").unwrap();
        policy(
            &root,
            serde_json::json!([{
                "cwd": ".", "argv": argv, "inputs": ["src", "build.js"], "outputs": [".next", "generated.exe"]
            }]),
        );
        let capture = |argv: &[String]| {
            let b = Boundary::load(&root, &root, argv).unwrap();
            let mut cache = StatCache::load(&base, &root);
            let files =
                super::snapshot(&root, ignored(&root).as_deref(), b.as_ref(), &mut cache).unwrap();
            let outside = InputSet::command_files(
                &root,
                argv,
                &BTreeMap::new(),
                &root,
                b.as_ref(),
                &files,
                &mut cache,
            )
            .unwrap();
            InputSet {
                files,
                outside,
                argv: argv.to_vec(),
                ..InputSet::default()
            }
        };
        let before = capture(&argv);
        assert_eq!(before.files.outputs, Outputs::Missing);
        fs::create_dir_all(root.join(".next/server")).unwrap();
        fs::write(root.join(".next/server/chunk.js"), "bundle").unwrap();
        fs::write(root.join("generated.exe"), "generated tool").unwrap();
        let built = capture(&argv);
        assert_eq!(before.digest(), built.digest());
        let Outputs::Present(hash) = &built.files.outputs else {
            panic!("missing build artifacts")
        };
        let proof = base.join("outputs.sha256");
        fs::write(&proof, hash).unwrap();
        assert!(capture(&argv).files.outputs.matches_proof(&proof));
        fs::write(root.join("generated.exe"), "modified tool").unwrap();
        assert!(!capture(&argv).files.outputs.matches_proof(&proof));
        fs::write(root.join("generated.exe"), "generated tool").unwrap();
        let consumer = ["../tool.cmd".to_string(), "serve".to_string()];
        let serving = capture(&consumer);
        fs::write(root.join(".next/server/chunk.js"), "updated bundle").unwrap();
        assert_ne!(serving.digest(), capture(&consumer).digest());
        assert!(!capture(&argv).files.outputs.matches_proof(&proof));
        fs::remove_dir_all(root.join(".next")).unwrap();
        assert_eq!(capture(&argv).files.outputs, Outputs::Missing);
        assert!(!capture(&argv).files.outputs.matches_proof(&proof));
        fs::create_dir_all(root.join(".next/server")).unwrap();
        fs::write(root.join(".next/server/chunk.js"), "bundle").unwrap();
        assert!(capture(&argv).files.outputs.matches_proof(&proof));
        for protected in [".next/pnpm-lock.yaml", ".next/tool.exe"] {
            fs::write(root.join(protected), "unexpected build input").unwrap();
            assert_eq!(before.changed_during(&capture(&argv)), [protected]);
            fs::remove_file(root.join(protected)).unwrap();
        }
        for p in ["src/page.js", "package-lock.json", "build.js", ".env.local"] {
            fs::write(root.join(p), "after").unwrap();
            let changed = capture(&argv);
            assert_eq!(before.changed_during(&changed), [p]);
            assert_ne!(before.digest(), changed.digest());
            fs::write(root.join(p), "before").unwrap();
        }
        fs::write(base.join("tool.cmd"), "tool v2").unwrap();
        let changed = capture(&argv);
        assert_ne!(before.digest(), changed.digest());
        assert!(
            before
                .changed_during(&changed)
                .iter()
                .any(|p| p.ends_with("tool.cmd"))
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn ambiguous_boundaries_and_hidden_command_inputs_are_rejected() {
        let root = temp("invalid-boundary");
        git(&root, &["init", "-q"]).unwrap();
        fs::create_dir_all(root.join("tracked")).unwrap();
        fs::write(root.join("tracked/source"), "tracked").unwrap();
        git(&root, &["add", "tracked"]).unwrap();
        let argv = vec!["./tool".to_string(), ".next/build.js".to_string()];
        let check = |outputs: &[&str]| {
            serde_json::json!({
                "cwd": ".", "argv": argv, "inputs": ["src"], "outputs": outputs
            })
        };
        for outputs in [
            &["../outside"][..],
            &["/absolute"],
            &["."],
            &["dist/*"],
            &[".git"],
            &["src/out"],
            &["tracked"],
            &[".next", ".next/cache"],
            &["pkg", "PKG"],
        ] {
            policy(&root, serde_json::json!([check(outputs)]));
            assert!(Boundary::load(&root, &root, &argv).is_err(), "{outputs:?}");
        }
        let next = check(&[".next"]);
        policy(&root, serde_json::json!([next, next]));
        assert!(Boundary::load(&root, &root, &argv).is_err());
        policy(&root, serde_json::json!([next]));
        fs::create_dir_all(root.join(".next")).unwrap();
        fs::write(root.join(".next/build.js"), "script").unwrap();
        let b = Boundary::load(&root, &root, &argv).unwrap();
        assert!(
            InputSet::command_files(
                &root,
                &argv,
                &BTreeMap::new(),
                &root,
                b.as_ref(),
                &Files::default(),
                &mut StatCache::load(&root, &root)
            )
            .is_err()
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("..", root.join("alias")).unwrap();
            policy(&root, serde_json::json!([check(&["alias/generated"])]));
            assert!(Boundary::load(&root, &root, &argv).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_edit_changes_the_digest_and_a_touch_does_not() {
        let root = temp("edit");
        let store = temp("store");
        fs::create_dir_all(store.join("inputs")).unwrap();
        fs::write(root.join("a.ts"), "one").unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join("target/CACHEDIR.TAG"), "Signature").unwrap();
        fs::write(root.join("target/out.bin"), "x").unwrap();
        let mut cache = StatCache::load(&store, &root);
        let first = snapshot(&root, None, &mut cache);
        assert_eq!(first.files.len(), 1, "the tagged cache is no input");
        cache.save().unwrap();

        let mut cache = StatCache::load(&store, &root);
        fs::write(root.join("target/out.bin"), "y").unwrap();
        let same = snapshot(&root, None, &mut cache);
        assert_eq!(first.digest(), same.digest());

        // Same bytes written again: new times, same content.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(root.join("a.ts"), "one").unwrap();
        let touched = snapshot(&root, None, &mut cache);
        assert_eq!(first.digest(), touched.digest());

        fs::write(root.join("a.ts"), "two").unwrap();
        let edited = snapshot(&root, None, &mut cache);
        assert_ne!(first.digest(), edited.digest());
        assert_eq!(changed_paths(&first, &edited), vec!["a.ts".to_string()]);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(store);
    }

    #[test]
    fn a_file_written_just_now_is_hashed_again_next_time() {
        // Windows keeps a write time at the clock's tick: two same-size writes in one tick look unchanged, so a
        // hash of a file that fresh is never kept (it failed exactly so on windows-latest, 13 Nov 2026).
        let root = temp("racy");
        fs::write(root.join("fresh.ts"), "one").unwrap();
        fs::write(root.join("old.ts"), "one").unwrap();
        let hour_ago = std::time::SystemTime::now() - Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(root.join("old.ts"))
            .unwrap()
            .set_modified(hour_ago)
            .unwrap();
        let mut cache = StatCache {
            path: root.join("cache.tsv"),
            map: HashMap::new(),
        };
        snapshot(&root, None, &mut cache);
        assert!(!cache.map.contains_key("fresh.ts"));
        assert!(cache.map.contains_key("old.ts"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cache_names_are_skipped_only_where_git_ignores_them() {
        let root = temp("names");
        fs::create_dir_all(root.join("coverage")).unwrap();
        fs::write(root.join("coverage/lib.ts"), "source").unwrap();
        let mut cache = StatCache {
            path: root.join("cache.tsv"),
            map: HashMap::new(),
        };
        let tracked = snapshot(&root, Some(&[]), &mut cache);
        assert_eq!(
            tracked.files.len(),
            1,
            "a tracked folder named coverage is an input"
        );
        let ignored = snapshot(&root, Some(&["coverage/".to_string()]), &mut cache);
        assert!(ignored.files.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plumbing_variables_are_not_inputs() {
        assert!(volatile_env("OMP_GUI_SESSION_TAG"));
        assert!(volatile_env("TERM_SESSION_ID"));
        assert!(!volatile_env("PATH"));
        assert!(!volatile_env("CI"));
        assert!(!volatile_env("NODE_OPTIONS"));
        // Session variables that change what tests do are inputs.
        assert!(!volatile_env("OMP_GUI_REAL_WORK"));
        assert!(!volatile_env("OMP_GUI_TEST_FAKE_OMP"));
        assert!(!volatile_env("OMPDESK_HEAVY_SLOTS"));
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_folder_is_read_through_and_a_loop_ends() {
        let base = std::env::temp_dir().join(format!("ompdesk-links-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("repo");
        let shared = base.join("shared-modules");
        fs::create_dir_all(shared.join("pkg")).unwrap();
        fs::create_dir_all(&root).unwrap();
        fs::write(shared.join("pkg").join("index.js"), "one").unwrap();
        std::os::unix::fs::symlink(&shared, root.join("node_modules")).unwrap();
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        let mut cache = StatCache::load(&base.join("store"), &root);
        let before = snapshot(&root, Some(&[]), &mut cache);
        let hash_of = |f: &Files| {
            f.files
                .iter()
                .find(|(p, _)| p == "node_modules/pkg/index.js")
                .map(|(_, h)| h.clone())
        };
        let first = hash_of(&before).expect("the linked folder was not read");
        assert!(before.files.iter().all(|(p, _)| !p.starts_with("loop/")));
        fs::write(shared.join("pkg").join("index.js"), "two, longer").unwrap();
        let after = snapshot(&root, Some(&[]), &mut cache);
        assert_ne!(
            hash_of(&after),
            Some(first),
            "an edit behind the link was not seen"
        );
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn an_ignored_alias_does_not_hide_an_included_alias_of_the_same_folder() {
        let base = std::env::temp_dir().join(format!("ompdesk-aliases-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("repo");
        let shared = base.join("deps");
        fs::create_dir_all(shared.join("pkg")).unwrap();
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(shared.join("pkg").join("index.js"), "one").unwrap();
        // The ignored alias sits at the root, so the walk always meets it before the one inside `app/`.
        std::os::unix::fs::symlink(&shared, root.join("coverage")).unwrap();
        std::os::unix::fs::symlink(&shared, root.join("app").join("node_modules")).unwrap();
        let mut cache = StatCache::load(&base.join("store"), &root);
        let files = snapshot(&root, Some(&["coverage/".to_string()]), &mut cache);
        assert!(
            files
                .files
                .iter()
                .any(|(p, _)| p == "app/node_modules/pkg/index.js"),
            "the included alias was skipped: {:?}",
            files.files
        );
        assert!(files.files.iter().all(|(p, _)| !p.starts_with("coverage/")));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn differences_name_what_changed() {
        let mut a = InputSet::default();
        a.files.files = vec![("a.ts".into(), "1".into()), ("b.ts".into(), "2".into())];
        a.env.insert("NODE_ENV".into(), "x".into());
        a.tools.insert("node".into(), "v22".into());
        let earlier = a.to_tsv();
        let mut b = a.clone();
        b.files.files = vec![("a.ts".into(), "9".into()), ("c.ts".into(), "3".into())];
        b.env.insert("NODE_ENV".into(), "y".into());
        b.tools.insert("node".into(), "v24".into());
        let lines = differences(&earlier, &b, 20);
        assert_eq!(
            lines,
            vec![
                "3 files changed: a.ts changed, c.ts added, b.ts removed".to_string(),
                "1 environment variable changed: NODE_ENV changed".to_string(),
                "1 tool changed: node v22 → v24".to_string(),
            ]
        );
        assert_ne!(a.digest(), b.digest());
    }
}
