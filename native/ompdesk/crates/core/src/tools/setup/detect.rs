//! What this machine has (was `src/main/setup/detect.ts`): Bun, omp (through main's own resolution and version gate),
//! Git, the GitHub CLI, Node.js, agent-desktop and Tailscale, plus the package managers setup may use (Homebrew,
//! winget). Every lookup runs along the PATH main's spawns get (the login shell's).

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::rc::Rc;

use serde_json::{Value, json};

use super::paths::{
    dirname, find_git_bash, host_join, managed_agent_desktop, omp_bun_minimum, omp_package_root,
};
use super::{ITEMS, Presence, exec, git_aslr};
use crate::server::Scope;
use crate::tools::Tools;
use crate::tools::spawn::{
    brew_bin_dirs, executable_name, find_on_path, is_newer, off_hub, off_hub_async,
};

/// `AGENT_DESKTOP_MIN_VERSION`: no `agent-desktop mcp` before it.
pub const AGENT_DESKTOP_MIN_VERSION: &str = "1.2.0";

/// What detection found (`Detection`), and the PATH it looked along.
#[derive(Clone, Debug, Default)]
pub struct Detection {
    pub presence: HashMap<&'static str, Presence>,
    pub bun: Option<String>,
    pub omp: Option<String>,
    pub brew: Option<String>,
    pub winget: Option<String>,
    pub path_env: String,
}

impl Detection {
    pub fn presence(&self, id: &str) -> Presence {
        self.presence.get(id).cloned().unwrap_or(Presence::Missing)
    }
}

/// `bunForOmp`: a Bun below the omp package's `engines.bun` is `outdated`, so setup upgrades it before omp.
pub fn bun_for_omp(found: Presence, minimum: Option<&str>) -> Presence {
    match (&found, minimum) {
        (
            Presence::Present {
                version: Some(version),
                path,
                ..
            },
            Some(minimum),
        ) if is_newer(minimum, Some(version)) => Presence::Outdated {
            version: version.clone(),
            minimum: minimum.to_owned(),
            path: path.clone(),
        },
        _ => found,
    }
}

/// `gitShellProblem`: the sh probe's outcome as a problem, or none when sh started its child. 0xC0000142 is Mandatory
/// ASLR's signature.
pub fn git_shell_problem(code: Option<i32>, output: &str) -> Option<Value> {
    if code == Some(0) {
        return None;
    }
    if output.to_lowercase().contains("0xc0000142") {
        return Some(json!({"kind": "mandatory-aslr"}));
    }
    let last = crate::fs::order::js_trim(output)
        .rsplit('\n')
        .next()
        .filter(|line| !line.is_empty())
        .map(str::to_owned);
    let detail = last.unwrap_or_else(|| match code {
        Some(code) => format!("exit {code}"),
        None => "exit null".to_owned(),
    });
    Some(json!({"kind": "spawn-failed", "detail": detail}))
}

/// `probeGitShell`: `<root>\usr\bin\sh.exe -c "/usr/bin/true; exit"`, two commands, so sh must fork a child.
async fn probe_git_shell(root: &str, env: &BTreeMap<String, String>) -> Option<Value> {
    let sh = host_join(&[root, "usr", "bin", "sh.exe"]);
    let args = ["-c".to_owned(), "/usr/bin/true; exit".to_owned()];
    let ran = exec(&sh, &args, false, env, 30_000).await;
    let output = format!("{}{}", ran.stdout, ran.stderr);
    let output = if output.is_empty() {
        ran.error.clone().unwrap_or_default()
    } else {
        output
    };
    git_shell_problem(ran.code, &output)
}

/// `readGitAslrOverride`: the override's state from the registry (no elevation needed to read).
async fn read_git_aslr_override(root: &str, env: &BTreeMap<String, String>) -> bool {
    const IFEO: &str =
        r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\sh.exe";
    let args = ["query".to_owned(), IFEO.to_owned(), "/s".to_owned()];
    let ran = exec("reg.exe", &args, false, env, 15_000).await;
    ran.code == Some(0) && git_aslr::overridden(&ran.stdout, root)
}

/// `versionOf`: `setup.toolVersion` of `bin`, as a presence at `bin`.
async fn version_of(bin: &str, env: &BTreeMap<String, String>) -> Presence {
    let cwd = std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_owned());
    let (file, probe_env) = (bin.to_owned(), env.clone());
    let found = off_hub_async(move || async move {
        crate::setup::runtime::tool_version_of(&file, &cwd, &probe_env, &Scope::detached()).await
    })
    .await;
    match found {
        Ok(found) if found["kind"] == "present" => Presence::Present {
            version: found["version"].as_str().map(str::to_owned),
            path: Some(bin.to_owned()),
            git_shell: None,
            git_aslr_override: None,
            git_aslr_undoable: None,
        },
        Ok(found) => Presence::Broken {
            detail: found["detail"].as_str().unwrap_or_default().to_owned(),
            path: Some(bin.to_owned()),
        },
        Err(fault) => Presence::Broken {
            detail: fault.message,
            path: Some(bin.to_owned()),
        },
    }
}

/// omp as setup sees it (`OmpDetection`), from main's resolution (`OmpResolution`).
pub struct Omp {
    presence: Presence,
    bin: Option<String>,
    bun_minimum: Option<String>,
    bun: Option<(String, String)>,
}

/// `detectOmp`: main's resolution of omp; the first detection of a launch shares the one main's first tab used, later
/// ones (after an install or an update) resolve again.
async fn detect_omp(tools: &Rc<Tools>) -> Omp {
    let fresh = std::mem::replace(&mut tools.setup.borrow_mut().launch_resolution_used, true);
    let resolution = tools
        .ask("ompResolution", json!({"fresh": fresh}))
        .await
        .unwrap_or(Value::Null);
    off_hub(move || omp_of(&resolution)).await
}

/// `detectOmp`'s reading of one `OmpResolution`.
pub fn omp_of(resolution: &Value) -> Omp {
    let text = |value: &Value| value.as_str().map(str::to_owned);
    let minimum_of = |bin: &Value| {
        bin.as_str()
            .and_then(omp_package_root)
            .and_then(|root| omp_bun_minimum(Some(&root)))
    };
    if resolution["ok"] == true {
        let runtime = &resolution["runtime"];
        return Omp {
            presence: Presence::Present {
                version: text(&runtime["version"]),
                path: text(&runtime["bin"]),
                git_shell: None,
                git_aslr_override: None,
                git_aslr_undoable: None,
            },
            bin: text(&runtime["bin"]),
            bun_minimum: minimum_of(&runtime["bin"]),
            bun: None,
        };
    }
    let reason = &resolution["reason"];
    let bin = &reason["bin"];
    match reason["kind"].as_str() {
        Some("too-old") => Omp {
            presence: Presence::Outdated {
                version: text(&reason["version"]).unwrap_or_default(),
                minimum: text(&reason["minimum"]).unwrap_or_default(),
                path: text(bin),
            },
            bin: text(bin),
            bun_minimum: minimum_of(bin),
            bun: None,
        },
        Some("cannot-run") => Omp {
            presence: Presence::Broken {
                detail: text(&reason["detail"]).unwrap_or_default(),
                path: text(bin),
            },
            bin: None,
            bun_minimum: minimum_of(bin),
            bun: None,
        },
        Some("compiled") => Omp {
            presence: Presence::Broken {
                detail: "a compiled omp, not the package OMPdesk runs".to_owned(),
                path: text(bin),
            },
            bin: None,
            bun_minimum: minimum_of(bin),
            bun: None,
        },
        Some("bun-too-old") => Omp {
            presence: Presence::Broken {
                detail: format!(
                    "needs Bun {} or newer, found {}",
                    reason["minimum"].as_str().unwrap_or_default(),
                    reason["bunVersion"].as_str().unwrap_or_default()
                ),
                path: text(bin),
            },
            bin: None,
            bun_minimum: text(&reason["minimum"]),
            bun: Some((
                text(&reason["bun"]).unwrap_or_default(),
                text(&reason["bunVersion"]).unwrap_or_default(),
            )),
        },
        _ => Omp {
            presence: Presence::Missing,
            bin: None,
            bun_minimum: None,
            bun: None,
        },
    }
}

fn present_at(path: &str) -> Presence {
    Presence::Present {
        version: None,
        path: Some(path.to_owned()),
        git_shell: None,
        git_aslr_override: None,
        git_aslr_undoable: None,
    }
}

/// `detectGit`.
async fn detect_git(
    tools: &Tools,
    platform: &str,
    path_env: &str,
    env: &BTreeMap<String, String>,
) -> Presence {
    if platform == "win32" {
        let (path_env, env_vars) = (path_env.to_owned(), env.clone());
        let found = off_hub(move || {
            let lookup = |name: &str| {
                if name == "PATH" {
                    return Some(path_env.clone());
                }
                env_vars
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case(name))
                    .map(|(_, value)| value.clone())
            };
            let bash = find_git_bash(&lookup, &|file| Path::new(file).exists())?;
            let root = dirname(true, &dirname(true, &bash));
            let git = host_join(&[&root, "cmd", "git.exe"]);
            let has_sh = Path::new(&host_join(&[&root, "usr", "bin", "sh.exe"])).exists();
            let has_git = Path::new(&git).exists();
            Some((root, git, has_sh, has_git))
        })
        .await;
        let Some((root, git, has_sh, has_git)) = found else {
            return Presence::Missing;
        };
        let found = async {
            if has_git {
                version_of(&git, env).await
            } else {
                present_at(&root)
            }
        };
        let shell = async {
            if has_sh {
                probe_git_shell(&root, env).await
            } else {
                None
            }
        };
        let overridden = async { has_sh && read_git_aslr_override(&root, env).await };
        let (found, git_shell, overridden) = tokio::join!(found, shell, overridden);
        let Presence::Present { version, .. } = found else {
            return found;
        };
        if let Some(problem) = &git_shell {
            let mut details = json!({"level": "warn", "root": root});
            if let (Some(details), Some(problem)) = (details.as_object_mut(), problem.as_object()) {
                details.extend(problem.clone());
            }
            tools.log("setup", "Git's sh cannot start a child process", details);
        }
        return Presence::Present {
            version,
            path: Some(root),
            git_shell,
            git_aslr_override: overridden.then_some(true),
            git_aslr_undoable: None,
        };
    }
    // /usr/bin/git is a stub until the Command Line Tools exist; running it then opens Apple's install dialog.
    let names = ["git".to_owned()];
    let separator = if cfg!(windows) { ";" } else { ":" };
    let path_env = path_env
        .split(separator)
        .filter(|dir| Path::new(dir) != Path::new("/usr/bin"))
        .collect::<Vec<_>>()
        .join(separator);
    let lookup_platform = platform.to_owned();
    if let Some(git) = off_hub(move || find_on_path(&names, &path_env, &lookup_platform, &[])).await
    {
        return version_of(&git, env).await;
    }
    if platform != "darwin" {
        return Presence::Missing;
    }
    let cwd = std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_owned());
    let probe_env = env.clone();
    let selected = off_hub_async(move || async move {
        crate::setup::developer_dir(&cwd, probe_env, 15_000, Scope::detached()).await
    })
    .await;
    match selected {
        Ok(Some(_)) => version_of("/usr/bin/git", env).await,
        _ => Presence::Missing,
    }
}

/// `detectAgentDesktop`: the managed copy, or the bundle the app ships while it is the one a session would run.
pub async fn detect_agent_desktop(
    platform: &str,
    tools_dir: &str,
    env: &BTreeMap<String, String>,
    bundle: Option<&str>,
) -> Presence {
    if platform == "other" {
        return Presence::Missing;
    }
    let win = platform == "win32";
    let exe = managed_agent_desktop(win, tools_dir);
    let mut managed = Presence::Missing;
    let file = exe.clone();
    if off_hub(move || Path::new(&file).exists()).await {
        managed = match version_of(&exe, env).await {
            broken @ Presence::Broken { .. } => broken,
            Presence::Present { version: None, .. } => Presence::Broken {
                detail: "agent-desktop printed no version".to_owned(),
                path: Some(exe.clone()),
            },
            Presence::Present {
                version: Some(version),
                ..
            } if is_newer(AGENT_DESKTOP_MIN_VERSION, Some(&version)) => Presence::Outdated {
                version,
                minimum: AGENT_DESKTOP_MIN_VERSION.to_owned(),
                path: Some(exe.clone()),
            },
            found => found,
        };
    }
    let known = match &managed {
        Presence::Present {
            version: Some(version),
            ..
        } => Some((exe.clone(), version.clone())),
        _ => None,
    };
    let copy = crate::setup::desktop::pick_copy(
        win,
        bundle.map(Path::new),
        known,
        AGENT_DESKTOP_MIN_VERSION,
    )
    .await;
    match copy {
        Some((path, version)) => Presence::Present {
            version: Some(version),
            path: Some(path),
            git_shell: None,
            git_aslr_override: None,
            git_aslr_undoable: None,
        },
        None => managed,
    }
}

/// `detectTailscale`: installed when its CLI is found where Mobile web looks for it.
async fn detect_tailscale(
    platform: &str,
    path_env: &str,
    env: &BTreeMap<String, String>,
) -> Presence {
    let (platform, path_env, env) = (platform.to_owned(), path_env.to_owned(), env.clone());
    let found = off_hub_async(move || async move {
        crate::tailscale::setup_install(&platform, &path_env, &env).await
    })
    .await;
    match found {
        Some((path, version)) => Presence::Present {
            version,
            path: Some(path),
            git_shell: None,
            git_aslr_override: None,
            git_aslr_undoable: None,
        },
        None => Presence::Missing,
    }
}

/// `detectMachine`: every setup item, with main's spawn environment (`env` ask) and its PATH.
pub async fn machine(tools: &Rc<Tools>) -> Detection {
    let opts = &tools.opts;
    let platform = opts.platform.as_str();
    let win = platform == "win32";
    // `detectMachine` read main's own `process.env` with the spawn PATH, not the spawn environment: a test that hides
    // the machine's Git for Windows hides it from detection while its installers still get the real Program Files.
    let mut env: BTreeMap<String, String> = tools
        .ask("env", json!({ "detect": true }))
        .await
        .ok()
        .and_then(|env| serde_json::from_value(env).ok())
        .unwrap_or_default();
    let path_key = |key: &String| {
        if cfg!(windows) {
            key.eq_ignore_ascii_case("PATH")
        } else {
            key == "PATH"
        }
    };
    let path_env = env
        .get("PATH")
        .or_else(|| {
            env.iter()
                .find(|(key, _)| path_key(key))
                .map(|(_, value)| value)
        })
        .cloned()
        .unwrap_or_default();
    env.retain(|key, _| !path_key(key));
    env.insert("PATH".to_owned(), path_env.clone());
    let apps: Vec<String> = env
        .iter()
        .find(|(key, value)| key.eq_ignore_ascii_case("LOCALAPPDATA") && !value.is_empty())
        .map(|(_, local)| host_join(&[local, "Microsoft", "WindowsApps", "winget.exe"]))
        .into_iter()
        .collect();
    // Homebrew's gh is the user's even when the login shell's PATH omits Homebrew's bin dir.
    let brew_gh: Vec<String> = if win {
        Vec::new()
    } else {
        brew_bin_dirs()
            .iter()
            .map(|dir| host_join(&[dir, "gh"]))
            .collect()
    };
    let own_bun = host_join(&[&opts.bun_install, "bin", &executable_name("bun", platform)]);
    let (lookup_path, lookup_platform) = (path_env.clone(), platform.to_owned());
    let (bun, brew, winget, gh, node) = off_hub(move || {
        let (path_env, platform) = (lookup_path.as_str(), lookup_platform.as_str());
        let exe = |name: &str| vec![executable_name(name, platform)];
        let bun = find_on_path(&exe("bun"), path_env, platform, &[own_bun]);
        let brew = if win {
            None
        } else {
            find_on_path(
                &["brew".to_owned()],
                path_env,
                platform,
                &[
                    "/opt/homebrew/bin/brew".to_owned(),
                    "/usr/local/bin/brew".to_owned(),
                ],
            )
        };
        let winget = if win {
            find_on_path(&["winget.exe".to_owned()], path_env, platform, &apps)
        } else {
            None
        };
        let gh = find_on_path(&exe("gh"), path_env, platform, &brew_gh);
        let node = find_on_path(&exe("node"), path_env, platform, &[]);
        (bun, brew, winget, gh, node)
    })
    .await;
    let found = |bin: Option<String>| {
        let env = &env;
        async move {
            match bin {
                Some(bin) => version_of(&bin, env).await,
                None => Presence::Missing,
            }
        }
    };
    let (found_bun, omp, git, gh_presence, node_presence, agent_desktop, tailscale) = tokio::join!(
        found(bun.clone()),
        detect_omp(tools),
        detect_git(tools, platform, &path_env, &env),
        found(gh),
        found(node),
        detect_agent_desktop(
            platform,
            &opts.tools_dir,
            &env,
            opts.agent_desktop_bundle.as_deref()
        ),
        detect_tailscale(platform, &path_env, &env),
    );
    // The Bun omp runs on, when omp's resolution found that one too old: the Bun `bun upgrade` must reach.
    let bun_path = omp.bun.as_ref().map(|(path, _)| path.clone()).or(bun);
    let bun_presence = bun_for_omp(
        match &omp.bun {
            Some((path, version)) => Presence::Present {
                version: Some(version.clone()),
                path: Some(path.clone()),
                git_shell: None,
                git_aslr_override: None,
                git_aslr_undoable: None,
            },
            None => found_bun,
        },
        omp.bun_minimum.as_deref(),
    );
    let usable_bun = matches!(
        bun_presence,
        Presence::Present { .. } | Presence::Outdated { .. }
    );
    let presence: HashMap<&'static str, Presence> = ITEMS
        .into_iter()
        .zip([
            bun_presence,
            git,
            omp.presence,
            gh_presence,
            node_presence,
            agent_desktop,
            tailscale,
        ])
        .collect();
    Detection {
        presence,
        // An outdated Bun still installs packages and upgrades itself.
        bun: usable_bun.then_some(bun_path).flatten(),
        omp: omp.bin,
        brew,
        winget,
        path_env,
    }
}
