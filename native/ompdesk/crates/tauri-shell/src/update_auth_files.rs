use serde_json::{Value, json};
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::Path;

const TOKEN: &str = "update-token.bin";
const MARKER: &str = "update-token.dropped";
const WOULD_ASK: &str = "keychain-would-ask";

pub(crate) fn read(profile: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(profile.join(TOKEN)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub(crate) fn status(profile: &Path) -> Value {
    let marker = fs::read(profile.join(MARKER)).ok();
    let reason = marker.as_deref().map(String::from_utf8_lossy);
    json!({
        "hasStoredToken": profile.join(TOKEN).exists(),
        "droppedReason": reason.as_deref().map(str::trim).filter(|text| !text.is_empty()),
    })
}

fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn replace(profile: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    // NamedTempFile creates the sibling with mode 0600 on Unix, including on replacement.
    let mut file = tempfile::NamedTempFile::new_in(profile)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    crate::profile_file::persist(file, &profile.join(name))
}

pub(crate) fn save(profile: &Path, ciphertext: &[u8]) -> io::Result<()> {
    fs::create_dir_all(profile)?;
    replace(profile, TOKEN, ciphertext)?;
    remove(&profile.join(MARKER))
}

pub(crate) fn drop_token(profile: &Path) -> io::Result<()> {
    remove(&profile.join(TOKEN))?;
    replace(profile, MARKER, WOULD_ASK.as_bytes())
}

pub(crate) fn clear(profile: &Path) -> io::Result<()> {
    remove(&profile.join(TOKEN))?;
    remove(&profile.join(MARKER))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ciphertext_and_marker_survive_separate_operations() -> io::Result<()> {
        let temp = tempfile::tempdir()?;
        let profile = temp.path().join("profile");
        assert_eq!(read(&profile)?, None);
        let bytes = [0, 10, 255];
        save(&profile, &bytes)?;
        assert_eq!(read(&profile)?.as_deref(), Some(bytes.as_slice()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(profile.join(TOKEN))?.permissions().mode() & 0o777,
                0o600
            );
        }
        drop_token(&profile)?;
        assert_eq!(read(&profile)?, None);
        assert_eq!(
            status(&profile),
            json!({"hasStoredToken":false,"droppedReason":WOULD_ASK})
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(profile.join(MARKER))?.permissions().mode() & 0o777,
                0o600
            );
        }
        save(&profile, &[])?;
        assert_eq!(read(&profile)?, Some(vec![]));
        assert_eq!(
            status(&profile),
            json!({"hasStoredToken":true,"droppedReason":null})
        );
        clear(&profile)?;
        clear(&profile)?;
        assert_eq!(
            status(&profile),
            json!({"hasStoredToken":false,"droppedReason":null})
        );
        Ok(())
    }

    #[test]
    fn failure_of_first_mutation_preserves_marker() -> io::Result<()> {
        let temp = tempfile::tempdir()?;
        let profile = temp.path();
        fs::create_dir(profile.join(TOKEN))?;
        fs::write(profile.join(MARKER), "old")?;
        assert!(read(profile).is_err());
        assert!(drop_token(profile).is_err());
        assert!(save(profile, b"new").is_err());
        assert!(clear(profile).is_err());
        assert_eq!(fs::read(profile.join(MARKER))?, b"old");
        Ok(())
    }

    #[test]
    fn failure_of_marker_mutation_reports_committed_token_change() -> io::Result<()> {
        let temp = tempfile::tempdir()?;
        let profile = temp.path();
        fs::create_dir(profile.join(MARKER))?;
        assert!(save(profile, b"new").is_err());
        assert_eq!(read(profile)?.as_deref(), Some(b"new".as_slice()));
        assert!(drop_token(profile).is_err());
        assert_eq!(read(profile)?, None);
        fs::write(profile.join(TOKEN), b"again")?;
        assert!(clear(profile).is_err());
        assert_eq!(read(profile)?, None);
        Ok(())
    }
}
