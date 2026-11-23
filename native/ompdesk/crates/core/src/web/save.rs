//! Host file saves from paired devices. Check uploads against the authenticated device's store before copying.

#[cfg(all(test, windows))]
use std::fs;
use std::fs::File;
#[cfg(unix)]
use std::fs::{self, FileTimes, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::uploads;
use crate::fs::{disk, error::NodeError};
use crate::server::{Call, Fault, Registry, Reply};

#[derive(Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Source {
    Inline,
    Upload {
        path: String,
        device_id: String,
        user_data: PathBuf,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Params {
    dir: String,
    target: String,
    #[serde(default)]
    overwrite: bool,
    source: Source,
}

#[derive(Serialize)]
struct Saved<'a> {
    ok: bool,
    path: &'a str,
}

fn refused(error: &str, code: Option<&str>) -> Result<Reply, Fault> {
    #[derive(Serialize)]
    struct Refused<'a> {
        ok: bool,
        error: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<&'a str>,
    }
    Reply::json(&Refused {
        ok: false,
        error,
        code,
    })
}

fn write_inline(target: &str, overwrite: bool, bytes: &[u8]) -> Result<(), NodeError> {
    let mut output = File::options()
        .write(true)
        .create(overwrite)
        .create_new(!overwrite)
        .truncate(overwrite)
        .open(target)
        .map_err(|e| NodeError::new(&e, "open", Some(target)))?;
    output
        .write_all(bytes)
        .map_err(|e| NodeError::new(&e, "write", None))
}

#[cfg(windows)]
fn copy_upload(source: &str, target: &str, overwrite: bool) -> io::Result<()> {
    crate::sys::copy_file(source, target, !overwrite)
}

#[cfg(unix)]
fn copy_upload(source: &str, target: &str, overwrite: bool) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, fchown};
    let mut input = File::open(source)?;
    let meta = input.metadata()?;
    let mut output = OpenOptions::new()
        .write(true)
        .create(overwrite)
        .create_new(!overwrite)
        .mode(meta.mode())
        .open(target)?;

    // Never truncate before comparing the open files. A second lookup could see a different entry.
    if overwrite && disk::same_entry(&meta, &output.metadata()?, source, target) {
        return Ok(());
    }

    let copied = (|| {
        if overwrite {
            output.set_len(0)?;
        }
        let _ = fchown(&output, Some(meta.uid()), Some(meta.gid()));
        output.set_permissions(meta.permissions())?;
        io::copy(
            &mut std::io::Read::take(&mut input, meta.len()),
            &mut output,
        )?;
        if let (Ok(accessed), Ok(modified)) = (meta.accessed(), meta.modified()) {
            let _ = output.set_times(
                FileTimes::new()
                    .set_accessed(accessed)
                    .set_modified(modified),
            );
        }
        Ok(())
    })();
    if copied.is_err() {
        // copyFile removes an incomplete destination only after it successfully opened it.
        let _ = fs::remove_file(target);
    }
    copied
}

fn save(call: Call) -> Result<Reply, Fault> {
    let p: Params = call.params()?;
    if !disk::stat(&p.dir).is_ok_and(|info| info.is_dir()) {
        return refused("Not a folder", Some("not_a_directory"));
    }
    let saved = match (&p.source, call.bin.as_deref()) {
        (Source::Inline, Some(bytes)) => write_inline(&p.target, p.overwrite, bytes),
        (
            Source::Upload {
                path: source,
                device_id,
                user_data,
            },
            None,
        ) => {
            if !uploads::open(user_data).owns(device_id, source) {
                return refused(
                    "Not one of this device's uploads",
                    Some("path_escapes_roots"),
                );
            }
            if source.contains('\0') {
                Err(NodeError::nul_in_path("src", source))
            } else {
                copy_upload(source, &p.target, p.overwrite).map_err(|e| {
                    NodeError::with_dest(&e, "copyfile", Some(source), Some(&p.target))
                })
            }
        }
        _ => {
            return Err(Fault::new(
                "invalid_params",
                "Only an inline save takes a binary tail",
            ));
        }
    };
    match saved {
        Ok(()) => Reply::json(&Saved {
            ok: true,
            path: &p.target,
        }),
        Err(e) if e.code == "EEXIST" => refused("A file with that name exists", Some("exists")),
        Err(e) => refused(&e.message, None),
    }
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("web.host.save", |call| {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || save(call))
                .await
                .map_err(|_| Fault::new("internal", "The file system call panicked"))?
        })
    });
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::{Value, json};

    use super::*;
    use crate::server::{Events, Scope};

    struct Folder(PathBuf);

    impl Folder {
        fn new() -> Self {
            Self(disk::make_temp_dir("ompdesk-web-save-").unwrap())
        }

        fn upload(&self, name: &str) -> PathBuf {
            let folder = self.0.join("web-uploads").join("dev1").join("fixture");
            fs::create_dir_all(&folder).unwrap();
            folder.join(name)
        }

        fn source(&self, file: &Path) -> Value {
            json!({ "upload": { "path": file, "userData": self.0, "deviceId": "dev1" } })
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn request(params: Value, bytes: Option<&[u8]>) -> Result<Value, Fault> {
        let (events, _tx, _rx) = Events::capture();
        let reply = save(Call {
            params: serde_json::value::to_raw_value(&params).unwrap(),
            bin: bytes.map(<[u8]>::to_vec),
            events,
            scope: Scope::detached(),
        })?;
        Ok(serde_json::from_str(reply.result.get()).unwrap())
    }

    fn params(dir: &Path, source: Value, overwrite: bool) -> Value {
        json!({ "dir": dir, "target": dir.join("saved"), "source": source, "overwrite": overwrite })
    }

    #[test]
    fn only_explicit_inline_bytes_write_even_an_empty_file() {
        let dir = Folder::new();
        let target = dir.0.join("saved");
        let new = params(&dir.0, json!("inline"), false);
        let replace = params(&dir.0, json!("inline"), true);
        let ok = json!({ "ok": true, "path": target });
        assert_eq!(request(new.clone(), Some(&[0, 255, 7])).unwrap(), ok);
        assert_eq!(
            request(new, Some(b"x")).unwrap(),
            json!({
                "ok": false, "code": "exists", "error": "A file with that name exists"
            })
        );
        assert_eq!(
            request(replace.clone(), None).unwrap_err().code,
            "invalid_params"
        );
        assert_eq!(fs::read(&target).unwrap(), [0, 255, 7]);
        assert_eq!(request(replace, Some(b"")).unwrap(), ok);
        assert!(fs::read(target).unwrap().is_empty());
    }

    #[test]
    fn a_bad_folder_precedes_a_denied_upload_and_raw_paths_are_not_sources() {
        let dir = Folder::new();
        let secret = dir.0.join("other-device");
        fs::write(&secret, b"private").unwrap();
        for bad in [&secret, &dir.0.join("missing")] {
            assert_eq!(
                request(params(bad, dir.source(&secret), true), None).unwrap(),
                json!({
                    "ok": false, "code": "not_a_directory", "error": "Not a folder"
                })
            );
        }
        let denied = params(&dir.0, dir.source(&secret), true);
        assert_eq!(
            request(denied, None).unwrap(),
            json!({
                "ok": false, "code": "path_escapes_roots", "error": "Not one of this device's uploads"
            })
        );
        let mut spoofed = params(&dir.0, json!("inline"), true);
        spoofed["uploadPath"] = json!(secret);
        assert_eq!(
            request(spoofed, Some(b"x")).unwrap_err().code,
            "invalid_params"
        );
        let escaped = dir.upload("..").join("..").join("other-device");
        assert_eq!(
            request(params(&dir.0, dir.source(&escaped), true), None).unwrap()["code"],
            "path_escapes_roots"
        );
        assert_eq!(
            request(params(&dir.0, json!({ "ownedUpload": secret }), true), None)
                .unwrap_err()
                .code,
            "invalid_params"
        );
        assert_eq!(
            request(params(&dir.0, json!(secret), true), None)
                .unwrap_err()
                .code,
            "invalid_params"
        );
        assert!(!dir.0.join("saved").exists());
    }

    #[test]
    fn an_upload_copies_exclusively_and_a_missing_source_precedes_a_collision() {
        let dir = Folder::new();
        let source = dir.upload("upload");
        let target = dir.0.join("saved");
        let own = dir.source(&source);
        fs::write(&source, b"first").unwrap();
        let new = params(&dir.0, own.clone(), false);
        let ok = json!({ "ok": true, "path": target });
        assert_eq!(request(new.clone(), None).unwrap(), ok);
        fs::write(&source, b"x").unwrap();
        assert_eq!(request(new.clone(), None).unwrap()["code"], "exists");
        assert_eq!(fs::read(&target).unwrap(), b"first");
        assert_eq!(request(params(&dir.0, own, true), None).unwrap(), ok);
        assert_eq!(fs::read(&target).unwrap(), b"x");
        fs::remove_file(&source).unwrap();
        let error = format!(
            "ENOENT: no such file or directory, copyfile '{}' -> '{}'",
            source.display(),
            target.display()
        );
        assert_eq!(
            request(new, None).unwrap(),
            json!({ "ok": false, "error": error })
        );
        assert_eq!(fs::read(target).unwrap(), b"x");
    }

    #[test]
    fn copying_over_the_upload_or_its_hard_link_does_not_truncate_it() {
        let dir = Folder::new();
        let target = dir.upload("saved");
        let alias = dir.upload("alias");
        let dest = target.parent().unwrap();
        fs::write(&target, b"keep").unwrap();
        fs::hard_link(&target, &alias).unwrap();
        for source in [&target, &alias] {
            let own = dir.source(source);
            assert_eq!(
                request(params(dest, own.clone(), false), None).unwrap()["code"],
                "exists"
            );
            assert_eq!(
                request(params(dest, own, true), None).unwrap(),
                json!({ "ok": true, "path": target })
            );
            assert_eq!(fs::read(&target).unwrap(), b"keep");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_destination_is_not_overwritten_and_an_upload_keeps_its_streams() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = Folder::new();
        let source = dir.upload("upload");
        let target = dir.0.join("saved");
        fs::write(&source, b"new").unwrap();
        fs::write(dir.upload("upload:note"), b"extra").unwrap();
        fs::write(&target, b"old").unwrap();
        let held = File::options()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();
        let save = params(&dir.0, dir.source(&source), true);
        assert_eq!(request(save.clone(), None).unwrap()["ok"], false);
        drop(held);
        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert_eq!(request(save, None).unwrap()["ok"], true);
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read(dir.0.join("saved:note")).unwrap(), b"extra");
    }

    #[cfg(unix)]
    #[test]
    fn copies_private_permissions_and_mtime_and_follows_a_destination_link() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        use std::time::{Duration, UNIX_EPOCH};

        let dir = Folder::new();
        let target = dir.0.join("saved");
        let source = dir.upload("upload");
        let backing = dir.0.join("backing");
        fs::write(&source, b"new").unwrap();
        fs::write(&backing, b"previous").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        let stamp = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        File::open(&source).unwrap().set_modified(stamp).unwrap();
        symlink(&backing, &target).unwrap();
        let save = params(&dir.0, dir.source(&source), true);
        assert_eq!(request(save, None).unwrap()["ok"], true);
        assert!(target.is_symlink());
        assert_eq!(fs::read(&backing).unwrap(), b"new");
        let meta = fs::metadata(backing).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        assert_eq!(meta.modified().unwrap(), stamp);
    }
}
