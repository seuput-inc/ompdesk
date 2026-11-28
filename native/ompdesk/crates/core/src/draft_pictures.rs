//! A composer draft's pictures, kept beside the draft the renderer saves in `localStorage`, so they outlive a relaunch
//! of the app or of a phone's page. One file of raw bytes per picture, `<root>/<owner>/<id>` (folders 0700, files
//! 0600): the owner is this computer's own windows (`desktop`) or one paired web device (`device-<sha256[..32]>`),
//! never a path a caller names, and the id is the lowercase UUID the renderer gave the picture.
//!
//! Each owner folder's operations run strictly one after another in the order their calls arrived (enqueued
//! synchronously before returning the async answer), so a remove or read made after a put never overtakes it, and a
//! failure in one call never blocks the next.
//!
//! Served both as core IPC channels (`draft-pictures:put`, `draft-pictures:read`, `draft-pictures:remove`, routed
//! directly from `tauri-shell` via H(c)) and as `draftPictures.*` core RPC methods (for `DraftPictures.removeDevice`
//! on device revocation and `draft-pictures.test.ts`).

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};

use base64::Engine as _;
use base64::alphabet::STANDARD as BASE64_STANDARD;
use base64::engine::{GeneralPurpose, GeneralPurposeConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};

use crate::disk::tree::{fault as io_fault, remove as remove_tree, write_atomic_if};
use crate::ipc::{Handled, IpcContext};
use crate::server::{Answer, Call, Fault, Registry, Reply, Scope, at_once};

/// One picture's bytes at most: a phone's upload limit (`web/uploads.ts`), so any picture a page can send it can keep.
pub const DRAFT_PICTURE_MAX_BYTES: usize = 25 * 1024 * 1024;
/// One owner's pictures together at most: a renderer that lost its drafts (and with them the ids) cannot fill the disk.
pub const DRAFT_PICTURES_OWNER_MAX_BYTES: u64 = 256 * 1024 * 1024;
const BASE64_MAX_CHARS: usize = DRAFT_PICTURE_MAX_BYTES.div_ceil(3) * 4;

/// Matches Node's `Buffer.from(data, "base64")` after strict character/length/padding checks.
const BASE64_ENGINE: GeneralPurpose = GeneralPurpose::new(
    &BASE64_STANDARD,
    GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
);

pub fn register(registry: &mut Registry) {
    registry.add("draftPictures.put", rpc_put);
    registry.add("draftPictures.read", rpc_read);
    registry.add("draftPictures.remove", rpc_remove);
    registry.add("draftPictures.removeDevice", rpc_remove_device);
}

fn coded(code: &'static str, message: &str) -> Fault {
    Fault::new(code, format!("[{code}] {message}"))
}

/// `crypto.randomUUID()`'s lowercase hex form: the only names a picture's file can have.
fn is_picture_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, &b)| match i {
        8 | 13 | 18 | 23 => b == b'-',
        _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
    })
}

fn validate_id(value: &Value) -> Result<String, Fault> {
    match value.as_str() {
        Some(id) if is_picture_id(id) => Ok(id.to_owned()),
        _ => Err(coded("invalid_name", "Not a draft picture's id")),
    }
}

/// Matches `/^[A-Za-z0-9+/]*={0,2}$/` with `len % 4 == 0`.
fn is_valid_base64(data: &str) -> bool {
    let bytes = data.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return false;
    }
    let trimmed = match bytes {
        [rest @ .., b'=', b'='] => rest,
        [rest @ .., b'='] => rest,
        all => all,
    };
    trimmed
        .iter()
        .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/'))
}

/// The bytes of an `ImageContent` a caller sent; refuses anything else or past the size limit.
fn picture_bytes(content: &Value) -> Result<Vec<u8>, Fault> {
    let Some(obj) = content.as_object() else {
        return Err(coded("invalid_content", "No picture to keep"));
    };
    let kind = obj.get("type").and_then(Value::as_str);
    let data = obj.get("data").and_then(Value::as_str);
    let mime = obj.get("mimeType").and_then(Value::as_str);
    let (Some("image"), Some(data), Some(_)) = (kind, data, mime) else {
        return Err(coded("invalid_content", "No picture to keep"));
    };
    if data.is_empty() {
        return Err(coded("invalid_content", "No picture to keep"));
    }
    if data.len() > BASE64_MAX_CHARS {
        return Err(coded("file_too_large", "This picture is too large to keep"));
    }
    if !is_valid_base64(data) {
        return Err(coded("invalid_content", "The picture's data is damaged"));
    }
    BASE64_ENGINE
        .decode(data)
        .map_err(|_| coded("invalid_content", "The picture's data is damaged"))
}

fn owner_dir(root: &Path, owner: Option<&str>) -> PathBuf {
    let folder = match owner {
        None => "desktop".to_owned(),
        Some(device_id) => {
            let digest = crate::hex(&Sha256::digest(device_id.as_bytes()));
            format!("device-{}", &digest[..32])
        }
    };
    root.join(folder)
}

enum Op {
    Put {
        name: String,
        bytes: Vec<u8>,
        owner_max: u64,
    },
    Read {
        name: String,
    },
    Remove {
        name: String,
    },
    RemoveDevice,
}

#[derive(Debug)]
enum OpResult {
    Unit,
    Read(Option<String>),
}

struct Task {
    op: Op,
    reply: oneshot::Sender<Result<OpResult, Fault>>,
}

static LANES: LazyLock<Mutex<HashMap<PathBuf, mpsc::UnboundedSender<Task>>>> =
    LazyLock::new(Mutex::default);

fn lanes() -> MutexGuard<'static, HashMap<PathBuf, mpsc::UnboundedSender<Task>>> {
    LANES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Enqueues `op` onto `dir`'s FIFO lane synchronously so later calls for the same owner folder never overtake it.
fn enqueue_op(dir: PathBuf, op: Op) -> oneshot::Receiver<Result<OpResult, Fault>> {
    let (reply, answer) = oneshot::channel();
    let task = Task { op, reply };
    let mut map = lanes();
    let task = match map.get(&dir) {
        Some(lane) => match lane.send(task) {
            Ok(()) => return answer,
            Err(mpsc::error::SendError(task)) => task,
        },
        None => task,
    };
    let (lane, queue) = mpsc::unbounded_channel();
    let _ = lane.send(task);
    map.insert(dir.clone(), lane);
    tokio::spawn(run_owner_lane(dir, queue));
    answer
}

async fn run_owner_lane(dir: PathBuf, mut queue: mpsc::UnboundedReceiver<Task>) {
    loop {
        let task = {
            let mut map = lanes();
            match queue.try_recv() {
                Ok(task) => task,
                Err(_) => {
                    map.remove(&dir);
                    return;
                }
            }
        };
        let work_dir = dir.clone();
        let outcome = tokio::task::spawn_blocking(move || run_op(&work_dir, task.op))
            .await
            .unwrap_or_else(|_| Err(Fault::new("internal", "Draft picture task failed")));
        let _ = task.reply.send(outcome);
    }
}

fn held_besides(dir: &Path, name: &str) -> Result<u64, Fault> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(io_fault(&error, "scandir", dir)),
    };
    let mut total = 0u64;
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let file_name = entry.file_name();
        let Some(other) = file_name.to_str() else {
            continue;
        };
        if other == name || !is_picture_id(other) {
            continue;
        }
        if let Ok(meta) = fs::metadata(dir.join(other)) {
            total = total.saturating_add(meta.len());
        }
    }
    Ok(total)
}

fn run_op(dir: &Path, op: Op) -> Result<OpResult, Fault> {
    match op {
        Op::Put {
            name,
            bytes,
            owner_max,
        } => {
            let held = held_besides(dir, &name)?;
            if held.saturating_add(bytes.len() as u64) > owner_max {
                return Err(coded(
                    "file_too_large",
                    "This device keeps too many draft pictures already",
                ));
            }
            let file = dir.join(&name);
            write_atomic_if(&file, &bytes, Some(0o600), 0o700, &|| true)?;
            Ok(OpResult::Unit)
        }
        Op::Read { name } => {
            let file = dir.join(&name);
            match fs::read(&file) {
                Ok(bytes) => Ok(OpResult::Read(Some(BASE64_ENGINE.encode(bytes)))),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(OpResult::Read(None)),
                Err(error) => Err(io_fault(&error, "read", &file)),
            }
        }
        Op::Remove { name } => {
            let file = dir.join(&name);
            match fs::remove_file(&file) {
                Ok(()) => Ok(OpResult::Unit),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(OpResult::Unit),
                Err(error) => Err(io_fault(&error, "unlink", &file)),
            }
        }
        Op::RemoveDevice => {
            remove_tree(dir, false, &Scope::detached())?;
            Ok(OpResult::Unit)
        }
    }
}

fn start_put(
    root: &Path,
    owner: Option<&str>,
    id: &Value,
    content: &Value,
    owner_max: u64,
) -> Result<oneshot::Receiver<Result<OpResult, Fault>>, Fault> {
    let name = validate_id(id)?;
    let bytes = picture_bytes(content)?;
    let dir = owner_dir(root, owner);
    Ok(enqueue_op(
        dir,
        Op::Put {
            name,
            bytes,
            owner_max,
        },
    ))
}

fn start_read(
    root: &Path,
    owner: Option<&str>,
    id: &Value,
) -> Result<oneshot::Receiver<Result<OpResult, Fault>>, Fault> {
    let name = validate_id(id)?;
    let dir = owner_dir(root, owner);
    Ok(enqueue_op(dir, Op::Read { name }))
}

fn start_remove(
    root: &Path,
    owner: Option<&str>,
    id: &Value,
) -> Result<oneshot::Receiver<Result<OpResult, Fault>>, Fault> {
    let name = validate_id(id)?;
    let dir = owner_dir(root, owner);
    Ok(enqueue_op(dir, Op::Remove { name }))
}

fn start_remove_device(root: &Path, device_id: &str) -> oneshot::Receiver<Result<OpResult, Fault>> {
    let dir = owner_dir(root, Some(device_id));
    enqueue_op(dir, Op::RemoveDevice)
}

async fn finish_unit(rx: oneshot::Receiver<Result<OpResult, Fault>>) -> Result<(), Fault> {
    rx.await
        .map_err(|_| Fault::new("internal", "Draft picture lane ended"))??;
    Ok(())
}

async fn finish_read(
    rx: oneshot::Receiver<Result<OpResult, Fault>>,
) -> Result<Option<String>, Fault> {
    match rx
        .await
        .map_err(|_| Fault::new("internal", "Draft picture lane ended"))??
    {
        OpResult::Read(data) => Ok(data),
        OpResult::Unit => Err(Fault::new("internal", "Unexpected draft picture result")),
    }
}

// --- Core RPC handlers (`draftPictures.*`) ---

#[derive(Deserialize)]
struct PutParams {
    root: String,
    owner: Option<String>,
    #[serde(default)]
    id: Value,
    #[serde(default)]
    content: Value,
}

#[derive(Deserialize)]
struct IdParams {
    root: String,
    owner: Option<String>,
    #[serde(default)]
    id: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveDeviceParams {
    root: String,
    device_id: String,
}

#[derive(Serialize)]
struct ReadResult {
    data: Option<String>,
}

fn rpc_put(call: Call) -> Answer {
    let params: PutParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return at_once(Err(fault)),
    };
    let rx = match start_put(
        Path::new(&params.root),
        params.owner.as_deref(),
        &params.id,
        &params.content,
        DRAFT_PICTURES_OWNER_MAX_BYTES,
    ) {
        Ok(rx) => rx,
        Err(fault) => return at_once(Err(fault)),
    };
    Box::pin(async move {
        finish_unit(rx).await?;
        Reply::json(&serde_json::json!({}))
    })
}

fn rpc_read(call: Call) -> Answer {
    let params: IdParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return at_once(Err(fault)),
    };
    let rx = match start_read(Path::new(&params.root), params.owner.as_deref(), &params.id) {
        Ok(rx) => rx,
        Err(fault) => return at_once(Err(fault)),
    };
    Box::pin(async move {
        let data = finish_read(rx).await?;
        Reply::json(&ReadResult { data })
    })
}

fn rpc_remove(call: Call) -> Answer {
    let params: IdParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return at_once(Err(fault)),
    };
    let rx = match start_remove(Path::new(&params.root), params.owner.as_deref(), &params.id) {
        Ok(rx) => rx,
        Err(fault) => return at_once(Err(fault)),
    };
    Box::pin(async move {
        finish_unit(rx).await?;
        Reply::json(&serde_json::json!({}))
    })
}

fn rpc_remove_device(call: Call) -> Answer {
    let params: RemoveDeviceParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return at_once(Err(fault)),
    };
    let rx = start_remove_device(Path::new(&params.root), &params.device_id);
    Box::pin(async move {
        finish_unit(rx).await?;
        Reply::json(&serde_json::json!({}))
    })
}

// --- Core IPC handlers (`draft-pictures:*`, routed directly from tauri-shell via H(c)) ---

fn ipc_root(ctx: &IpcContext) -> Result<PathBuf, Fault> {
    ctx.user_data
        .as_ref()
        .map(|base| base.join("draft-pictures"))
        .ok_or_else(|| Fault::new("internal", "ompdesk-core IPC started without userData"))
}

pub(crate) fn ipc_put(ctx: IpcContext, args: Vec<Value>) -> Handled {
    let started = ipc_root(&ctx).and_then(|root| {
        let id = args.first().unwrap_or(&Value::Null);
        let content = args.get(1).unwrap_or(&Value::Null);
        start_put(
            &root,
            ctx.caller.device_id.as_deref(),
            id,
            content,
            DRAFT_PICTURES_OWNER_MAX_BYTES,
        )
    });
    Box::pin(async move {
        finish_unit(started?).await?;
        Ok(None)
    })
}

pub(crate) fn ipc_read(ctx: IpcContext, args: Vec<Value>) -> Handled {
    let started = ipc_root(&ctx).and_then(|root| {
        let id = args.first().unwrap_or(&Value::Null);
        start_read(&root, ctx.caller.device_id.as_deref(), id)
    });
    Box::pin(async move {
        let value = match finish_read(started?).await? {
            Some(data) => Value::String(data),
            None => Value::Null,
        };
        Ok(Some(value))
    })
}

pub(crate) fn ipc_remove(ctx: IpcContext, args: Vec<Value>) -> Handled {
    let started = ipc_root(&ctx).and_then(|root| {
        let id = args.first().unwrap_or(&Value::Null);
        start_remove(&root, ctx.caller.device_id.as_deref(), id)
    });
    Box::pin(async move {
        finish_unit(started?).await?;
        Ok(None)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    const ID: &str = "0b5c1e2a-7d4f-4c8e-9a1b-3f6e2d9c8a71";
    const OTHER: &str = "9f3e2d1c-0b4a-4e5f-8a7b-6c5d4e3f2a10";

    fn temp_root(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "ompdesk-draft-pictures-{}-{tag}-{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        base.join("draft-pictures")
    }

    fn png(text: &str) -> Value {
        json!({
            "type": "image",
            "mimeType": "image/png",
            "data": BASE64_ENGINE.encode(text.as_bytes()),
        })
    }

    fn b64(text: &str) -> String {
        BASE64_ENGINE.encode(text.as_bytes())
    }

    #[tokio::test]
    async fn keeps_reads_and_removes_picture_with_owner_only_permissions() {
        let root = temp_root("crud");
        finish_unit(
            start_put(
                &root,
                None,
                &json!(ID),
                &png("PNG bytes"),
                DRAFT_PICTURES_OWNER_MAX_BYTES,
            )
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            finish_read(start_read(&root, None, &json!(ID)).unwrap())
                .await
                .unwrap(),
            Some(b64("PNG bytes"))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(root.join("desktop"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(root.join("desktop").join(ID))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        finish_unit(start_remove(&root, None, &json!(ID)).unwrap())
            .await
            .unwrap();
        assert_eq!(
            finish_read(start_read(&root, None, &json!(ID)).unwrap())
                .await
                .unwrap(),
            None
        );
        // Removing what is not kept is no error.
        finish_unit(start_remove(&root, None, &json!(ID)).unwrap())
            .await
            .unwrap();
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[tokio::test]
    async fn isolates_devices_hashes_device_folders_and_removes_device() {
        let root = temp_root("devices");
        finish_unit(
            start_put(
                &root,
                Some("phone-a"),
                &json!(ID),
                &png("A"),
                DRAFT_PICTURES_OWNER_MAX_BYTES,
            )
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            finish_read(start_read(&root, None, &json!(ID)).unwrap())
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            finish_read(start_read(&root, Some("phone-b"), &json!(ID)).unwrap())
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            finish_read(start_read(&root, Some("phone-a"), &json!(ID)).unwrap())
                .await
                .unwrap(),
            Some(b64("A"))
        );
        finish_unit(
            start_put(
                &root,
                Some("../escape"),
                &json!(OTHER),
                &png("E"),
                DRAFT_PICTURES_OWNER_MAX_BYTES,
            )
            .unwrap(),
        )
        .await
        .unwrap();
        for entry in fs::read_dir(&root).unwrap() {
            let name = entry.unwrap().file_name().into_string().unwrap();
            assert!(
                name == "desktop"
                    || (name.starts_with("device-")
                        && name.len() == 7 + 32
                        && name[7..]
                            .bytes()
                            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))),
                "unexpected owner folder {name:?}"
            );
        }
        finish_unit(start_remove_device(&root, "phone-a"))
            .await
            .unwrap();
        assert_eq!(
            finish_read(start_read(&root, Some("phone-a"), &json!(ID)).unwrap())
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            finish_read(start_read(&root, Some("../escape"), &json!(OTHER)).unwrap())
                .await
                .unwrap(),
            Some(b64("E"))
        );
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[tokio::test]
    async fn fifo_order_per_owner_and_recovery_after_failure() {
        let root = temp_root("fifo");
        let put1 = start_put(
            &root,
            None,
            &json!(ID),
            &png("first"),
            DRAFT_PICTURES_OWNER_MAX_BYTES,
        )
        .unwrap();
        let rem = start_remove(&root, None, &json!(ID)).unwrap();
        let after_rem = start_read(&root, None, &json!(ID)).unwrap();
        let put2 = start_put(
            &root,
            None,
            &json!(ID),
            &png("second"),
            DRAFT_PICTURES_OWNER_MAX_BYTES,
        )
        .unwrap();
        let after_put = start_read(&root, None, &json!(ID)).unwrap();

        finish_unit(put1).await.unwrap();
        finish_unit(rem).await.unwrap();
        assert_eq!(finish_read(after_rem).await.unwrap(), None);
        finish_unit(put2).await.unwrap();
        assert_eq!(finish_read(after_put).await.unwrap(), Some(b64("second")));

        // A folder where a file belongs fails read without poisoning later ops.
        let bad_id = "11111111-1111-1111-1111-111111111111";
        fs::create_dir_all(root.join("desktop").join(bad_id)).unwrap();
        let failed = start_read(&root, None, &json!(bad_id)).unwrap();
        let kept = start_put(
            &root,
            None,
            &json!(OTHER),
            &png("ok"),
            DRAFT_PICTURES_OWNER_MAX_BYTES,
        )
        .unwrap();
        assert!(finish_read(failed).await.is_err());
        finish_unit(kept).await.unwrap();
        assert_eq!(
            finish_read(start_read(&root, None, &json!(OTHER)).unwrap())
                .await
                .unwrap(),
            Some(b64("ok"))
        );
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[tokio::test]
    async fn validates_ids_content_size_and_owner_cap() {
        let root = temp_root("validate");
        for bad in [
            json!("../x"),
            json!(""),
            json!("0B5C1E2A-7D4F-4C8E-9A1B-3F6E2D9C8A71"),
            json!(5),
        ] {
            let err = start_put(&root, None, &bad, &png("x"), DRAFT_PICTURES_OWNER_MAX_BYTES)
                .unwrap_err();
            assert_eq!(err.code, "invalid_name");
            assert!(err.message.contains("[invalid_name]"), "{}", err.message);
        }
        let err = start_read(&root, None, &json!("../../etc/passwd")).unwrap_err();
        assert_eq!(err.code, "invalid_name");

        for bad_content in [
            json!({"type": "text", "data": b64("x"), "mimeType": "image/png"}),
            Value::Null,
            json!({"type": "image", "data": "", "mimeType": "image/png"}),
            json!({"type": "image", "data": "not*base64==", "mimeType": "image/png"}),
            json!({"type": "image", "data": "abc", "mimeType": "image/png"}),
        ] {
            let err = start_put(
                &root,
                None,
                &json!(ID),
                &bad_content,
                DRAFT_PICTURES_OWNER_MAX_BYTES,
            )
            .unwrap_err();
            assert_eq!(err.code, "invalid_content");
            assert!(err.message.contains("[invalid_content]"), "{}", err.message);
        }

        let huge = json!({
            "type": "image",
            "mimeType": "image/png",
            "data": "A".repeat(BASE64_MAX_CHARS + 4),
        });
        let err = start_put(
            &root,
            None,
            &json!(ID),
            &huge,
            DRAFT_PICTURES_OWNER_MAX_BYTES,
        )
        .unwrap_err();
        assert_eq!(err.code, "file_too_large");
        assert!(err.message.contains("[file_too_large]"), "{}", err.message);

        // Per-owner cap excludes the picture being replaced, rejects overflow from a second one.
        finish_unit(start_put(&root, None, &json!(ID), &png("12345"), 8).unwrap())
            .await
            .unwrap();
        // Replacing ID with 8 bytes succeeds (held besides ID is 0).
        finish_unit(start_put(&root, None, &json!(ID), &png("12345678"), 8).unwrap())
            .await
            .unwrap();
        // Adding OTHER pushes total over 8 bytes and fails.
        let err = finish_unit(start_put(&root, None, &json!(OTHER), &png("x"), 8).unwrap())
            .await
            .unwrap_err();
        assert_eq!(err.code, "file_too_large");
        assert!(err.message.contains("[file_too_large]"), "{}", err.message);
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[tokio::test]
    async fn ipc_channels_route_desktop_vs_paired_device_and_preserve_undefined_vs_null() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

        let user_data =
            std::env::temp_dir().join(format!("ompdesk-draft-pictures-ipc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&user_data);
        fs::create_dir_all(&user_data).unwrap();

        let (client, server_io) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server_io);
        let server = tokio::spawn(crate::serve(server_read, server_write, crate::registry()));
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut lines = tokio::io::BufReader::new(client_read);

        let policy = json!({
            "draft-pictures:put": {"dir": "invoke"},
            "draft-pictures:read": {"dir": "invoke"},
            "draft-pictures:remove": {"dir": "invoke"},
        });
        let phone = json!({"key": "c1", "window": -1, "connId": "1", "deviceId": "phone-a"});
        let desktop = json!({"key": "w1", "window": 1, "connId": null, "deviceId": null});
        let frames = [
            json!({"id": 1, "method": "ipc.start", "params": {"policy": policy, "userData": user_data.to_string_lossy()}}),
            json!({"id": 2, "method": "ipc.call", "params": {"caller": phone, "channel": "draft-pictures:put", "dir": "invoke", "args": [ID, png("phone")]}}),
            json!({"id": 3, "method": "ipc.call", "params": {"caller": desktop, "channel": "draft-pictures:read", "dir": "invoke", "args": [ID]}}),
            json!({"id": 4, "method": "ipc.call", "params": {"caller": phone, "channel": "draft-pictures:read", "dir": "invoke", "args": [ID]}}),
            json!({"id": 5, "method": "ipc.call", "params": {"caller": phone, "channel": "draft-pictures:remove", "dir": "invoke", "args": [ID]}}),
            json!({"id": 6, "method": "ipc.call", "params": {"caller": phone, "channel": "draft-pictures:read", "dir": "invoke", "args": [ID]}}),
        ];
        for frame in frames {
            client_write
                .write_all(format!("{frame}\n").as_bytes())
                .await
                .unwrap();
        }
        client_write.shutdown().await.unwrap();

        let mut answers = HashMap::new();
        let mut line = String::new();
        while lines.read_line(&mut line).await.unwrap() > 0 {
            let frame: Value = serde_json::from_str(&line).unwrap();
            if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                answers.insert(id, frame);
            }
            line.clear();
        }
        server.await.unwrap().unwrap();

        assert_eq!(answers[&1]["ok"], true);
        // `put` omits `value` => JS `undefined`.
        assert_eq!(answers[&2]["ok"], true);
        assert!(answers[&2]["result"].get("value").is_none());
        // Desktop sees explicit `null` for phone's picture.
        assert_eq!(answers[&3]["result"].get("value"), Some(&Value::Null));
        // Phone reads its own picture back.
        assert_eq!(answers[&4]["result"]["value"], json!(b64("phone")));
        // `remove` omits `value` => JS `undefined`.
        assert_eq!(answers[&5]["ok"], true);
        assert!(answers[&5]["result"].get("value").is_none());
        // After remove, phone reads explicit `null`.
        assert_eq!(answers[&6]["result"].get("value"), Some(&Value::Null));

        let _ = fs::remove_dir_all(&user_data);
    }
}
