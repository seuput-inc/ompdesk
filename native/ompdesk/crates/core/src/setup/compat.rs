use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::disk::saves::write_kept;
use crate::server::{Call, Fault, Registry, Reply};

const MAX_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    user_data: PathBuf,
}

fn cache_file(call: &Call) -> Result<PathBuf, Fault> {
    let Params { mut user_data } = call.params()?;
    if !user_data.is_absolute() {
        return Err(Fault::new(
            "invalid_params",
            "Expected an absolute userData",
        ));
    }
    user_data.push("omp-compat.json");
    Ok(user_data)
}

fn read(file: &Path) -> Option<Vec<u8>> {
    let meta = file.symlink_metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
        return None;
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    File::open(file)
        .ok()?
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= MAX_BYTES && std::str::from_utf8(&bytes).is_ok()).then_some(bytes)
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("setup.readCompatCache", |call| {
        Box::pin(async move {
            let file = cache_file(&call)?;
            let bytes = tokio::task::spawn_blocking(move || read(&file))
                .await
                .map_err(|e| Fault::new("internal", e.to_string()))?;
            Ok(Reply {
                bin: bytes,
                ..Reply::json(&())?
            })
        })
    });
    registry.add("setup.saveCompatCache", |call| {
        Box::pin(async move {
            let file = cache_file(&call)?;
            let bytes = call
                .bin
                .ok_or_else(|| Fault::new("invalid_params", "Missing verified list"))?;
            if bytes.len() > MAX_BYTES || std::str::from_utf8(&bytes).is_err() {
                return Err(Fault::new("invalid_params", "Invalid verified list text"));
            }
            tokio::task::spawn_blocking(move || write_kept(&file, &bytes, None, 0o777))
                .await
                .map_err(|e| Fault::new("internal", e.to_string()))??;
            Reply::json(&())
        })
    });
}
