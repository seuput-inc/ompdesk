//! Closing the last shown app window (docs/rust-node-removal.md W4; was `quit-guard.ts` `lastWindowCloseAction`, the
//! `close` handler of `window.ts` and its wiring in `index.ts`). Settings › General › Window's close-to-tray prefs reach
//! the shell as Node stores them (`app.closeToTray`, at start and on every change), so a close decides at once, also
//! while Node is busy.

use crate::labels::text;
use crate::{entry, host, quit_chain, tray};
use serde_json::{Value, json};
use std::sync::{Mutex, OnceLock};

/// What closing an app window does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Close,
    Hide,
    Quit,
}

/// The prefs as Node last pushed them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Prefs {
    /// `closeToTray`: on unless stored `false` (Settings › General › Window).
    close_to_tray: bool,
    /// `closeToTrayNoticeShown`.
    notice_shown: bool,
}

impl Prefs {
    fn parse(data: &Value) -> Self {
        Self {
            close_to_tray: data["closeToTray"] != false,
            notice_shown: data["noticeShown"] == true,
        }
    }
}

/// Before Node's first push: the pref's default, and no notice, since nothing could record it was shown.
static PREFS: Mutex<Prefs> = Mutex::new(Prefs {
    close_to_tray: true,
    notice_shown: true,
});

/// The app icon the notice carries, as Node's notifications do on Windows (`hello`'s `appIcon.path`).
static ICON: OnceLock<String> = OnceLock::new();

/// Closing a window while no other app window is shown. An approved quit lets every window close. macOS hides it, so
/// its tabs and their omp processes keep running and the Dock shows the same window again. Elsewhere close-to-tray
/// hides it; otherwise the app quits with it, asked for before the window goes like any quit: the confirmation for
/// running work, then the tabs end with the quit approved, so their resume markers stay (turn-resume.ts).
fn action(quit_approved: bool, macos: bool, close_to_tray: bool) -> Action {
    if quit_approved {
        Action::Close
    } else if macos || close_to_tray {
        Action::Hide
    } else {
        Action::Quit
    }
}

/// After a hide: whether the one-time "keeps running in the tray" notice shows now. Never on macOS, where the Dock is
/// the way back and needs no explanation.
fn take_notice(prefs: &mut Prefs, macos: bool) -> bool {
    if macos || prefs.notice_shown {
        return false;
    }
    prefs.notice_shown = true;
    true
}

/// `app.closeToTray` from Node: `{closeToTray, noticeShown}` as stored (absent when unset).
pub fn prefs_pushed(data: &Value) {
    *PREFS.lock().expect("close prefs") = Prefs::parse(data);
}

pub fn set_icon(path: Option<&str>) {
    if let Some(path) = path {
        let _ = ICON.set(path.to_owned());
    }
}

/// App window `win` is asked to close by its person (caption button, Alt+F4, ⌘W, Close Window) or by Node
/// (`win.op close`, Electron's `close()`). UI thread. `Close`: the caller closes it. A window already closing, or
/// beside another shown one, just closes. A hidden window stays an app window, so a notification click, the tray and
/// the Dock show it again.
pub fn requested(win: u64) -> Action {
    let windows = entry::app_windows();
    let live = windows.iter().any(|(id, _)| *id == win);
    let others_shown = windows
        .iter()
        .any(|(other, window)| *other != win && window.is_visible().unwrap_or(false));
    if !live || others_shown {
        return Action::Close;
    }
    let macos = cfg!(target_os = "macos");
    let approved = crate::runtime().quit.lock().expect("quit chain").approved();
    let (chosen, notice) = {
        let mut prefs = PREFS.lock().expect("close prefs");
        let chosen = action(approved, macos, tray::exists() && prefs.close_to_tray);
        (
            chosen,
            chosen == Action::Hide && take_notice(&mut prefs, macos),
        )
    };
    match chosen {
        Action::Close => {}
        Action::Hide => entry::op(win, "hide"),
        Action::Quit => quit_chain::ask("last-window"),
    }
    if notice {
        show_notice();
    }
    chosen
}

/// Node writes `closeToTrayNoticeShown` (it owns the prefs file's writes until the core's prefs owner takes the
/// shell's), then the notice shows.
fn show_notice() {
    host::event("app.closeToTrayNoticeShown", json!({}));
    let lang = tray::language();
    let spec = shell_core::notify_spec::ToastSpec {
        // Node numbers its notifications from 1; this one never meets them.
        id: u64::MAX,
        title: text(lang, "tray.keepsRunningTitle").to_owned(),
        body: text(lang, "tray.keepsRunningBody").to_owned(),
        icon: ICON.get().cloned(),
        silent: false,
    };
    #[cfg(windows)]
    if let Err(error) = shell_core::sys::toast::show(&spec, |_, _, _| {}) {
        crate::log::log("closeToTray.notice_failed", json!({"error":error}));
    }
    #[cfg(not(windows))]
    let _ = spec;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_the_last_shown_window() {
        // quit-guard.test.ts: on Windows the quit is asked for before the window goes, so running turns are asked about
        // and resume.
        assert_eq!(action(false, false, false), Action::Quit);
        // It hides to the tray unless the person turned close-to-tray off.
        assert_eq!(action(false, false, true), Action::Hide);
        // Once a quit is approved it just closes.
        assert_eq!(action(true, false, false), Action::Close);
        assert_eq!(action(true, false, true), Action::Close);
        assert_eq!(action(true, true, false), Action::Close);
        // macOS hides whatever the pref, so tabs and omp keep running and the Dock brings it back.
        assert_eq!(action(false, true, false), Action::Hide);
        assert_eq!(action(false, true, true), Action::Hide);
    }

    #[test]
    fn the_pref_is_on_unless_stored_false_and_the_notice_shown_only_when_stored_true() {
        let read = |data: Value| Prefs::parse(&data);
        // quit-guard.test.ts: `closeToTrayEnabled(undefined | true)` on, `false` off.
        assert!(read(json!({})).close_to_tray);
        assert!(read(json!({"closeToTray":null})).close_to_tray);
        assert!(read(json!({"closeToTray":true})).close_to_tray);
        assert!(read(json!({"closeToTray":"no"})).close_to_tray);
        assert!(!read(json!({"closeToTray":false})).close_to_tray);
        // index.ts: `prefs.get(CLOSE_TO_TRAY_NOTICE_PREF) === true`.
        assert!(!read(json!({})).notice_shown);
        assert!(!read(json!({"noticeShown":"true"})).notice_shown);
        assert!(read(json!({"noticeShown":true})).notice_shown);
    }

    #[test]
    fn the_notice_shows_once_and_never_on_macos() {
        let mut prefs = Prefs::parse(&json!({}));
        assert!(!take_notice(&mut prefs, true));
        assert!(take_notice(&mut prefs, false));
        assert!(!take_notice(&mut prefs, false));
        assert!(!take_notice(
            &mut Prefs::parse(&json!({"noticeShown":true})),
            false
        ));
        // Before Node's first push nothing could record it, so it does not show.
        let mut before = *PREFS.lock().expect("close prefs");
        assert!(!take_notice(&mut before, false));
    }
}
