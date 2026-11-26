//! The notification popup's window on macOS (docs/design/custom-notifications.md › Window): a non-activating
//! `NSPanel` that holds a webview's view. A click in an `NSWindow` activates its app, which would hand the keyboard to
//! OMPdesk's window behind other apps; a click in a non-activating panel does not. Main thread.
#![allow(unsafe_code)]

use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::{NSPoint, NSRect, NSSize};

// NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
const STYLE: usize = 1 << 7;
const BACKING_BUFFERED: usize = 2;
const STATUS_WINDOW_LEVEL: isize = 25;
// CanJoinAllSpaces | Stationary | IgnoresCycle | FullScreenAuxiliary
const BEHAVIOR: usize = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8);
const CORNER_RADIUS: f64 = 10.0;

/// Moves the content view of `ns_window` (a hidden window that is never shown) into a new panel and returns the
/// panel. The panel lives as long as the app.
pub fn adopt(ns_window: isize) -> Result<isize, String> {
    let window = ns_window as *mut AnyObject;
    if window.is_null() {
        return Err("no NSWindow".into());
    }
    // SAFETY: AppKit calls on the main thread on live objects: `window` is the caller's window, `content` its content
    // view (held by `Retained` across the move), `panel` a panel this function makes and leaks on purpose.
    unsafe {
        let content: Option<Retained<AnyObject>> = msg_send![window, contentView];
        let content = content.ok_or("the window has no content view")?;
        let placeholder: Retained<AnyObject> = msg_send![class!(NSView), new];
        let _: () = msg_send![window, setContentView: &*placeholder];
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(360.0, 64.0));
        let panel: Allocated<AnyObject> = msg_send![class!(NSPanel), alloc];
        let panel: Option<Retained<AnyObject>> = msg_send![
            panel,
            initWithContentRect: rect,
            styleMask: STYLE,
            backing: BACKING_BUFFERED,
            defer: Bool::NO
        ];
        let panel = panel.ok_or("NSPanel could not be made")?;
        let _: () = msg_send![&*panel, setReleasedWhenClosed: Bool::NO];
        let _: () = msg_send![&*panel, setFloatingPanel: Bool::YES];
        let _: () = msg_send![&*panel, setBecomesKeyOnlyIfNeeded: Bool::YES];
        let _: () = msg_send![&*panel, setHidesOnDeactivate: Bool::NO];
        let _: () = msg_send![&*panel, setLevel: STATUS_WINDOW_LEVEL];
        let _: () = msg_send![&*panel, setCollectionBehavior: BEHAVIOR];
        let _: () = msg_send![&*panel, setOpaque: Bool::NO];
        let clear: Retained<AnyObject> = msg_send![class!(NSColor), clearColor];
        let _: () = msg_send![&*panel, setBackgroundColor: &*clear];
        let _: () = msg_send![&*panel, setHasShadow: Bool::YES];
        let _: () = msg_send![&*panel, setContentView: &*content];
        let _: () = msg_send![&*content, setWantsLayer: Bool::YES];
        let layer: Option<Retained<AnyObject>> = msg_send![&*content, layer];
        if let Some(layer) = layer {
            let _: () = msg_send![&*layer, setCornerRadius: CORNER_RADIUS];
            let _: () = msg_send![&*layer, setMasksToBounds: Bool::YES];
        }
        Ok(Retained::into_raw(panel) as isize)
    }
}

fn inside(point: NSPoint, rect: NSRect) -> bool {
    (rect.origin.x..rect.origin.x + rect.size.width).contains(&point.x)
        && (rect.origin.y..rect.origin.y + rect.size.height).contains(&point.y)
}

/// The visible frame (without the menu bar and the Dock) of the screen under the pointer, else the main screen.
fn visible_frame() -> Option<NSRect> {
    // SAFETY: class messages and NSArray reads on the main thread.
    unsafe {
        let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        let count: usize = msg_send![screens, count];
        for at in 0..count {
            let screen: *mut AnyObject = msg_send![screens, objectAtIndex: at];
            let frame: NSRect = msg_send![screen, frame];
            if inside(mouse, frame) {
                return Some(msg_send![screen, visibleFrame]);
            }
        }
        let main: *mut AnyObject = msg_send![class!(NSScreen), mainScreen];
        (!main.is_null()).then(|| msg_send![main, visibleFrame])
    }
}

/// Sizes the panel to `width` × `height` points at the top-right of the visible frame, `margin` from its edges,
/// and shows it without activating the app.
pub fn show_top_right(panel: isize, width: f64, height: f64, margin: f64) {
    let Some(area) = visible_frame() else {
        return;
    };
    let frame = NSRect::new(
        NSPoint::new(
            area.origin.x + area.size.width - width - margin,
            area.origin.y + area.size.height - height - margin,
        ),
        NSSize::new(width, height),
    );
    // SAFETY: a live panel of ours; AppKit's origin is the bottom-left, as `visibleFrame` gives it. The content view and
    // the views in it (wry's parent view, the WKWebView) are given the new size too: they came from another window,
    // and the macOS runner showed the panel's content staying at its first size.
    unsafe {
        let panel = panel as *mut AnyObject;
        let _: () = msg_send![panel, setFrame: frame, display: Bool::NO];
        let bounds = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
        let content: Option<Retained<AnyObject>> = msg_send![panel, contentView];
        if let Some(content) = content {
            let _: () = msg_send![&*content, setFrame: bounds];
            let subviews: Retained<AnyObject> = msg_send![&*content, subviews];
            let count: usize = msg_send![&*subviews, count];
            for at in 0..count {
                let view: *mut AnyObject = msg_send![&*subviews, objectAtIndex: at];
                let _: () = msg_send![view, setFrame: bounds];
            }
        }
        let _: () = msg_send![panel, display];
        let _: () = msg_send![panel, orderFrontRegardless];
    }
}

/// The panel's height and its content view's, in points (a check of `show_top_right`).
pub fn heights(panel: isize) -> (f64, f64) {
    // SAFETY: frame getters of a live panel of ours and its content view.
    unsafe {
        let frame: NSRect = msg_send![panel as *mut AnyObject, frame];
        let content: Option<Retained<AnyObject>> = msg_send![panel as *mut AnyObject, contentView];
        let inner = content.map_or(0.0, |content| {
            let rect: NSRect = msg_send![&*content, frame];
            rect.size.height
        });
        (frame.size.height, inner)
    }
}

pub fn hide(panel: isize) {
    // SAFETY: a live panel of ours.
    unsafe {
        let _: () = msg_send![panel as *mut AnyObject, orderOut: std::ptr::null_mut::<AnyObject>()];
    }
}

/// Whether the pointer is over the panel.
pub fn contains_mouse(panel: isize) -> bool {
    // SAFETY: a live panel of ours and a class message.
    unsafe {
        let visible: Bool = msg_send![panel as *mut AnyObject, isVisible];
        if !visible.as_bool() {
            return false;
        }
        let frame: NSRect = msg_send![panel as *mut AnyObject, frame];
        let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        inside(mouse, frame)
    }
}

#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {
    fn NSBeep();
}

/// The person's alert sound, as a banner with sound plays one.
pub fn alert_sound() {
    // SAFETY: NSBeep takes no arguments.
    unsafe { NSBeep() };
}
