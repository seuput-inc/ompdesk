//! Where an installed vendor CLI lives and what owns it (`cli-tools/detect.ts`). The executable is found along the
//! spawn PATH (the login shell's, like every tool OMPdesk runs) and followed through its links and shims; the resolved
//! path says which package manager put it there (`ext.binaryFacts`), so a tool is updated only through the install the
//! user's own shell runs.

use std::path::Path;

use serde_json::{Value, json};

use super::Detection;
use super::catalog::spec;
use crate::hub::LocalFuture;
use crate::tools::setup::{managed_bin_dirs, pick_copy};
use crate::tools::spawn::{
    Env, InstallContext, find_on_path, is_newer, launcher_names, parse_omp_version, read_install,
};

/// `AGENT_DESKTOP_MIN_VERSION` of `setup/archives.ts`: the first release with `agent-desktop mcp`.
const AGENT_DESKTOP_MIN_VERSION: &str = "1.2.0";

/// What one detection runs with.
#[derive(Clone)]
pub struct DetectDeps {
    pub path_env: String,
    pub env: Env,
    pub ctx: InstallContext,
    /// The agent-desktop the app ships.
    pub agent_desktop_bundle: Option<String>,
    /// Homebrew's bin dirs (`brewBinDirs`), looked in even when the PATH omits them.
    pub brew_dirs: Vec<String>,
}

/// `<bin> <args>` stdout, or its reason (`probeOutput`; tests answer it themselves).
pub type Probe<'a> = &'a dyn Fn(&str, &[String]) -> LocalFuture<Result<String, String>>;

/// `gh extension list`: the gh-copilot line's version (`v1.0.5` → `1.0.5`, none when it has none); `None` when the
/// extension is absent.
pub fn gh_copilot_version(list: &str) -> Option<Option<String>> {
    const NAME: &str = "github/gh-copilot";
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    list.split('\n')
        .find(|line| {
            line.match_indices(NAME)
                .any(|(at, _)| !line[at + NAME.len()..].starts_with(word))
        })
        .map(parse_omp_version)
}

fn text(facts: &Value, key: &str) -> Option<String> {
    facts[key].as_str().map(str::to_owned)
}

fn owner(facts: &Value) -> Option<Value> {
    Some(facts["owner"].clone()).filter(|owner| !owner.is_null())
}

/// Find and classify `id`; none when it is not installed (OMPdesk never installs a vendor CLI) or cannot be read.
/// agent-desktop also counts when only the app's own copy is, or the managed copy is older: it is machine setup's to
/// update, and an update installs the newer release into the managed tools dir, which sessions run from their next
/// start (`pickAgentDesktop`).
pub async fn detect_cli_tool(
    id: &'static str,
    deps: &DetectDeps,
    probe: Probe<'_>,
) -> Option<Detection> {
    let found = detect_installed(id, deps, probe).await;
    let bundled = match (&deps.agent_desktop_bundle, id) {
        (Some(bundle), "agent-desktop") => {
            let win32 = deps.ctx.platform == "win32";
            pick_copy(
                win32,
                Some(Path::new(bundle)),
                None,
                AGENT_DESKTOP_MIN_VERSION,
            )
            .await
        }
        _ => None,
    };
    let Some((path, version)) = bundled else {
        return found;
    };
    if let Some(installed) = found.as_ref().and_then(|found| found.installed.as_deref())
        && !is_newer(&version, Some(installed))
    {
        return found;
    }
    let facts = read_install(&path, &deps.ctx, json!({"kind": "bundle"}))
        .await
        .ok()?;
    let skip = (facts["writable"] != true).then(|| "not-writable".to_owned());
    Some(Detection {
        id,
        real: path.clone(),
        path,
        owner: if skip.is_some() { None } else { owner(&facts) },
        skip,
        installed: Some(version),
    })
}

async fn detect_installed(
    id: &'static str,
    deps: &DetectDeps,
    probe: Probe<'_>,
) -> Option<Detection> {
    let spec = spec(id);
    let ctx = &deps.ctx;
    let win = ctx.platform == "win32";
    // Never the bare name on Windows: npm writes one beside its `.cmd` for POSIX shells, which Windows cannot start.
    let names = launcher_names(spec.bin, &ctx.platform);
    // A managed-only tool is the copy in the managed tools dir: looked up there first, so one the user put earlier on
    // PATH (npm, Homebrew) never hides it. Others are found along the spawn PATH.
    let lookup = if spec.managed_only {
        let mut dirs = managed_bin_dirs(&ctx.tools_dir, &ctx.platform);
        dirs.push(deps.path_env.clone());
        dirs.join(if win { ";" } else { ":" })
    } else {
        deps.path_env.clone()
    };
    // Homebrew's prefixes count even when the login shell's PATH omits them.
    let extra: Vec<String> = if win {
        Vec::new()
    } else {
        deps.brew_dirs
            .iter()
            .flat_map(|dir| {
                names
                    .iter()
                    .map(|name| Path::new(dir).join(name).to_string_lossy().into_owned())
            })
            .collect()
    };
    let path = find_on_path(&names, &lookup, &ctx.platform, &extra)?;
    let source = if id == "gh-copilot" {
        json!({"kind": "ghExtension"})
    } else {
        json!({"kind": "cli", "spec": {
            "self": spec.update.is_some(),
            "managed": spec.managed,
            "managedOnly": spec.managed_only,
            "winget": spec.winget,
        }})
    };
    let facts = read_install(&path, ctx, source).await.ok()?;
    let real = text(&facts, "real").unwrap_or_else(|| path.clone());
    let skip = text(&facts, "skip");
    let found_owner = owner(&facts);
    if id == "gh-copilot" {
        // The extension lives in gh's own data dir, which is the user's; gh itself upgrades it.
        let list = probe(&path, &["extension".to_owned(), "list".to_owned()])
            .await
            .unwrap_or_default();
        let installed = gh_copilot_version(&list)?;
        return Some(Detection {
            id,
            path,
            real,
            owner: found_owner,
            skip,
            installed,
        });
    }
    if skip.as_deref() == Some("unknown-install") && spec.managed_only {
        return None;
    }
    let refused = if found_owner.is_some() && facts["writable"] != true {
        Some("not-writable".to_owned())
    } else {
        skip
    };
    let installed = match text(&facts, "installed") {
        Some(installed) => Some(installed),
        None => probe(&path, &["--version".to_owned()])
            .await
            .ok()
            .and_then(|output| parse_omp_version(&output)),
    };
    Some(Detection {
        id,
        path,
        real,
        owner: if refused.is_some() { None } else { found_owner },
        skip: refused,
        installed,
    })
}
