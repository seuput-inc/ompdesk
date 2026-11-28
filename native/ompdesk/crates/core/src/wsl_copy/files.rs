use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use super::{State, invalid};

pub(super) fn directory(path: &Path, create: bool) -> io::Result<()> {
    if create {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        match builder.create(path) {
            Ok(()) => sync_parent(path)?,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e),
        }
    }
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || linked(&meta) {
        return Err(invalid("not a host store directory"));
    }
    Ok(())
}

fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    meta.is_symlink()
}

fn regular(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || linked(&meta) {
        return Err(invalid("not a host store file"));
    }
    Ok(())
}

pub(super) fn open(path: &Path) -> io::Result<File> {
    regular(path)?;
    File::open(path)
}

pub(super) fn lock(path: &Path, writing: bool) -> io::Result<File> {
    regular(path)?;
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    if writing {
        file.lock()?;
    } else {
        file.lock_shared()?;
    }
    Ok(file)
}

pub(super) fn lease(path: &Path) -> io::Result<File> {
    regular(path)?;
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    file.try_lock()?;
    Ok(file)
}

pub(super) fn create(path: &Path) -> io::Result<File> {
    let mut opts = OpenOptions::new();
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.read(true).write(true).create_new(true).open(path)
}

pub(super) fn sync_parent(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path.parent().ok_or_else(|| invalid("missing parent"))?)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn replace(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        crate::sys::replace_durable(source, target)
    }
    #[cfg(unix)]
    {
        fs::rename(source, target)?;
        sync_parent(target)
    }
}

// The session writer is exclusive. Never truncate a reused slot: a viewer can still hold its old file.
fn stage(dir: &Path) -> io::Result<(std::path::PathBuf, File)> {
    let temp = dir.join("stage");
    match fs::remove_file(&temp) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
    }
    let file = create(&temp)?;
    Ok((temp, file))
}

pub(super) fn commit(dir: &Path, state: &State) -> io::Result<()> {
    let (path, mut file) = stage(dir)?;
    let bytes = serde_json::to_vec(state)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    replace(&path, &dir.join("journal"))
}

pub(super) fn empty_slot(dir: &Path, name: &str) -> io::Result<File> {
    let (path, file) = stage(dir)?;
    file.sync_all()?;
    replace(&path, &dir.join(name))?;
    Ok(file)
}
