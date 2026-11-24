//! STAND-IN for `tools::spawn` (T2.4, the CLI unit, owns the real one): the few lookups and spawn rules setup calls,
//! under the names that module exports, with bodies just good enough for setup and its tests. The integration
//! switches setup's imports to `super::super::spawn` and deletes this file; nothing here is a second implementation
//! to keep.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::paths::{DELIMITER, host_join};
use crate::tools::runner::SpawnSpec;

/// `executableName`.
pub(crate) fn executable_name(name: &str, platform: &str) -> String {
    if platform == "win32" {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

/// `isExecutableFile`.
fn is_executable_file(file: &str, platform: &str) -> bool {
    let Ok(meta) = std::fs::metadata(file) else {
        // An app execution alias may refuse a stat; it still exists.
        return platform == "win32" && std::fs::symlink_metadata(file).is_ok();
    };
    #[cfg(unix)]
    if platform != "win32" {
        use std::os::unix::fs::PermissionsExt;
        return !meta.is_dir() && meta.permissions().mode() & 0o111 != 0;
    }
    !meta.is_dir()
}

/// `findOnPath`: the first `names` entry along `path_env`, then the first `extra` that exists; never one of `exclude`.
pub(crate) fn find_on_path(
    names: &[String],
    path_env: &str,
    platform: &str,
    extra: &[String],
    exclude: &[String],
) -> Option<String> {
    let sep = if platform == "win32" { ';' } else { DELIMITER };
    path_env
        .split(sep)
        .filter(|dir| !dir.is_empty())
        .flat_map(|dir| names.iter().map(move |name| host_join(&[dir, name])))
        .chain(extra.iter().cloned())
        .find(|file| !exclude.contains(file) && is_executable_file(file, platform))
}

/// `spawnCommand`/`spawnArgs`/`needsShell` as one spec: a Windows `.cmd`/`.bat` shim runs quoted through cmd.exe.
pub(crate) fn spawn_spec(file: &str, args: &[String], platform: &str) -> SpawnSpec {
    let lower = file.to_ascii_lowercase();
    let shell = platform == "win32" && (lower.ends_with(".cmd") || lower.ends_with(".bat"));
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

/// `brewBinDirs`: `OMP_GUI_TEST_BREW_DIRS` of main's environment replaces Homebrew's two.
pub(crate) fn brew_bin_dirs(env: &BTreeMap<String, String>) -> Vec<String> {
    match env.get("OMP_GUI_TEST_BREW_DIRS") {
        Some(dirs) => dirs
            .split(DELIMITER)
            .filter(|dir| !dir.is_empty())
            .map(str::to_owned)
            .collect(),
        None => vec!["/opt/homebrew/bin".to_owned(), "/usr/local/bin".to_owned()],
    }
}

/// `npmFor`: the prefix's own npm, else one on PATH.
pub(crate) fn npm_for(prefix: &str, platform: &str, path_env: &str) -> Option<String> {
    let own = if platform == "win32" {
        host_join(&[prefix, "npm.cmd"])
    } else {
        host_join(&[prefix, "bin", "npm"])
    };
    if std::path::Path::new(&own).exists() {
        return Some(own);
    }
    let npm = if platform == "win32" {
        "npm.cmd"
    } else {
        "npm"
    };
    find_on_path(&[npm.to_owned()], path_env, platform, &[], &[])
}

/// `InstallContext`.
pub(crate) struct InstallContext {
    pub platform: String,
    pub tools_dir: String,
    pub brew: Option<String>,
}

/// `readInstall`: `ext.binaryFacts` of `path` for `source`, as JSON (`{launcher, real, owner, …}`).
pub(crate) fn read_install(path: &str, ctx: &InstallContext, source: Value) -> Value {
    let cwd = std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_default();
    let file = std::path::absolute(path)
        .map(|file| file.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_owned());
    crate::ext::binary_facts(json!({
        "path": path,
        "file": file,
        "cwd": cwd,
        "ctx": {"platform": ctx.platform, "toolsDir": ctx.tools_dir, "brew": ctx.brew},
        "source": source,
    }))
    .unwrap_or(Value::Null)
}

/// `isNewer` of `src/shared/version.ts`.
pub(crate) fn is_newer(latest: &str, installed: Option<&str>) -> bool {
    let Some(installed) = installed else {
        return true;
    };
    match crate::tailscale::compare_versions(latest, installed) {
        Some(order) => order.is_gt(),
        None => latest.trim() != installed.trim(),
    }
}
