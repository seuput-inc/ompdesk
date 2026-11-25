//! An MCP server's binary and its package (was `ext-update/mcp-owner.ts` and `mcp-plans.ts`): the command resolved
//! on the spawn PATH, its launcher and ownership read by the core's install rules (`read_install`), the pip owner of a
//! python script found through its interpreter's entry points, and the check and update commands of each owner:
//! npm, Bun, Homebrew and winget through the CLI updater's own builders, pipx, `uv tool` and pip here, and the
//! registry lookup of a pinned runner package (`npx pkg@1.2.3`). Every command asks the owner or the user's own
//! configured registry or index; the update runs that owner's own command for the install it found, never with sudo.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::super::spawn::{
    CliCommand, Env, InstallContext, PlanTools, brew_bin_dirs, bun_view, command, executable_name,
    find_on_path, launcher_names, npm_bin, off_hub, owner_check_command, owner_update_command,
    parse_latest, probe_output, read_install,
};
use crate::server::Fault;

/// `McpBinary`: a direct command's binary as found.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct McpBinary {
    /// The command as configured.
    pub command: String,
    /// Where it was found.
    pub path: String,
    /// Symlinks resolved.
    pub real: String,
    /// `McpOwner`: a `CliOwner` package manager, a venv (`pipx`, `uv`) or `{method: "pip", name, python}`.
    pub owner: Option<Value>,
    pub skip: Option<String>,
    pub installed: Option<String>,
    /// A script (shebang, `.cmd`, `.js`) an interpreter loads lazily, as opposed to a native binary.
    pub script: bool,
}

/// `OwnerDeps`: the spawn PATH, the install context and the environment a probe runs with.
pub struct OwnerDeps {
    pub path_env: String,
    pub ctx: InstallContext,
    pub env: Env,
}

/// A runner package (`McpClass` of kind `runner`), as far as a check reads it.
#[derive(Clone, Debug, Deserialize)]
pub struct RunnerPackage {
    pub runner: String,
    pub ecosystem: String,
    pub pkg: String,
    pub checkable: bool,
}

fn has_separator(command: &str) -> bool {
    command.contains(['/', '\\'])
}

/// Plain-file executable lookup: a path is used as it is, a bare name is looked up along PATH (and Homebrew's
/// prefixes).
pub fn resolve_command(command: &str, path_env: &str, ctx: &InstallContext) -> Option<String> {
    if has_separator(command) {
        return Path::new(command).exists().then(|| command.to_owned());
    }
    let win = ctx.platform == "win32";
    let lower = command.to_ascii_lowercase();
    let names = if win && (lower.ends_with(".exe") || lower.ends_with(".cmd")) {
        vec![command.to_owned()]
    } else {
        launcher_names(command, &ctx.platform)
    };
    let extra: Vec<String> = if win {
        Vec::new()
    } else {
        brew_bin_dirs()
            .iter()
            .flat_map(|dir| {
                names
                    .iter()
                    .map(move |name| Path::new(dir).join(name).to_string_lossy().into_owned())
            })
            .collect()
    };
    find_on_path(&names, path_env, &ctx.platform, &extra)
}

const DIST_SNIPPET: &str = concat!(
    "import sys, importlib.metadata as m\n",
    "for d in m.distributions():\n",
    " for e in (d.entry_points or ()):\n",
    "  if e.group == 'console_scripts' and e.name == sys.argv[1]:\n",
    "   print(d.metadata['Name']); raise SystemExit(0)\n",
    "raise SystemExit(1)",
);

const VERSION_SNIPPET: &str = "import sys, importlib.metadata as m; print(m.version(sys.argv[1]))";

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

async fn probe(deps: &OwnerDeps, bin: &str, args: &[&str]) -> Option<String> {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    probe_output(bin, &args, &deps.env, &deps.ctx.platform)
        .await
        .ok()
        .map(|output| output.trim().to_owned())
}

/// Finds `command`, follows its links, owns it (`detectMcpBinary`). None when nothing on PATH (or at that path)
/// runs; a fault when the install rules gave no answer, so an owned server is never listed as "unknown install".
pub async fn detect(command: String, deps: &OwnerDeps) -> Result<Option<McpBinary>, Fault> {
    let found = {
        let (command, path_env, ctx) = (command.clone(), deps.path_env.clone(), deps.ctx.clone());
        off_hub(move || resolve_command(&command, &path_env, &ctx)).await
    };
    let Some(path) = found else {
        return Ok(None);
    };
    let facts = read_install(&path, &deps.ctx, json!({"kind": "mcp", "command": command})).await?;
    let real = text(&facts["real"]).unwrap_or_default();
    let mcp = &facts["mcp"];
    let mut owner = Some(facts["owner"].clone()).filter(|owner| !owner.is_null());
    let mut skip = text(&facts["skip"]);
    let script = mcp["script"].as_bool().unwrap_or(true);
    if owner.is_none()
        && skip.as_deref() == Some("unknown-install")
        && script
        && let Some(named) = mcp["python"].as_str()
    {
        // `#!/usr/bin/env python3` is looked up along PATH.
        let python = if has_separator(named) {
            Some(named.to_owned())
        } else {
            let (named, path_env, platform) = (
                named.to_owned(),
                deps.path_env.clone(),
                deps.ctx.platform.clone(),
            );
            off_hub(move || find_on_path(&[named], &path_env, &platform, &[])).await
        };
        if let Some(python) = python {
            let name = mcp["name"].as_str().unwrap_or_default();
            let dist = probe(deps, &python, &["-c", DIST_SNIPPET, name])
                .await
                .unwrap_or_default();
            if !dist.is_empty() {
                owner = Some(json!({"method": "pip", "name": dist, "python": python}));
                skip = None;
            }
        }
    }
    let mut installed = text(&facts["installed"]);
    match owner.as_ref().map(|owner| owner["method"].as_str()) {
        Some(Some("pip")) => {
            let pip = owner.clone().unwrap_or_default();
            let (python, name) = (
                pip["python"].as_str().unwrap_or_default(),
                pip["name"].as_str().unwrap_or_default(),
            );
            // Checked after the entry-point probe, not against a directory observed before python ran.
            let dir = Path::new(&real)
                .parent()
                .unwrap_or(Path::new(""))
                .to_owned();
            if !off_hub(move || crate::ext::install::may_write(&dir)).await {
                owner = None;
                skip = Some("not-writable".to_owned());
            }
            installed = probe(deps, python, &["-c", VERSION_SNIPPET, name])
                .await
                .filter(|version| !version.is_empty());
        }
        Some(_) if facts["writable"] != true => {
            owner = None;
            skip = Some("not-writable".to_owned());
        }
        _ => {}
    }
    Ok(Some(McpBinary {
        command,
        path,
        real,
        owner,
        skip,
        installed,
        script,
    }))
}

fn method(owner: &Value) -> &str {
    owner["method"].as_str().unwrap_or_default()
}

fn field<'a>(owner: &'a Value, key: &str) -> &'a str {
    owner[key].as_str().unwrap_or_default()
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

fn pip_index(python: &str, name: &str) -> CliCommand {
    command(python, &strings(&["-m", "pip", "index", "versions", name]))
}

/// The read-only check that prints the newest version (`mcpOwnerCheck`). None when only the owner's own idempotent
/// upgrade can tell (`uv tool upgrade`): the updater runs it and compares the installed version before and after.
pub fn owner_check(owner: &Value, tools: &PlanTools) -> Option<CliCommand> {
    match method(owner) {
        "pipx" => {
            // A pipx venv carries its own pip; `pip index versions` reads the user's index configuration.
            let python = Path::new(field(owner, "venv"))
                .join(if tools.platform == "win32" {
                    "Scripts"
                } else {
                    "bin"
                })
                .join(executable_name("python", &tools.platform));
            python
                .exists()
                .then(|| pip_index(&python.to_string_lossy(), field(owner, "name")))
        }
        "uv" => None,
        "pip" => Some(pip_index(field(owner, "python"), field(owner, "name"))),
        _ => owner_check_command(owner, tools),
    }
}

fn on_path(name: &str, tools: &PlanTools) -> Option<String> {
    find_on_path(
        &[executable_name(name, &tools.platform)],
        &tools.path_env,
        &tools.platform,
        &[],
    )
}

/// The update of the install the binary came from (`mcpOwnerUpdate`).
pub fn owner_update(owner: &Value, latest: Option<&str>, tools: &PlanTools) -> Option<CliCommand> {
    let name = field(owner, "name");
    match method(owner) {
        "pipx" => on_path("pipx", tools).map(|pipx| command(&pipx, &strings(&["upgrade", name]))),
        "uv" => on_path("uv", tools).map(|uv| command(&uv, &strings(&["tool", "upgrade", name]))),
        "pip" => Some(command(
            field(owner, "python"),
            &strings(&["-m", "pip", "install", "--upgrade", name]),
        )),
        _ => owner_update_command(owner, latest, tools),
    }
}

/// The registry lookup of a pinned runner package (`runnerCheck`): npm's `npm view` (Bun's `bun pm view` for
/// `bunx`/`bun x`, each falling back to the other), PyPI's through the first python's `pip index versions`. None
/// when no tool to ask is installed or the spec is a URL or path: the row then stays pinned with no latest.
pub fn runner_check(runner: &RunnerPackage, tools: &PlanTools) -> Option<CliCommand> {
    if !runner.checkable {
        return None;
    }
    if runner.ecosystem == "pypi" {
        let names = if tools.platform == "win32" {
            strings(&["python.exe"])
        } else {
            strings(&["python3", "python"])
        };
        return find_on_path(&names, &tools.path_env, &tools.platform, &[])
            .map(|python| pip_index(&python, &runner.pkg));
    }
    let npm = find_on_path(
        &[npm_bin(&tools.platform).to_owned()],
        &tools.path_env,
        &tools.platform,
        &[],
    );
    let via_npm = npm.map(|npm| command(&npm, &strings(&["view", &runner.pkg, "version"])));
    let via_bun = on_path("bun", tools).map(|bun| bun_view(&bun, &runner.pkg));
    if runner.runner == "bunx" || runner.runner == "bun-x" {
        via_bun.or(via_npm)
    } else {
        via_npm.or(via_bun)
    }
}

fn pip_latest(output: &str) -> Result<String, String> {
    crate::ext::latest::pip(output)
        .map(str::to_owned)
        .map_err(|fault| fault.message)
}

/// The newest version in an owner check's output (`parseMcpOwnerLatest`).
pub fn owner_latest(
    owner: &Value,
    output: &str,
    installed: Option<&str>,
) -> Result<String, String> {
    match method(owner) {
        "pipx" | "pip" => pip_latest(output),
        "uv" => Err("uv has no read-only check".to_owned()),
        _ => parse_latest(owner, output, installed),
    }
}

/// The newest version in a runner package's registry lookup (`parseRunnerLatest`).
pub fn runner_latest(runner: &RunnerPackage, output: &str) -> Result<String, String> {
    if runner.ecosystem == "pypi" {
        pip_latest(output)
    } else {
        crate::ext::latest::registry(output)
            .map(str::to_owned)
            .map_err(|fault| fault.message)
    }
}
