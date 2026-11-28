//! A window's activation on Windows, as Electron's `BrowserWindow` reports and honours it.
//!
//! `isFocused`, `focus` and `blur` are the window's own activation (`Widget::IsActive`: `GetActiveWindow() == hwnd`),
//! never the keyboard focus of its page. Tauri raises `WindowEvent::Focused` for a window with one WebView from
//! WebView2's `GotFocus`/`LostFocus` and drops tao's own events (tauri-runtime-wry 2.12.3 `add_focus_change_listeners`),
//! and wry moves the WebView's focus at creation (wry 0.57.1 `MoveFocus`), so that event can come while the window
//! is hidden or inactive. This module takes the window's activation from the system instead: a subclass sees
//! `WM_ACTIVATE`, and Node hears `focus`/`blur` only when `GetActiveWindow` flips.
//!
//! tao shows a window with `SW_SHOW`, which activates it. `show_inactive` shows a window natively instead and never
//! changes another application's foreground.
#![allow(unsafe_code)]

use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde_json::{Value, json};
use tauri::WebviewWindow;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetActiveWindow, GetFocus};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, GWL_STYLE, GWLP_WNDPROC, GetClassNameW, GetForegroundWindow,
    IsWindowVisible, PostMessageW, STYLESTRUCT, SetWindowLongPtrW, WM_ACTIVATE, WM_APP, WM_DESTROY,
    WM_NCDESTROY, WM_NCHITTEST, WM_SIZE, WM_STYLECHANGING, WNDPROC, WS_VISIBLE,
};

/// Posted by the subclass to its own window on every `WM_ACTIVATE`: the report runs once the activation that raised
/// it is over, outside whatever call (a show, a flag change) caused it.
const WM_SYNC: u32 = WM_APP + 0x3f43;

#[derive(Clone, Copy)]
struct Hook {
    previous: WNDPROC,
    win: u64,
    reported: bool,
}

static HOOKS: Mutex<Vec<(isize, Hook)>> = Mutex::new(Vec::new());
/// The window whose `show_inactive` is setting tao's visibility flag (0 for none).
static RECONCILING: AtomicIsize = AtomicIsize::new(0);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether the window is the calling thread's active window: Electron's `isFocused`. UI thread only.
pub(crate) fn is_active(hwnd: isize) -> bool {
    // SAFETY: GetActiveWindow reads the calling thread's active window.
    unsafe { GetActiveWindow() as isize == hwnd }
}

fn class_of(hwnd: HWND) -> String {
    if hwnd.is_null() {
        return String::new();
    }
    let mut name = [0u16; 64];
    // SAFETY: GetClassNameW writes at most `name.len()` UTF-16 units into the buffer.
    let len = unsafe { GetClassNameW(hwnd, name.as_mut_ptr(), name.len() as i32) };
    String::from_utf16_lossy(&name[..usize::try_from(len).unwrap_or(0)])
}

/// What the system says about the window right now, for the shell log.
fn snapshot(hwnd: isize) -> Value {
    // SAFETY: the reads take the calling thread's input state, or any handle.
    let (foreground, focus, visible) = unsafe {
        (
            GetForegroundWindow(),
            GetFocus(),
            IsWindowVisible(hwnd as HWND) != 0,
        )
    };
    json!({
        "active": is_active(hwnd),
        "foreground": foreground as isize == hwnd,
        "focus": class_of(focus),
        "visible": visible,
        "focusable": shell_core::sys::winops::is_focusable(hwnd),
    })
}

/// Puts the subclass on a window of this thread, once, as it is created.
pub(crate) fn watch(hwnd: isize, win: u64) -> Result<(), String> {
    // SAFETY: GWLP_WNDPROC of a window of this thread takes a window procedure and returns the one it replaces.
    let previous = unsafe {
        SetWindowLongPtrW(
            hwnd as HWND,
            GWLP_WNDPROC,
            window_proc as *const () as usize as isize,
        )
    };
    if previous == 0 {
        return Err(format!(
            "subclass the window: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: the value GWLP_WNDPROC held is the address of a window procedure, a WNDPROC.
    let previous = unsafe {
        std::mem::transmute::<*const (), WNDPROC>(std::ptr::with_exposed_provenance(
            previous as usize,
        ))
    };
    lock(&HOOKS).push((
        hwnd,
        Hook {
            previous,
            win,
            reported: is_active(hwnd),
        },
    ));
    Ok(())
}

fn hook_of(hwnd: HWND) -> Option<Hook> {
    lock(&HOOKS)
        .iter()
        .find(|(window, _)| *window == hwnd as isize)
        .map(|(_, hook)| *hook)
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let Some(hook) = hook_of(hwnd) else {
        // SAFETY: the default procedure for a message this thread is dispatching to a window it owns.
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    };
    match message {
        WM_NCHITTEST => {
            if let Some(result) = crate::windows_chrome::hit(hwnd, lparam) {
                return result;
            }
        }
        WM_SIZE => {
            // SAFETY: let tao finish reordering its resize child before placing the title-bar input row.
            let result = unsafe { CallWindowProcW(hook.previous, hwnd, message, wparam, lparam) };
            crate::windows_chrome::resized(hwnd);
            return result;
        }
        WM_DESTROY => crate::windows_chrome::forget(hwnd),
        WM_STYLECHANGING
            if wparam as i32 == GWL_STYLE
                && lparam != 0
                && RECONCILING.load(Ordering::Relaxed) == hwnd as isize =>
        {
            // SAFETY: for this message lparam points to the STYLESTRUCT of the change the system is about to apply.
            let style = unsafe { &mut *(lparam as *mut STYLESTRUCT) };
            // tao writes the style from its own visibility flag and clears `WS_VISIBLE` of a window it has not
            // shown: keep the bit, so the `SW_SHOW` that follows is not a second, activating show.
            style.styleNew = (style.styleNew & !WS_VISIBLE) | (style.styleOld & WS_VISIBLE);
        }
        WM_ACTIVATE => {
            // SAFETY: the procedure this one replaced, with the message it was given.
            let result = unsafe { CallWindowProcW(hook.previous, hwnd, message, wparam, lparam) };
            // SAFETY: a message to a window of this thread, handled below once the queue reaches it.
            let _ = unsafe { PostMessageW(hwnd, WM_SYNC, 0, 0) };
            return result;
        }
        WM_SYNC => {
            // A panic must not unwind out of a window procedure.
            let _ = std::panic::catch_unwind(|| sync(hook.win));
            return 0;
        }
        WM_NCDESTROY => {
            // SAFETY: as for WM_ACTIVATE; the window is gone after this message, so the subclass is left in place.
            let result = unsafe { CallWindowProcW(hook.previous, hwnd, message, wparam, lparam) };
            lock(&HOOKS).retain(|(window, _)| *window != hwnd as isize);
            return result;
        }
        _ => {}
    }
    // SAFETY: the procedure this one replaced, with the message it was given.
    unsafe { CallWindowProcW(hook.previous, hwnd, message, wparam, lparam) }
}

/// Tells Node the window's activation when it differs from what Node last heard: the `win.state` that shows it, then
/// the event (PROTOCOL.md `win.event`).
fn sync(win: u64) {
    let Ok(window) = crate::window_for_win(win) else {
        return;
    };
    let Ok(hwnd) = window.hwnd().map(|hwnd| hwnd.0 as isize) else {
        return;
    };
    let active = is_active(hwnd);
    let changed = {
        let mut hooks = lock(&HOOKS);
        let Some((_, hook)) = hooks.iter_mut().find(|(window, _)| *window == hwnd) else {
            return;
        };
        let changed = hook.reported != active;
        hook.reported = active;
        changed
    };
    if !changed {
        return;
    }
    let _ = crate::win_state(&window, win);
    crate::win_event(win, if active { "focus" } else { "blur" });
    crate::log::log(
        "window.activation",
        json!({"winId":win,"window":snapshot(hwnd)}),
    );
}

/// Tauri's `Focused` for the window's WebView (what the page holds), logged beside the window's own activation: the
/// two differ when the WebView takes focus in a window that was never activated.
pub(crate) fn webview_focus(window: &WebviewWindow, win: u64, focused: bool) {
    if let Ok(hwnd) = window.hwnd().map(|hwnd| hwnd.0 as isize) {
        crate::log::log(
            "window.webview_focus",
            json!({"winId":win,"webview":focused,"window":snapshot(hwnd)}),
        );
    }
}

/// Electron's `showInactive`: the window appears without becoming the active window or taking the foreground.
///
/// tao 0.37.2 has no inactive show. Its `set_visible(true)` ends in `ShowWindow(SW_SHOW)` ("Activates the window and
/// displays it"; its `SW_SHOWNOACTIVATE` branch needs `MARKER_DONT_FOCUS`, which it removes once creation is over), and
/// it learns a window's visibility only from its own `set_visible`: no handler reads `WM_SHOWWINDOW`, and
/// `WM_WINDOWPOSCHANGED` only reports a move. Its other flag changes (maximize, minimize, `setFocusable`) hide a window
/// whose flag says hidden and skip `SW_MAXIMIZE`, so the flag cannot stay false while the window is visible.
///
/// So the window is shown natively with `SW_SHOWNOACTIVATE`, then tao's flag is set with `window.show()`. That call
/// clears `WS_VISIBLE` through `SetWindowLong` before its `ShowWindow(SW_SHOW)`; `window_proc` keeps the bit while
/// `RECONCILING` names this window, so `SW_SHOW` finds a visible window, on which Wine `ShowWindow`
/// (`case SW_SHOW: if (was_visible) goto done`) and ReactOS `co_WinPosShowWindow` ("Nothing to do!") do nothing.
/// Microsoft's page for `ShowWindow` states no such exception; the Windows gate must observe `active:false` in the
/// `window.inactive` log. The focusable flag stays tao's, so it survives later flag changes.
pub(crate) fn show_inactive(window: &WebviewWindow, op: &'static str) -> tauri::Result<()> {
    let hwnd = window.hwnd()?.0 as isize;
    shell_core::sys::winops::show_no_activate(hwnd);
    RECONCILING.store(hwnd, Ordering::Relaxed);
    let result = window.show();
    RECONCILING.store(0, Ordering::Relaxed);
    crate::log::log(
        "window.inactive",
        json!({
            "op": op,
            "window": snapshot(hwnd),
        }),
    );
    result
}
