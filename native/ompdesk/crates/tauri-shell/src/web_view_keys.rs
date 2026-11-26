//! Keeps a key an app page left unhandled away from tao's window view (macOS).
//!
//! Tauri's `unstable` feature (on for `Manager::get_webview`) hosts each app window's WKWebView as a child of tao's
//! content view. WebKit hands a keyDown the page did not use (Right at the end of the text, Left at its start) to
//! the view's next responder, and tao's `keyDown:` runs `interpretKeyEvents:` on it, which in that layout inserts a
//! character for the arrow into the focused field (tauri-apps/tauri#10194 measured U+001D for Right; the event's
//! own characters are U+F703). Without `unstable`, wry's own parent view (`WryWebViewParent`)
//! swallows these keys; this responder, put between the WKWebView and tao's view, does the same. Everything else a
//! responder passes up (key up, mouse, scroll, commands) goes on to tao's view unchanged.
#![allow(unsafe_code)]

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{MainThreadMarker, MainThreadOnly, define_class, ffi, msg_send};
use objc2_app_kit::{NSEvent, NSResponder};
use tauri::WebviewWindow;

define_class!(
    // SAFETY: NSResponder supports subclassing; the one override keeps its signature and the class has no ivars.
    #[unsafe(super = NSResponder)]
    #[thread_kind = MainThreadOnly]
    #[name = "OMPdeskUnhandledKeySink"]
    struct KeySink;

    impl KeySink {
        #[unsafe(method(keyDown:))]
        fn key_down(&self, _event: &NSEvent) {}
    }
);

/// The associated-object key that ties a sink's life to its WKWebView.
static SINK: u8 = 0;

/// Puts the sink between the window's WKWebView and tao's view. Runs once, right after the window is built.
pub fn attach(window: &WebviewWindow, wc: u64) {
    let attached = window.with_webview(move |view| {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        // SAFETY: Tauri hands this closure the live WKWebView, or null, on the main thread; a WKWebView is an
        // NSResponder.
        if let Some(web_view) = unsafe { view.inner().cast::<NSResponder>().as_ref() } {
            hold_unhandled_keys(web_view, mtm);
        }
    });
    if let Err(error) = attached {
        crate::log::log(
            "webview.keys.unattached",
            serde_json::json!({"wcId":wc,"error":error.to_string()}),
        );
    }
}

fn hold_unhandled_keys(view: &NSResponder, mtm: MainThreadMarker) {
    // SAFETY: a fresh instance of a class with no ivars, initialized by NSResponder's `init`.
    let sink: Retained<KeySink> = unsafe { msg_send![KeySink::alloc(mtm), init] };
    // SAFETY: next responders are unretained. The view retains the sink (the association below) and the sink's next
    // responder is the view's superview, which holds the view.
    unsafe {
        sink.setNextResponder(view.nextResponder().as_deref());
        view.setNextResponder(Some(&sink));
        ffi::objc_setAssociatedObject(
            (view as *const NSResponder).cast_mut().cast::<AnyObject>(),
            (&raw const SINK).cast(),
            Retained::as_ptr(&sink).cast_mut().cast::<AnyObject>(),
            ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::DefinedClass;
    use objc2_app_kit::{NSEventModifierFlags, NSEventType};
    use objc2_foundation::{NSPoint, NSString};
    use std::cell::Cell;

    #[derive(Default)]
    struct Seen {
        down: Cell<u32>,
        up: Cell<u32>,
    }

    define_class!(
        // SAFETY: NSResponder supports subclassing and the ivars have no custom drop.
        #[unsafe(super = NSResponder)]
        #[thread_kind = MainThreadOnly]
        #[ivars = Seen]
        #[name = "OMPdeskTestWindowView"]
        struct WindowView;

        impl WindowView {
            #[unsafe(method(keyDown:))]
            fn key_down(&self, _event: &NSEvent) { self.ivars().down.set(self.ivars().down.get() + 1); }
            #[unsafe(method(keyUp:))]
            fn key_up(&self, _event: &NSEvent) { self.ivars().up.set(self.ivars().up.get() + 1); }
        }
    );

    fn right_arrow(kind: NSEventType) -> Retained<NSEvent> {
        let characters = NSString::from_str("\u{F703}");
        NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind,
            NSPoint::new(0.0, 0.0),
            NSEventModifierFlags::empty(),
            0.0,
            0,
            None,
            &characters,
            &characters,
            false,
            124,
        )
        .expect("key event")
    }

    #[test]
    fn a_right_arrow_the_page_left_unhandled_never_reaches_the_window_view() {
        // SAFETY: the responders here belong to no window or event loop; this test thread is their only user.
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let window_view = WindowView::alloc(mtm).set_ivars(Seen::default());
        // SAFETY: NSResponder's `init` on an instance whose ivars are set.
        let window_view: Retained<WindowView> = unsafe { msg_send![super(window_view), init] };
        // A plain responder stands in for the WKWebView: its unhandled keyDown goes to its next responder, as
        // WebKit's re-sent key does.
        let web_view = NSResponder::new(mtm);
        // SAFETY: both responders live to the end of the test.
        unsafe { web_view.setNextResponder(Some(&window_view)) };
        let down = right_arrow(NSEventType::KeyDown);

        web_view.keyDown(&down);
        assert_eq!(
            window_view.ivars().down.get(),
            1,
            "the unguarded chain hands the key to tao's view"
        );

        hold_unhandled_keys(&web_view, mtm);
        web_view.keyDown(&down);
        assert_eq!(
            window_view.ivars().down.get(),
            1,
            "the sink keeps the key from tao's view"
        );
        web_view.keyUp(&right_arrow(NSEventType::KeyUp));
        assert_eq!(
            window_view.ivars().up.get(),
            1,
            "other responder traffic still reaches tao's view"
        );
    }
}
