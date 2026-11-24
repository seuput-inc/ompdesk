//! WKWebView. The probe is `evaluateJavaScript:completionHandler:`, which WebKit carries to the page over its own
//! connection: no page IPC, no resource load. The kill is the private
//! `-[WKWebView _killWebContentProcessAndResetState]`: it ends a page whose main thread is stuck and tells the
//! navigation delegate before it returns. `_killWebContentProcess` is not usable: on macOS 27.2 it left the process
//! running, told nobody, and the view never loaded again (measured 19 Nov 2026).
#![allow(unsafe_code)]

use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2::{msg_send, sel};
use objc2_foundation::NSString;
use shell_core::wire::WireError;
use std::panic::AssertUnwindSafe;
use tauri::WebviewWindow;

pub fn probe(window: &WebviewWindow, wc: u64, probe: u64) {
    let started = window.with_webview(move |view| {
        // SAFETY: Tauri hands this closure the live WKWebView, or null, on the main thread.
        let Some(webview) = (unsafe { view.inner().cast::<AnyObject>().as_ref() }) else {
            return super::settled(wc, probe, false);
        };
        let done = RcBlock::new(move |_value: *mut AnyObject, error: *mut AnyObject| {
            super::settled(wc, probe, error.is_null());
        });
        let source = NSString::from_str(super::PROBE);
        // SAFETY: a live WKWebView on the main thread; WebKit copies the block and calls it there once.
        unsafe {
            let _: () = msg_send![webview, evaluateJavaScript: &*source, completionHandler: &*done];
        }
    });
    if started.is_err() {
        super::settled(wc, probe, false);
    }
}

pub fn kill(window: &WebviewWindow, wc: u64) {
    // A view that is gone drops the closure: its page has nothing left to end.
    let _ = window.with_webview(move |view| {
        let result = (|| {
            // SAFETY: Tauri hands this closure the live WKWebView, or null, on the main thread.
            let webview = unsafe { view.inner().cast::<AnyObject>().as_ref() }
                .ok_or_else(|| WireError::new("gone", "WKWebView is unavailable"))?;
            let kill = sel!(_killWebContentProcessAndResetState);
            // SAFETY: `respondsToSelector:` is NSObject's, sent to a live object on the main thread.
            let known: bool = unsafe { msg_send![webview, respondsToSelector: kill] };
            if !known {
                return Err(WireError::new(
                    "unsupported",
                    "this WebKit has no -[WKWebView _killWebContentProcessAndResetState]",
                ));
            }
            super::killing(wc, true);
            // SAFETY: WKWebView said it implements the selector, which takes and returns nothing. An exception
            // WebKit raises is caught here.
            objc2::exception::catch(AssertUnwindSafe(|| unsafe {
                let _: () = msg_send![webview, _killWebContentProcessAndResetState];
            }))
            .map_err(|_| {
                super::killing(wc, false);
                WireError::new("failed", "WebKit refused to end the content process")
            })
        })();
        super::killed(wc, result);
    });
}
