//! WebView2. The probe is `ExecuteScript`, which the browser process carries to the renderer: no page IPC, no
//! resource load. The kill is DevTools `Page.crash`, which the browser sends to the renderer's IO thread, so it ends a
//! renderer whose main thread is held. (Ending the process found through `GetProcessExtendedInfos` took the shell down
//! on the Windows runner as soon as its list answered, 19 Nov 2026.) `ProcessFailed` reports a renderer that ended,
//! and one the engine itself found unresponsive.
#![allow(unsafe_code)]

use crate::host::Call;
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    ICoreWebView2ProcessFailedEventArgs2,
};
use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler, ExecuteScriptCompletedHandler,
    ProcessFailedEventHandler,
};
use windows::core::{HSTRING, Interface};

pub fn probe(window: &WebviewWindow, wc: u64, probe: u64) {
    let started = window.with_webview(move |view| {
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, _value| {
            super::settled(wc, probe, result.is_ok());
            Ok(())
        }));
        // SAFETY: Tauri hands this closure the live controller on the owning UI thread; WebView2 retains the handler
        // until the script answers.
        let sent = unsafe { view.controller().CoreWebView2() }
            .and_then(|core| unsafe { core.ExecuteScript(&HSTRING::from(super::PROBE), &handler) });
        if sent.is_err() {
            super::settled(wc, probe, false);
        }
    });
    if started.is_err() {
        super::settled(wc, probe, false);
    }
}

/// Answered once `Page.crash` is sent: the renderer it ends answers nothing, and its end comes as `ProcessFailed`.
pub fn kill(window: &WebviewWindow, wc: u64, call: Call) {
    // A view that is gone drops the closure, and the call with it: that answers `failed`.
    let asked = window.with_webview(move |view| {
        // The protocol call's own answer, if any, says nothing the page's end does not.
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
        super::killing(wc, true);
        // SAFETY: Tauri hands this closure the live controller on the owning UI thread; WebView2 retains the handler
        // until the protocol call answers.
        let sent = unsafe { view.controller().CoreWebView2() }.and_then(|core| unsafe {
            core.CallDevToolsProtocolMethod(
                &HSTRING::from("Page.crash"),
                &HSTRING::from("{}"),
                &handler,
            )
        });
        let sent = sent.map_err(|error| {
            super::killing(wc, false);
            crate::failed(format!("Page.crash: {error}"))
        });
        super::crash_answer(wc, call, sent);
    });
    if let Err(error) = asked {
        crate::log::log(
            "page.kill_failed",
            serde_json::json!({"wcId": wc, "error": format!("with_webview: {error}")}),
        );
    }
}

/// Reports the page's renderer ending, and WebView2's own verdict that it is unresponsive. A subframe's renderer and
/// the browser's other processes are WebView2's to recover.
pub fn watch_failures(window: &WebviewWindow, wc: u64) -> tauri::Result<()> {
    window.with_webview(move |view| {
        let handler = ProcessFailedEventHandler::create(Box::new(move |_, failure| {
            let Some(failure) = failure else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            // SAFETY: WebView2 hands the handler live event arguments on the UI thread.
            unsafe { failure.ProcessFailedKind(&mut kind) }?;
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                let mut code = 0;
                let exit = failure
                    .cast::<ICoreWebView2ProcessFailedEventArgs2>()
                    // SAFETY: as above; `code` outlives the call.
                    .and_then(|failure| unsafe { failure.ExitCode(&mut code) })
                    .ok()
                    .map(|()| code);
                super::content_process_gone(wc, exit);
            } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
                super::engine_unresponsive(wc);
            }
            Ok(())
        }));
        let mut token = 0;
        // SAFETY: Tauri hands this closure the live controller on the owning UI thread; WebView2 retains the handler
        // for the view's life.
        let added = unsafe { view.controller().CoreWebView2() }
            .and_then(|core| unsafe { core.add_ProcessFailed(&handler, &mut token) });
        if let Err(error) = added {
            crate::log::log(
                "page.watch_failed",
                serde_json::json!({"wcId": wc, "error": error.to_string()}),
            );
        }
    })
}
