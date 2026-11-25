//! Durable replacement for a caller that already wrote and flushed a private sibling temp file.

use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};

fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "file path contains NUL",
        ));
    }
    value.push(0);
    Ok(value)
}

pub fn replace_durable(source: &Path, target: &Path) -> io::Result<()> {
    let source = wide(source)?;
    let target = wide(target)?;
    // SAFETY: both paths are NUL-terminated and contain no interior NUL; their buffers outlive the call.
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    #[test]
    fn interior_nul_never_reaches_the_os() {
        let invalid = std::path::PathBuf::from(OsString::from_wide(&[b'x' as u16, 0, b'y' as u16]));
        assert_eq!(
            replace_durable(&invalid, Path::new("unused"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            replace_durable(Path::new("unused"), &invalid)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
