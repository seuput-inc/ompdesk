//! A composer draft's pictures (was `src/main/draft-pictures.ts`): raw bytes kept under
//! `<root>/<owner>/<id>` (`desktop` or `device-<sha256[..32]>`), folders 0700 and files 0600, so
//! pending draft attachments survive a relaunch of the app or of a phone's page.
//!
//! Each owner directory has its own serial lane enqueued on the server read loop before the next
//! frame is read, so a remove or read made after a put never overtakes it, while different owners
//! run concurrently. Picture bytes travel in the wire `bin` tail, never base64.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};

use crate::disk::tree::{fault, remove, write_atomic_if};
use crate::server::{Answer, Call, Fault, Registry, Reply, Scope, at_once};

/// One picture's bytes at most: a phone's upload limit (`web/uploads.rs`), so any picture a page
/// can send it can keep.
pub const MAX_PICTURE_BYTES: usize = 25 * 1024 * 1024;
/// One owner's pictures together at most: a renderer that lost its drafts (and with them the ids)
/// cannot fill the disk.
pub const OWNER_MAX_BYTES: u64 = 256 * 1024 * 1024;

pub fn register(registry: &mut Registry) {
    registry.add("web.draftPicturesPut", put);
    registry.add("web.draftPicturesRead", read);
    registry.add("web.draftPicturesRemove", remove_picture);
    registry.add("web.draftPicturesRemoveDevice", remove_device);
}

/// Lowercase UUID (`crypto.randomUUID()`): the only names a picture's file can have.
fn is_picture_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, &byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'),
    })
}

fn parse_id(value: &Value) -> Result<String, Fault> {
    value
        .as_str()
        .filter(|id| is_picture_id(id))
        .map(str::to_owned)
        .ok_or_else(|| Fault::new("invalid_name", "Not a draft picture's id"))
}

/// `desktop` for this computer's windows, else `device-<32 hex of sha256(deviceId)>`.
fn owner_dir(root: &Path, owner: Option<&str>) -> PathBuf {
    let folder = match owner {
        None => "desktop".to_owned(),
        Some(device) => {
            let digest = Sha256::digest(device.as_bytes());
            format!("device-{}", &crate::hex(&digest)[..32])
        }
    };
    root.join(folder)
}

type Work = Box<dyn FnOnce() -> Result<Reply, Fault> + Send + 'static>;

struct Job {
    work: Work,
    reply: oneshot::Sender<Result<Reply, Fault>>,
}

static LANES: LazyLock<Mutex<HashMap<PathBuf, mpsc::UnboundedSender<Job>>>> =
    LazyLock::new(Mutex::default);

fn lanes() -> MutexGuard<'static, HashMap<PathBuf, mpsc::UnboundedSender<Job>>> {
    LANES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Places `work` onto `dir`'s serial lane now (on the server read loop) before returning the future
/// that awaits its outcome.
fn enqueue(dir: PathBuf, work: impl FnOnce() -> Result<Reply, Fault> + Send + 'static) -> Answer {
    let (reply, answer) = oneshot::channel();
    let job = Job {
        work: Box::new(work),
        reply,
    };
    let mut map = lanes();
    let pending = match map.get(&dir) {
        Some(lane) => match lane.send(job) {
            Ok(()) => None,
            Err(mpsc::error::SendError(job)) => Some(job),
        },
        None => Some(job),
    };
    if let Some(job) = pending {
        let (lane, queue) = mpsc::unbounded_channel();
        let _ = lane.send(job);
        map.insert(dir.clone(), lane);
        tokio::spawn(run_lane(dir, queue));
    }
    drop(map);
    Box::pin(async move {
        answer.await.map_err(|_| {
            Fault::new(
                "internal",
                "The draft pictures lane ended before it answered",
            )
        })?
    })
}

async fn run_lane(dir: PathBuf, mut queue: mpsc::UnboundedReceiver<Job>) {
    loop {
        let job = {
            let mut map = lanes();
            match queue.try_recv() {
                Ok(job) => job,
                Err(_) => {
                    map.remove(&dir);
                    return;
                }
            }
        };
        let outcome = match tokio::task::spawn_blocking(job.work).await {
            Ok(outcome) => outcome,
            Err(_) => Err(Fault::new("internal", "The draft pictures job panicked")),
        };
        let _ = job.reply.send(outcome);
    }
}

/// The bytes `dir`'s other picture files hold (a write's temp file is no picture).
fn held_besides(dir: &Path, skip: &str) -> Result<u64, Fault> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(fault(&error, "scandir", dir)),
    };
    let mut total = 0_u64;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name == skip || !is_picture_id(name) {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(entry.path()) {
            total = total.saturating_add(meta.len());
        }
    }
    Ok(total)
}

fn put_sync(dir: &Path, id: &str, bytes: &[u8], owner_max: u64) -> Result<Reply, Fault> {
    let held = held_besides(dir, id)?;
    if held.saturating_add(bytes.len() as u64) > owner_max {
        return Err(Fault::new(
            "file_too_large",
            "This device keeps too many draft pictures already",
        ));
    }
    write_atomic_if(&dir.join(id), bytes, Some(0o600), 0o700, &|| true)?;
    Reply::json(&Value::Null)
}

#[derive(Deserialize)]
struct PictureParams {
    root: PathBuf,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    id: Value,
}

#[derive(Serialize)]
struct ReadResult {
    found: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveDeviceParams {
    root: PathBuf,
    device_id: String,
}

fn put(call: Call) -> Answer {
    let params: PictureParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return at_once(Err(fault)),
    };
    let id = match parse_id(&params.id) {
        Ok(id) => id,
        Err(fault) => return at_once(Err(fault)),
    };
    let Some(bytes) = call.bin.filter(|bytes| !bytes.is_empty()) else {
        return at_once(Err(Fault::new("invalid_content", "No picture to keep")));
    };
    if bytes.len() > MAX_PICTURE_BYTES {
        return at_once(Err(Fault::new(
            "file_too_large",
            "This picture is too large to keep",
        )));
    }
    let dir = owner_dir(&params.root, params.owner.as_deref());
    enqueue(dir.clone(), move || {
        put_sync(&dir, &id, &bytes, OWNER_MAX_BYTES)
    })
}

fn read(call: Call) -> Answer {
    let params: PictureParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return at_once(Err(fault)),
    };
    let id = match parse_id(&params.id) {
        Ok(id) => id,
        Err(fault) => return at_once(Err(fault)),
    };
    let dir = owner_dir(&params.root, params.owner.as_deref());
    enqueue(dir.clone(), move || {
        let path = dir.join(&id);
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Reply::json(&ReadResult { found: true })?.with_bin(bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Reply::json(&ReadResult { found: false })
            }
            Err(error) => Err(fault(&error, "open", &path)),
        }
    })
}

fn remove_picture(call: Call) -> Answer {
    let params: PictureParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return at_once(Err(fault)),
    };
    let id = match parse_id(&params.id) {
        Ok(id) => id,
        Err(fault) => return at_once(Err(fault)),
    };
    let dir = owner_dir(&params.root, params.owner.as_deref());
    enqueue(dir.clone(), move || {
        let path = dir.join(&id);
        match std::fs::remove_file(&path) {
            Ok(()) => Reply::json(&Value::Null),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Reply::json(&Value::Null),
            Err(error) => Err(fault(&error, "unlink", &path)),
        }
    })
}

fn remove_device(call: Call) -> Answer {
    let params: RemoveDeviceParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return at_once(Err(fault)),
    };
    let dir = owner_dir(&params.root, Some(&params.device_id));
    enqueue(dir.clone(), move || {
        remove(&dir, false, &Scope::detached())?;
        Reply::json(&Value::Null)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    const ID: &str = "0b5c1e2a-7d4f-4c8e-9a1b-3f6e2d9c8a71";
    const OTHER: &str = "9f3e2d1c-0b4a-4e5f-8a7b-6c5d4e3f2a10";

    #[test]
    fn validates_lowercase_uuid_picture_ids() {
        assert!(is_picture_id(ID));
        assert!(is_picture_id(OTHER));
        for bad in [
            "",
            "../x",
            "0B5C1E2A-7D4F-4C8E-9A1B-3F6E2D9C8A71",
            "0b5c1e2a-7d4f-4c8e-9a1b-3f6e2d9c8a7",
            "0b5c1e2a-7d4f-4c8e-9a1b-3f6e2d9c8a711",
            "0b5c1e2a_7d4f_4c8e_9a1b_3f6e2d9c8a71",
        ] {
            assert!(!is_picture_id(bad), "{bad}");
        }
    }

    #[test]
    fn hashes_device_owner_folders_and_enforces_owner_budget() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("draft-pictures");
        assert_eq!(owner_dir(&root, None), root.join("desktop"));
        let escaped = owner_dir(&root, Some("../escape"));
        let name = escaped.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("device-"));
        assert_eq!(name.len(), 7 + 32);
        assert!(
            name[7..]
                .bytes()
                .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
        );

        let desktop = owner_dir(&root, None);
        put_sync(&desktop, ID, b"123456", 10).unwrap();
        // Overwriting the same id replaces its own bytes instead of double-counting them.
        put_sync(&desktop, ID, b"12345678", 10).unwrap();
        let over = put_sync(&desktop, OTHER, b"123", 10).err().unwrap();
        assert_eq!(over.code, "file_too_large");
        assert_eq!(
            over.message,
            "This device keeps too many draft pictures already"
        );
    }

    #[tokio::test]
    async fn wire_operations_keep_owner_order_isolation_and_permissions() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("draft-pictures");
        let (client, server_io) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server_io);
        let mut registry = Registry::default();
        register(&mut registry);
        let server = tokio::spawn(crate::serve(server_read, server_write, registry));
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut lines = BufReader::new(client_read);

        let mut ready = String::new();
        lines.read_line(&mut ready).await.unwrap();
        assert!(ready.contains("\"event\":\"ready\""));

        async fn send_frame(
            writer: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>,
            head: Value,
            bin: Option<&[u8]>,
        ) {
            let line = format!("{head}\n");
            writer.write_all(line.as_bytes()).await.unwrap();
            if let Some(bin) = bin {
                writer.write_all(bin).await.unwrap();
            }
        }

        // Back-to-back put -> remove -> read -> put -> read must execute in arrival order.
        send_frame(
            &mut client_write,
            json!({"id": 1, "method": "web.draftPicturesPut", "params": {"root": root, "owner": null, "id": ID}, "bin": 5}),
            Some(b"first"),
        )
        .await;
        send_frame(
            &mut client_write,
            json!({"id": 2, "method": "web.draftPicturesRemove", "params": {"root": root, "owner": null, "id": ID}}),
            None,
        )
        .await;
        send_frame(
            &mut client_write,
            json!({"id": 3, "method": "web.draftPicturesRead", "params": {"root": root, "owner": null, "id": ID}}),
            None,
        )
        .await;
        send_frame(
            &mut client_write,
            json!({"id": 4, "method": "web.draftPicturesPut", "params": {"root": root, "owner": null, "id": ID}, "bin": 6}),
            Some(b"second"),
        )
        .await;
        send_frame(
            &mut client_write,
            json!({"id": 5, "method": "web.draftPicturesRead", "params": {"root": root, "owner": null, "id": ID}}),
            None,
        )
        .await;
        send_frame(
            &mut client_write,
            json!({"id": 6, "method": "web.draftPicturesPut", "params": {"root": root, "owner": "phone-a", "id": OTHER}, "bin": 1}),
            Some(b"A"),
        )
        .await;
        send_frame(
            &mut client_write,
            json!({"id": 7, "method": "web.draftPicturesRemoveDevice", "params": {"root": root, "deviceId": "phone-a"}}),
            None,
        )
        .await;
        send_frame(
            &mut client_write,
            json!({"id": 8, "method": "web.draftPicturesRead", "params": {"root": root, "owner": "phone-a", "id": OTHER}}),
            None,
        )
        .await;
        send_frame(
            &mut client_write,
            json!({"id": 9, "method": "web.draftPicturesRead", "params": {"root": root, "owner": null, "id": "../bad"}}),
            None,
        )
        .await;
        client_write.shutdown().await.unwrap();

        let mut answers: HashMap<u64, (Value, Option<Vec<u8>>)> = HashMap::new();
        let mut line = String::new();
        while lines.read_line(&mut line).await.unwrap() > 0 {
            let head: Value = serde_json::from_str(&line).unwrap();
            let bin = if let Some(len) = head.get("bin").and_then(Value::as_u64) {
                let mut buf = vec![0_u8; len as usize];
                lines.read_exact(&mut buf).await.unwrap();
                Some(buf)
            } else {
                None
            };
            if let Some(id) = head.get("id").and_then(Value::as_u64) {
                answers.insert(id, (head, bin));
            }
            line.clear();
        }
        server.await.unwrap().unwrap();

        assert_eq!(answers[&1].0["ok"], true);
        assert_eq!(answers[&2].0["ok"], true);
        assert_eq!(answers[&3].0["result"]["found"], false);
        assert_eq!(answers[&4].0["ok"], true);
        assert_eq!(answers[&5].0["result"]["found"], true);
        assert_eq!(answers[&5].1.as_deref(), Some(b"second".as_slice()));
        assert_eq!(answers[&6].0["ok"], true);
        assert_eq!(answers[&7].0["ok"], true);
        assert_eq!(answers[&8].0["result"]["found"], false);
        assert_eq!(answers[&9].0["error"]["code"], "invalid_name");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(root.join("desktop"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(root.join("desktop").join(ID))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
