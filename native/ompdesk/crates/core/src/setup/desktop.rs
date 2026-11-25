use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::archives::{Platform, is_version};
use super::runtime::{VersionMode, version_output};
use crate::server::{Call, Fault, Reply, Scope};
use crate::tailscale::{compare_versions, version_in};

#[derive(Deserialize, Serialize)]
struct Copy {
    path: PathBuf,
    version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    bundle_dir: Option<PathBuf>,
    platform: Platform,
    managed: Option<Managed>,
    minimum: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Managed {
    Known(Copy),
    Probe {
        path: String,
        cwd: String,
        env: BTreeMap<String, String>,
    },
}

#[derive(PartialEq)]
struct Identity {
    size: u64,
    modified: SystemTime,
    inode: u64,
}

fn identity(path: &Path) -> Option<Identity> {
    #[cfg(unix)]
    let (meta, inode) = {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(path).ok()?;
        let inode = meta.ino();
        (meta, inode)
    };
    #[cfg(windows)]
    let (meta, inode) = {
        use std::os::windows::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new().access_mode(0).open(path).ok()?;
        (
            file.metadata().ok()?,
            crate::sys::file_identity(&file).ok()?.1,
        )
    };
    Some(Identity {
        size: meta.len(),
        modified: meta.modified().ok()?,
        inode,
    })
}

type VersionCache = Mutex<HashMap<PathBuf, (Identity, String)>>;
static VERSIONS: LazyLock<VersionCache> = LazyLock::new(Default::default);

async fn managed(input: Managed, scope: &Scope) -> Result<Option<Copy>, Fault> {
    let (path, cwd, env) = match input {
        Managed::Known(copy) => return Ok(Some(copy)),
        Managed::Probe { path, cwd, env } => (path, cwd, env),
    };
    let file = Path::new(&cwd).join(&path);
    let (file, id) = tokio::task::spawn_blocking(move || {
        let id = identity(&file);
        (file, id)
    })
    .await
    .map_err(|e| Fault::new("io_error", e.to_string()))?;
    let Some(id) = id else { return Ok(None) };
    let cached = VERSIONS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&file)
        .filter(|entry| entry.0 == id)
        .map(|entry| entry.1.clone());
    let version = match cached {
        Some(v) => v,
        None => {
            let bytes = match version_output(&path, &cwd, &env, scope, VersionMode::ExecFile).await
            {
                Ok((true, stdout, _)) => stdout,
                Err(e) if e.code == "cancelled" => return Err(e),
                _ => return Ok(None),
            };
            let text = String::from_utf8_lossy(&bytes);
            let Some(v) = version_in(&text) else {
                return Ok(None);
            };
            VERSIONS
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(file, (id, v.into()));
            v.to_owned()
        }
    };
    Ok(Some(Copy {
        path: path.into(),
        version,
    }))
}

#[derive(Deserialize)]
struct Record {
    version: String,
}

#[derive(Serialize)]
struct Selected {
    source: &'static str,
    #[serde(flatten)]
    copy: Copy,
}

async fn bundled(dir: &Path, platform: Platform) -> Option<Copy> {
    let bytes = tokio::fs::read(dir.join("agent-desktop.build.json"))
        .await
        .ok()?;
    let Record { version } = serde_json::from_slice(&bytes).ok()?;
    if version.starts_with('v') || !is_version(&version) {
        return None;
    }
    let path = dir.join(match platform {
        Platform::Win32 => "agent-desktop.exe",
        Platform::Darwin => "agent-desktop",
    });
    tokio::fs::metadata(&path).await.ok()?;
    Some(Copy { path, version })
}

fn pick(managed: Option<Copy>, bundled: Option<Copy>, minimum: &str) -> Option<Selected> {
    if let Some(copy) = managed {
        let meets = |floor| compare_versions(&copy.version, floor).is_some_and(|v| v.is_ge());
        if meets(minimum) && bundled.as_ref().is_none_or(|b| meets(&b.version)) {
            return Some(Selected {
                source: "managed",
                copy,
            });
        }
    }
    bundled.map(|copy| Selected {
        source: "bundled",
        copy,
    })
}

pub(super) async fn select(call: Call) -> Result<Reply, Fault> {
    let p: Params = call.params()?;
    let bundle = match p.bundle_dir {
        Some(dir) => bundled(&dir, p.platform).await,
        None => None,
    };
    let copy = match p.managed {
        Some(input) => managed(input, &call.scope).await?,
        None => None,
    };
    Reply::json(&pick(copy, bundle, &p.minimum))
}

/// `pickAgentDesktop` in process (machine setup's detection): the copy a session runs, of the bundle in `bundle_dir`
/// and the managed copy `managed` (its path and the version it printed), as its path and version.
pub(crate) async fn pick_copy(
    win32: bool,
    bundle_dir: Option<&Path>,
    managed: Option<(String, String)>,
    minimum: &str,
) -> Option<(String, String)> {
    let platform = if win32 {
        Platform::Win32
    } else {
        Platform::Darwin
    };
    let bundle = match bundle_dir {
        Some(dir) => bundled(dir, platform).await,
        None => None,
    };
    let managed = managed.map(|(path, version)| Copy {
        path: path.into(),
        version,
    });
    pick(managed, bundle, minimum).map(|selected| {
        (
            selected.copy.path.to_string_lossy().into_owned(),
            selected.copy.version,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_copy_the_typescript_spawn_used() {
        let at = |v: &str| Copy {
            path: PathBuf::new(),
            version: v.into(),
        };
        for (m, b, want) in [
            (None, None, None),
            (None, Some("1.1.0"), Some("bundled")),
            (Some("1.1.9"), None, None),
            (Some("1.2.0"), None, Some("managed")),
            (Some("1.2.0"), Some("1.2.0"), Some("managed")),
            (Some("1.2.0"), Some("1.3.0"), Some("bundled")),
            (Some("1.2.1"), Some("1.2.0"), Some("managed")),
            (Some("bad"), Some("1.2.0"), Some("bundled")),
        ] {
            assert_eq!(pick(m.map(at), b.map(at), "1.2.0").map(|s| s.source), want);
        }
    }
}
