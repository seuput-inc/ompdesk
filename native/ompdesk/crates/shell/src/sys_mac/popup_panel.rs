//! The notification popup's window on macOS (docs/design/custom-notifications.md › Window): a non-activating
//! `NSPanel` that holds a webview's view. A click in an `NSWindow` activates its app, which would hand the keyboard to
//! OMPdesk's window behind other apps; a click in a non-activating panel does not. Main thread.
#![allow(unsafe_code)]

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
    // view (retained across the move, released once), `panel` a panel this function allocates and keeps.
    unsafe {
        let content: *mut AnyObject = msg_send![window, contentView];
        if content.is_null() {
            return Err("the window has no content view".into());
        }
        let _: *mut AnyObject = msg_send![content, retain];
        let placeholder: *mut AnyObject = msg_send![class!(NSView), new];
        let _: () = msg_send![window, setContentView: placeholder];
        let _: () = msg_send![placeholder, release];
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(360.0, 64.0));
        let panel: *mut AnyObject = msg_send![class!(NSPanel), alloc];
        let panel: *mut AnyObject = msg_send![
            panel,
            initWithContentRect: rect,
            styleMask: STYLE,
            backing: BACKING_BUFFERED,
            defer: Bool::NO
        ];
        if panel.is_null() {
            let _: () = msg_send![content, release];
            return Err("NSPanel could not be made".into());
        }
        let _: () = msg_send![panel, setReleasedWhenClosed: Bool::NO];
        let _: () = msg_send![panel, setFloatingPanel: Bool::YES];
        let _: () = msg_send![panel, setBecomesKeyOnlyIfNeeded: Bool::YES];
        let _: () = msg_send![panel, setHidesOnDeactivate: Bool::NO];
        let _: () = msg_send![panel, setLevel: STATUS_WINDOW_LEVEL];
        let _: () = msg_send![panel, setCollectionBehavior: BEHAVIOR];
        let _: () = msg_send![panel, setOpaque: Bool::NO];
        let clear: *mut AnyObject = msg_send![class!(NSColor), clearColor];
        let _: () = msg_send![panel, setBackgroundColor: clear];
        let _: () = msg_send![panel, setHasShadow: Bool::YES];
        let _: () = msg_send![panel, setContentView: content];
        let _: () = msg_send![content, release];
        let _: () = msg_send![content, setWantsLayer: Bool::YES];
        let layer: *mut AnyObject = msg_send![content, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setCornerRadius: CORNER_RADIUS];
            let _: () = msg_send![layer, setMasksToBounds: Bool::YES];
        }
        Ok(panel as isize)
    }
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
            if mouse.x >= frame.origin.x
                && mouse.x < frame.origin.x + frame.size.width
                && mouse.y >= frame.origin.y
                && mouse.y < frame.origin.y + frame.size.height
            {
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
    // SAFETY: a live panel of ours; AppKit's origin is the bottom-left, as `visibleFrame` gives it.
    unsafe {
        let _: () = msg_send![panel as *mut AnyObject, setFrame: frame, display: Bool::YES];
        let _: () = msg_send![panel as *mut AnyObject, orderFrontRegardless];
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
        mouse.x >= frame.origin.x
            && mouse.x < frame.origin.x + frame.size.width
            && mouse.y >= frame.origin.y
            && mouse.y < frame.origin.y + frame.size.height
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
