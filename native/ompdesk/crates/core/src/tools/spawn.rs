//! Finding and starting a command-line tool the way each platform runs it, and the package managers' own checks and
//! updates, shared by the tool CLI updater (`cli`), the extension updater's MCP binaries (`ext`) and setup's plans.
//! The Rust of `src/main/spawn.ts` (`findOnPath`, `launcherNames`, `executableName`, `spawnCommand`/`spawnArgs`/
//! `needsShell`), `shell-env.ts` `brewBinDirs`, `cli-tools/detect.ts` (`findBrew`, `probeOutput`, `readInstall`),
//! `cli-tools/plans.ts` (`command`, `NPM_BIN`, `bunView`, `npmFor`, `ownerCheckCommand`, `ownerUpdateCommand`,
//! `parseLatest`), the CLI updater's `runCheckProcess` and `src/shared/version.ts` `isNewer`/`parseOmpVersion`.
//!
//! Windows starts a native `.exe` directly but a `.cmd`/`.bat` shim (npm's) only through cmd.exe, and the bare `<bin>`
//! npm writes beside a shim is a POSIX shell script it cannot start. `platform` is the opts' `"darwin"` or `"win32"`;
//! an owner is the `CliOwner` JSON `ext.binaryFacts` answers (`{method, …}`).

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::process::Command;

use super::runner::SpawnSpec;
use crate::fs::error::uv_code;
use crate::fs::order::js_trim;
use crate::server::Fault;
use crate::tailscale::compare_versions;

pub(crate) type Env = BTreeMap<String, String>;

/// `CHECK_TIMEOUT_MS` of the CLI updater: a check (`npm view`, `brew outdated`) runs at most this long.
const CHECK_TIMEOUT: Duration = Duration::from_secs(120);
/// `probeOutput`'s bound (`<tool> --version`, `gh extension list`).
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// Homebrew's bin dirs (Apple Silicon, Intel).
const BREW_BIN_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

fn win32(platform: &str) -> bool {
    platform == "win32"
}

/// Windows `.cmd`/`.bat` shims only run through cmd.exe.
pub(crate) fn needs_shell(bin: &str, platform: &str) -> bool {
    let lower = bin.to_ascii_lowercase();
    win32(platform) && (lower.ends_with(".cmd") || lower.ends_with(".bat"))
}

/// `{file: spawnCommand, args: spawnArgs, shell: needsShell}`: a shell spawn joins command and argv into one cmd.exe
/// line unquoted, so the shim and each argument are quoted there (a `"` doubled); elsewhere argv goes verbatim.
pub(crate) fn spawn_spec(file: &str, args: &[String], platform: &str) -> SpawnSpec {
    let shell = needs_shell(file, platform);
    SpawnSpec {
        file: if shell {
            format!("\"{file}\"")
        } else {
            file.to_owned()
        },
        args: if shell {
            args.iter()
                .map(|arg| format!("\"{}\"", arg.replace('"', "\"\"")))
                .collect()
        } else {
            args.to_vec()
        },
        shell,
        input_file: None,
    }
}

/// A native tool's file name: `<name>.exe` on Windows, the bare name elsewhere.
pub(crate) fn executable_name(name: &str, platform: &str) -> String {
    if win32(platform) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

/// The names a tool that may be a native binary or an npm shim is looked up by: on Windows `<name>.exe`, then
/// `<name>.cmd` (never the bare name, a POSIX shell script there); the bare name elsewhere.
pub(crate) fn launcher_names(name: &str, platform: &str) -> Vec<String> {
    if win32(platform) {
        vec![format!("{name}.exe"), format!("{name}.cmd")]
    } else {
        vec![name.to_owned()]
    }
}

#[cfg(unix)]
fn may_execute(path: &Path) -> bool {
    crate::sys::may_execute(path)
}

/// node's `accessSync(F_OK)` on Windows.
#[cfg(not(unix))]
fn may_execute(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

/// A file this platform can start: any existing file on Windows, one with an execute bit on POSIX; never a directory.
/// An app execution alias (`WindowsApps\winget.exe`) is a reparse point that may refuse a stat: only a directory that
/// stats as one is ruled out.
pub(crate) fn is_executable_file(file: &Path) -> bool {
    may_execute(file) && std::fs::metadata(file).map_or(true, |meta| !meta.is_dir())
}

fn joined(dir: &str, name: &str) -> String {
    Path::new(dir).join(name).to_string_lossy().into_owned()
}

/// Main's working directory and, on Windows, its per-drive ones (`=X:` of its environment): what main's `findOnPath`,
/// `execFile` and `readInstall` resolved a relative launcher against. The core's own working directory is the shell's,
/// so a relative PATH entry is resolved here, never by the OS against the core's.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Base {
    pub cwd: String,
    /// `=D:` → `D:\work`, as main's environment holds them.
    pub drives: BTreeMap<String, String>,
}

static BASE: std::sync::RwLock<Option<Base>> = std::sync::RwLock::new(None);

/// Main's base, from the instance's opts; a launch before any (a test) resolves against the core's own directory.
pub(crate) fn set_base(base: Base) {
    *BASE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(base);
}

fn base() -> Base {
    BASE.read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .unwrap_or_else(|| Base {
            cwd: std::env::current_dir()
                .map(|dir| dir.to_string_lossy().into_owned())
                .unwrap_or_default(),
            drives: BTreeMap::new(),
        })
}

/// The drive letter of a Windows path (`d:` → `D:`), if it starts with one.
fn drive_of(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        .then(|| path[..2].to_ascii_uppercase())
}

/// Where `path.resolve("D:")` lands in main: its working directory when that is on D:, else its `=D:`, else `D:\`.
pub(crate) fn drive_base(drive: &str, base: &Base) -> String {
    let drive = drive.to_ascii_uppercase();
    if drive_of(&base.cwd).as_deref() == Some(drive.as_str()) {
        return base.cwd.clone();
    }
    base.drives
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(&format!("={drive}")))
        .map_or_else(|| format!("{drive}\\"), |(_, dir)| dir.clone())
}

/// `path.resolve(dir)` in main: `dir` as it is when it names its whole place, else against main's directories.
pub(crate) fn resolve_against(dir: &str, base: &Base, windows: bool) -> String {
    if !windows {
        return if dir.starts_with('/') {
            dir.to_owned()
        } else {
            joined(&base.cwd, dir)
        };
    }
    let bytes = dir.as_bytes();
    let separator = |at: usize| matches!(bytes.get(at), Some(b'\\' | b'/'));
    match drive_of(dir) {
        Some(_) if separator(2) => dir.to_owned(),
        Some(drive) => joined(&drive_base(&drive, base), &dir[2..]),
        // `\\server\share` and `\x`: the first is whole, the second is on the working directory's drive.
        None if separator(0) && separator(1) => dir.to_owned(),
        None if separator(0) => format!("{}{dir}", drive_of(&base.cwd).unwrap_or_default()),
        None => joined(&base.cwd, dir),
    }
}

/// The first `names` entry found along `path_env` (each directory tries every name in order), then the first `extra`
/// candidate that exists. A relative directory is main's (`Base`), so what is found is the file main would find.
pub(crate) fn find_on_path(
    names: &[String],
    path_env: &str,
    platform: &str,
    extra: &[String],
) -> Option<String> {
    find_on_path_from(names, path_env, platform, extra, &base())
}

fn find_on_path_from(
    names: &[String],
    path_env: &str,
    platform: &str,
    extra: &[String],
    base: &Base,
) -> Option<String> {
    let windows = win32(platform) || cfg!(windows);
    let separator = if windows { ';' } else { ':' };
    path_env
        .split(separator)
        .filter(|dir| !dir.is_empty())
        .map(|dir| resolve_against(dir, base, windows))
        .flat_map(|dir| names.iter().map(move |name| joined(&dir, name)))
        .chain(extra.iter().cloned())
        .find(|file| is_executable_file(Path::new(file)))
}

/// `brewBinDirs` over `OMP_GUI_TEST_BREW_DIRS` (a PATH-style list, empty for none), which a test launch sets so the
/// developer's own Homebrew never answers it.
fn brew_dirs_from(test: Option<String>) -> Vec<String> {
    match test {
        None => BREW_BIN_DIRS.map(str::to_owned).to_vec(),
        Some(dirs) => std::env::split_paths(&dirs)
            .map(|dir| dir.to_string_lossy().into_owned())
            .filter(|dir| !dir.is_empty())
            .collect(),
    }
}

/// Where a brew-installed tool is looked for even when the shell's PATH omits Homebrew's bin dir.
pub(crate) fn brew_bin_dirs() -> Vec<String> {
    brew_dirs_from(std::env::var("OMP_GUI_TEST_BREW_DIRS").ok())
}

fn find_brew_in(path_env: &str, platform: &str, brew_dirs: &[String]) -> Option<String> {
    if win32(platform) {
        return None;
    }
    let extra: Vec<String> = brew_dirs.iter().map(|dir| joined(dir, "brew")).collect();
    find_on_path(&["brew".to_owned()], path_env, platform, &extra)
}

/// Homebrew's `brew`: on PATH, else at its standard prefixes. None on Windows and on a Mac without it.
pub(crate) fn find_brew(path_env: &str, platform: &str) -> Option<String> {
    find_brew_in(path_env, platform, &brew_bin_dirs())
}

/// What one process did.
struct Exited {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Runs `spec` with exactly `env` (in `cwd`) for at most `timeout`, as node's `execFile` with `windowsHide`; a process
/// past it, or whose caller went away, is killed. `Err` when it could not start (node's `spawn <file> ENOENT`).
async fn exec(
    spec: &SpawnSpec,
    env: &Env,
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<Exited, String> {
    let mut command = if spec.shell {
        Command::from(crate::supervise::shell_command(&spec.file, &spec.args).0)
    } else {
        let mut command = Command::new(&spec.file);
        command.args(&spec.args);
        command
    };
    command.env_clear();
    crate::run::Runner::apply_environment(env, &mut command);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let child = command
        .spawn()
        .map_err(|error| format!("spawn {} {}", spec.file, uv_code(&error)))?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(Exited {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Ok(Exited {
            success: false,
            stdout: String::new(),
            stderr: String::new(),
        }),
    }
}

/// node's `Command failed: <file> <args…>`, the message of a failed `execFile` without stderr.
fn failed_message(spec: &SpawnSpec) -> String {
    let mut line = format!("Command failed: {}", spec.file);
    for arg in &spec.args {
        line.push(' ');
        line.push_str(arg);
    }
    line
}

/// `<bin> <args>` stdout, or its stderr (else node's message) when it failed or ran past 15 s.
pub(crate) async fn probe_output(
    bin: &str,
    args: &[String],
    env: &Env,
    platform: &str,
) -> Result<String, String> {
    let spec = spawn_spec(bin, args, platform);
    match exec(&spec, env, None, PROBE_TIMEOUT).await {
        Ok(exited) if exited.success => Ok(exited.stdout),
        Ok(exited) if !exited.stderr.is_empty() => Err(js_trim(&exited.stderr).to_owned()),
        Ok(_) => Err(failed_message(&spec)),
        Err(message) => Err(js_trim(&message).to_owned()),
    }
}

/// What `ext.binaryFacts` reads an install with (`InstallContext` without the bundle).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct InstallContext {
    pub platform: String,
    pub tools_dir: String,
    pub brew: Option<String>,
}

/// `readInstall`: who owns the launcher at `path` and what it says of itself (`ext.binaryFacts` in process).
/// `source` is `InstallSource` (`{kind: "cli", spec}`, `{kind: "ghExtension" | "omp" | "bundle"}`, `{kind: "mcp",
/// command}`). Node resolved a relative or drive-relative launcher in its current directory: so does the core.
pub(crate) async fn read_install(
    path: &str,
    ctx: &InstallContext,
    source: Value,
) -> Result<Value, Fault> {
    // `process.cwd()`, `resolve(path)` and `resolve("D:")` were main's: its directories, never the core's (`Base`).
    let base = base();
    let file = std::path::absolute(resolve_against(path, &base, cfg!(windows)))
        .map(|file| file.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_owned());
    let mut drives = serde_json::Map::new();
    if cfg!(windows) {
        for input in [
            Some(path),
            Some(ctx.tools_dir.as_str()),
            ctx.brew.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            let bytes = input.as_bytes();
            let drive_relative = bytes.len() >= 2
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && !matches!(bytes.get(2), Some(b'\\' | b'/'));
            if drive_relative && !drives.contains_key(&input[..2]) {
                drives.insert(input[..2].to_owned(), json!(drive_base(&input[..2], &base)));
            }
        }
    }
    let cwd = base.cwd;
    let params = json!({
        "path": path,
        "file": file,
        "cwd": cwd,
        "drives": drives,
        "ctx": {"platform": ctx.platform, "toolsDir": ctx.tools_dir, "brew": ctx.brew},
        "source": source,
    });
    tokio::task::spawn_blocking(move || crate::ext::binary_facts(params))
        .await
        .map_err(|_| Fault::new("internal", "The file read panicked"))?
}

/// The PATH a command is looked up along, on the platform it runs on.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PlanTools {
    pub platform: String,
    pub path_env: String,
}

/// A process to run: a check (read-only, short) or an update (under the setup supervisor).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct CliCommand {
    pub spawn: SpawnSpec,
    /// Added to the environment.
    pub env: Env,
    /// Run in a private temp dir holding an empty `package.json`: `bun pm view` refuses to run without one in its cwd
    /// ("No package.json was found", Bun 1.4.2), and the check must not depend on where the core runs.
    pub package_dir: bool,
}

/// A Windows `.cmd` shim (npm's) runs through cmd.exe, quoted the way omp's own shim is; whatever platform runs.
pub(crate) fn command(file: &str, args: &[String]) -> CliCommand {
    let platform = if needs_shell(file, "win32") {
        "win32"
    } else {
        "darwin"
    };
    CliCommand {
        spawn: spawn_spec(file, args, platform),
        ..CliCommand::default()
    }
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

/// npm's Windows launcher is `npm.cmd`; the bare `npm` beside it is a POSIX shell script Windows cannot start.
pub(crate) fn npm_bin(platform: &str) -> &'static str {
    if win32(platform) { "npm.cmd" } else { "npm" }
}

/// The npm that owns `prefix` (its own, else the first on PATH, always aimed at that prefix).
pub(crate) fn npm_for(prefix: &str, tools: &PlanTools) -> Option<String> {
    let own = if win32(&tools.platform) {
        Path::new(prefix).join("npm.cmd")
    } else {
        Path::new(prefix).join("bin").join("npm")
    };
    if own.exists() {
        return Some(own.to_string_lossy().into_owned());
    }
    find_on_path(
        &[npm_bin(&tools.platform).to_owned()],
        &tools.path_env,
        &tools.platform,
        &[],
    )
}

fn bun_for(bun_root: &str, tools: &PlanTools) -> Option<String> {
    let bun = executable_name("bun", &tools.platform);
    let own = Path::new(bun_root).join("bin").join(&bun);
    if own.exists() {
        return Some(own.to_string_lossy().into_owned());
    }
    find_on_path(&[bun], &tools.path_env, &tools.platform, &[])
}

fn winget(tools: &PlanTools) -> Option<String> {
    find_on_path(
        &["winget.exe".to_owned()],
        &tools.path_env,
        &tools.platform,
        &[],
    )
}

/// `bun pm view <name> version`, the newest version on the registry Bun is configured with.
pub(crate) fn bun_view(bun: &str, name: &str) -> CliCommand {
    CliCommand {
        package_dir: true,
        ..command(bun, &strings(&["pm", "view", name, "version"]))
    }
}

fn text<'a>(owner: &'a Value, key: &str) -> &'a str {
    owner[key].as_str().unwrap_or_default()
}

fn with_env(mut command: CliCommand, name: &str, value: &str) -> CliCommand {
    command.env.insert(name.to_owned(), value.to_owned());
    command
}

/// The read-only check of a package manager's own install (brew, brew-cask, npm, bun, winget); none for any other
/// owner or when its manager is nowhere.
pub(crate) fn owner_check_command(owner: &Value, tools: &PlanTools) -> Option<CliCommand> {
    let name = text(owner, "name");
    match text(owner, "method") {
        "npm" => npm_for(text(owner, "prefix"), tools)
            .map(|npm| command(&npm, &strings(&["view", name, "version"]))),
        "bun" => {
            let root = text(owner, "bunRoot");
            bun_for(root, tools).map(|bun| with_env(bun_view(&bun, name), "BUN_INSTALL", root))
        }
        "brew" => Some(command(
            text(owner, "brew"),
            &strings(&["outdated", "--json=v2", name]),
        )),
        "brew-cask" => Some(command(
            text(owner, "brew"),
            &strings(&["outdated", "--json=v2", "--cask", name]),
        )),
        "winget" => winget(tools).map(|bin| {
            command(
                &bin,
                &strings(&[
                    "list",
                    "--id",
                    text(owner, "id"),
                    "-e",
                    "--upgrade-available",
                    "--accept-source-agreements",
                    "--disable-interactivity",
                ]),
            )
        }),
        _ => None,
    }
}

/// A package manager's own update of the install it owns (`latest` pins npm and Bun to it; none means `@latest`);
/// none for any other owner or when its manager is nowhere.
pub(crate) fn owner_update_command(
    owner: &Value,
    latest: Option<&str>,
    tools: &PlanTools,
) -> Option<CliCommand> {
    let name = text(owner, "name");
    let target = format!("{name}@{}", latest.unwrap_or("latest"));
    match text(owner, "method") {
        "npm" => {
            let prefix = text(owner, "prefix");
            npm_for(prefix, tools).map(|npm| {
                command(
                    &npm,
                    &strings(&["install", "-g", "--prefix", prefix, &target]),
                )
            })
        }
        "bun" => {
            let root = text(owner, "bunRoot");
            bun_for(root, tools).map(|bun| {
                with_env(
                    command(&bun, &strings(&["install", "-g", &target])),
                    "BUN_INSTALL",
                    root,
                )
            })
        }
        "brew" => Some(with_env(
            command(text(owner, "brew"), &strings(&["upgrade", name])),
            "HOMEBREW_NO_AUTO_UPDATE",
            "1",
        )),
        "brew-cask" => Some(with_env(
            command(text(owner, "brew"), &strings(&["upgrade", "--cask", name])),
            "HOMEBREW_NO_AUTO_UPDATE",
            "1",
        )),
        "winget" => winget(tools).map(|bin| {
            command(
                &bin,
                &strings(&[
                    "upgrade",
                    "--id",
                    text(owner, "id"),
                    "-e",
                    "--accept-source-agreements",
                    "--accept-package-agreements",
                    "--disable-interactivity",
                ]),
            )
        }),
        _ => None,
    }
}

/// Every `/\d+\.\d+\.\d+/g` match of `text`, in order.
fn versions(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let digits = |from: usize| {
        let mut end = from;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        end
    };
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        // A match that fails from the start of a run of digits fails from inside it too: the run is read greedily.
        if !bytes[at].is_ascii_digit() || (at > 0 && bytes[at - 1].is_ascii_digit()) {
            at += 1;
            continue;
        }
        let mut end = digits(at);
        let mut parts = 1;
        while parts < 3 && bytes.get(end) == Some(&b'.') && digits(end + 1) > end + 1 {
            end = digits(end + 1);
            parts += 1;
        }
        if parts == 3 {
            found.push(&text[at..end]);
            at = end;
        } else {
            at += 1;
        }
    }
    found
}

/// The first `x.y.z` in a tool's output (`/(\d+\.\d+\.\d+)/`).
pub(crate) fn parse_omp_version(output: &str) -> Option<String> {
    versions(output)
        .first()
        .map(|version| (*version).to_owned())
}

/// `latest` is newer than `installed`. An unknown installed version (none) counts as older than anything; versions
/// that cannot be ordered count as newer when they differ.
pub(crate) fn is_newer(latest: &str, installed: Option<&str>) -> bool {
    let Some(installed) = installed else {
        return true;
    };
    match compare_versions(latest, installed) {
        Some(order) => order.is_gt(),
        None => js_trim(latest) != js_trim(installed),
    }
}

/// The newest version in a check's output; `installed` when the owner lists nothing newer (Homebrew and winget list
/// only what is outdated). `Err` when the output says nothing usable.
pub(crate) fn parse_latest(
    owner: &Value,
    output: &str,
    installed: Option<&str>,
) -> Result<String, String> {
    match text(owner, "method") {
        method @ ("brew" | "brew-cask") => {
            let parsed: Value = serde_json::from_str(output).map_err(|error| error.to_string())?;
            let name = text(owner, "name");
            let key = if method == "brew" {
                "formulae"
            } else {
                "casks"
            };
            let entry = parsed[key]
                .as_array()
                .and_then(|list| list.iter().find(|item| item["name"] == name));
            let latest = match entry.map(|entry| &entry["current_version"]) {
                Some(Value::String(current)) => parse_omp_version(current),
                _ => installed.map(str::to_owned),
            };
            latest.ok_or_else(|| format!("brew outdated said nothing about {name}"))
        }
        "winget" => {
            let id = text(owner, "id");
            let line = output.split('\n').find(|line| line.contains(id));
            line.and_then(|line| versions(line).last().map(|v| (*v).to_owned()))
                .or_else(|| installed.map(str::to_owned))
                .ok_or_else(|| format!("winget said nothing about {id}"))
        }
        _ => parse_omp_version(output).ok_or_else(|| {
            js_trim(output)
                .split('\n')
                .next_back()
                .map(|line| line.strip_suffix('\r').unwrap_or(line))
                .filter(|line| !line.is_empty())
                .unwrap_or("no version in the registry's answer")
                .to_owned()
        }),
    }
}

/// The last line of `text` once trimmed (`.trim().split(/\r?\n/).at(-1)`).
fn last_line(text: &str) -> String {
    let line = js_trim(text).split('\n').next_back().unwrap_or_default();
    line.strip_suffix('\r').unwrap_or(line).to_owned()
}

/// `runCheckProcess`: stdout of a short read-only check run with `env` plus its own, or its own reason. `brew
/// outdated` exits 1 when it lists something, so any output is the answer whatever the exit.
pub(crate) async fn run_check(command: &CliCommand, env: &Env) -> Result<String, String> {
    let mut env = env.clone();
    env.extend(command.env.clone());
    let dir = if command.package_dir {
        let dir = tempfile::Builder::new()
            .prefix("ompdesk-cli-check-")
            .tempdir()
            .map_err(|error| error.to_string())?;
        std::fs::write(dir.path().join("package.json"), "{}\n")
            .map_err(|error| error.to_string())?;
        Some(dir)
    } else {
        None
    };
    let exited = exec(
        &command.spawn,
        &env,
        dir.as_ref().map(tempfile::TempDir::path),
        CHECK_TIMEOUT,
    )
    .await;
    drop(dir);
    match exited {
        Ok(exited) if exited.success || !js_trim(&exited.stdout).is_empty() => Ok(exited.stdout),
        Ok(exited) if !exited.stderr.is_empty() => Err(last_line(&exited.stderr)),
        Ok(_) => Err(last_line(&failed_message(&command.spawn))),
        Err(message) => Err(last_line(&message)),
    }
}

#[cfg(test)]
mod tests;
