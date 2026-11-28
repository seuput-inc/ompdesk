//! WKWebView reports the blank DOM target after AppKit dispatched mouseDown. Keep the actual
//! mouse event until the gesture ends; never invent one or drag a different window.
#![allow(unsafe_code)]
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObjectProtocol};
use objc2::{MainThreadMarker, msg_send, sel};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventType, NSWindow};
use objc2_foundation::{NSUserDefaults, ns_string};
use objc2_web_kit::WKWebView;
use std::cell::{OnceCell, RefCell};
use std::ptr::NonNull;

thread_local! {
    static MONITOR: OnceCell<Retained<AnyObject>> = const { OnceCell::new() };
    static MOUSE: RefCell<Option<Retained<NSEvent>>> = const { RefCell::new(None) };
}

pub(super) fn install() -> Result<(), &'static str> {
    MainThreadMarker::new().ok_or("title bar input needs the AppKit main thread")?;
    MONITOR.with(|slot| {
        if slot.get().is_some() {
            return Ok(());
        }
        let capture = RcBlock::new(|ptr: NonNull<NSEvent>| {
            // SAFETY: AppKit passes a live event here. Return the original untouched.
            let event = unsafe { ptr.as_ref() };
            let remember = event.r#type() == NSEventType::LeftMouseDown || event.clickCount() == 2;
            MOUSE.replace(if remember {
                unsafe { Retained::retain(ptr.as_ptr()) }
            } else {
                None
            });
            ptr.as_ptr()
        });
        // Local to this application. No global monitor, event posting or input permission.
        let monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::LeftMouseDown | NSEventMask::LeftMouseUp,
                &capture,
            )
        }
        .ok_or("could not watch app title bar input")?;
        slot.set(monitor)
            .map_err(|_| "title bar input already installed")
    })
}

pub(super) fn act(
    view: &tauri::webview::PlatformWebview,
    drag: bool,
    x: f64,
    y: f64,
) -> Result<(), &'static str> {
    // SAFETY: with_webview passes the caller's NSWindow on its main thread.
    let window =
        unsafe { view.ns_window().cast::<NSWindow>().as_ref() }.ok_or("app window closed")?;
    let event = MOUSE.with_borrow_mut(|mouse| {
        let event = mouse.as_ref()?;
        let kind = if drag {
            NSEventType::LeftMouseDown
        } else {
            NSEventType::LeftMouseUp
        };
        (event.windowNumber() == window.windowNumber()
            && event.r#type() == kind
            && event.clickCount() == if drag { 1 } else { 2 })
        .then(|| mouse.take().unwrap())
    });
    let Some(event) = event else {
        return Ok(());
    }; // The user released the mouse before the IPC arrived.
    // A delayed call cannot borrow a later mouse-down elsewhere in this window.
    // SAFETY: WKWebView and its page zoom are supplied by the live main-thread view.
    let web = unsafe { view.inner().cast::<WKWebView>().as_ref() }.ok_or("app webview closed")?;
    let point = web.convertPoint_fromView(event.locationInWindow(), None);
    let zoom = unsafe { web.pageZoom() };
    let css_y = if web.isFlipped() {
        point.y
    } else {
        web.bounds().size.height - point.y
    } / zoom;
    if !(0.0..36.0).contains(&css_y) || (css_y - y).abs() > 1.0 || (point.x / zoom - x).abs() > 1.0
    {
        return Ok(());
    }
    if drag {
        if NSEvent::pressedMouseButtons() & 1 != 0 {
            window.performWindowDragWithEvent(&event);
        }
    } else {
        let setting = NSUserDefaults::standardUserDefaults()
            .stringForKey(ns_string!("AppleActionOnDoubleClick"));
        match setting.as_deref() {
            None => window.performZoom(None),
            Some(s) if s == ns_string!("Maximize") => window.performZoom(None),
            Some(s) if s == ns_string!("Minimize") => window.performMiniaturize(None),
            Some(s) if s == ns_string!("Fill") && window.respondsToSelector(sel!(_zoomFill:)) => {
                // AppKit's Fill action maintains its own restore frame (macOS 15+).
                unsafe {
                    let _: () = msg_send![window, _zoomFill: Option::<&AnyObject>::None];
                }
            }
            _ => {} // None or an unknown preference does not change the window.
        }
    }
    Ok(())
}
