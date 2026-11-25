//! Private destinations for a stock bridge's redacted session ZIP. The receipt lives on disk, not in the core process.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::server::{Fault, Registry, Reply};

const PREFIX: &str = "ompdesk-archive-";

#[derive(Deserialize, Serialize)]
struct Grant {
    path: String,
    receipt: String,
}

fn io_fault(e: io::Error) -> Fault {
    Fault::new("io", e.to_string())
}

fn hex_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn output(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("ompdesk-dump-{id}.zip"))
}

fn reparse(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    meta.is_symlink()
}

fn prepare() -> Result<Grant, Fault> {
    let mut random = [0; 32];
    crate::sys::random(&mut random).map_err(io_fault)?;
    let id = crate::hex(&random[..16]);
    let receipt = crate::hex(&random[16..]);
    let dir = std::env::temp_dir().join(format!("{PREFIX}{id}"));
    let mut builder = fs::DirBuilder::new();
    let builder = builder.recursive(false);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(builder, 0o700);
    builder.create(&dir).map_err(io_fault)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let marker = dir.join(format!("receipt-{receipt}"));
    if let Err(e) = options.open(&marker) {
        let _ = fs::remove_dir(&dir);
        return Err(io_fault(e));
    }
    let path = output(&dir, &id);
    let created = options.open(&path).and_then(|mut f| {
        let written = f.write_all(id.as_bytes());
        drop(f);
        if written.is_err() {
            let _ = fs::remove_file(&path);
        }
        written
    });
    if let Err(e) = created {
        let _ = fs::remove_file(marker);
        let _ = fs::remove_dir(dir);
        return Err(io_fault(e));
    }
    Ok(Grant {
        path: path.to_string_lossy().into_owned(),
        receipt,
    })
}

fn metadata(path: &Path) -> Result<Option<fs::Metadata>, Fault> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_fault(e)),
    }
}

fn discard(grant: &Grant) -> Result<bool, Fault> {
    let path = Path::new(&grant.path);
    let Some(dir) = path.parent() else {
        return Ok(false);
    };
    let Some(id) = dir
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix(PREFIX))
    else {
        return Ok(false);
    };
    if !hex_id(id)
        || !hex_id(&grant.receipt)
        || output(&std::env::temp_dir().join(format!("{PREFIX}{id}")), id).as_os_str()
            != path.as_os_str()
    {
        return Ok(false);
    }
    if !metadata(dir)?.is_some_and(|m| m.is_dir() && !reparse(&m)) {
        return Ok(false);
    }
    let marker = dir.join(format!("receipt-{}", grant.receipt));
    if !metadata(&marker)?.is_some_and(|m| m.is_file() && !reparse(&m) && m.len() == 0) {
        return Ok(false);
    }
    // No recursive removal: another file in the folder was never part of the grant.
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(io_fault(e)),
        _ => {}
    }
    match fs::remove_file(marker) {
        Ok(()) => {
            let _ = fs::remove_dir(dir);
            Ok(true)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(io_fault(e)),
    }
}

pub fn register(registry: &mut Registry) {
    registry.add("archive.prepare", |call| {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let grant = prepare()?;
                if call.scope.cancelled() {
                    discard(&grant)?;
                    return Err(Fault::cancelled());
                }
                Reply::json(&grant)
            })
            .await
            .map_err(|_| Fault::new("internal", "Archive preparation panicked"))?
        })
    });
    registry.add("archive.discard", |call| {
        Box::pin(async move {
            let grant = call.params()?;
            tokio::task::spawn_blocking(move || Reply::json(&json!({"removed": discard(&grant)?})))
                .await
                .map_err(|_| Fault::new("internal", "Archive discard panicked"))?
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_recorded_file_and_receipt_can_be_consumed() {
        let grant = prepare().unwrap();
        let dir = Path::new(&grant.path).parent().unwrap();
        let other = dir.join("other.zip");
        fs::write(&other, b"unrelated").unwrap();
        fs::write(&grant.path, b"fixture").unwrap();
        let foreign = Grant {
            path: other.to_string_lossy().into_owned(),
            receipt: grant.receipt.clone(),
        };
        let forged = Grant {
            path: grant.path.clone(),
            receipt: "0".repeat(32),
        };
        assert!(!discard(&foreign).unwrap());
        assert!(!discard(&forged).unwrap());
        assert!(Path::new(&grant.path).exists());
        assert!(discard(&grant).unwrap());
        assert!(!discard(&grant).unwrap());
        assert_eq!(fs::read(&other).unwrap(), b"unrelated");
        fs::remove_file(other).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
