use std::{fs, io};

use serde::Deserialize;

use super::error::NodeError;
use crate::server::{Fault, Reply};

#[cfg(windows)]
pub(crate) fn copy_file(source: &str, target: &str, overwrite: bool) -> io::Result<()> {
    crate::sys::copy_file(source, target, !overwrite)
}

#[cfg(unix)]
pub(crate) fn copy_file(source: &str, target: &str, overwrite: bool) -> io::Result<()> {
    use std::fs::{File, FileTimes, OpenOptions};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, fchown};

    let mut input = File::open(source)?;
    let meta = input.metadata()?;
    let mut output = OpenOptions::new()
        .write(true)
        .create(overwrite)
        .create_new(!overwrite)
        .mode(meta.mode())
        .open(target)?;

    // Never truncate before comparing the open files. A second lookup could see a different entry.
    if overwrite && super::disk::same_entry(&meta, &output.metadata()?, source, target) {
        return Ok(());
    }

    let copied = (|| {
        if overwrite {
            output.set_len(0)?;
        }
        let _ = fchown(&output, Some(meta.uid()), Some(meta.gid()));
        output.set_permissions(meta.permissions())?;
        io::copy(
            &mut std::io::Read::take(&mut input, meta.len()),
            &mut output,
        )?;
        if let (Ok(accessed), Ok(modified)) = (meta.accessed(), meta.modified()) {
            let _ = output.set_times(
                FileTimes::new()
                    .set_accessed(accessed)
                    .set_modified(modified),
            );
        }
        Ok(())
    })();
    if copied.is_err() {
        // copyFile removes an incomplete destination only after it successfully opened it.
        let _ = fs::remove_file(target);
    }
    copied
}

#[derive(Deserialize)]
pub(super) struct Params {
    abs: String,
    dest: String,
}

pub(super) fn save(p: Params) -> Result<Reply, Fault> {
    let error = if p.abs.contains('\0') {
        NodeError::nul_in_path("src", &p.abs)
    } else if p.dest.contains('\0') {
        NodeError::nul_in_path("dest", &p.dest)
    } else {
        match copy_file(&p.abs, &p.dest, true) {
            Ok(()) => return Reply::json(&()),
            Err(e) => NodeError::with_dest(&e, "copyfile", Some(&p.abs), Some(&p.dest)),
        }
    };
    // libuv's F_OK follows a dangling link on POSIX but sees the link's own attributes on Windows.
    #[cfg(unix)]
    let accessible = fs::metadata(&p.abs).is_ok();
    #[cfg(windows)]
    let accessible = fs::symlink_metadata(&p.abs).is_ok();
    Err(Fault::new(
        if accessible { "io" } else { "file_not_found" },
        error.message,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_missing_source_gets_the_app_code() {
        let dir = super::super::disk::make_temp_dir("ompdesk-save-copy-").unwrap();
        fs::write(dir.join("source"), b"source").unwrap();
        fs::write(dir.join("saved"), b"previous").unwrap();
        for (source, target, code) in [
            ("gone", dir.join("saved"), "file_not_found"),
            ("source", dir.join("missing").join("target"), "io"),
        ] {
            let abs = dir.join(source).into_os_string().into_string().unwrap();
            let dest = target.into_os_string().into_string().unwrap();
            let msg = format!("ENOENT: no such file or directory, copyfile '{abs}' -> '{dest}'");
            let error = save(Params { abs, dest }).err().unwrap();
            assert_eq!(error, Fault::new(code, msg));
            assert_eq!(fs::read(dir.join("saved")).unwrap(), b"previous");
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
