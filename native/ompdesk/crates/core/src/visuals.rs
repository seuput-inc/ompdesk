//! `gui_visualize` file admission, snapshot history and `omp-visual:` serving.

mod store;

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncReadExt;

use crate::fs::{disk, error::NodeError};
use crate::server::{Fault, Registry, Reply};

const MAX_FILE: u64 = 5 * 1024 * 1024;

fn mime(path: &Path, asset: bool) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?;
    let mut folded = [0; 5];
    let folded = folded.get_mut(..ext.len())?;
    folded.copy_from_slice(ext.as_bytes());
    folded.make_ascii_lowercase();
    Some(match &*folded {
        b"html" | b"htm" => "text/html",
        b"svg" => "image/svg+xml",
        b"png" => "image/png",
        b"jpg" | b"jpeg" => "image/jpeg",
        b"gif" => "image/gif",
        b"webp" => "image/webp",
        b"avif" => "image/avif",
        b"txt" => "text/plain",
        _ if !asset => return None,
        b"css" => "text/css",
        b"js" | b"mjs" => "text/javascript",
        b"json" => "application/json",
        b"ico" => "image/x-icon",
        b"woff" => "font/woff",
        b"woff2" => "font/woff2",
        b"ttf" => "font/ttf",
        b"otf" => "font/otf",
        b"mp4" => "video/mp4",
        b"webm" => "video/webm",
        b"mp3" => "audio/mpeg",
        b"wav" => "audio/wav",
        b"wasm" => "application/wasm",
        b"md" => "text/plain",
        _ => return None,
    })
}

async fn source(
    cwd: &str,
    raw: &str,
    path: &Path,
) -> Result<(PathBuf, PathBuf, String, Vec<u8>), Fault> {
    let fail = |message| Fault::new("visual", message);
    let root = disk::real(cwd)
        .await
        .ok_or_else(|| fail(format!("The working directory is unavailable: {cwd}")))?;
    let target = disk::real(path)
        .await
        .ok_or_else(|| fail(format!("No such file: {raw}")))?;
    let entry = target
        .strip_prefix(&root)
        .ok()
        .filter(|entry| !entry.as_os_str().as_encoded_bytes().starts_with(b".."))
        .ok_or_else(|| fail(format!("{raw} is outside the working directory")))?;
    let io = |error, syscall| {
        let error = NodeError::new(&error, syscall, target.to_str());
        Fault::new(error.code, error.message)
    };
    let stat = tokio::fs::metadata(&target)
        .await
        .map_err(|e| io(e, "stat"))?;
    if !stat.is_file() {
        return Err(fail(format!("{raw} is not a file")));
    }
    if mime(&target, false).is_none() {
        return Err(fail(
            "visualize shows .html, .htm, .svg, .txt and image files".into(),
        ));
    }
    let too_large = || fail(format!("{raw} is larger than 5 MB"));
    if stat.len() > MAX_FILE {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(stat.len() as usize);
    tokio::fs::File::open(&target)
        .await
        .map_err(|e| io(e, "open"))?
        .take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| io(e, "read"))?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(too_large());
    }
    let entry = entry.to_string_lossy().into_owned();
    #[cfg(windows)]
    let entry = entry.replace('\\', "/");
    Ok((target, root, entry, bytes))
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Location {
    Snapshot {
        dir: PathBuf,
        id: String,
        file: String,
    },
    Asset {
        root: PathBuf,
        relative: String,
    },
}

#[derive(Deserialize)]
struct Request {
    entry: PathBuf,
    bytes: bool,
    #[serde(flatten)]
    location: Location,
}

fn visible(name: &str) -> bool {
    !name
        .split(std::path::is_separator)
        .any(|part| part.starts_with('.'))
}

impl Request {
    async fn resolve(&self) -> Option<(PathBuf, &'static str)> {
        match &self.location {
            Location::Snapshot { dir, id, file } => {
                if !store::valid_id(id) || Path::new(file).file_name()?.to_str()? != file {
                    return None;
                }
                let folder = disk::real(dir).await?.join(id);
                let real = disk::real(folder.join(file)).await?;
                (real.parent()? == folder)
                    .then(|| (real, mime(&self.entry, false).unwrap_or("text/html")))
            }
            Location::Asset { root, relative } => {
                let requested = Path::new(relative);
                if !visible(relative)
                    || !requested
                        .components()
                        .all(|c| matches!(c, Component::Normal(_)))
                {
                    return None;
                }
                let kind = mime(requested, true)?;
                let parent = self.entry.parent()?;
                let mut parts = requested.components();
                for component in parent.components() {
                    let other = parts.next()?;
                    if component != other
                        && !(cfg!(windows)
                            && component
                                .as_os_str()
                                .eq_ignore_ascii_case(other.as_os_str()))
                    {
                        return None;
                    }
                }
                let real = disk::real(root.join(requested)).await?;
                let within = real.strip_prefix(root.join(parent)).ok()?;
                if !visible(within.to_str()?)
                    || mime(&real, true)? != kind
                    || !tokio::fs::metadata(&real).await.ok()?.is_file()
                {
                    return None;
                }
                Some((real, kind))
            }
        }
    }
}

async fn file(p: Request) -> Result<Reply, Fault> {
    let Some((file, kind)) = p.resolve().await else {
        return Reply::json(&None::<()>);
    };
    let reply = Reply::json(&json!({"file": file, "type": kind}))?;
    if !p.bytes {
        return Ok(reply);
    }
    match tokio::fs::read(file).await {
        Ok(bytes) => Ok(reply.with_bin(bytes)),
        Err(_) => Reply::json(&None::<()>),
    }
}

pub(crate) fn register(registry: &mut Registry) {
    store::register(registry);
    registry.add("visual.file", |call| {
        Box::pin(async move { file(call.params()?).await })
    });
}
