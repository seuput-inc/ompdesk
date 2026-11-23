//! A single entry relative to a directory we hold. A checkout hook's link is an entry, never a directory to traverse.

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(PartialEq, Eq)]
pub(in crate::disk) enum Kind {
    File,
    Link,
    Directory,
    Other,
}

pub(in crate::disk) struct Entry<'a> {
    name: &'a OsStr,
    #[cfg(unix)]
    parent: File,
    #[cfg(windows)]
    parent: PathBuf,
    #[cfg(windows)]
    _parents: Vec<File>,
}

fn unsafe_path() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "not an ordinary directory inside the worktree",
    )
}

pub(in crate::disk) type RootId = [u32; 4]; // Device and inode in lossless JSON words, not JavaScript-sized integers.

pub(in crate::disk) fn directory(dir: &Path) -> io::Result<File> {
    #[cfg(unix)]
    {
        use rustix::fs::{Mode, OFlags, open};
        Ok(open(
            dir,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NOFOLLOW,
            Mode::empty(),
        )?
        .into())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Deny write and delete sharing so a checked directory cannot become a junction or be replaced.
        let file = File::options()
            .access_mode(0x80)
            .share_mode(1)
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .open(dir)?;
        let meta = file.metadata()?;
        if !meta.is_dir() || crate::fs::disk::linked(&meta) {
            return Err(unsafe_path());
        }
        Ok(file)
    }
}

pub(in crate::disk) fn identity(file: &File) -> io::Result<RootId> {
    #[cfg(unix)]
    let (device, inode) = {
        use std::os::unix::fs::MetadataExt;
        let m = file.metadata()?;
        (m.dev(), m.ino())
    };
    #[cfg(windows)]
    let (device, inode) = {
        let (volume, index, _) = crate::sys::file_identity(file)?;
        (u64::from(volume), index)
    };
    Ok([
        (device >> 32) as u32,
        device as u32,
        (inode >> 32) as u32,
        inode as u32,
    ])
}

pub(in crate::disk) fn verified_directory(
    path: &Path,
    expected: RootId,
) -> Result<File, crate::server::Fault> {
    let held = directory(path).map_err(|e| super::fault(&e, "open", path))?;
    if identity(&held).ok() != Some(expected) {
        return Err(super::keep("the checkout directory changed during restore"));
    }
    Ok(held)
}

impl<'a> Entry<'a> {
    pub(in crate::disk) fn at(root: &Path, relative: &'a Path, create: bool) -> io::Result<Self> {
        Self::in_dir(directory(root)?, relative, create)
    }

    pub(super) fn in_dir(root_handle: File, relative: &'a Path, create: bool) -> io::Result<Self> {
        let name = relative.file_name().ok_or_else(unsafe_path)?;
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            return Err(unsafe_path());
        }
        let parents = relative
            .parent()
            .ok_or_else(unsafe_path)?
            .components()
            .filter_map(|c| match c {
                Component::Normal(n) => Some(n),
                _ => None,
            });
        #[cfg(unix)]
        {
            use rustix::fs::{Mode, OFlags, mkdirat, openat};
            let flags = OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY | OFlags::NOFOLLOW;
            let mut dir: std::os::fd::OwnedFd = root_handle.into();
            for part in parents {
                dir = match openat(&dir, part, flags, Mode::empty()) {
                    Err(rustix::io::Errno::NOENT) if create => {
                        match mkdirat(&dir, part, Mode::from_raw_mode(0o777)) {
                            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
                            Err(e) => return Err(e.into()),
                        }
                        openat(&dir, part, flags, Mode::empty())?
                    }
                    other => other?,
                };
            }
            Ok(Self {
                name,
                parent: dir.into(),
            })
        }
        #[cfg(windows)]
        {
            let mut dir = crate::sys::final_file_path(&root_handle)?;
            let mut handles = vec![root_handle];
            // A verbatim root and single normal components prevent Win32 device, stream and dot/space aliases.
            for component in relative.components().filter_map(|c| match c {
                Component::Normal(n) => Some(n),
                _ => None,
            }) {
                let s = component.to_string_lossy();
                if s.ends_with(['.', ' ']) || s.contains(':') {
                    return Err(unsafe_path());
                }
            }
            for part in parents {
                dir.push(part);
                let f = match directory(&dir) {
                    Err(e) if create && e.kind() == io::ErrorKind::NotFound => {
                        match std::fs::create_dir(&dir) {
                            Ok(()) => {}
                            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                            Err(e) => return Err(e),
                        }
                        directory(&dir)?
                    }
                    other => other?,
                };
                handles.push(f);
            }
            Ok(Self {
                name,
                parent: dir,
                _parents: handles,
            })
        }
    }

    pub(in crate::disk) fn kind(&self) -> io::Result<Kind> {
        #[cfg(unix)]
        {
            use rustix::fs::{AtFlags, FileType, statat};
            Ok(
                match FileType::from_raw_mode(
                    statat(&self.parent, self.name, AtFlags::SYMLINK_NOFOLLOW)?.st_mode,
                ) {
                    FileType::RegularFile => Kind::File,
                    FileType::Symlink => Kind::Link,
                    FileType::Directory => Kind::Directory,
                    _ => Kind::Other,
                },
            )
        }
        #[cfg(windows)]
        {
            let meta = std::fs::symlink_metadata(self.parent.join(self.name))?;
            Ok(if meta.is_symlink() {
                Kind::Link
            } else if crate::fs::disk::linked(&meta) {
                Kind::Other
            } else if meta.is_file() {
                Kind::File
            } else if meta.is_dir() {
                Kind::Directory
            } else {
                Kind::Other
            })
        }
    }

    pub(in crate::disk) fn file(&self, create: bool) -> io::Result<File> {
        #[cfg(unix)]
        let file: File = {
            use rustix::fs::{Mode, OFlags, openat};
            let access = if create {
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL
            } else {
                OFlags::RDONLY
            };
            openat(
                &self.parent,
                self.name,
                access | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC | OFlags::NOCTTY,
                Mode::from_raw_mode(0o600),
            )?
            .into()
        };
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            File::options()
                .read(!create)
                .write(create)
                .create_new(create)
                .share_mode(1)
                .custom_flags(0x0020_0000)
                .open(self.parent.join(self.name))?
        };
        let meta = file.metadata()?;
        if !meta.is_file() || crate::fs::disk::linked(&meta) {
            return Err(unsafe_path());
        }
        Ok(file)
    }

    /// An open file still names the entry compared, not a same-size replacement.
    pub(in crate::disk) fn still_names(&self, file: &File) -> io::Result<bool> {
        #[cfg(unix)]
        {
            use rustix::fs::{AtFlags, statat};
            use std::os::unix::fs::MetadataExt;
            let entry = statat(&self.parent, self.name, AtFlags::SYMLINK_NOFOLLOW)?;
            let meta = file.metadata()?;
            Ok(entry.st_dev as u64 == meta.dev() && entry.st_ino as u64 == meta.ino())
        }
        #[cfg(windows)]
        {
            // This handle and every directory handle above it deny delete sharing.
            Ok(crate::sys::final_file_path(file)?
                == std::fs::canonicalize(self.parent.join(self.name))?)
        }
    }

    pub(super) fn read_link(&self) -> io::Result<PathBuf> {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            Ok(std::ffi::OsString::from_vec(
                rustix::fs::readlinkat(&self.parent, self.name, Vec::new())?.into_bytes(),
            )
            .into())
        }
        #[cfg(windows)]
        {
            std::fs::read_link(self.parent.join(self.name))
        }
    }

    pub(super) fn link(&self, text: &Path) -> io::Result<()> {
        #[cfg(unix)]
        {
            Ok(rustix::fs::symlinkat(text, &self.parent, self.name)?)
        }
        #[cfg(windows)]
        {
            let path = self.parent.join(self.name);
            if self.parent.join(text).is_dir() {
                std::os::windows::fs::symlink_dir(text, path)
            } else {
                std::os::windows::fs::symlink_file(text, path)
            }
        }
    }

    pub(super) fn remove(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            Ok(rustix::fs::unlinkat(
                &self.parent,
                self.name,
                rustix::fs::AtFlags::empty(),
            )?)
        }
        #[cfg(windows)]
        {
            let p = self.parent.join(self.name);
            let m = std::fs::symlink_metadata(&p)?;
            if m.file_type().is_symlink_dir() {
                return std::fs::remove_dir(p);
            }
            match std::fs::remove_file(&p) {
                Err(e)
                    if e.kind() == io::ErrorKind::PermissionDenied
                        && m.is_file()
                        && !crate::fs::disk::linked(&m)
                        && m.permissions().readonly() =>
                {
                    use std::os::windows::fs::OpenOptionsExt;
                    let f = File::options()
                        .access_mode(0x180)
                        .share_mode(1)
                        .custom_flags(0x0020_0000)
                        .open(&p)?;
                    let meta = f.metadata()?;
                    if !meta.is_file() || crate::fs::disk::linked(&meta) {
                        return Err(unsafe_path());
                    }
                    let mut perms = meta.permissions();
                    perms.set_readonly(false);
                    f.set_permissions(perms)?;
                    drop(f);
                    std::fs::remove_file(p)
                }
                other => other,
            }
        }
    }

    pub(super) fn move_aside(&self) -> io::Result<()> {
        let mut base = self.name.to_owned();
        base.push(".ompdesk-before-restore");
        for i in 1u64.. {
            let mut name = base.clone();
            if i != 1 {
                name.push(format!("-{i}"));
            }
            #[cfg(unix)]
            let moved: io::Result<()> = rustix::fs::renameat_with(
                &self.parent,
                self.name,
                &self.parent,
                &name,
                rustix::fs::RenameFlags::NOREPLACE,
            )
            .map_err(Into::into);
            #[cfg(windows)]
            let moved = crate::sys::move_launcher_exclusive(
                &self.parent.join(self.name),
                &self.parent.join(name),
            );
            match moved {
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                other => return other,
            }
        }
        Err(io::Error::other("no unused name beside the restore"))
    }
}

#[cfg(windows)]
use std::os::windows::fs::FileTypeExt;
