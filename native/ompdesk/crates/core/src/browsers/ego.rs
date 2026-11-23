//! Find ego-browser without running it. Only the first positive answer survives the request.
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use serde::Deserialize;

use crate::server::{Fault, Registry, Reply};

static FOUND: OnceLock<PathBuf> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Search {
    path_env: String,
    home: PathBuf,
    cwd: PathBuf,
}

#[cfg(windows)]
const NAMES: &[&str] = &["ego-browser.exe", "ego-browser.cmd", "ego-browser"];
#[cfg(not(windows))]
const NAMES: &[&str] = &["ego-browser"];

// Node's path.join collapses dots before testing the file, without resolving symlinks.
fn directory(dir: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in dir.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir if out.file_name().is_some() => {
                out.pop();
            }
            Component::ParentDir if out.has_root() => {}
            _ => out.push(part.as_os_str()),
        }
    }
    #[cfg(windows)]
    if dir.as_os_str().as_encoded_bytes().len() == 2
        && matches!(dir.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(_)))
    {
        out.push("\\");
    }
    out
}

fn executable(path: &Path) -> bool {
    #[cfg(unix)]
    if !crate::sys::may_execute(path) {
        return false;
    }
    #[cfg(windows)]
    if std::fs::symlink_metadata(path).is_err() {
        return false;
    }
    // An execution alias can pass the access check but refuse stat. Only a known directory is excluded.
    !std::fs::metadata(path).is_ok_and(|m| m.is_dir())
}

fn find(search: Search) -> Option<PathBuf> {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let local = search.home.join(".local").join("bin");
    let dirs = search
        .path_env
        .split(separator)
        .filter(|d| !d.is_empty())
        .map(Path::new)
        .chain([local.as_path()]);
    for dir in dirs {
        let dir = directory(dir);
        for name in NAMES {
            let candidate = dir.join(name);
            let present = if candidate.is_absolute() {
                executable(&candidate)
            } else {
                executable(&search.cwd.join(&candidate))
            };
            if present {
                return Some(candidate);
            }
        }
    }
    None
}

pub(super) async fn resolve(search: Option<Search>) -> Result<Option<&'static PathBuf>, Fault> {
    if FOUND.get().is_none()
        && let Some(search) = search
        && let Some(path) = super::blocking(move || find(search)).await?
    {
        let _ = FOUND.set(path);
    }
    Ok(FOUND.get())
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("browsers.cachedEgo", |_| {
        Box::pin(async { Reply::json(&FOUND.get()) })
    });
    registry.add("browsers.resolveEgo", |call| {
        Box::pin(async move { Reply::json(&resolve(Some(call.params()?)).await?) })
    });
}
