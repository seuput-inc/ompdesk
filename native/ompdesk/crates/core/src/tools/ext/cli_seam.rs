//! Stand-in for `tools/spawn.rs` (T2.4 owns it): the spawn, PATH and package-manager pieces the extension updater
//! shares with the CLI updater and setup, under the names and signatures agreed with the integration owner. The
//! integration deletes this file and points `ext`'s imports at `super::spawn`.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use super::super::runner::SpawnSpec;
use crate::server::Fault;

pub type Env = BTreeMap<String, String>;

fn needs_shell(file: &str, platform: &str) -> bool {
    let lower = file.to_ascii_lowercase();
    platform == "win32" && (lower.ends_with(".cmd") || lower.ends_with(".bat"))
}

fn is_executable_file(file: &Path, platform: &str) -> bool {
    #[cfg(unix)]
    if platform != "win32" && !crate::sys::may_execute(file) {
        return false;
    }
    let _ = platform;
    match std::fs::metadata(file) {
        Ok(meta) => !meta.is_dir(),
        Err(_) => std::fs::symlink_metadata(file).is_ok(),
    }
}

pub fn find_on_path(
    names: &[String],
    path_env: &str,
    platform: &str,
    extra: &[String],
) -> Option<String> {
    let delimiter = if platform == "win32" || cfg!(windows) {
        ';'
    } else {
        ':'
    };
    path_env
        .split(delimiter)
        .filter(|dir| !dir.is_empty())
        .flat_map(|dir| {
            names
                .iter()
                .map(move |name| Path::new(dir).join(name).to_string_lossy().into_owned())
        })
        .chain(extra.iter().cloned())
        .find(|file| is_executable_file(Path::new(file), platform))
}

pub fn launcher_names(name: &str, platform: &str) -> Vec<String> {
    if platform == "win32" {
        vec![format!("{name}.exe"), format!("{name}.cmd")]
    } else {
        vec![name.to_owned()]
    }
}

pub fn executable_name(name: &str, platform: &str) -> String {
    if platform == "win32" {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

pub fn spawn_spec(file: &str, args: &[String], platform: &str) -> SpawnSpec {
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

pub fn brew_bin_dirs() -> Vec<String> {
    match std::env::var("OMP_GUI_TEST_BREW_DIRS") {
        Ok(dirs) => dirs
            .split(if cfg!(windows) { ';' } else { ':' })
            .filter(|dir| !dir.is_empty())
            .map(str::to_owned)
            .collect(),
        Err(_) => vec!["/opt/homebrew/bin".to_owned(), "/usr/local/bin".to_owned()],
    }
}

pub fn find_brew(path_env: &str, platform: &str) -> Option<String> {
    if platform == "win32" {
        return None;
    }
    let extra: Vec<String> = brew_bin_dirs()
        .iter()
        .map(|dir| Path::new(dir).join("brew").to_string_lossy().into_owned())
        .collect();
    find_on_path(&["brew".to_owned()], path_env, platform, &extra)
}

async fn output_of(
    spec: &SpawnSpec,
    env: &Env,
    cwd: Option<&Path>,
    timeout: Duration,
    keep_failed_stdout: bool,
) -> Result<String, String> {
    let mut command = tokio::process::Command::new(&spec.file);
    command
        .args(&spec.args)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| "timed out".to_owned())?
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() || (keep_failed_stdout && !stdout.trim().is_empty()) {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(stderr
        .trim()
        .lines()
        .last()
        .unwrap_or("the command failed")
        .to_owned())
}

pub async fn probe_output(
    bin: &str,
    args: &[String],
    env: &Env,
    platform: &str,
) -> Result<String, String> {
    output_of(
        &spawn_spec(bin, args, platform),
        env,
        None,
        Duration::from_secs(15),
        false,
    )
    .await
}

#[derive(Clone, Debug)]
pub struct InstallContext {
    pub platform: String,
    pub tools_dir: String,
    pub brew: Option<String>,
}

pub async fn read_install(
    _path: &str,
    _ctx: &InstallContext,
    _source: Value,
) -> Result<Value, Fault> {
    Err(Fault::new(
        "unported",
        "read_install is T2.4's (tools/spawn.rs)",
    ))
}

#[derive(Clone, Debug)]
pub struct PlanTools {
    pub platform: String,
    pub path_env: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CliCommand {
    pub spawn: SpawnSpec,
    pub env: Env,
    pub package_dir: bool,
}

pub fn command(file: &str, args: &[String]) -> CliCommand {
    let platform = if needs_shell(file, "win32") {
        "win32"
    } else {
        "darwin"
    };
    CliCommand {
        spawn: spawn_spec(file, args, platform),
        env: Env::new(),
        package_dir: false,
    }
}

pub fn npm_bin(platform: &str) -> &'static str {
    if platform == "win32" {
        "npm.cmd"
    } else {
        "npm"
    }
}

pub fn bun_view(bun: &str, name: &str) -> CliCommand {
    let args = ["pm", "view", name, "version"].map(str::to_owned);
    CliCommand {
        package_dir: true,
        ..command(bun, &args)
    }
}

fn text<'a>(owner: &'a Value, key: &str) -> &'a str {
    owner[key].as_str().unwrap_or_default()
}

fn npm_for(prefix: &str, tools: &PlanTools) -> Option<String> {
    let own = if tools.platform == "win32" {
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
    let name = executable_name("bun", &tools.platform);
    let own = Path::new(bun_root).join("bin").join(&name);
    if own.exists() {
        return Some(own.to_string_lossy().into_owned());
    }
    find_on_path(&[name], &tools.path_env, &tools.platform, &[])
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| (*arg).to_owned()).collect()
}

pub fn owner_check_command(owner: &Value, tools: &PlanTools) -> Option<CliCommand> {
    let name = text(owner, "name");
    match text(owner, "method") {
        "npm" => npm_for(text(owner, "prefix"), tools)
            .map(|npm| command(&npm, &args(&["view", name, "version"]))),
        "bun" => bun_for(text(owner, "bunRoot"), tools).map(|bun| {
            let mut view = bun_view(&bun, name);
            view.env
                .insert("BUN_INSTALL".to_owned(), text(owner, "bunRoot").to_owned());
            view
        }),
        "brew" => Some(command(
            text(owner, "brew"),
            &args(&["outdated", "--json=v2", name]),
        )),
        "brew-cask" => Some(command(
            text(owner, "brew"),
            &args(&["outdated", "--json=v2", "--cask", name]),
        )),
        _ => None,
    }
}

pub fn owner_update_command(
    owner: &Value,
    latest: Option<&str>,
    tools: &PlanTools,
) -> Option<CliCommand> {
    let name = text(owner, "name");
    let target = format!("{name}@{}", latest.unwrap_or("latest"));
    match text(owner, "method") {
        "npm" => {
            let prefix = text(owner, "prefix");
            npm_for(prefix, tools)
                .map(|npm| command(&npm, &args(&["install", "-g", "--prefix", prefix, &target])))
        }
        "bun" => bun_for(text(owner, "bunRoot"), tools).map(|bun| {
            let mut update = command(&bun, &args(&["install", "-g", &target]));
            update
                .env
                .insert("BUN_INSTALL".to_owned(), text(owner, "bunRoot").to_owned());
            update
        }),
        _ => None,
    }
}

pub fn parse_latest(
    owner: &Value,
    output: &str,
    installed: Option<&str>,
) -> Result<String, String> {
    match text(owner, "method") {
        "brew" | "brew-cask" => installed
            .map(str::to_owned)
            .ok_or_else(|| format!("brew outdated said nothing about {}", text(owner, "name"))),
        _ => parse_omp_version(output).ok_or_else(|| {
            output
                .trim()
                .lines()
                .last()
                .filter(|line| !line.is_empty())
                .unwrap_or("no version in the registry's answer")
                .to_owned()
        }),
    }
}

pub async fn run_check(cmd: &CliCommand, env: &Env) -> Result<String, String> {
    let dir = if cmd.package_dir {
        let dir = std::env::temp_dir().join(format!("ompdesk-cli-check-{}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        std::fs::write(dir.join("package.json"), "{}\n").map_err(|error| error.to_string())?;
        Some(dir)
    } else {
        None
    };
    let mut env = env.clone();
    env.extend(cmd.env.clone());
    let output = output_of(
        &cmd.spawn,
        &env,
        dir.as_deref(),
        Duration::from_secs(120),
        true,
    )
    .await;
    if let Some(dir) = dir {
        let _ = std::fs::remove_dir_all(dir);
    }
    output
}

/// `parse` of `src/shared/version.ts`: the dotted numbers and the prerelease parts.
fn parse(version: &str) -> Option<(Vec<f64>, Vec<&str>)> {
    let version = version.trim();
    let version = version.strip_prefix('v').unwrap_or(version);
    let version = version.split_once('+').map_or(version, |(core, _)| core);
    let (core, pre) = version
        .split_once('-')
        .map_or((version, None), |(core, pre)| (core, Some(pre)));
    let numbers: Option<Vec<f64>> = core
        .split('.')
        .map(|part| {
            (!part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
                .then(|| part.parse::<f64>().ok())
                .flatten()
        })
        .collect();
    let pre: Vec<&str> = match pre {
        Some(pre) if !pre.is_empty() => pre.split('.').collect(),
        Some(_) => return None,
        None => Vec::new(),
    };
    Some((numbers?, pre))
}

fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    let ((ac, ap), (bc, bp)) = (parse(a)?, parse(b)?);
    for i in 0..ac.len().max(bc.len()) {
        let (x, y) = (
            ac.get(i).copied().unwrap_or(0.0),
            bc.get(i).copied().unwrap_or(0.0),
        );
        if x != y {
            return x.partial_cmp(&y);
        }
    }
    if ap.is_empty() || bp.is_empty() {
        // A release outranks any prerelease of the same core.
        return Some(if ap.len() == bp.len() {
            Ordering::Equal
        } else if ap.is_empty() {
            Ordering::Greater
        } else {
            Ordering::Less
        });
    }
    for i in 0..ap.len().max(bp.len()) {
        let (Some(x), Some(y)) = (ap.get(i), bp.get(i)) else {
            return Some(if ap.len() < bp.len() {
                Ordering::Less
            } else {
                Ordering::Greater
            });
        };
        let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        let order = match (numeric(x), numeric(y)) {
            (true, true) => x
                .parse::<f64>()
                .ok()?
                .partial_cmp(&y.parse::<f64>().ok()?)?,
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => x.cmp(y),
        };
        if order != Ordering::Equal {
            return Some(order);
        }
    }
    Some(Ordering::Equal)
}

pub fn is_newer(latest: &str, installed: Option<&str>) -> bool {
    let Some(installed) = installed else {
        return true;
    };
    match compare_versions(latest, installed) {
        Some(order) => order == std::cmp::Ordering::Greater,
        None => latest.trim() != installed.trim(),
    }
}

pub fn parse_omp_version(output: &str) -> Option<String> {
    let bytes = output.as_bytes();
    (0..bytes.len()).find_map(|start| {
        let mut end = start;
        for part in 0..3 {
            let digits = bytes[end..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count();
            if digits == 0 {
                return None;
            }
            end += digits;
            if part < 2 {
                if bytes.get(end) != Some(&b'.') {
                    return None;
                }
                end += 1;
            }
        }
        Some(output[start..end].to_owned())
    })
}
