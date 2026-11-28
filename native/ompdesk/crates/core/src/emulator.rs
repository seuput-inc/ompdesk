//! The Preview's device screen (Orca's emulator pane, `emulator-pane/**`; FT71, FL56): the iOS Simulators booted on
//! this computer (`xcrun simctl`) and the Android devices `adb` sees, each one's screen as a PNG, and for Android a tap
//! or a hardware key. This only reads and drives devices that already run: booting one is the agent's or the person's
//! (the `ompdesk-mobile-emulator` skill), so nothing started here outlives the request. Main hands over the login shell's
//! `PATH` (a GUI app's own lacks Homebrew and the Android SDK); the SDK's usual folders are tried after it.
//!
//! Methods: `emulator.devices {path}` → `{devices: [{platform, id, name}]}`; `emulator.screen {path, platform, id}` →
//! the PNG as the answer's bytes; `emulator.tap {path, id, x, y}` and `emulator.key {path, id, key}` (Android only).

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::ipc::{Handled, IpcContext};
use crate::server::{Call, Fault, Registry, Reply};

/// A screen is a few MB at most; a listing or an input answers in a few KB.
const SCREEN_MAX: usize = 32 * 1024 * 1024;
const TEXT_MAX: usize = 1024 * 1024;
const WAIT: Duration = Duration::from_secs(10);

pub fn register(registry: &mut Registry) {
    registry.add("emulator.devices", |call| Box::pin(devices(call)));
    registry.add("emulator.screen", |call| Box::pin(screen(call)));
    registry.add("emulator.tap", |call| Box::pin(tap(call)));
    registry.add("emulator.key", |call| Box::pin(key(call)));
}

fn failed(message: impl Into<String>) -> Fault {
    Fault::new("emulator_failed", message)
}

/// `PATH` as main gave it, then the Android SDK's platform tools where Android Studio puts them.
fn search_path(path: &str) -> String {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(path).collect();
    for root in [
        std::env::var_os("ANDROID_HOME"),
        std::env::var_os("ANDROID_SDK_ROOT"),
    ]
    .into_iter()
    .flatten()
    {
        dirs.push(PathBuf::from(root).join("platform-tools"));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        dirs.push(home.join("Library/Android/sdk/platform-tools"));
        dirs.push(home.join("AppData/Local/Android/Sdk/platform-tools"));
    }
    std::env::join_paths(dirs)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_owned())
}

/// Runs `bin args` on `path` with no shell and no input; its stdout up to `max`, or why it failed.
async fn run(bin: &str, args: &[&str], path: &str, max: usize) -> Result<Vec<u8>, Fault> {
    let path = search_path(path);
    let program = std::env::split_paths(&path)
        .map(|dir| {
            dir.join(if cfg!(windows) {
                format!("{bin}.exe")
            } else {
                bin.to_owned()
            })
        })
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| Fault::new("emulator_missing", format!("{bin} is not installed")))?;
    let mut child = Command::new(program)
        .args(args)
        .env("PATH", &path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| failed(error.to_string()))?;
    let mut stdout = child.stdout.take().ok_or_else(|| failed("no output"))?;
    let mut stderr = child.stderr.take().ok_or_else(|| failed("no output"))?;
    let finished = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut out_limited = (&mut stdout).take(max as u64 + 1);
        let mut err_limited = (&mut stderr).take(64 * 1024);
        let (read, _) = tokio::join!(
            out_limited.read_to_end(&mut out),
            err_limited.read_to_end(&mut err),
        );
        read.map_err(|error| failed(error.to_string()))?;
        if out.len() > max {
            return Err(failed(format!("{bin} wrote more than expected")));
        }
        let status = child
            .wait()
            .await
            .map_err(|error| failed(error.to_string()))?;
        if !status.success() {
            return Err(failed(String::from_utf8_lossy(&err).trim().to_owned()));
        }
        Ok(out)
    };
    tokio::time::timeout(WAIT, finished)
        .await
        .map_err(|_| failed(format!("{bin} did not answer")))?
}

#[derive(Deserialize)]
struct PathParams {
    path: String,
}

async fn devices(call: Call) -> Result<Reply, Fault> {
    let params: PathParams = call.params()?;
    let mut devices = Vec::new();
    if cfg!(target_os = "macos")
        && let Ok(listed) = run(
            "xcrun",
            &["simctl", "list", "devices", "booted", "-j"],
            &params.path,
            TEXT_MAX,
        )
        .await
    {
        devices.extend(booted_simulators(&String::from_utf8_lossy(&listed)));
    }
    devices.extend(android_devices(&params.path, ADB_SERVER).await);
    Reply::json(&json!({ "devices": devices }))
}

/// adb's server port. `adb` with no server running forks one that outlives its caller (and OMPdesk), so adb runs here
/// only while a server someone else started answers.
const ADB_SERVER: u16 = 5037;

async fn adb_server_up(port: u16) -> bool {
    let connect = tokio::net::TcpStream::connect(("127.0.0.1", port));
    matches!(
        tokio::time::timeout(Duration::from_millis(300), connect).await,
        Ok(Ok(_))
    )
}

/// The Android devices of the running adb server on `port`; none, and no adb run, when no server answers.
async fn android_devices(path: &str, port: u16) -> Vec<Value> {
    if !adb_server_up(port).await {
        return Vec::new();
    }
    match run("adb", &["devices", "-l"], path, TEXT_MAX).await {
        Ok(listed) => adb_devices(&String::from_utf8_lossy(&listed)),
        Err(_) => Vec::new(),
    }
}

/// One `adb` command, only while its server runs (see `ADB_SERVER`).
async fn run_adb(args: &[&str], path: &str, max: usize) -> Result<Vec<u8>, Fault> {
    if !adb_server_up(ADB_SERVER).await {
        return Err(failed("The Android debug bridge is not running"));
    }
    run("adb", args, path, max).await
}

/// `simctl list devices booted -j`: each booted device by its UDID and name.
fn booted_simulators(listing: &str) -> Vec<Value> {
    let Ok(parsed) = serde_json::from_str::<Value>(listing) else {
        return Vec::new();
    };
    parsed["devices"]
        .as_object()
        .into_iter()
        .flat_map(|runtimes| runtimes.values())
        .filter_map(Value::as_array)
        .flatten()
        .filter(|device| device["state"] == "Booted")
        .filter_map(|device| {
            Some(json!({"platform": "ios", "id": device["udid"].as_str()?,
                "name": device["name"].as_str().unwrap_or("Simulator")}))
        })
        .collect()
}

/// `adb devices -l`: each device ready for commands (`device`), named by its model.
fn adb_devices(listing: &str) -> Vec<Value> {
    listing
        .lines()
        .skip_while(|line| !line.starts_with("List of devices"))
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let serial = fields.next()?;
            if fields.next()? != "device" {
                return None;
            }
            let model = fields
                .find_map(|field| field.strip_prefix("model:"))
                .map(|model| model.replace('_', " "))
                .unwrap_or_else(|| serial.to_owned());
            Some(json!({"platform": "android", "id": serial, "name": model}))
        })
        .collect()
}

/// A device id as `simctl` or `adb` names one: never an option.
fn device_id(id: &str) -> Result<&str, Fault> {
    if id.is_empty() || id.starts_with('-') || id.len() > 200 {
        return Err(failed("Invalid device"));
    }
    Ok(id)
}

#[derive(Deserialize)]
struct ScreenParams {
    path: String,
    platform: String,
    id: String,
}

async fn screen(call: Call) -> Result<Reply, Fault> {
    let params: ScreenParams = call.params()?;
    let id = device_id(&params.id)?;
    let png = match params.platform.as_str() {
        "ios" => {
            run(
                "xcrun",
                &["simctl", "io", id, "screenshot", "--type=png", "-"],
                &params.path,
                SCREEN_MAX,
            )
            .await?
        }
        "android" => {
            run_adb(
                &["-s", id, "exec-out", "screencap", "-p"],
                &params.path,
                SCREEN_MAX,
            )
            .await?
        }
        _ => return Err(failed("Unknown platform")),
    };
    if !png.starts_with(b"\x89PNG") {
        return Err(failed("The device sent no picture"));
    }
    Ok(Reply::json(&Value::Null)?.with_bin(png))
}

#[derive(Deserialize)]
struct TapParams {
    path: String,
    id: String,
    x: u32,
    y: u32,
}

/// An Android tap at screen pixels (`input tap`). A Simulator takes touches only through its window.
async fn tap(call: Call) -> Result<Reply, Fault> {
    let params: TapParams = call.params()?;
    let id = device_id(&params.id)?;
    let (x, y) = (params.x.to_string(), params.y.to_string());
    run_adb(
        &["-s", id, "shell", "input", "tap", &x, &y],
        &params.path,
        TEXT_MAX,
    )
    .await?;
    Reply::json(&Value::Null)
}

#[derive(Deserialize)]
struct KeyParams {
    path: String,
    id: String,
    key: String,
}

/// An Android hardware key: back, home or the app switcher.
async fn key(call: Call) -> Result<Reply, Fault> {
    let params: KeyParams = call.params()?;
    let id = device_id(&params.id)?;
    let code = match params.key.as_str() {
        "back" => "KEYCODE_BACK",
        "home" => "KEYCODE_HOME",
        "apps" => "KEYCODE_APP_SWITCH",
        _ => return Err(failed("Unknown key")),
    };
    run_adb(
        &["-s", id, "shell", "input", "keyevent", code],
        &params.path,
        TEXT_MAX,
    )
    .await?;
    Reply::json(&Value::Null)
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum IpcDeviceRequest {
    List,
    Screen { platform: String, id: String },
    Tap { id: String, x: i64, y: i64 },
    Key { id: String, key: String },
}

fn validate_ipc_device_id(id: &str) -> Result<&str, Fault> {
    if id.is_empty() || id.len() > 200 {
        return Err(Fault::new("invalid_params", "Invalid device request"));
    }
    device_id(id)
}

/// Direct core IPC `preview:device`: lists booted iOS simulators and ready Android devices, captures PNG screens as
/// base64, and sends Android tap/key events using main's login-shell `PATH`.
pub(crate) fn ipc_device(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(async move {
        let raw = args.into_iter().next().unwrap_or(Value::Null);
        let req: IpcDeviceRequest = serde_json::from_value(raw)
            .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
        let path = crate::tools::ipc::spawn_path().await;
        match req {
            IpcDeviceRequest::List => {
                let mut list = Vec::new();
                if cfg!(target_os = "macos")
                    && let Ok(listed) = run(
                        "xcrun",
                        &["simctl", "list", "devices", "booted", "-j"],
                        &path,
                        TEXT_MAX,
                    )
                    .await
                {
                    list.extend(booted_simulators(&String::from_utf8_lossy(&listed)));
                }
                list.extend(android_devices(&path, ADB_SERVER).await);
                Ok(Some(Value::Array(list)))
            }
            IpcDeviceRequest::Screen { platform, id } => {
                let id = validate_ipc_device_id(&id)?;
                let png = match platform.as_str() {
                    "ios" => {
                        run(
                            "xcrun",
                            &["simctl", "io", id, "screenshot", "--type=png", "-"],
                            &path,
                            SCREEN_MAX,
                        )
                        .await?
                    }
                    "android" => {
                        run_adb(
                            &["-s", id, "exec-out", "screencap", "-p"],
                            &path,
                            SCREEN_MAX,
                        )
                        .await?
                    }
                    _ => return Err(Fault::new("invalid_params", "Unknown platform")),
                };
                if !png.starts_with(b"\x89PNG") {
                    return Err(failed("The device sent no picture"));
                }
                Ok(Some(Value::String(
                    base64::engine::general_purpose::STANDARD.encode(&png),
                )))
            }
            IpcDeviceRequest::Tap { id, x, y } => {
                let id = validate_ipc_device_id(&id)?;
                if !(0..=100_000).contains(&x) || !(0..=100_000).contains(&y) {
                    return Err(Fault::new("invalid_params", "Tap coordinates out of range"));
                }
                let (x, y) = (x.to_string(), y.to_string());
                run_adb(
                    &["-s", id, "shell", "input", "tap", &x, &y],
                    &path,
                    TEXT_MAX,
                )
                .await?;
                Ok(Some(Value::Null))
            }
            IpcDeviceRequest::Key { id, key } => {
                let id = validate_ipc_device_id(&id)?;
                let code = match key.as_str() {
                    "back" => "KEYCODE_BACK",
                    "home" => "KEYCODE_HOME",
                    "apps" => "KEYCODE_APP_SWITCH",
                    _ => return Err(Fault::new("invalid_params", "Unknown key")),
                };
                run_adb(
                    &["-s", id, "shell", "input", "keyevent", code],
                    &path,
                    TEXT_MAX,
                )
                .await?;
                Ok(Some(Value::Null))
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With no adb server answering, the listing runs no adb at all (it would fork a server that outlives OMPdesk):
    /// the `adb` on this PATH would record any run.
    #[tokio::test]
    async fn no_adb_runs_while_no_adb_server_answers() {
        let closed = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let dir =
            std::env::temp_dir().join(format!("ompdesk-emulator-{}-{port}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("ran");
        let adb = dir.join(if cfg!(windows) { "adb.exe" } else { "adb" });
        std::fs::write(&adb, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&adb, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(
            android_devices(dir.to_str().unwrap(), port)
                .await
                .is_empty()
        );
        assert!(!marker.exists());
        let server = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        assert!(adb_server_up(server.local_addr().unwrap().port()).await);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn lists_only_booted_simulators_and_ready_android_devices() {
        let simctl = r#"{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[
            {"udid":"A1","name":"iPhone 16","state":"Booted"},
            {"udid":"B2","name":"iPad","state":"Shutdown"}]}}"#;
        assert_eq!(
            booted_simulators(simctl),
            vec![json!({"platform":"ios","id":"A1","name":"iPhone 16"})]
        );
        let adb = "* daemon started successfully\nList of devices attached\n\
            emulator-5554          device product:sdk_gphone64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\
            R58M123                unauthorized usb:1-1 transport_id:2\n\n";
        assert_eq!(
            adb_devices(adb),
            vec![json!({"platform":"android","id":"emulator-5554","name":"sdk gphone64 arm64"})]
        );
    }

    #[test]
    fn a_device_id_is_never_an_option() {
        assert!(device_id("emulator-5554").is_ok());
        assert!(device_id("-s").is_err());
        assert!(device_id("").is_err());
    }

    #[tokio::test]
    async fn ipc_device_rejects_bad_requests() {
        use crate::ipc::Caller;
        let ctx = || IpcContext {
            caller: Caller {
                key: "w1".into(),
                window: Some(1),
                conn_id: None,
                device_id: None,
            },
            user_data: None,
        };
        assert!(ipc_device(ctx(), vec![json!({})]).await.is_err());
        assert!(
            ipc_device(
                ctx(),
                vec![json!({"action": "tap", "id": "emu", "x": -1, "y": 0})]
            )
            .await
            .is_err()
        );
        assert!(
            ipc_device(
                ctx(),
                vec![json!({"action": "key", "id": "emu", "key": "power"})]
            )
            .await
            .is_err()
        );
        assert!(
            ipc_device(
                ctx(),
                vec![json!({"action": "screen", "platform": "web", "id": "emu"})]
            )
            .await
            .is_err()
        );
    }
}
