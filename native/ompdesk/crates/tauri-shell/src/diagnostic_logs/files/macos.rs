use std::{
    ffi::CStr,
    fs::{File, OpenOptions},
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::OpenOptionsExt,
    },
    path::Path,
};

pub(super) fn open(profile: &Path, archive: bool) -> io::Result<File> {
    let profile = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(profile)?;
    let logs = child(&profile, c"logs", libc::O_DIRECTORY)?;
    let name = if archive {
        c"gui-runtime.jsonl.1"
    } else {
        c"gui-runtime.jsonl"
    };
    let file = child(&logs, name, libc::O_NONBLOCK | libc::O_NOCTTY)?;
    if file.metadata()?.is_file() {
        Ok(file)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a regular log file",
        ))
    }
}

#[allow(unsafe_code)]
fn child(parent: &File, name: &CStr, flags: libc::c_int) -> io::Result<File> {
    // SAFETY: parent and the NUL-terminated single component live across openat. No O_CREAT.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | flags,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}
