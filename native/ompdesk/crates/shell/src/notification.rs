//! `notification.*` (PROTOCOL.md §8): desktop notifications. `show` answers `ok` whenever the request is well formed:
//! a toast that cannot be shown (notifications off, no AppUserModelID, no bundle) is reported by a `failed` event, as
//! Electron's `Notification` does, so the caller's `failed` listener sees it. The toast's own events (`click`,
//! `close`, `failed`) follow from the OS's threads through `emit`.
//!
//! A shell may draw notifications itself (`set_popup`: the Tauri shell's popup, docs/design/custom-notifications.md);
//! one it does not take goes to the OS banner. Either way Node hears the same events.
//!
//! A banner shown about a tab (`show`'s `tab`) is kept until it is clicked, closed or failed; `closeTab` closes every
//! one still up about that tab once the person looks at it (was `src/main/tab-attention.ts`).

use std::sync::{Mutex, MutexGuard, OnceLock};

use serde_json::{Value, json};
use shell_core::notify_spec::ToastSpec;

use crate::host::{self, Call};
use crate::log::log;
use crate::ui;

#[cfg(windows)]
use shell_core::sys::toast as native;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::toast as native;

/// A destination the shell draws itself. Both run on the UI thread.
pub struct Popup {
    /// Takes the notification (`true`), or leaves it to the OS banner.
    pub show: fn(&ToastSpec) -> bool,
    /// Removes notification `id` if it holds it (`true`).
    pub close: fn(u64) -> bool,
}

static POPUP: OnceLock<Popup> = OnceLock::new();

pub fn set_popup(popup: Popup) {
    let _ = POPUP.set(popup);
}

/// The banners still up about a tab, as (tab, notification id), oldest first.
static BANNERS: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());

fn banners() -> MutexGuard<'static, Vec<(String, u64)>> {
    BANNERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Takes the banners about `tab` out of `held`: they are closed.
fn take_tab(held: &mut Vec<(String, u64)>, tab: &str) -> Vec<u64> {
    let mut taken = Vec::new();
    held.retain(|(about, id)| {
        let keep = about != tab;
        if !keep {
            taken.push(*id);
        }
        keep
    });
    taken
}

/// A notification event to Node; also what the OS's threads and the popup call. A banner clicked, closed or failed is
/// no longer up.
pub fn emit(id: u64, name: &'static str, reason: Option<String>) {
    if matches!(name, "click" | "close" | "failed") {
        banners().retain(|(_, shown)| *shown != id);
    }
    let mut data = json!({ "id": id, "name": name });
    if let Some(reason) = reason {
        data["reason"] = Value::String(reason);
    }
    host::event("notification.event", data);
}

/// Shows `spec` as the OS banner and tells Node how that went. UI thread.
pub fn banner(spec: &ToastSpec) {
    match native::show(spec, emit) {
        Ok(()) => emit(spec.id, "show", None),
        Err(why) => {
            log(
                "notification.failed",
                json!({ "id": spec.id, "error": why }),
            );
            emit(spec.id, "failed", Some(why));
        }
    }
}

/// Takes notification `id` down wherever it shows. UI thread.
fn close_any(id: u64) {
    if !POPUP.get().is_some_and(|popup| (popup.close)(id)) {
        native::close(id);
    }
}

pub fn handle(call: Call) {
    match call.method.as_str() {
        "notification.show" => {
            let Some(spec) = ToastSpec::from_json(&call.params) else {
                call.err("invalid", "notification.show needs an id");
                return;
            };
            let tab = call.str("tab").filter(|tab| !tab.is_empty());
            ui::run(move || {
                if let Some(tab) = tab {
                    banners().push((tab, spec.id));
                }
                let taken = POPUP.get().is_some_and(|popup| (popup.show)(&spec));
                call.ok(json!({}));
                if !taken {
                    banner(&spec);
                }
            });
        }
        "notification.close" => {
            let Some(id) = call.params.get("id").and_then(Value::as_u64) else {
                call.err("invalid", "notification.close needs an id");
                return;
            };
            ui::run(move || {
                close_any(id);
                call.ok(json!({}));
            });
        }
        "notification.closeTab" => {
            let Some(tab) = call.str("tab") else {
                call.err("invalid", "notification.closeTab needs a tab");
                return;
            };
            ui::run(move || {
                let ids = take_tab(&mut banners(), &tab);
                for id in ids {
                    close_any(id);
                    // Node's notification hears its close, as after its own `close()` (macOS removes one silently).
                    emit(id, "close", None);
                }
                call.ok(json!({}));
            });
        }
        _ => call.unsupported(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tab_s_banners_close_together_and_no_other_tab_s() {
        let mut held = vec![
            ("a".to_string(), 1),
            ("b".to_string(), 2),
            ("a".to_string(), 3),
        ];
        assert_eq!(take_tab(&mut held, "a"), [1, 3]);
        assert_eq!(held, [("b".to_string(), 2)]);
        assert!(take_tab(&mut held, "a").is_empty());
    }
}
