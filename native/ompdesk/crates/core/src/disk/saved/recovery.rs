//! Decide whether the original still holds every archived byte, and put those bytes back after checkout and seeding.

use std::fs::File;
use std::io::{self, BufReader, Read, Seek};
use std::path::Path;

use super::entry::{Entry, Kind};
use super::{ARCHIVE_MAX_BYTES, Manifest, keep, mode_of};
use crate::disk::tree::{fault, live, relative_entries, remove};
use crate::server::{Fault, Scope};

type Buffers = ([u8; 16 * 1024], [u8; 16 * 1024]);

fn manifest(worktree: &str, archive: &Path, counts: (usize, u64)) -> Result<Manifest, Fault> {
    let name = Path::new("manifest.json");
    let file = Entry::at(archive, name, false)
        .and_then(|e| e.file(false))
        .map_err(|e| fault(&e, "open", &archive.join(name)))?;
    let manifest: Manifest = serde_json::from_reader(BufReader::new(file))
        .map_err(|e| Fault::new("archive_manifest", e.to_string()))?;
    if manifest.worktree != worktree
        || manifest.files.len() != counts.0
        || counts.1 > ARCHIVE_MAX_BYTES
        || manifest
            .files
            .iter()
            .try_fold(0u64, |n, f| n.checked_add(f.size))
            != Some(counts.1)
    {
        return Err(keep(
            "the archive manifest does not match the saved worktree",
        ));
    }
    relative_entries(manifest.files.iter().map(|f| f.path.as_str()))?;
    Ok(manifest)
}

/// Bounded read through regular-file handles: a read error, a changed stamp or a replaced name cannot prove equality.
fn same_bytes(
    a: (&Entry<'_>, &File),
    b: (&Entry<'_>, &File),
    size: u64,
    (one, two): &mut Buffers,
    scope: &Scope,
) -> io::Result<bool> {
    let ((a, mut left), (b, mut right)) = (a, b);
    let before = (left.metadata()?, right.metadata()?);
    if size > ARCHIVE_MAX_BYTES || before.0.len() != size || before.1.len() != size {
        return Ok(false);
    }
    let times = (before.0.modified()?, before.1.modified()?);
    let mut remaining = size;
    while remaining != 0 {
        if scope.cancelled() {
            return Ok(false);
        }
        let n = remaining.min(one.len() as u64) as usize;
        left.read_exact(&mut one[..n])?;
        right.read_exact(&mut two[..n])?;
        if one[..n] != two[..n] {
            return Ok(false);
        }
        remaining -= n as u64;
    }
    let after = (left.metadata()?, right.metadata()?);
    Ok(after.0.len() == size
        && after.1.len() == size
        && times == (after.0.modified()?, after.1.modified()?)
        && a.still_names(left)?
        && b.still_names(right)?
        && !scope.cancelled())
}

pub(in crate::disk) fn sources_present(
    worktree: &str,
    archive: &Path,
    counts: (usize, u64),
    scope: &Scope,
) -> Result<bool, Fault> {
    let Ok(m) = manifest(worktree, archive, counts) else {
        return Ok(false);
    };
    for f in m.files {
        live(scope)?;
        let kind = Entry::at(Path::new(worktree), Path::new(&f.path), false).and_then(|e| e.kind());
        if !kind.is_ok_and(|k| k == if f.link { Kind::Link } else { Kind::File }) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The current source and its archive agree, including every private ignored file that git now sees.
pub(in crate::disk) fn matches(
    worktree: &str,
    archive: &Path,
    counts: (usize, u64),
    required: &[u8],
    scope: &Scope,
) -> Result<bool, Fault> {
    live(scope)?;
    let Ok(manifest) = manifest(worktree, archive, counts) else {
        return Ok(false);
    };
    if !required.is_empty() {
        let mut missing: std::collections::HashSet<_> = required
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .collect();
        for f in &manifest.files {
            missing.remove(f.path.as_bytes());
        }
        if !missing.is_empty() {
            return Ok(false);
        }
    }
    let mut buffers: Buffers = ([0; 16 * 1024], [0; 16 * 1024]);
    for f in manifest.files {
        live(scope)?;
        let relative = Path::new(&f.path);
        let copy = Path::new("files").join(relative);
        let same = (|| -> io::Result<bool> {
            let original = Entry::at(Path::new(worktree), relative, false)?;
            let archived = Entry::at(archive, &copy, false)?;
            if f.link {
                if original.kind()? != Kind::Link || archived.kind()? != Kind::Link {
                    return Ok(false);
                }
                let text = original.read_link()?;
                return Ok(text.as_os_str() == archived.read_link()?.as_os_str()
                    && text.as_os_str() == original.read_link()?.as_os_str());
            }
            let a = original.file(false)?;
            let b = archived.file(false)?;
            Ok(mode_of(&a.metadata()?) == f.mode
                && same_bytes(
                    (&original, &a),
                    (&archived, &b),
                    f.size,
                    &mut buffers,
                    scope,
                )?)
        })();
        if !same.unwrap_or(false) {
            return Ok(false);
        }
    }
    live(scope)?;
    Ok(true)
}

/// After a refused or partial removal, only a demonstrably intact original may give up its recovery copy.
pub(in crate::disk) fn settle(
    worktree: &str,
    archive: &str,
    counts: (usize, u64),
    scope: &Scope,
) -> Result<bool, Fault> {
    let archive = Path::new(archive);
    if !matches(worktree, archive, counts, &[], scope)? {
        return Ok(false);
    }
    remove(archive, false, scope)?;
    Ok(true)
}

pub(in crate::disk) fn restore(
    worktree: &str,
    root: &File,
    archive: &str,
    counts: (usize, u64),
    scope: &Scope,
) -> Result<(usize, usize), Fault> {
    let archive = Path::new(archive);
    let manifest = manifest(worktree, archive, counts)?;
    let mut buffers: Buffers = ([0; 16 * 1024], [0; 16 * 1024]);
    let (mut restored, mut skipped) = (0, 0);
    for f in manifest.files {
        live(scope)?;
        let relative = Path::new(&f.path);
        let copy = Path::new("files").join(relative);
        let from = Entry::at(archive, &copy, false).map_err(|e| fault(&e, "open", &copy))?;
        let input = if f.link {
            None
        } else {
            let input = from.file(false).map_err(|e| fault(&e, "open", &copy))?;
            let stat = input.metadata().map_err(|e| fault(&e, "stat", &copy))?;
            if stat.len() != f.size {
                return Err(keep("the archived file no longer matches its manifest"));
            }
            Some((
                input,
                stat.modified().map_err(|e| fault(&e, "stat", &copy))?,
            ))
        };
        let link = if f.link {
            Some(from.read_link().map_err(|e| fault(&e, "readlink", &copy))?)
        } else {
            None
        };
        live(scope)?;
        let Ok(target) = root
            .try_clone()
            .and_then(|f| Entry::in_dir(f, relative, true))
        else {
            // A hook may have put a link or a file where we need a directory. Keep the record, archive and hook's entry.
            skipped += 1;
            continue;
        };
        match target.kind() {
            Ok(Kind::Directory | Kind::Other) => {
                skipped += 1;
                continue;
            }
            Ok(kind) => {
                if let Some((input, _)) = &input
                    && kind == Kind::File
                {
                    if target
                        .file(false)
                        .and_then(|to| {
                            same_bytes((&from, input), (&target, &to), f.size, &mut buffers, scope)
                        })
                        .unwrap_or(false)
                    {
                        restored += 1;
                        continue;
                    }
                } else if let Some(text) = &link
                    && kind == Kind::Link
                    && target
                        .read_link()
                        .is_ok_and(|t| t.as_os_str() == text.as_os_str())
                {
                    restored += 1;
                    continue;
                }
                live(scope)?;
                if f.overwrite {
                    target.remove()
                } else {
                    target.move_aside()
                }
                .map_err(|e| fault(&e, "rename", relative))?;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(fault(&e, "lstat", relative)),
        }
        live(scope)?;
        if let Some(text) = link {
            target
                .link(&text)
                .map_err(|e| fault(&e, "symlink", relative))?;
        } else if let Some((mut input, modified)) = input {
            input.rewind().map_err(|e| fault(&e, "read", &copy))?;
            let mut output = target.file(true).map_err(|e| fault(&e, "open", relative))?;
            let n = io::copy(&mut (&mut input).take(f.size + 1), &mut output)
                .map_err(|e| fault(&e, "copyfile", relative))?;
            if n != f.size
                || input.metadata().and_then(|m| m.modified()).ok() != Some(modified)
                || !from.still_names(&input).unwrap_or(false)
            {
                return Err(keep("the archived file changed during restore"));
            }
            live(scope)?;
            #[cfg(unix)]
            let perms = <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(
                f.mode & 0o777,
            );
            #[cfg(windows)]
            let perms = {
                let mut p = output
                    .metadata()
                    .map_err(|e| fault(&e, "stat", relative))?
                    .permissions();
                p.set_readonly(f.mode & 0o200 == 0);
                p
            };
            output
                .set_permissions(perms)
                .map_err(|e| fault(&e, "chmod", relative))?;
            if !target.still_names(&output).unwrap_or(false) {
                return Err(keep("the restored file moved during restore"));
            }
        }
        restored += 1;
    }
    live(scope)?;
    Ok((restored, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn a_changed_file_of_the_same_length_or_an_unproven_manifest_keeps_the_archive() {
        let root = crate::fs::disk::make_temp_dir("ompdesk-saved-proof-").unwrap();
        let worktree = root.join("work");
        let archive = root.join("archive");
        fs::create_dir(&worktree).unwrap();
        fs::write(worktree.join("mine"), b"first").unwrap();
        let (wt, dir) = (worktree.to_str().unwrap(), archive.to_str().unwrap());
        let scope = Scope::detached();
        let counts = super::super::write_archive(wt, &["mine".into()], dir, &[], &scope).unwrap();
        fs::write(worktree.join("mine"), b"later").unwrap();
        assert!(!settle(wt, dir, counts, &scope).unwrap());
        assert_eq!(fs::read(archive.join("files/mine")).unwrap(), b"first");
        fs::write(worktree.join("mine"), b"first").unwrap();
        assert!(!matches(wt, &archive, counts, b"mine\0new-private\0", &scope).unwrap());
        assert!(!settle(wt, dir, (counts.0 + 1, counts.1), &scope).unwrap());
        assert!(settle(wt, dir, counts, &scope).unwrap());
        assert!(!archive.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_hook_directory_link_skips_the_entry_and_preserves_both_copies() {
        let root = crate::fs::disk::make_temp_dir("ompdesk-restore-folder-").unwrap();
        let worktree = root.join("work");
        let archive = root.join("archive");
        let elsewhere = root.join("hook-defaults");
        fs::create_dir_all(worktree.join("config")).unwrap();
        fs::create_dir(&elsewhere).unwrap();
        fs::write(worktree.join("config/value"), b"local").unwrap();
        fs::write(elsewhere.join("value"), b"default").unwrap();
        let (wt, dir) = (worktree.to_str().unwrap(), archive.to_str().unwrap());
        let scope = Scope::detached();
        let counts =
            super::super::write_archive(wt, &["config/".into()], dir, &[], &scope).unwrap();
        fs::rename(worktree.join("config"), root.join("old-config")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&elsewhere, worktree.join("config")).unwrap();
        #[cfg(windows)]
        crate::sys::junction(&elsewhere, &worktree.join("config")).unwrap();
        assert_eq!(
            restore(
                wt,
                &super::super::entry::directory(&worktree).unwrap(),
                dir,
                counts,
                &scope
            )
            .unwrap(),
            (0, 1)
        );
        assert_eq!(fs::read(elsewhere.join("value")).unwrap(), b"default");
        assert_eq!(
            fs::read(archive.join("files/config/value")).unwrap(),
            b"local"
        );
        crate::disk::tree::remove(&root, false, &scope).unwrap();
    }
}
