//! `power.*`: suspend/resume/lock/battery events, idle time, whether the person is away and the blockers
//! (`powerSaveBlocker`).
//!
//! Away (was `src/main/presence.ts`' `readDesktopAway` over Electron's `getSystemIdleState`; after Orca's desktop-away
//! state, stablyai/orca `src/main/notifications/desktop-away-state.ts`, MIT, re-implemented): the screen is locked, or
//! no keyboard or mouse input for `DESKTOP_AWAY_SECONDS`. `power.desktopAway` answers it now and the event
//! `power.desktopAway {away}` tells each change (read every 3 s with the network, `system.rs`), for the paired phones'
//! pushes and the presence a paired computer reports to its hosts.

use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;
use shell_core::desk_state::{BlockerKind, Blockers, Msg};

use crate::host::{self, Call};
use crate::system;

/// Idle seconds after which a desktop counts as away (Orca's threshold).
const DESKTOP_AWAY_SECONDS: u64 = 180;

thread_local! {
    static BLOCKERS: RefCell<Blockers> = RefCell::new(Blockers::default());
    static ON_BATTERY: Cell<bool> = const { Cell::new(false) };
    static SUSPENDED: Cell<bool> = const { Cell::new(false) };
}

/// The screen is locked (the hidden window's lock and unlock); read off the UI thread.
static LOCKED: AtomicBool = AtomicBool::new(false);

fn event(name: &str) {
    host::event("power.event", json!({ "name": name }));
}

fn away(locked: bool, idle_seconds: u64) -> bool {
    locked || idle_seconds >= DESKTOP_AWAY_SECONDS
}

/// Whether the person is away from this computer now. Any thread.
pub fn desktop_away() -> bool {
    away(LOCKED.load(Ordering::Relaxed), system::idle_seconds())
}

/// UI thread.
pub fn init() {
    ON_BATTERY.set(system::on_battery());
}

/// One message of the hidden window. UI thread.
pub fn message(msg: Msg) {
    match msg {
        Msg::Suspend => {
            SUSPENDED.set(true);
            event("suspend");
        }
        // Windows sends RESUMEAUTOMATIC and then RESUMESUSPEND on input; Electron's `resume` fires once.
        Msg::Resume => {
            if SUSPENDED.replace(false) {
                event("resume");
            }
        }
        Msg::Lock => {
            LOCKED.store(true, Ordering::Relaxed);
            event("lock-screen");
        }
        Msg::Unlock => {
            LOCKED.store(false, Ordering::Relaxed);
            event("unlock-screen");
        }
        Msg::Shutdown => event("shutdown"),
        Msg::PowerStatus => {
            let battery = system::on_battery();
            if ON_BATTERY.replace(battery) != battery {
                host::event(
                    "power.event",
                    json!({ "name": if battery { "on-battery" } else { "on-ac" }, "onBattery": battery }),
                );
            }
        }
        Msg::SettingChange | Msg::DisplayChange | Msg::Hotkey(_) => {}
    }
}

pub fn handle(call: Call) {
    match call.method.as_str() {
        "power.idleTime" => {
            let seconds = system::idle_seconds();
            call.ok(json!({ "seconds": seconds }));
        }
        "power.desktopAway" => call.ok(json!({ "away": desktop_away() })),
        "power.blockerStart" => {
            let Some(id) = call.params.get("id").map(ToString::to_string) else {
                return call.err("invalid", "power.blockerStart needs an id");
            };
            let Some(kind) = call.str("type").as_deref().and_then(BlockerKind::parse) else {
                return call.err("invalid", "power.blockerStart: type must be prevent-app-suspension or prevent-display-sleep");
            };
            crate::ui::run(move || {
                BLOCKERS.with(|b| b.borrow_mut().start(id, kind));
                apply(call);
            });
        }
        "power.blockerStop" => {
            let Some(id) = call.params.get("id").map(ToString::to_string) else {
                return call.err("invalid", "power.blockerStop needs an id");
            };
            crate::ui::run(move || {
                BLOCKERS.with(|b| b.borrow_mut().stop(&id));
                apply(call);
            });
        }
        _ => call.unsupported(),
    }
}

/// Applies the live set to the UI thread's execution state, then answers.
fn apply(call: Call) {
    let (system_on, display) = BLOCKERS.with(|b| b.borrow().wanted());
    match system::set_blockers(system_on, display) {
        Ok(()) => call.ok(json!({})),
        Err(message) => call.err("failed", message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn away_when_locked_or_idle_past_the_threshold_present_otherwise() {
        assert!(away(true, 0));
        assert!(away(false, DESKTOP_AWAY_SECONDS));
        assert!(!away(false, DESKTOP_AWAY_SECONDS - 1));
    }
}
