//! Windows test-branch probe. Log only startup phases and error codes, never page URLs or headers.
#![allow(unsafe_code)]

use serde_json::json;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_WEB_ERROR_STATUS, ICoreWebView2, ICoreWebView2_2,
};
use webview2_com::{
    NavigationCompletedEventHandler, NavigationStartingEventHandler,
    WebResourceRequestedEventHandler, WebResourceResponseReceivedEventHandler, take_pwstr,
};
use windows::core::{BOOL, Interface, PWSTR, Result};

pub fn watch(core: &ICoreWebView2, wc: u64) -> Result<()> {
    let mut token = 0;
    // Callbacks run on the controller's UI thread; WebView2 retains each until the view closes.
    unsafe {
        core.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, event| {
                if let Some(event) = event {
                    let (mut id, mut uri) = (0, PWSTR::null());
                    let mut cancelled = BOOL::default();
                    event.NavigationId(&mut id)?;
                    event.Uri(&mut uri)?;
                    event.Cancel(&mut cancelled)?;
                    let uri = take_pwstr(uri);
                    let kind = if crate::profile_bootstrap(&uri) { "bootstrap" } else if uri == "about:blank" { "blank" } else { "other" };
                    crate::log::log("probe.nav.start", json!({"wc":wc,"id":id,"kind":kind,"cancelled":cancelled.as_bool()}));
                }
                Ok(())
            })),
            &mut token,
        )?;
        core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, event| {
                if let Some(event) = event {
                    let (mut id, mut ok, mut status) = (0, BOOL::default(), COREWEBVIEW2_WEB_ERROR_STATUS::default());
                    event.NavigationId(&mut id)?;
                    event.IsSuccess(&mut ok)?;
                    event.WebErrorStatus(&mut status)?;
                    crate::log::log("probe.nav.end", json!({"wc":wc,"id":id,"ok":ok.as_bool(),"error":status.0}));
                }
                Ok(())
            })),
            &mut token,
        )?;
        core.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, event| {
                if let Some(event) = event {
                    let mut uri = PWSTR::null();
                    event.Request()?.Uri(&mut uri)?;
                    if crate::profile_bootstrap(&take_pwstr(uri)) {
                        crate::log::log("probe.nav.resource", json!({"wc":wc}));
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
        core.cast::<ICoreWebView2_2>()?.add_WebResourceResponseReceived(
            &WebResourceResponseReceivedEventHandler::create(Box::new(move |_, event| {
                if let Some(event) = event {
                    let mut uri = PWSTR::null();
                    event.Request()?.Uri(&mut uri)?;
                    if crate::profile_bootstrap(&take_pwstr(uri)) {
                        let mut status = 0;
                        event.Response()?.StatusCode(&mut status)?;
                        crate::log::log("probe.nav.response", json!({"wc":wc,"status":status}));
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    crate::log::log("probe.nav.watching", json!({"wc":wc}));
    Ok(())
}
