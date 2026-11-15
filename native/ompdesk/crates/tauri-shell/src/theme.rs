use std::cell::RefCell;

use serde_json::{Value, json};
use shell_core::desk_state::{ThemeSource, effective_theme};
use tauri::Manager;

use crate::host::{self, Call};
use crate::system;

#[derive(Default)]
struct State {
    source: ThemeSource,
    last: Option<Value>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn snapshot(source: ThemeSource) -> Value {
    let mut value = effective_theme(&system::theme(), source);
    value["reducedMotion"] = json!(system::reduced_motion());
    value
}

pub fn for_new_window() -> Option<tauri::Theme> {
    STATE.with(|state| match state.borrow().source {
        ThemeSource::System => None,
        ThemeSource::Light => Some(tauri::Theme::Light),
        ThemeSource::Dark => Some(tauri::Theme::Dark),
    })
}

pub fn init() {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.last = Some(snapshot(state.source));
    });
}

fn apply() -> Result<(), String> {
    let theme = for_new_window();
    let app = &crate::runtime().app;
    app.set_theme(theme);
    for (label, window) in app.webview_windows() {
        window
            .set_theme(theme)
            .map_err(|error| format!("theme for window {label}: {error}"))?;
    }
    Ok(())
}

pub fn refresh() {
    let changed = STATE.with(|state| {
        let mut state = state.borrow_mut();
        let now = snapshot(state.source);
        if state.last.as_ref() == Some(&now) {
            None
        } else {
            state.last = Some(now.clone());
            Some(now)
        }
    });
    if let Some(now) = changed {
        host::event("theme.changed", now);
    }
}

pub fn handle(call: Call) {
    if call.method != "theme.setSource" {
        return call.unsupported();
    }
    let Some(source) = call.str("source").as_deref().and_then(ThemeSource::parse) else {
        return call.err(
            "invalid",
            "theme.setSource: source must be system, light or dark",
        );
    };
    crate::ui::run(move || {
        STATE.with(|state| state.borrow_mut().source = source);
        if let Err(error) = apply() {
            call.err("failed", error);
            return;
        }
        refresh();
        let now = snapshot(source);
        call.ok(json!({"dark": now["dark"], "highContrast": now["highContrast"], "inverted": now["inverted"]}));
    });
}
