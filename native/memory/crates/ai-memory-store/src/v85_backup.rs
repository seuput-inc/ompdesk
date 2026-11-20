//! Keep the last OMPdesk V85 database before refinery applies the V103 release's migrations.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::Path;

use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use tempfile::NamedTempFile;

use crate::StoreResult;

const BACKUP: &str = "memory.pre-v103.sqlite";

fn version(conn: &Connection) -> rusqlite::Result<Option<i32>> {
    conn.query_row(
        "SELECT MAX(version) FROM refinery_schema_history",
        [],
        |r| r.get(0),
    )
}

fn identity(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT id FROM store_identity WHERE singleton = 1",
        [],
        |r| r.get(0),
    )
}

fn same_schema(source: &Connection, copy: &Connection) -> rusqlite::Result<bool> {
    const OBJECTS: &str = "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name";
    let mut a = source.prepare(OBJECTS)?;
    let mut b = copy.prepare(OBJECTS)?;
    let mut a = a.query([])?;
    let mut b = b.query([])?;
    loop {
        match (a.next()?, b.next()?) {
            (Some(x), Some(y)) => {
                for i in 0..3 {
                    if x.get_ref(i)? != y.get_ref(i)? {
                        return Ok(false);
                    }
                }
            }
            (None, None) => return Ok(true),
            _ => return Ok(false),
        }
    }
}

#[cfg(windows)]
fn require_private_acl(path: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // Inspect SIDs, not localized icacls output. Reject null DACLs and ACE types
    // we cannot interpret. Neither the new file nor an existing backup is re-ACL'd.
    const CHECK: &str = r#"
$ErrorActionPreference = 'Stop'
$trusted = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
$security = [IO.File]::GetAccessControl($env:OMPDESK_BACKUP_PATH)
$sd = [Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(), 0)
if ($null -eq $sd.Owner -or $trusted -notcontains $sd.Owner.Value -or $null -eq $sd.DiscretionaryAcl) { exit 1 }
foreach ($ace in $sd.DiscretionaryAcl) {
    if ($ace.AceType -eq 'AccessDenied') { continue }
    if ($ace.AceType -ne 'AccessAllowed' -or $trusted -notcontains $ace.SecurityIdentifier.Value) { exit 1 }
}
[Console]::Out.Write('private')
exit 0"#;
    let windows = std::env::var_os("SystemRoot")
        .ok_or_else(|| io::Error::new(ErrorKind::NotFound, "Windows system directory not set"))?;
    let shell = Path::new(&windows).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let result = Command::new(shell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            CHECK,
        ])
        .env("OMPDESK_BACKUP_PATH", path)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()?;
    if result.status.success() && result.stdout == b"private" {
        Ok(())
    } else {
        Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "could not verify a private Windows ACL on the V85 backup",
        ))
    }
}

fn validate(path: &Path, source: &Connection, source_id: &str) -> StoreResult<()> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() {
        return Err(
            io::Error::new(ErrorKind::InvalidData, "V85 backup is not a regular file").into(),
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(
                io::Error::new(ErrorKind::PermissionDenied, "V85 backup is not private").into(),
            );
        }
    }
    #[cfg(windows)]
    require_private_acl(path)?;
    let copy = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let journal: String = copy.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
    if journal != "delete"
        || version(&copy)? != Some(85)
        || identity(&copy)? != source_id
        || !same_schema(source, &copy)?
    {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "V85 backup is not a standalone snapshot of this store and schema",
        )
        .into());
    }
    let integrity: String = copy.query_row("PRAGMA integrity_check(1)", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "V85 backup failed SQLite integrity_check",
        )
        .into());
    }
    Ok(())
}

pub(super) fn ensure(conn: &mut Connection, db_path: &Path) -> StoreResult<()> {
    // Only Store::open calls this; in-memory migration runners never enter here.
    // Pin the source version, identity and WAL contents to the same read snapshot.
    let source = conn.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let has_history: bool = source.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='refinery_schema_history')",
        [],
        |r| r.get(0),
    )?;
    if !has_history || version(&source)? != Some(85) {
        return Ok(());
    }
    let id = identity(&source)?;
    let dest = db_path.with_file_name(BACKUP);
    let dir = dest.parent().expect("the store database is inside db/");
    match fs::symlink_metadata(&dest) {
        Ok(_) => validate(&dest, &source, &id)?,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            let temp = NamedTempFile::new_in(dir)?;
            #[cfg(windows)]
            require_private_acl(temp.path())?;
            source.backup(
                rusqlite::MAIN_DB,
                temp.path(),
                rusqlite::backup::NO_PROGRESS,
            )?;
            // Publish one self-contained file, never a DB depending on a WAL sidecar.
            Connection::open(temp.path())?.pragma_update(None, "journal_mode", "DELETE")?;
            validate(temp.path(), &source, &id)?;
            temp.as_file().sync_all()?;
            match temp.persist_noclobber(&dest) {
                Ok(_) => (),
                Err(e) if e.error.kind() == ErrorKind::AlreadyExists => {
                    validate(&dest, &source, &id)?
                }
                Err(e) => return Err(e.error.into()),
            }
        }
        Err(e) => return Err(e.into()),
    }
    #[cfg(unix)]
    fs::File::open(dir)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DB_FILENAME, Store, migrations};

    fn private_db_dir(root: &Path) -> std::path::PathBuf {
        let dir = root.join("db");
        fs::create_dir(&dir).unwrap();
        #[cfg(windows)]
        {
            // CI's temp root need not have the same inherited ACL as a user profile.
            let user = std::process::Command::new("whoami")
                .args(["/user", "/fo", "csv", "/nh"])
                .output()
                .unwrap();
            assert!(user.status.success());
            let row = String::from_utf8_lossy(&user.stdout);
            let sid = row.trim().rsplit(',').next().unwrap().trim_matches('"');
            assert!(sid.starts_with("S-1-"));
            let acl = std::process::Command::new("icacls")
                .arg(&dir)
                .args(["/inheritance:r", "/grant:r", &format!("*{sid}:(OI)(CI)F")])
                .output()
                .unwrap();
            assert!(acl.status.success());
        }
        dir
    }

    #[cfg(windows)]
    #[test]
    fn a_readable_by_everyone_snapshot_cannot_authorize_migration() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = private_db_dir(tmp.path());
        let path = dir.join(DB_FILENAME);
        let dest = dir.join(BACKUP);
        let mut conn = Connection::open(&path).unwrap();
        migrations::run_to(&mut conn, 85).unwrap();
        ensure(&mut conn, &path).unwrap();
        let grant = std::process::Command::new("icacls")
            .arg(&dest)
            .args(["/grant", "*S-1-1-0:(R)"])
            .output()
            .unwrap();
        assert!(grant.status.success());
        let before = fs::read(&dest).unwrap();
        assert!(Store::open(tmp.path()).is_err());
        assert_eq!(version(&conn).unwrap(), Some(85));
        assert_eq!(fs::read(&dest).unwrap(), before);
    }

    #[test]
    fn store_upgrades_only_after_a_private_restartable_v85_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = private_db_dir(tmp.path());
        let db = dir.join(DB_FILENAME);
        let dest = dir.join(BACKUP);
        let mut conn = Connection::open(&db).unwrap();
        migrations::run_to(&mut conn, 85).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch("CREATE TABLE rollback_probe(value TEXT); INSERT INTO rollback_probe VALUES('committed in WAL')").unwrap();
        // A broken destination must not allow even the first migration to run.
        fs::create_dir(&dest).unwrap();
        assert!(Store::open(tmp.path()).is_err());
        assert_eq!(version(&conn).unwrap(), Some(85));
        fs::remove_dir(&dest).unwrap();
        // A completed backup of a different V85 database is not ours to replace.
        let foreign_id = {
            let mut foreign = Connection::open(&dest).unwrap();
            migrations::run_to(&mut foreign, 85).unwrap();
            identity(&foreign).unwrap()
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dest, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(Store::open(tmp.path()).is_err());
        assert_eq!(version(&conn).unwrap(), Some(85));
        assert_eq!(
            identity(&Connection::open(&dest).unwrap()).unwrap(),
            foreign_id
        );
        fs::remove_file(&dest).unwrap();
        // A restart after publication but before migration must reuse the original bytes.
        ensure(&mut conn, &db).unwrap();
        let copy = Connection::open_with_flags(&dest, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(version(&copy).unwrap(), Some(85));
        assert_eq!(identity(&copy).unwrap(), identity(&conn).unwrap());
        let value: String = copy
            .query_row("SELECT value FROM rollback_probe", [], |r| r.get(0))
            .unwrap();
        assert_eq!(value, "committed in WAL");
        drop(copy);
        let bytes = fs::read(&dest).unwrap();
        conn.execute("UPDATE rollback_probe SET value='later'", [])
            .unwrap();
        drop(conn);
        drop(Store::open(tmp.path()).unwrap());
        assert_eq!(version(&Connection::open(&db).unwrap()).unwrap(), Some(103));
        drop(Store::open(tmp.path()).unwrap());
        assert_eq!(fs::read(&dest).unwrap(), bytes);
    }

    #[test]
    fn a_fresh_or_current_store_never_creates_a_rollback_file() {
        let tmp = tempfile::tempdir().unwrap();
        for _ in 0..2 {
            drop(Store::open(tmp.path()).unwrap());
            assert!(!tmp.path().join("db").join(BACKUP).exists());
        }
    }
}
