use std::fs;
use std::io::{self, ErrorKind};
use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
enum Migration {
    Moved,
    Copied,
    Skipped,
}

/// Called only by the owner of the default profile, before opening even the shell log.
pub(super) fn migrate(user_data: &Path) -> Option<String> {
    let legacy = user_data.with_file_name("seucode");
    match migrate_with(user_data, &legacy, |a, b| fs::rename(a, b), copy_tree) {
        Ok(Migration::Skipped) => None,
        Ok(Migration::Moved) => Some("Legacy profile moved into userData".into()),
        Ok(Migration::Copied) => Some("Legacy profile copied into userData".into()),
        Err(error) => Some(format!("Legacy profile migration failed: {error}")),
    }
}

fn migrate_with(
    user_data: &Path,
    legacy: &Path,
    rename_legacy: impl FnOnce(&Path, &Path) -> io::Result<()>,
    copy: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<Migration> {
    if legacy == user_data || !legacy.is_dir() {
        return Ok(Migration::Skipped);
    }
    // Two Unix launches reclaiming a stale instance socket can both enter. Keep stale-stage
    // cleanup, copying and publication under the same lock, released by the OS even on a crash.
    #[cfg(unix)]
    let _source_lock = {
        use std::os::unix::fs::MetadataExt;
        let source = match fs::File::open(legacy) {
            Ok(source) => source,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Migration::Skipped),
            Err(error) => return Err(error),
        };
        source.lock()?;
        let opened = source.metadata()?;
        if !fs::metadata(legacy).is_ok_and(|m| m.dev() == opened.dev() && m.ino() == opened.ino()) {
            return Ok(Migration::Skipped);
        }
        source
    };
    let empty_dir = match fs::read_dir(user_data) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return Ok(Migration::Skipped);
            }
            true
        }
        Err(error) if error.kind() == ErrorKind::NotFound && !user_data.is_symlink() => false,
        _ => return Ok(Migration::Skipped),
    };
    let staging = user_data.with_added_extension("migrating");
    if legacy.is_symlink() {
        let source = legacy.canonicalize()?;
        // Removing an apparently stale stage must not delete the legacy link's actual contents.
        if [staging.as_path(), user_data]
            .into_iter()
            .any(|path| path.canonicalize().is_ok_and(|p| source.starts_with(p)))
        {
            return Ok(Migration::Skipped);
        }
    }
    let result = (|| {
        remove_staging(&staging)?;
        if empty_dir {
            // Never recursively remove the destination: it might no longer be empty.
            fs::remove_dir(user_data)?;
        }
        if rename_legacy(legacy, user_data).is_ok() {
            return Ok(Migration::Moved);
        }
        copy(legacy, &staging)?;
        fs::rename(&staging, user_data)?;
        Ok(Migration::Copied)
    })();
    if result.is_err() {
        let cleanup = remove_staging(&staging);
        fs::create_dir_all(user_data)?;
        cleanup?;
    }
    result
}

fn remove_staging(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        #[cfg(windows)]
        Ok(metadata)
            if std::os::windows::fs::FileTypeExt::is_symlink_dir(&metadata.file_type()) =>
        {
            fs::remove_dir(path)
        }
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.is_symlink() {
        let link = fs::read_link(source)?;
        #[cfg(unix)]
        return std::os::unix::fs::symlink(link, target);
        #[cfg(windows)]
        {
            use std::os::windows::fs::{FileTypeExt, symlink_dir, symlink_file};
            return if metadata.file_type().is_symlink_dir() {
                symlink_dir(link, target)
            } else {
                symlink_file(link, target)
            };
        }
    }
    if metadata.is_dir() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(target)?;
        }
        #[cfg(not(unix))]
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
        return fs::set_permissions(target, metadata.permissions());
    }
    if !metadata.is_file() {
        return Err(io::Error::other(format!(
            "Cannot copy {}: not a regular file",
            source.display()
        )));
    }
    fs::copy(source, target)?;
    let mut options = fs::File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_WRITE_ATTRIBUTES;
        options.access_mode(FILE_WRITE_ATTRIBUTES);
    }
    options.open(target)?.set_times(
        fs::FileTimes::new()
            .set_accessed(fs::metadata(source)?.accessed()?)
            .set_modified(metadata.modified()?),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(legacy: &Path) {
        fs::create_dir_all(legacy.join("Local Storage")).unwrap();
        fs::write(legacy.join("prefs.json"), r#"{"lastProject":"/work"}"#).unwrap();
        fs::write(legacy.join("Local Storage/leveldb.log"), "state").unwrap();
    }

    fn assert_profile(path: &Path) {
        assert_eq!(
            fs::read_to_string(path.join("prefs.json")).unwrap(),
            r#"{"lastProject":"/work"}"#
        );
        assert_eq!(
            fs::read(path.join("Local Storage/leveldb.log")).unwrap(),
            b"state"
        );
    }

    fn cross_device(_: &Path, _: &Path) -> io::Result<()> {
        Err(ErrorKind::CrossesDevices.into())
    }

    #[test]
    fn moves_into_an_absent_or_empty_profile() {
        for empty in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let legacy = root.path().join("seucode");
            let profile = root.path().join("ompdesk");
            seed(&legacy);
            if empty {
                fs::create_dir(&profile).unwrap();
            }
            assert_eq!(
                migrate(&profile).as_deref(),
                Some("Legacy profile moved into userData")
            );
            assert_profile(&profile);
            assert!(!legacy.exists());
            assert_eq!(migrate(&profile), None);
        }
    }

    #[test]
    fn skips_missing_file_same_and_used_profiles() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("seucode");
        let profile = root.path().join("ompdesk");
        assert_eq!(migrate(&profile), None);
        fs::write(&legacy, "not a profile").unwrap();
        assert_eq!(migrate(&profile), None);
        assert!(!profile.exists());
        fs::remove_file(&legacy).unwrap();
        fs::create_dir(&legacy).unwrap();
        assert_eq!(
            migrate_with(&legacy, &legacy, cross_device, copy_tree).unwrap(),
            Migration::Skipped
        );
        seed(&legacy);
        fs::create_dir(&profile).unwrap();
        fs::write(profile.join("prefs.json"), "{}").unwrap();
        assert_eq!(migrate(&profile), None);
        assert_eq!(fs::read(profile.join("prefs.json")).unwrap(), b"{}");
        assert_profile(&legacy);
    }

    #[test]
    fn stages_an_entire_copy_after_a_failed_rename_and_keeps_the_source() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("seucode");
        let profile = root.path().join("ompdesk");
        let stage = root.path().join("ompdesk.migrating");
        seed(&legacy);
        let prefs = legacy.join("prefs.json");
        let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_500_000_000);
        fs::File::options()
            .write(true)
            .open(&prefs)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::{PermissionsExt, symlink};
            fs::set_permissions(&prefs, fs::Permissions::from_mode(0o400)).unwrap();
            symlink("../missing", legacy.join("link")).unwrap();
        }
        fs::create_dir(&stage).unwrap();
        fs::write(stage.join("stale"), "from an interrupted copy").unwrap();
        assert_eq!(
            migrate_with(&profile, &legacy, cross_device, copy_tree).unwrap(),
            Migration::Copied
        );
        assert_profile(&profile);
        assert_profile(&legacy);
        assert!(!stage.exists());
        assert!(!profile.join("stale").exists());
        let metadata = fs::metadata(profile.join("prefs.json")).unwrap();
        assert_eq!(metadata.modified().unwrap(), modified);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(metadata.permissions().mode() & 0o777, 0o400);
            assert_eq!(
                fs::read_link(profile.join("link")).unwrap(),
                Path::new("../missing")
            );
        }
    }

    #[test]
    fn discards_a_partial_copy_and_recreates_the_empty_destination() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("seucode");
        let profile = root.path().join("ompdesk");
        seed(&legacy);
        let error = migrate_with(&profile, &legacy, cross_device, |_, stage| {
            fs::create_dir(stage)?;
            fs::write(stage.join("partial"), "not a profile")?;
            Err(io::Error::other("disk full"))
        })
        .unwrap_err();
        assert_eq!(error.to_string(), "disk full");
        assert_eq!(fs::read_dir(&profile).unwrap().count(), 0);
        assert!(!root.path().join("ompdesk.migrating").exists());
        assert_profile(&legacy);
        assert!(migrate(&profile).is_some());
        assert_profile(&profile);
    }

    #[test]
    fn never_replaces_a_destination_populated_while_copying() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("seucode");
        let profile = root.path().join("ompdesk");
        seed(&legacy);
        assert!(
            migrate_with(&profile, &legacy, cross_device, |source, stage| {
                copy_tree(source, stage)?;
                fs::create_dir(&profile)?;
                fs::write(profile.join("prefs.json"), "{}")
            })
            .is_err()
        );
        assert_profile(&legacy);
        assert_eq!(fs::read(profile.join("prefs.json")).unwrap(), b"{}");
        assert!(!root.path().join("ompdesk.migrating").exists());
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_copies_cannot_clean_or_publish_each_others_stage() {
        use std::sync::mpsc;

        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("seucode");
        let profile = root.path().join("ompdesk");
        seed(&legacy);
        let (staged, partial) = mpsc::channel();
        let (contended, resume) = mpsc::channel();
        std::thread::scope(|threads| {
            let (profile, legacy) = (profile.as_path(), legacy.as_path());
            let first = threads.spawn(move || {
                migrate_with(profile, legacy, cross_device, |source, stage| {
                    fs::create_dir(stage)?;
                    fs::copy(source.join("prefs.json"), stage.join("prefs.json"))?;
                    staged.send(()).unwrap();
                    resume.recv().unwrap();
                    copy_tree(&source.join("Local Storage"), &stage.join("Local Storage"))
                })
            });
            partial.recv().unwrap();
            let second = threads.spawn(move || {
                let lock = fs::File::open(legacy).unwrap().try_lock();
                contended.send(()).unwrap();
                assert!(matches!(lock, Err(fs::TryLockError::WouldBlock)));
                migrate_with(profile, legacy, cross_device, copy_tree)
            });
            assert_eq!(first.join().unwrap().unwrap(), Migration::Copied);
            assert_eq!(second.join().unwrap().unwrap(), Migration::Skipped);
        });
        assert_profile(&profile);
        assert_profile(&legacy);
        assert!(!root.path().join("ompdesk.migrating").exists());
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_directory_is_copied_and_a_locked_file_is_reported() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ,
        };

        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("seucode");
        let profile = root.path().join("ompdesk");
        seed(&legacy);
        let _no_rename = fs::File::options()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&legacy)
            .unwrap();
        let no_copy = fs::File::options()
            .read(true)
            .share_mode(0)
            .open(legacy.join("prefs.json"))
            .unwrap();
        assert!(
            migrate(&profile)
                .unwrap()
                .starts_with("Legacy profile migration failed: ")
        );
        assert_eq!(fs::read_dir(&profile).unwrap().count(), 0);
        assert!(!root.path().join("ompdesk.migrating").exists());
        drop(no_copy);
        assert_eq!(
            migrate(&profile).as_deref(),
            Some("Legacy profile copied into userData")
        );
        assert_profile(&profile);
        assert_profile(&legacy);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_clean_a_stage_that_contains_the_legacy_profile() {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("ompdesk.migrating/nested");
        seed(&original);
        std::os::unix::fs::symlink(&original, root.path().join("seucode")).unwrap();
        let profile = root.path().join("ompdesk");
        assert_eq!(migrate(&profile), None);
        assert_profile(&original);
        assert!(!profile.exists());
    }
}
