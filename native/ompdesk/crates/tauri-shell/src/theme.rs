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

/// The effective facts under `source`, and as `system` what the OS itself says: Node answers `shouldUseDarkColors` for
/// a source set back to `system` from it, before the shell's answer arrives, and a forced source hides it otherwise.
fn snapshot(source: ThemeSource) -> Value {
    let os = system::theme();
    let mut value = effective_theme(&os, source);
    value["system"] = json!({
        "dark": os["dark"].as_bool().unwrap_or(false),
        "highContrast": os["highContrast"].as_bool().unwrap_or(false),
        "inverted": os["inverted"].as_bool().unwrap_or(false),
    });
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

/// The page's background in each scheme (`--sc-bg`; src/renderer/styles/tokens.test.ts pins the file to it).
const WINDOW_BACKGROUND: &str = include_str!("../../../../../src/shared/window-background.json");

fn hex(colour: &str) -> Option<tauri::window::Color> {
    let digits = colour
        .strip_prefix('#')
        .filter(|digits| digits.len() == 6)?;
    let channel = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok();
    Some(tauri::window::Color(
        channel(0)?,
        channel(2)?,
        channel(4)?,
        255,
    ))
}

/// Whether the app shows in its dark scheme now (the source the page set, else the OS's).
pub fn is_dark() -> bool {
    let source = STATE.with(|state| state.borrow().source);
    effective_theme(&system::theme(), source)["dark"]
        .as_bool()
        .unwrap_or(false)
}

/// The page's background (`--sc-bg`) in the scheme it shows now, as `#rrggbb`.
pub fn background_hex() -> Option<String> {
    let colours: Value = serde_json::from_str(WINDOW_BACKGROUND).ok()?;
    Some(
        colours[if is_dark() { "dark" } else { "light" }]
            .as_str()?
            .to_owned(),
    )
}

/// What a new app window is painted in until its page paints: the page's own background in the scheme it will open in,
/// so a window shown before a slow first paint is the app's colour, never white or black.
pub fn window_background() -> Option<tauri::window::Color> {
    hex(&background_hex()?)
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
        call.ok(json!({"dark": now["dark"], "highContrast": now["highContrast"], "inverted": now["inverted"], "system": now["system"]}));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_schemes_have_an_opaque_window_background() {
        let colours: Value = serde_json::from_str(WINDOW_BACKGROUND).unwrap();
        for scheme in ["light", "dark"] {
            let colour = hex(colours[scheme].as_str().unwrap()).unwrap();
            assert_eq!(colour.3, 255, "{scheme}");
        }
    }
}
