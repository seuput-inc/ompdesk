use std::{fs::File, io, path::Path};

#[cfg(target_os = "macos")]
#[path = "files/macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "files/windows.rs"]
mod platform;

/// Tauri supplies the trusted profile location. Descendants are opened relative to directory
/// handles. Rotation may change which regular file is selected, not the open handle's target.
/// This checks entry types, not provenance (including hard links) or file contents.
pub(super) fn open(profile: &Path, archive: bool) -> io::Result<File> {
    #[cfg(any(target_os = "macos", windows))]
    {
        platform::open(profile, archive)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (profile, archive);
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}

#[cfg(all(test, any(target_os = "macos", windows)))]
mod tests {
    use super::*;
    use std::{fs, io::Read};
    use tempfile::tempdir;

    #[test]
    fn selects_current_or_archive_and_preserves_missing_errors() -> io::Result<()> {
        let profile = tempdir()?;
        let logs = profile.path().join("logs");
        assert_eq!(
            open(profile.path(), false).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        fs::create_dir(&logs)?;
        fs::write(logs.join("gui-runtime.jsonl"), "current")?;
        assert_eq!(
            open(profile.path(), true).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        fs::write(logs.join("gui-runtime.jsonl.1"), "previous")?;
        for (archive, expected) in [(false, "current"), (true, "previous")] {
            let mut text = String::new();
            open(profile.path(), archive)?.read_to_string(&mut text)?;
            assert_eq!(text, expected);
        }
        Ok(())
    }

    #[test]
    fn rejects_linked_logs_directory_and_linked_leaf() -> io::Result<()> {
        #[cfg(target_os = "macos")]
        use std::os::unix::fs::{symlink as symlink_dir, symlink as symlink_file};
        #[cfg(windows)]
        use std::os::windows::fs::{symlink_dir, symlink_file};

        let outside = tempdir()?;
        let target = outside.path().join("gui-runtime.jsonl");
        fs::write(&target, "synthetic")?;
        let linked = tempdir()?;
        symlink_dir(outside.path(), linked.path().join("logs"))?;
        assert!(open(linked.path(), false).is_err());
        let profile = tempdir()?;
        let logs = profile.path().join("logs");
        fs::create_dir(&logs)?;
        symlink_file(target, logs.join("gui-runtime.jsonl.1"))?;
        assert!(open(profile.path(), true).is_err());
        fs::create_dir(logs.join("gui-runtime.jsonl"))?;
        assert!(open(profile.path(), false).is_err());
        Ok(())
    }
}
