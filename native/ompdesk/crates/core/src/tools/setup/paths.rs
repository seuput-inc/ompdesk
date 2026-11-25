//! Where setup installs and how it points a process at an install (was `src/main/setup/paths.ts` and the install rules
//! of `src/main/omp-runtime.ts`): node's `path.join`/`dirname` for the platform a plan runs on, the managed tools dir's
//! folders, the PATH lists, Git Bash's roots, and what ties an omp launcher to its Bun root and package.

use std::path::Path;

use serde_json::Value;

use crate::fs::path::{normalize_parts, normalize_win32};

/// `path.posix.normalize`.
fn normalize_posix(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let chars: Vec<char> = path.chars().collect();
    let mut out = normalize_parts(&chars, !absolute, '/', |c| c == '/');
    if out.is_empty() {
        if absolute {
            return "/".to_owned();
        }
        out.push('.');
    } else if trailing {
        out.push('/');
    }
    if absolute { format!("/{out}") } else { out }
}

/// node's `path.join` of `win32` (`win`) or `posix`: the non-empty parts, normalized.
pub fn join(win: bool, parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(if win { "\\" } else { "/" });
    if joined.is_empty() {
        return ".".to_owned();
    }
    if win {
        normalize_win32(&joined)
    } else {
        normalize_posix(&joined)
    }
}

/// node's `path.dirname` of `win32` (`win`) or `posix`.
pub fn dirname(win: bool, path: &str) -> String {
    let sep = |c: char| c == '/' || (win && c == '\\');
    // The root a path keeps: `/`, `C:\`, `C:`.
    let root = if win && path.len() >= 2 && path.as_bytes()[1] == b':' {
        if path[2..].starts_with(sep) { 3 } else { 2 }
    } else {
        usize::from(path.starts_with(sep))
    };
    let rest = &path[root..];
    let trimmed = rest.trim_end_matches(sep);
    match trimmed.rfind(sep) {
        Some(at) => {
            let head = trimmed[..at].trim_end_matches(sep);
            if head.is_empty() {
                path[..root.max(1)].to_owned()
            } else {
                format!("{}{head}", &path[..root])
            }
        }
        None if root > 0 => path[..root].to_owned(),
        None => ".".to_owned(),
    }
}

/// Joins on the platform this core runs on (node's own `path.join` in main).
pub fn host_join(parts: &[&str]) -> String {
    join(cfg!(windows), parts)
}

/// The separator of a PATH list on this computer (node's `path.delimiter`).
pub const DELIMITER: char = if cfg!(windows) { ';' } else { ':' };

/// The PortableGit root setup extracts on Windows (`managedGitRoot`).
pub fn managed_git_root(win: bool, tools_dir: &str) -> String {
    join(win, &[tools_dir, "git"])
}

/// Where setup unpacks agent-desktop (`managedAgentDesktopDir`).
pub fn managed_agent_desktop_dir(win: bool, tools_dir: &str) -> String {
    join(win, &[tools_dir, "agent-desktop"])
}

/// The managed agent-desktop executable (`managedAgentDesktop`).
pub fn managed_agent_desktop(win: bool, tools_dir: &str) -> String {
    let name = if win {
        "agent-desktop.exe"
    } else {
        "agent-desktop"
    };
    join(win, &[&managed_agent_desktop_dir(win, tools_dir), name])
}

/// The managed tools dir's folders a spawned process's PATH gets (`managedBinDirs`).
pub fn managed_bin_dirs(tools_dir: &str, platform: &str) -> Vec<String> {
    let win = platform == "win32";
    if win {
        vec![
            join(true, &[&managed_git_root(true, tools_dir), "cmd"]),
            managed_agent_desktop_dir(true, tools_dir),
        ]
    } else {
        vec![
            join(false, &[tools_dir, "node", "bin"]),
            join(false, &[tools_dir, "gh", "bin"]),
            managed_agent_desktop_dir(false, tools_dir),
        ]
    }
}

/// Git for Windows' bash.exe, or none (`findGitBash`): the Git roots stock's `resolveWindowsShell` checks, then a
/// `git.exe` on PATH whose install has `bin\bash.exe`. `env` reads a variable as Windows does, whatever its case.
pub fn find_git_bash(
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&str) -> bool,
) -> Option<String> {
    let at = |name: &str, rest: &[&str]| {
        env(name).filter(|value| !value.is_empty()).map(|value| {
            let mut parts = vec![value.as_str()];
            parts.extend_from_slice(rest);
            join(true, &parts)
        })
    };
    let roots = [
        at("ProgramFiles", &["Git"]),
        at("ProgramFiles(x86)", &["Git"]),
        at("LOCALAPPDATA", &["Programs", "Git"]),
        env("GIT_INSTALL_ROOT").filter(|root| !root.is_empty()),
        at("SCOOP", &["apps", "git", "current"]),
        at("USERPROFILE", &["scoop", "apps", "git", "current"]),
    ];
    for root in roots.into_iter().flatten() {
        let bash = join(true, &[&root, "bin", "bash.exe"]);
        if exists(&bash) {
            return Some(bash);
        }
    }
    let path = env("PATH").unwrap_or_default();
    for dir in path.split(';').filter(|dir| !dir.is_empty()) {
        if !exists(&join(true, &[dir, "git.exe"])) {
            continue;
        }
        let bash = join(true, &[&dirname(true, dir), "bin", "bash.exe"]);
        if exists(&bash) {
            return Some(bash);
        }
    }
    None
}

/// Bun's root when `bin` is the launcher of its global omp package (`ompBunRoot`).
pub fn omp_bun_root(bin: &str) -> Option<String> {
    let root = dirname(cfg!(windows), &dirname(cfg!(windows), bin));
    let manifest = host_join(&[
        &root,
        "install",
        "global",
        "node_modules",
        "@oh-my-pi",
        "pi-coding-agent",
        "package.json",
    ]);
    Path::new(&manifest).exists().then_some(root)
}

/// `basePath` plus the omp folder and Bun's bin folder (`ompPathEnv`).
pub fn omp_path_env(bin: &str, base: &str, bun_install: &str) -> String {
    let mut entries: Vec<String> = base
        .split(DELIMITER)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect();
    for dir in [
        dirname(cfg!(windows), bin),
        host_join(&[bun_install, "bin"]),
    ] {
        if !entries.contains(&dir) {
            entries.push(dir);
        }
    }
    entries.join(&DELIMITER.to_string())
}

/// What points stock `omp update` (and `--check`) at `bin`'s own install (`ompUpdateEnv`): its folder first on PATH,
/// and `BUN_INSTALL` for a Bun launcher.
pub fn omp_update_env(bin: &str, base: &str, bun_install: &str) -> (String, Option<String>) {
    let own = dirname(cfg!(windows), bin);
    let rest = base
        .split(DELIMITER)
        .filter(|entry| !entry.is_empty() && *entry != own);
    let path = std::iter::once(own.as_str())
        .chain(rest)
        .collect::<Vec<_>>()
        .join(&DELIMITER.to_string());
    (omp_path_env(bin, &path, bun_install), omp_bun_root(bin))
}

/// The oldest Bun a manifest names in `engines.bun` (`>=X.Y.Z`), else none (`manifestBunMinimum`).
pub fn manifest_bun_minimum(manifest: &Value) -> Option<String> {
    let range = manifest.get("engines")?.get("bun")?.as_str()?;
    let range = range.trim().strip_prefix(">=")?.trim_start();
    let version = range.strip_prefix('v').unwrap_or(range);
    let parts: Vec<&str> = version.split('.').collect();
    let digits = |part: &&str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    (parts.len() == 3 && parts.iter().all(digits)).then(|| version.to_owned())
}

fn read_manifest(file: &str) -> Option<Value> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

/// `manifestBunMinimum` of the omp package at `root` (`ompBunMinimum`).
pub fn omp_bun_minimum(root: Option<&str>) -> Option<String> {
    manifest_bun_minimum(&read_manifest(&host_join(&[root?, "package.json"]))?)
}

/// The `@oh-my-pi/pi-coding-agent` package behind `bin` (`ompPackageRoot`): the launcher's link target, or one of
/// Bun's and npm's layouts beside it.
pub fn omp_package_root(bin: &str) -> Option<String> {
    let win = cfg!(windows);
    let mut candidates = Vec::new();
    if let Ok(real) = std::fs::canonicalize(bin) {
        let real = real.to_string_lossy();
        let real = real.strip_prefix(r"\\?\").unwrap_or(&real).to_owned();
        candidates.push(dirname(win, &dirname(win, &real)));
    }
    let dir = dirname(win, bin);
    candidates.push(host_join(&[
        &dir,
        "..",
        "install",
        "global",
        "node_modules",
        "@oh-my-pi",
        "pi-coding-agent",
    ]));
    candidates.push(host_join(&[
        &dir,
        "node_modules",
        "@oh-my-pi",
        "pi-coding-agent",
    ]));
    candidates.push(host_join(&[
        &dir,
        "..",
        "lib",
        "node_modules",
        "@oh-my-pi",
        "pi-coding-agent",
    ]));
    candidates.into_iter().find(|dir| {
        read_manifest(&host_join(&[dir, "package.json"]))
            .is_some_and(|manifest| manifest["name"] == "@oh-my-pi/pi-coding-agent")
    })
}

/// The first number of a version (`majorOf`).
pub fn major_of(version: &str) -> Option<u64> {
    crate::tailscale::compare_versions(version, version)?;
    let text = crate::fs::order::js_trim(version);
    let text = text.strip_prefix('v').unwrap_or(text);
    text.split(['.', '-', '+']).next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_and_cuts_as_node_does() {
        assert_eq!(
            join(false, &["/opt/homebrew/bin/brew", "..", ".."]),
            "/opt/homebrew"
        );
        assert_eq!(
            join(false, &["/data/tools", ".downloads", "x.zip"]),
            "/data/tools/.downloads/x.zip"
        );
        assert_eq!(join(true, &["C:\\tools", "git"]), "C:\\tools\\git");
        assert_eq!(
            join(true, &["C:\\Windows", "System32", "x.exe"]),
            "C:\\Windows\\System32\\x.exe"
        );
        for (win, path, dir) in [
            (false, "/a/b/c", "/a/b"),
            (false, "/a", "/"),
            (false, "/", "/"),
            (false, "a", "."),
            (false, "/a/b/", "/a"),
            (true, "C:\\a\\b", "C:\\a"),
            (true, "C:\\a", "C:\\"),
            (true, "C:\\", "C:\\"),
            (true, "C:/a/b", "C:/a"),
        ] {
            assert_eq!(dirname(win, path), dir, "{path}");
        }
    }

    #[test]
    fn reads_engines_bun_and_majors() {
        let minimum =
            |range: &str| manifest_bun_minimum(&serde_json::json!({"engines": {"bun": range}}));
        assert_eq!(minimum(">=1.4.4").as_deref(), Some("1.4.4"));
        assert_eq!(minimum(" >= v1.4.4 ").as_deref(), Some("1.4.4"));
        assert_eq!(minimum("^1.4.4"), None);
        assert_eq!(minimum(">=1.4"), None);
        assert_eq!(major_of("18.22.2"), Some(18));
        assert_eq!(major_of("v18.22.2"), Some(18));
        assert_eq!(major_of("18.23.0-canary.3"), Some(18));
        assert_eq!(major_of("abc"), None);
    }

    #[test]
    fn finds_git_bash_in_stocks_order() {
        let env = |name: &str| match name {
            "ProgramFiles" => Some("C:\\Program Files".to_owned()),
            "GIT_INSTALL_ROOT" => Some("D:\\Git".to_owned()),
            "PATH" => Some("E:\\Git\\cmd;C:\\Windows".to_owned()),
            _ => None,
        };
        let only = |file: &'static str| move |path: &str| path == file;
        assert_eq!(
            find_git_bash(&env, &only("D:\\Git\\bin\\bash.exe")).as_deref(),
            Some("D:\\Git\\bin\\bash.exe")
        );
        let path_git =
            |path: &str| path == "E:\\Git\\cmd\\git.exe" || path == "E:\\Git\\bin\\bash.exe";
        assert_eq!(
            find_git_bash(&env, &path_git).as_deref(),
            Some("E:\\Git\\bin\\bash.exe")
        );
        assert_eq!(find_git_bash(&env, &|_| false), None);
    }
}
