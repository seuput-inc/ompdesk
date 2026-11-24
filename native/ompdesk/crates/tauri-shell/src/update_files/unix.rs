use crate::launcher::sha512_of;
use regex::Regex;
use rustix::fs::{AtFlags, Dir, Mode, OFlags, Stat, fstat, open, openat, statat, unlinkat};
use rustix::io::Errno;
use serde_json::Value;
use std::ffi::CStr;
use std::fmt::Write;
use std::fs::File;
use std::io;
use std::os::fd::OwnedFd;
use std::path::Path;
use std::sync::LazyLock;

static ASSET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"\Aompdesk-[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?",
        r"(?:-arm64)?(?: \([0-9]+\))?\.dmg\z"
    ))
    .unwrap()
});

// Downloads debris intentionally excludes prereleases and includes older non-triplet versions.
static DEBRIS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\Aompdesk-[0-9.]+(?:-arm64)?(?: \([0-9]+\))?\.dmg(?:\.partial|\.download-[0-9]+)\z",
    )
    .unwrap()
});

pub(crate) fn handle(
    method: &str,
    params: &Value,
    downloads: &Path,
    updates: &Path,
) -> Result<Value, String> {
    let fields = params
        .as_object()
        .ok_or("expected update file parameters")?;
    if fields.keys().any(|key| key != "asset" && key != "area") {
        return Err("unexpected update file parameter".into());
    }
    let field = |key: &str| {
        fields
            .get(key)
            .map(|v| v.as_str().ok_or("expected a string"))
            .transpose()
    };
    let area = field("area")?;
    let asset = field("asset")?;
    if asset.is_some_and(|name| !ASSET.is_match(name)) {
        return Err("invalid update asset name".into());
    }
    match (method, area, asset) {
        ("app.updateDestination", None, Some(name)) if !name.contains('(') => {
            destination(downloads, name)
        }
        ("app.updateDigest", Some("downloads"), Some(name)) => {
            digest(Area::Downloads(downloads), name)
        }
        ("app.updateDigest", Some("updates"), Some(name)) => digest(Area::Updates(updates), name),
        ("app.sweepUpdateFiles", Some("downloads"), active) => sweep_downloads(downloads, active),
        ("app.sweepUpdateFiles", Some("updates"), Some(name)) => sweep_updates(updates, name),
        _ => return Err("invalid update file method, area or asset".into()),
    }
    .map_err(|error| error.to_string())
}

const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::CLOEXEC)
    .union(OFlags::DIRECTORY);

enum Area<'a> {
    Downloads(&'a Path),
    Updates(&'a Path),
}

impl Area<'_> {
    fn open(self) -> rustix::io::Result<OwnedFd> {
        // Downloads can live on another volume. A link in place of private staging is not an update area.
        let (path, flags) = match self {
            Self::Downloads(path) => (path, DIRECTORY),
            Self::Updates(path) => (path, DIRECTORY | OFlags::NOFOLLOW),
        };
        open(path, flags, Mode::empty())
    }
}

fn destination(downloads: &Path, asset: &str) -> io::Result<Value> {
    let dir = match Area::Downloads(downloads).open() {
        Ok(dir) => dir,
        Err(Errno::NOENT) => return Ok(serde_json::to_value(downloads.join(asset))?),
        Err(err) => return Err(err.into()),
    };
    let mut candidate = std::borrow::Cow::Borrowed(asset);
    let mut suffix = 2u64;
    loop {
        match statat(&dir, &*candidate, AtFlags::SYMLINK_NOFOLLOW) {
            Err(Errno::NOENT) => {
                return Ok(serde_json::to_value(downloads.join(&*candidate))?);
            }
            Err(err) => return Err(err.into()),
            Ok(_) => {
                let next = candidate.to_mut();
                next.truncate(asset.len() - ".dmg".len());
                write!(next, " ({suffix}).dmg").expect("a String accepts formatted text");
                suffix += 1;
            }
        }
    }
}

fn digest(root: Area<'_>, asset: &str) -> io::Result<Value> {
    let file: File = openat(
        root.open()?,
        format!("{asset}.partial"),
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY,
        Mode::empty(),
    )?
    .into();
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("expected a regular installer partial"));
    }
    Ok(Value::String(sha512_of(file)?.1))
}

fn sweep_downloads(downloads: &Path, active: Option<&str>) -> io::Result<Value> {
    let mut removed = Vec::new();
    // Startup cleanup is best effort. Never recurse, even when a directory has a matching name.
    if let Ok(dir) = Area::Downloads(downloads).open()
        && let Ok(entries) = Dir::read_from(&dir)
    {
        for entry in entries.map_while(Result::ok) {
            let leaf = entry.file_name();
            let Ok(name) = leaf.to_str() else { continue };
            if !DEBRIS.is_match(name) {
                continue;
            }
            if let Some(asset) = name.strip_suffix(".partial")
                && active.is_none_or(|current| current == asset)
            {
                continue;
            }
            if unlinkat(&dir, leaf, AtFlags::empty()).is_ok() {
                removed.push(name.to_owned());
            }
        }
    }
    removed.sort_unstable();
    Ok(removed.into())
}

fn sweep_updates(updates: &Path, asset: &str) -> io::Result<Value> {
    let dir = match Area::Updates(updates).open() {
        Ok(dir) => dir,
        Err(Errno::NOENT) => return Ok(Value::Null),
        Err(err) => return Err(err.into()),
    };
    let root = fstat(&dir)?;
    let partial = format!("{asset}.partial");
    for entry in Dir::read_from(&dir)?.map_while(Result::ok) {
        let leaf = entry.file_name();
        let name = leaf.to_bytes();
        if name != b"swap.log" && name != asset.as_bytes() && name != partial.as_bytes() {
            // A busy leftover must not block the release that supersedes it.
            let _ = remove_obsolete(&dir, leaf, &root);
        }
    }
    Ok(Value::Null)
}

pub(crate) fn remove_staging_directory(updates: &Path, version: &str) -> io::Result<()> {
    let leaf = std::ffi::CString::new(version)?;
    if version.is_empty() || matches!(version, "." | "..") || version.contains('/') {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let result = (|| {
        let dir = Area::Updates(updates).open()?;
        remove_obsolete(&dir, &leaf, &fstat(&dir)?)
    })();
    match result {
        Ok(()) | Err(Errno::NOENT) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn remove_obsolete(parent: &OwnedFd, leaf: &CStr, root: &Stat) -> rustix::io::Result<()> {
    if matches!(leaf.to_bytes(), b"." | b"..") {
        return Ok(());
    }
    match unlinkat(parent, leaf, AtFlags::empty()) {
        Err(Errno::ISDIR | Errno::PERM) => {}
        result => return result,
    }
    let subdir = openat(parent, leaf, DIRECTORY | OFlags::NOFOLLOW, Mode::empty())?;
    if fstat(&subdir)?.st_dev != root.st_dev {
        return Err(Errno::XDEV);
    }
    for entry in Dir::read_from(&subdir)? {
        remove_obsolete(&subdir, entry?.file_name(), root)?;
    }
    unlinkat(parent, leaf, AtFlags::REMOVEDIR)
}
