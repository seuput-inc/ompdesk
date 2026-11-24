//! Who serves each page channel of `omp_ipc` (docs/rust-node-removal.md §2), keyed by direction and channel.
//!
//! `ipc_router.json` names the channels the shell serves itself; main hands over the channels it serves
//! (`ipc.routes`, once, right after `hello` and before it opens a window). A page's call goes to exactly one owner:
//! a native channel runs here and never reaches main, even when its handler fails (a mutation is never tried a
//! second time on main); a channel main listed goes to main as before; anything else (unknown, the other direction,
//! a call before the handover) is refused. Main's own callers of a native channel (a paired page's connection, an
//! agent's `ompdesk_app`) reach the same handler through `ipc.call`, after main's permission checks.
//!
//! Moving a channel here: add its handler to `handler`, its name to `ipc_router.json` and delete main's handler in the
//! same change. A `send` channel moves only with its ordering against main's sends settled: the page's sends reach
//! main in order, and a native one overtakes them.

use crate::log::log;
use crate::native_services::diagnostic_logs::FeedbackRead;
use crate::registry::Identity;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{LazyLock, OnceLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Dir {
    Invoke,
    Send,
}

impl Dir {
    fn name(self) -> &'static str {
        match self {
            Self::Invoke => "invoke",
            Self::Send => "send",
        }
    }
}

/// Channels by direction, as `ipc_router.json` and `ipc.routes` write them.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Channels {
    invoke: BTreeSet<String>,
    send: BTreeSet<String>,
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
static MAIN: OnceLock<Channels> = OnceLock::new();

/// What a native handler reads of the running shell.
pub(crate) struct Context<'a> {
    pub(crate) feedback_profile: &'a Path,
    /// `<appPath>/package.json`, which main's `app.getVersion()` read.
    pub(crate) app_package: &'a Path,
}

/// Who made a call, as the handler sees it. `Page`: the shell's own app page, after the URL, registry and
/// document-generation checks (its window, webContents and document generation). `Main`: a caller main admitted after
/// its own checks (a paired page's grant and quota, an agent's `ompdesk_app` risk): its lane key (`w<wcId>`,
/// `c<connId>`), its window (negative for a paired device's) and a paired page's connection.
pub(crate) enum Caller {
    Page(Identity),
    Main {
        key: String,
        window: Option<i64>,
        conn_id: Option<String>,
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
            } => json!({"key":key,"window":window,"connId":conn_id}),
        }
    }
}

/// A native handler: its caller and arguments in, its value or a `{code, message}` refusal out. Runs on the blocking
/// pool.
pub(crate) type Handler = fn(&Context, &Caller, &Value) -> Result<Value, Value>;

pub(crate) enum Route {
    Native(Handler),
    Main,
    Refused(Value),
}

/// The owner of `channel` called in `dir`.
pub(crate) fn route(dir: Dir, channel: &str) -> Route {
    route_in(&NATIVE, MAIN.get(), dir, channel)
}

fn route_in(native: &Channels, main: Option<&Channels>, dir: Dir, channel: &str) -> Route {
    if native.has(dir, channel)
        && let Some(handler) = handler(channel)
    {
        return Route::Native(handler);
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
        "runtime:log-path" => |ctx, _, _| Ok(FeedbackRead::Path.read(ctx.feedback_profile)),
        "runtime:log-tail" => {
            |ctx, _, args| Ok(FeedbackRead::tail(args).read(ctx.feedback_profile))
        }
        "updater:version" => |ctx, _, _| Ok(Value::String(app_version(ctx.app_package))),
        _ => return None,
    })
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

/// `ipc.routes {invoke, send}`: the channels main serves, handed over once. Refused when main names a native channel
/// (two owners) or hands over a second time.
pub(crate) fn hand_over(params: &Value) -> Result<(), String> {
    hand_over_to(&MAIN, &NATIVE, params)
}

fn hand_over_to(
    slot: &OnceLock<Channels>,
    native: &Channels,
    params: &Value,
) -> Result<(), String> {
    let main = Channels::deserialize(params).map_err(|error| error.to_string())?;
    let both: Vec<&str> = main
        .entries()
        .filter(|(_, channel)| native.has(Dir::Invoke, channel) || native.has(Dir::Send, channel))
        .map(|(_, channel)| channel)
        .collect();
    if !both.is_empty() {
        return Err(format!("main and the shell both serve {}", both.join(", ")));
    }
    slot.set(main)
        .map_err(|_| "main already handed over its IPC channels".to_owned())
}

/// `ipc.call {channel, dir, args, caller: {key, window, connId}}` from main: a native channel's call by a caller main
/// admitted.
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
    };
    let Route::Native(handler) = route(dir, channel) else {
        return Err(invalid(&format!(
            "'{channel}' ({}) is not the shell's",
            dir.name()
        )));
    };
    let value = run(handler, ctx, &caller, channel, &params["args"])?;
    Ok(json!({ "value": value }))
}

/// The native channels for `hello`'s facts (`nativeIpc`), so main registers them for its own callers and nowhere else.
pub(crate) fn native_facts() -> Value {
    NATIVE
        .entries()
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
    fn every_native_channel_has_its_handler() {
        for (_, channel) in NATIVE.entries() {
            assert!(
                handler(channel).is_some(),
                "{channel} is listed but has no handler"
            );
        }
    }

    #[test]
    fn one_owner_per_direction_and_channel() {
        let native = channels(&["runtime:log-path"], &[]);
        let main = channels(&["prefs:get"], &["app:quit"]);
        let owner =
            |main: Option<&Channels>, dir, channel| match route_in(&native, main, dir, channel) {
                Route::Native(_) => "native".to_owned(),
                Route::Main => "main".to_owned(),
                Route::Refused(error) => error["message"].as_str().unwrap().to_owned(),
            };
        assert_eq!(
            owner(Some(&main), Dir::Invoke, "runtime:log-path"),
            "native"
        );
        // A native channel answers before main handed over: it never needed main.
        assert_eq!(owner(None, Dir::Invoke, "runtime:log-path"), "native");
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
        let main = channels(&["no:handler"], &[]);
        assert!(matches!(
            route_in(&native, Some(&main), Dir::Invoke, "no:handler"),
            Route::Main
        ));
        assert!(matches!(
            route_in(
                &native,
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
        let slot = OnceLock::new();
        let clash = json!({"invoke": [], "send": ["runtime:log-path"]});
        assert_eq!(
            hand_over_to(&slot, &native, &clash),
            Err("main and the shell both serve runtime:log-path".into())
        );
        assert!(hand_over_to(&slot, &native, &json!({"invoke": ["prefs:get"]})).is_err());
        assert!(slot.get().is_none());
        hand_over_to(
            &slot,
            &native,
            &json!({"invoke": ["prefs:get"], "send": []}),
        )
        .unwrap();
        assert_eq!(
            hand_over_to(&slot, &native, &json!({"invoke": [], "send": []})),
            Err("main already handed over its IPC channels".into())
        );
        assert!(slot.get().unwrap().has(Dir::Invoke, "prefs:get"));
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
