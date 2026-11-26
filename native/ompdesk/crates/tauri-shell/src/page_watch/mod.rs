//! Notices an app window's page that stopped running script, and a page whose content process ended.
//!
//! A frozen page can do nothing, and no engine tells the host in time (WKWebView never does, WebView2 only once
//! input went undelivered). So the host asks: each turn it has the engine evaluate an empty script in every app page
//! that is due, by a path that uses neither the page's IPC nor a resource load. A probe unanswered for
//! [`rules::UNRESPONSIVE_AFTER`] is Electron's `unresponsive` for the window and its page, and its late answer is
//! `responsive`. What follows is app_window.rs's: the page's content process is ended, and a content process that
//! ended, by that or by itself, is `render-process-gone`, after which the page loads again.
//!
//! The timing is rules.rs; each page's `Watch` lives in its registry record, so it ends with the page.

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod native;
#[cfg(windows)]
#[path = "windows.rs"]
mod native;
mod rules;

pub use rules::{Activity, Step, Watch};

use crate::registry::Identity;
use crate::runtime;
use rules::Clock;
use serde_json::json;
use shell_core::wire::WireError;
use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::Manager;

/// How often the watch looks.
const TURN: Duration = Duration::from_secs(1);
/// The probe: a script with nothing to do.
const PROBE: &str = "0";

static CLOCK: Mutex<Clock> = Mutex::new(Clock::new());

/// Starts the watch for the rest of the run. Its turns run on the UI thread, where the probes are sent and answered,
/// so a held UI thread delays the turns with the answers instead of counting against the pages.
pub fn run() {
    static QUEUED: AtomicBool = AtomicBool::new(false);
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(TURN).await;
            if QUEUED.swap(true, Ordering::SeqCst) {
                continue;
            }
            let posted = runtime().app.run_on_main_thread(|| {
                QUEUED.store(false, Ordering::SeqCst);
                turn();
            });
            if posted.is_err() {
                return;
            }
        }
    });
}

fn turn() {
    let step = CLOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .step(Instant::now());
    let pages = runtime()
        .registry
        .lock()
        .expect("registry")
        .watched_labels();
    let inspected: HashSet<u64> = pages
        .into_iter()
        .filter(|(_, label)| {
            runtime()
                .app
                .get_webview_window(label)
                .is_some_and(|window| window.is_devtools_open())
        })
        .map(|(wc, _)| wc)
        .collect();
    let steps = runtime()
        .registry
        .lock()
        .expect("registry")
        .watch_turn(step, &inspected);
    for (identity, step) in steps {
        match step {
            Step::Probe(probe) => match crate::window_for_wc(identity.wc) {
                Ok(window) => native::probe(&window, identity.wc, probe),
                Err(_) => settled(identity.wc, probe, false),
            },
            Step::Unresponsive => tell(identity, "unresponsive"),
        }
    }
}

/// A probe ended: the page answered it, or the engine gave it up.
fn settled(wc: u64, probe: u64, answered: bool) {
    let back = runtime()
        .registry
        .lock()
        .expect("registry")
        .watched(wc)
        .and_then(|(identity, watch)| {
            if answered {
                watch.answered(probe).then_some(identity)
            } else {
                watch.failed(probe);
                None
            }
        });
    if let Some(identity) = back {
        tell(identity, "responsive");
    }
}

fn tell(identity: Identity, name: &str) {
    crate::log::log(&format!("page.{name}"), json!({"wcId": identity.wc}));
    crate::wc_event(identity.wc, name, json!([]));
    if let Some(win) = identity.win {
        crate::win_event(win, name);
    }
    if name == "unresponsive" {
        crate::app_window::unresponsive(identity.wc);
    } else {
        crate::app_window::responsive(identity.wc);
    }
}

/// WebView2's own verdict that the page's renderer is unresponsive.
#[cfg(windows)]
fn engine_unresponsive(wc: u64) {
    let told = runtime()
        .registry
        .lock()
        .expect("registry")
        .watched(wc)
        .and_then(|(identity, watch)| watch.engine_unresponsive().then_some(identity));
    if let Some(identity) = told {
        tell(identity, "unresponsive");
    }
}

/// The content process of an app page ended: `render-process-gone`, `killed` when the host ended it, `oom` when the
/// engine said it ran out of memory (WebView2's `OUT_OF_MEMORY`; WebKit names no reason).
fn content_process_gone(wc: u64, exit_code: Option<i32>, oom: bool) {
    let gone = runtime()
        .registry
        .lock()
        .expect("registry")
        .process_gone(wc);
    let Some((_, killed)) = gone else {
        return;
    };
    let reason = if killed {
        "killed"
    } else if oom {
        "oom"
    } else {
        "crashed"
    };
    let mut details = json!({ "reason": reason });
    if let Some(code) = exit_code {
        details["exitCode"] = json!(code);
    }
    crate::log::log("page.process_gone", json!({"wcId": wc, "details": details}));
    crate::wc_state(wc);
    crate::wc_event(wc, "render-process-gone", json!([details]));
    crate::app_window::process_gone(wc, &details, killed);
}

/// WebKit's notice that a webview's content process ended. With this hook set, wry no longer reloads the view itself.
#[cfg(target_os = "macos")]
pub fn content_process_ended(webview: &tauri::Webview) {
    let wc = runtime()
        .registry
        .lock()
        .expect("registry")
        .by_label(webview.label())
        .map(|page| page.identity.wc);
    if let Some(wc) = wc {
        content_process_gone(wc, None, false);
    }
}

/// WebView2 reports a renderer that ended, or that it found unresponsive, per webview.
#[cfg(windows)]
pub fn attach(window: &tauri::WebviewWindow, wc: u64) {
    if let Err(error) = native::watch_failures(window, wc) {
        crate::log::log(
            "page.watch_failed",
            json!({"wcId": wc, "error": error.to_string()}),
        );
    }
}

/// Ends the content process of a page that stopped answering (app_window.rs); `render-process-gone` follows, `killed`.
pub fn end_stuck(wc: u64) {
    crate::log::log("page.kill", json!({"wcId": wc}));
    match crate::window_for_wc(wc) {
        Ok(window) => native::kill(&window, wc),
        Err(error) => killed(wc, Err(error)),
    }
}

/// The host is about to end `wc`'s content process, so its end reads `killed`; `false` takes back a kill that failed.
fn killing(wc: u64, on: bool) {
    if let Some((_, watch)) = runtime().registry.lock().expect("registry").watched(wc) {
        watch.killing(on);
    }
}

/// How the kill went: nothing waits for it, so this line is the record.
fn killed(wc: u64, result: Result<(), WireError>) {
    match result {
        Ok(()) => crate::log::log("page.killed", json!({"wcId": wc})),
        Err(error) => crate::log::log(
            "page.kill_failed",
            json!({"wcId": wc, "code": error.code, "error": error.message}),
        ),
    }
}
