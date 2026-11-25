//! Drafts for editors that run in the desktop host. The receipt survives a core restart while the user edits.
//! `make_temp_dir` creates mode 0700 on Unix. On Windows the user's TEMP directory must have a private ACL.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::disk;
use super::error::{Codes, NodeError};
use crate::server::{Call, Fault, Reply};

const PREFIX: &str = "omp-editor-";
const DRAFT: &str = "draft.md";
const OWNER: &str = "receipt";

#[derive(Serialize, Deserialize)]
struct Receipt {
    folder: String,
    token: String,
}

#[derive(Serialize)]
struct Prepared<'a> {
    id: Receipt,
    file: &'a Path,
}

#[derive(Deserialize)]
struct Finish {
    id: Receipt,
    read: bool,
}

fn io_fault(error: std::io::Error, op: &str, path: &Path) -> Fault {
    NodeError::new(&error, op, Some(&path.to_string_lossy())).fault(Codes::None)
}

fn create(path: &Path, bytes: &[u8]) -> Result<(), Fault> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path).map_err(|e| io_fault(e, "open", path))?;
    file.write_all(bytes)
        .map_err(|e| io_fault(e, "write", path))
}

struct Cleanup<'a>(&'a Path);

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        if !fs::symlink_metadata(self.0).is_ok_and(|meta| meta.is_dir() && !reparse(&meta)) {
            return;
        }
        // The editor may have left a backup or the user another file. Neither belongs to this operation.
        let _ = fs::remove_file(self.0.join(DRAFT));
        let _ = fs::remove_file(self.0.join(OWNER));
        let _ = fs::remove_dir(self.0);
    }
}

pub(super) fn prepare(call: Call) -> Result<Reply, Fault> {
    let mut random = [0; 16];
    crate::sys::random(&mut random).map_err(|e| Fault::new("io", e.to_string()))?;
    let token = crate::hex(&random);
    let dir = disk::make_temp_dir(PREFIX).map_err(|e| e.fault(Codes::None))?;
    let cleanup = Cleanup(&dir);
    let folder = dir.file_name().unwrap_or_default().to_string_lossy();
    let file = dir.join(DRAFT);
    create(&dir.join(OWNER), token.as_bytes())?;
    create(&file, call.bin.as_deref().unwrap_or_default())?;
    let reply = Reply::json(&Prepared {
        id: Receipt {
            folder: folder.into_owned(),
            token,
        },
        file: &file,
    })?;
    if call.scope.cancelled() {
        return Err(Fault::cancelled());
    }
    // The host now owns the receipt; keep the folder even if this core exits before the editor does.
    std::mem::forget(cleanup);
    Ok(reply)
}

fn invalid() -> Fault {
    Fault::new("invalid_params", "Unknown external-editor draft")
}

fn regular_file(path: &Path) -> Result<File, Fault> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(
        &mut options,
        libc::O_NOFOLLOW | libc::O_NONBLOCK,
    );
    #[cfg(windows)]
    std::os::windows::fs::OpenOptionsExt::custom_flags(&mut options, 0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    let file = options.open(path).map_err(|e| io_fault(e, "open", path))?;
    let meta = file.metadata().map_err(|e| io_fault(e, "fstat", path))?;
    if !meta.is_file() || reparse(&meta) {
        return Err(invalid());
    }
    Ok(file)
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

pub(super) fn finish(call: Call) -> Result<Reply, Fault> {
    let Finish { id, read } = call.params()?;
    if !id
        .folder
        .strip_prefix(PREFIX)
        .is_some_and(|s| s.len() == 6 && s.bytes().all(|b| b.is_ascii_alphanumeric()))
        || id.token.len() != 32
        || !id.token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(invalid());
    }
    let dir = std::env::temp_dir().join(id.folder);
    let meta = fs::symlink_metadata(&dir).map_err(|_| invalid())?;
    if !meta.is_dir() || reparse(&meta) {
        return Err(invalid());
    }
    let mut proof = [0; 32];
    let mut owner = regular_file(&dir.join(OWNER))?;
    owner.read_exact(&mut proof).map_err(|_| invalid())?;
    if proof.as_slice() != id.token.as_bytes() {
        return Err(invalid());
    }
    drop(owner);
    let _cleanup = Cleanup(&dir);
    let reply = Reply::json(&())?;
    if !read {
        return Ok(reply);
    }
    let path = dir.join(DRAFT);
    let mut bytes = Vec::new();
    regular_file(&path)?
        .read_to_end(&mut bytes)
        .map_err(|e| io_fault(e, "read", &path))?;
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    Ok(reply.with_bin(bytes))
}
