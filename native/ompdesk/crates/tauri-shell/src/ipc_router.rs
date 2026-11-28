//! Who serves each page channel of `omp_ipc` (docs/rust-node-removal.md §2, §4), keyed by direction and channel.
//!
//! `ipc_router.json` names the channels the shell serves itself; `crates/core/src/ipc/channels.json` names the
//! channels `ompdesk-core` serves over the shell's direct `client: "shell"` connection (`core_ipc.rs`); main hands
//! over the channels it still serves plus `IPC_POLICY` (`ipc.routes`, once, right after `hello` and before it opens a
//! window). A page's call goes to exactly one owner: a shell-native channel runs here and never reaches main, even
//! when its handler fails; a core-owned channel goes directly `tauri-shell -> ompdesk-core` (`core_ipc.rs`) and never
//! reaches main (a mutation is never tried a second time on main); a channel main listed goes to main as before;
//! anything else (unknown, the other direction, a call before the handover) is refused. Main's own callers of a
//! shell-routed channel (a paired page's connection, an agent's `ompdesk_app`) reach the same handler through
//! `ipc.call`, after main's permission checks.
//!
//! Moving a channel to the shell: add its handler to `handler`, its name to `ipc_router.json` and delete main's
//! handler in the same change. Moving a channel to the core: add it to `crates/core/src/ipc/mod.rs` and
//! `channels.json` and delete main's handler in the same change. A `send` channel moves only with its ordering against
//! main's sends settled: the page's sends reach main in order, and a native or core one overtakes them.

use crate::core_ipc;
use crate::log::log;
use crate::native_services::diagnostic_logs::FeedbackRead;
use crate::native_services::power;
use crate::registry::Identity;
use crate::{page_dialogs, tray};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{LazyLock, Mutex, OnceLock, PoisonError};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Dir {
    Invoke,
    Send,
}

impl Dir {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Invoke => "invoke",
            Self::Send => "send",
        }
    }
}

/// Channels by direction, as `ipc_router.json`, `channels.json` and `ipc.routes` write them.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Channels {
    invoke: BTreeSet<String>,
    send: BTreeSet<String>,
}

/// `ipc.routes` payload from main: main's channels, plus `IPC_POLICY` for `ompdesk-core`'s `ipc.start`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HandOver {
    invoke: BTreeSet<String>,
    send: BTreeSet<String>,
    #[serde(default)]
    policy: Option<Value>,
}

impl Channels {
    fn has(&self, dir: Dir, channel: &str) -> bool {
        match dir {
            Dir::Invoke => self.invoke.contains(channel),
            Dir::Send => self.send.contains(channel),
        }
    }

    fn entries(&self) -> impl Iterator<Item = (Dir, &str)> {
        let invoke = self.invoke.iter().map(|c| (Dir::Invoke, c.as_str()));
        invoke.chain(self.send.iter().map(|c| (Dir::Send, c.as_str())))
    }
}

static NATIVE: LazyLock<Channels> = LazyLock::new(|| {
    serde_json::from_str(include_str!("ipc_router.json"))
        .expect("ipc_router.json is the native channel table")
});
static CORE: LazyLock<Channels> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../core/src/ipc/channels.json"))
        .expect("core/src/ipc/channels.json is the core channel table")
});
static MAIN: OnceLock<Channels> = OnceLock::new();
/// Latest validated list of file basenames waiting for disk space, pushed by main via `diskFull.state`.
static DISK_FULL: LazyLock<Mutex<Vec<String>>> = LazyLock::new(Mutex::default);

/// What a native handler reads of the running shell.
pub(crate) struct Context<'a> {
    pub(crate) feedback_profile: &'a Path,
    /// `<appPath>/package.json`, which main's `app.getVersion()` read.
    pub(crate) app_package: &'a Path,
}

/// Who made a call, as the handler sees it. `Page`: the shell's own app page, after the URL, registry and
/// document-generation checks (its window, webContents and document generation). `Main`: a caller main admitted after
/// its own checks (a paired page's grant and quota, an agent's `ompdesk_app` risk): its lane key (`w<wcId>`,
/// `c<connId>`), its window (negative for a paired device's), a paired page's connection and its paired device id.
pub(crate) enum Caller {
    Page(Identity),
    Main {
        key: String,
        window: Option<i64>,
        conn_id: Option<String>,
        device_id: Option<String>,
    },
}

impl Caller {
    fn describe(&self) -> Value {
        match self {
            Self::Page(Identity {
                win,
                wc,
                generation,
            }) => {
                json!({"window":win,"wcId":wc,"generation":generation})
            }
            Self::Main {
                key,
                window,
                conn_id,
                device_id,
            } => json!({"key":key,"window":window,"connId":conn_id,"deviceId":device_id}),
        }
    }
}

/// A native handler: its caller and arguments in, its value or a `{code, message}` refusal out. Runs on the blocking
/// pool.
pub(crate) type Handler = fn(&Context, &Caller, &Value) -> Result<Value, Value>;

pub(crate) enum Route {
    Native(Handler),
    Core,
    Main,
    Refused(Value),
}

/// The owner of `channel` called in `dir`.
pub(crate) fn route(dir: Dir, channel: &str) -> Route {
    route_in(&NATIVE, &CORE, MAIN.get(), dir, channel)
}

fn route_in(
    native: &Channels,
    core: &Channels,
    main: Option<&Channels>,
    dir: Dir,
    channel: &str,
) -> Route {
    if native.has(dir, channel)
        && let Some(handler) = handler(channel)
    {
        return Route::Native(handler);
    }
    if core.has(dir, channel) {
        return Route::Core;
    }
    match main {
        Some(main) if main.has(dir, channel) => Route::Main,
        // Electron's own words for a channel nobody handles, which the page saw before.
        Some(_) => Route::Refused(
            json!({"code":"invalid","message":format!("No handler registered for '{channel}' ({})", dir.name())}),
        ),
        None => Route::Refused(
            json!({"code":"denied","message":"main has not handed over its IPC channels"}),
        ),
    }
}

fn handler(channel: &str) -> Option<Handler> {
    Some(match channel {
        "disk-full:get" => |_, _, _| Ok(disk_full_snapshot()),
        "runtime:log-path" => |ctx, _, _| Ok(FeedbackRead::Path.read(ctx.feedback_profile)),
        "runtime:log-tail" => {
            |ctx, _, args| Ok(FeedbackRead::tail(args).read(ctx.feedback_profile))
        }
        "updater:version" => |ctx, _, _| Ok(Value::String(app_version(ctx.app_package))),
        // A desktop window starts its tab on its session, so nothing is pending; a paired page reads its own link.
        "session:consume-pending" => |_, _, _| Ok(Value::Null),
        "system:desktop-away" => |_, _, _| Ok(desktop_away()),
        "system:save-dialog" => |_, caller, args| page_dialogs::save_dialog(caller, args),
        "system:open-dialog" => |_, caller, args| page_dialogs::open_dialog(caller, args),
        "system:save-image" => |_, caller, args| page_dialogs::save_image(caller, args),
        // The tray's hover text and the app icon's progress gather every window's pushes (tray.rs).
        "tray:state-push" => |_, caller, args| Ok(tray::state_push(caller, &args[0])),
        "progress:set" => |_, caller, args| Ok(tray::progress_push(caller, &args[0])),
        _ => return None,
    })
}

fn parse_disk_full_files(data: &Value) -> Option<Vec<String>> {
    fn file_name(value: &Value) -> Option<String> {
        let name = value.as_str()?;
        let ok = !name.contains(['/', '\\'])
            && !matches!(name.as_bytes(), [b'a'..=b'z' | b'A'..=b'Z', b':', ..]);
        ok.then(|| name.to_owned())
    }
    if data.as_object()?.len() != 1 {
        return None;
    }
    data["files"]
        .as_array()?
        .iter()
        .map(file_name)
        .collect::<Option<Vec<_>>>()
}

/// Records the validated file basenames from `diskFull.state` so `disk-full:get` answers directly from the shell.
pub(crate) fn set_disk_full(data: &Value) {
    if let Some(files) = parse_disk_full_files(data) {
        *DISK_FULL.lock().unwrap_or_else(PoisonError::into_inner) = files;
    }
}

fn disk_full_snapshot() -> Value {
    let files = DISK_FULL
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    json!({ "files": files })
}

fn desktop_away_from(forced: Option<&str>, native: Option<bool>) -> Value {
    match forced {
        Some("0") => Value::Bool(false),
        Some("1") => Value::Bool(true),
        _ => native.map_or(Value::Null, Value::Bool),
    }
}

fn desktop_away() -> Value {
    let forced = std::env::var("OMP_GUI_TEST_DESKTOP_AWAY").ok();
    desktop_away_from(forced.as_deref(), power::desktop_away())
}

/// Main's `appVersion()`: `package.json`'s `version` when it is a string, else `0.0.0` (its `readPackage`).
fn app_version(package: &Path) -> String {
    std::fs::read(package)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get("version")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| "0.0.0".into())
}

/// Runs a native handler for `caller`; a refusal is logged with the caller, since no page console shows it.
pub(crate) fn run(
    handler: Handler,
    ctx: &Context,
    caller: &Caller,
    channel: &str,
    args: &Value,
) -> Result<Value, Value> {
    let result = handler(ctx, caller, args);
    if let Err(error) = &result {
        let caller = caller.describe();
        log(
            "ipc.native.failed",
            json!({"channel":channel,"caller":caller,"error":error}),
        );
    }
    result
}

/// Calls a core-owned channel directly through `core_ipc`, logging any refusal with caller details.
pub(crate) fn call_core(
    caller: &Caller,
    dir: Dir,
    channel: &str,
    args: &Value,
) -> Result<Option<Value>, Value> {
    let result = core_ipc::call(caller, dir, channel, args);
    if let Err(error) = &result {
        let caller = caller.describe();
        log(
            "ipc.core.failed",
            json!({"channel":channel,"caller":caller,"error":error}),
        );
    }
    result
}

/// Shapes an invoke answer for `omp_ipc` / `ipc.call`: `Some(v)` carries `{"value": v}`, `None` omits `"value"` so JS
/// receives `undefined`.
pub(crate) fn wrap_answer(value: Option<Value>) -> Value {
    match value {
        Some(value) => Value::from_iter([("value", value)]),
        None => json!({}),
    }
}

/// `ipc.routes {invoke, send, policy?}`: the channels main serves, handed over once, plus `IPC_POLICY` for
/// `ompdesk-core`. Refused when main names a native or core channel (two owners) or hands over a second time.
pub(crate) fn hand_over(params: &Value, user_data: &Path) -> Result<(), String> {
    let policy = hand_over_to(&MAIN, &NATIVE, &CORE, params)?;
    if let Some(policy) = policy {
        core_ipc::set_policy(policy, user_data);
    }
    Ok(())
}

fn hand_over_to(
    slot: &OnceLock<Channels>,
    native: &Channels,
    core: &Channels,
    params: &Value,
) -> Result<Option<Value>, String> {
    let HandOver {
        invoke,
        send,
        policy,
    } = HandOver::deserialize(params).map_err(|error| error.to_string())?;
    let main = Channels { invoke, send };
    let both: Vec<&str> = main
        .entries()
        .filter(|(_, channel)| {
            native.has(Dir::Invoke, channel)
                || native.has(Dir::Send, channel)
                || core.has(Dir::Invoke, channel)
                || core.has(Dir::Send, channel)
        })
        .map(|(_, channel)| channel)
        .collect();
    if !both.is_empty() {
        return Err(format!("main and the shell both serve {}", both.join(", ")));
    }
    slot.set(main)
        .map_err(|_| "main already handed over its IPC channels".to_owned())?;
    Ok(policy)
}

/// `ipc.call {channel, dir, args, caller: {key, window, connId, deviceId?}}` from main: a shell-native or core-owned
/// channel's call by a caller main admitted.
pub(crate) fn call_from_main(ctx: &Context, params: &Value) -> Result<Value, Value> {
    let invalid = |message: &str| json!({"code":"invalid","message":message});
    let channel = params["channel"]
        .as_str()
        .ok_or_else(|| invalid("missing channel"))?;
    let dir =
        Dir::deserialize(&params["dir"]).map_err(|_| invalid("dir must be invoke or send"))?;
    let caller = &params["caller"];
    let key = caller["key"]
        .as_str()
        .ok_or_else(|| invalid("missing caller key"))?;
    let caller = Caller::Main {
        key: key.to_owned(),
        window: caller["window"].as_i64(),
        conn_id: caller["connId"].as_str().map(str::to_owned),
        device_id: caller["deviceId"].as_str().map(str::to_owned),
    };
    match route(dir, channel) {
        Route::Native(handler) => {
            let value = run(handler, ctx, &caller, channel, &params["args"])?;
            Ok(json!({ "value": value }))
        }
        Route::Core => {
            let value = call_core(&caller, dir, channel, &params["args"])?;
            Ok(wrap_answer(value))
        }
        Route::Main | Route::Refused(_) => Err(invalid(&format!(
            "'{channel}' ({}) is not the shell's",
            dir.name()
        ))),
    }
}

/// The shell-routed channels (shell-native + core-owned) for `hello`'s facts (`nativeIpc`), so main registers them for
/// its own callers and nowhere else.
pub(crate) fn native_facts() -> Value {
    NATIVE
        .entries()
        .chain(CORE.entries())
        .map(|(dir, channel)| json!({"channel":channel,"dir":dir.name()}))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn channels(invoke: &[&str], send: &[&str]) -> Channels {
        Channels {
            invoke: invoke.iter().map(|c| (*c).to_owned()).collect(),
            send: send.iter().map(|c| (*c).to_owned()).collect(),
        }
    }

    #[test]
    fn every_native_channel_has_its_handler_and_is_disjoint_from_core() {
        for (_, channel) in NATIVE.entries() {
            assert!(
                handler(channel).is_some(),
                "{channel} is listed but has no handler"
            );
            assert!(
                !CORE.has(Dir::Invoke, channel) && !CORE.has(Dir::Send, channel),
                "{channel} is listed in both ipc_router.json and core/src/ipc/channels.json"
            );
        }
    }

    #[test]
    fn one_owner_per_direction_and_channel() {
        let native = channels(&["runtime:log-path"], &[]);
        let core = channels(&["draft-pictures:read"], &["core:ping"]);
        let main = channels(&["prefs:get"], &["app:quit"]);
        let owner = |main: Option<&Channels>, dir, channel| match route_in(
            &native, &core, main, dir, channel,
        ) {
            Route::Native(_) => "native".to_owned(),
            Route::Core => "core".to_owned(),
            Route::Main => "main".to_owned(),
            Route::Refused(error) => error["message"].as_str().unwrap().to_owned(),
        };
        assert_eq!(
            owner(Some(&main), Dir::Invoke, "runtime:log-path"),
            "native"
        );
        // Native and core channels route before main handed over: neither goes through main.
        assert_eq!(owner(None, Dir::Invoke, "runtime:log-path"), "native");
        assert_eq!(owner(None, Dir::Invoke, "draft-pictures:read"), "core");
        assert_eq!(
            owner(Some(&main), Dir::Invoke, "draft-pictures:read"),
            "core"
        );
        assert_eq!(owner(Some(&main), Dir::Send, "core:ping"), "core");
        assert_eq!(
            owner(Some(&main), Dir::Send, "draft-pictures:read"),
            "No handler registered for 'draft-pictures:read' (send)"
        );
        assert_eq!(owner(Some(&main), Dir::Invoke, "prefs:get"), "main");
        assert_eq!(owner(Some(&main), Dir::Send, "app:quit"), "main");
        assert_eq!(
            owner(Some(&main), Dir::Send, "runtime:log-path"),
            "No handler registered for 'runtime:log-path' (send)"
        );
        assert_eq!(
            owner(Some(&main), Dir::Invoke, "app:quit"),
            "No handler registered for 'app:quit' (invoke)"
        );
        assert_eq!(
            owner(Some(&main), Dir::Invoke, "nobody:serves"),
            "No handler registered for 'nobody:serves' (invoke)"
        );
        assert_eq!(
            owner(None, Dir::Invoke, "prefs:get"),
            "main has not handed over its IPC channels"
        );
    }

    #[test]
    fn a_listed_channel_without_handler_is_refused_not_sent_to_main() {
        let native = channels(&["no:handler"], &[]);
        let core = channels(&[], &[]);
        let main = channels(&["no:handler"], &[]);
        assert!(matches!(
            route_in(&native, &core, Some(&main), Dir::Invoke, "no:handler"),
            Route::Main
        ));
        assert!(matches!(
            route_in(
                &native,
                &core,
                Some(&channels(&[], &[])),
                Dir::Invoke,
                "no:handler"
            ),
            Route::Refused(_)
        ));
    }

    #[test]
    fn hand_over_refuses_two_owners_and_a_second_hand_over() {
        let native = channels(&["runtime:log-path"], &[]);
        let core = channels(&["draft-pictures:read"], &[]);
        let slot = OnceLock::new();
        let clash = json!({"invoke": [], "send": ["runtime:log-path"]});
        assert_eq!(
            hand_over_to(&slot, &native, &core, &clash),
            Err("main and the shell both serve runtime:log-path".into())
        );
        let core_clash = json!({"invoke": ["draft-pictures:read"], "send": []});
        assert_eq!(
            hand_over_to(&slot, &native, &core, &core_clash),
            Err("main and the shell both serve draft-pictures:read".into())
        );
        assert!(hand_over_to(&slot, &native, &core, &json!({"invoke": ["prefs:get"]})).is_err());
        assert!(slot.get().is_none());
        let policy = hand_over_to(
            &slot,
            &native,
            &core,
            &json!({"invoke": ["prefs:get"], "send": [], "policy": {"prefs:get": {"dir": "invoke"}}}),
        )
        .unwrap();
        assert_eq!(policy, Some(json!({"prefs:get": {"dir": "invoke"}})));
        assert_eq!(
            hand_over_to(&slot, &native, &core, &json!({"invoke": [], "send": []})),
            Err("main already handed over its IPC channels".into())
        );
        assert!(slot.get().unwrap().has(Dir::Invoke, "prefs:get"));
    }

    #[test]
    fn wrap_answer_preserves_undefined_vs_null() {
        assert_eq!(wrap_answer(None), json!({}));
        assert_eq!(wrap_answer(Some(Value::Null)), json!({"value": null}));
        assert_eq!(wrap_answer(Some(json!(42))), json!({"value": 42}));
    }

    #[test]
    fn disk_full_snapshot_validates_basenames_and_updates_snapshot() {
        assert_eq!(
            parse_disk_full_files(&json!({"files": ["prefs.json", "journal.json"]})),
            Some(vec!["prefs.json".into(), "journal.json".into()])
        );
        assert_eq!(
            parse_disk_full_files(&json!({"files": []})),
            Some(Vec::new())
        );
        for bad in [
            json!({"files": ["a/b"]}),
            json!({"files": ["a\\b"]}),
            json!({"files": ["C:x"]}),
            json!({"files": ["ok"], "extra": 1}),
            json!({"files": [123]}),
        ] {
            assert_eq!(parse_disk_full_files(&bad), None, "{bad}");
        }
        set_disk_full(&json!({"files": ["prefs.json"]}));
        assert_eq!(disk_full_snapshot(), json!({"files": ["prefs.json"]}));
        // Invalid payload leaves the last valid snapshot untouched.
        set_disk_full(&json!({"files": ["../escape"]}));
        assert_eq!(disk_full_snapshot(), json!({"files": ["prefs.json"]}));
        set_disk_full(&json!({"files": []}));
        assert_eq!(disk_full_snapshot(), json!({"files": []}));
    }

    #[test]
    fn desktop_away_respects_test_override_and_falls_back_to_native() {
        assert_eq!(desktop_away_from(Some("0"), Some(true)), json!(false));
        assert_eq!(desktop_away_from(Some("1"), Some(false)), json!(true));
        assert_eq!(desktop_away_from(Some("other"), Some(true)), json!(true));
        assert_eq!(desktop_away_from(None, Some(false)), json!(false));
        assert_eq!(desktop_away_from(None, None), Value::Null);
    }

    #[test]
    fn app_version_reads_package_json_as_main_did() {
        let dir = tempdir().unwrap();
        let package = dir.path().join("package.json");
        assert_eq!(app_version(&package), "0.0.0");
        for (text, version) in [
            (r#"{"name":"ompdesk","version":"0.141.2"}"#, "0.141.2"),
            (r#"{"version":141}"#, "0.0.0"),
            ("null", "0.0.0"),
            ("{", "0.0.0"),
            ("\u{feff}{\"version\":\"1.0.0\"}", "0.0.0"),
        ] {
            std::fs::write(&package, text).unwrap();
            assert_eq!(app_version(&package), version, "{text}");
        }
    }
}
