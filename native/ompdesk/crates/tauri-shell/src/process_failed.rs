//! A process of an app page's WebView2 ended (`ICoreWebView2::ProcessFailed`), told to Node as Electron tells it: the
//! GPU process as `app.childProcessGone` (src/main/gpu-fallback.ts logs it; WebView2 restarts the GPU process and
//! repaints by itself). The page's own renderer, its end and its hang, is page_watch's (`render-process-gone`,
//! `unresponsive`): it knows whether the host ended it, and a second report here reloaded the page twice. Without the
//! GPU report nothing of a GPU crash reached main's log (installer-check run 44616509774, open-work G12). macOS
//! (WKWebView) has no such event: only the mapping and its tests build there.
#![cfg_attr(not(windows), allow(dead_code))]

use serde_json::{Value, json};

/// Electron's `reason` for WebView2's `COREWEBVIEW2_PROCESS_FAILED_REASON`.
fn reason(code: i32) -> &'static str {
    match code {
        2 => "killed",
        3 => "crashed",
        4 => "launch-failed",
        5 => "oom",
        // UNEXPECTED, UNRESPONSIVE, PROFILE_DELETED.
        _ => "abnormal-exit",
    }
}

/// `app.childProcessGone`'s details for a failure of `kind` (and `reason`, `exit_code` where WebView2 gave them): the
/// GPU process only; none for the page's renderer (page_watch) or a process the app has no event for.
pub fn report(kind: i32, reason_code: Option<i32>, exit_code: Option<i32>) -> Option<Value> {
    (kind == 6).then(|| {
        json!({"reason": reason(reason_code.unwrap_or(0)), "exitCode": exit_code, "type": "GPU"})
    })
}

#[cfg(windows)]
mod windows {
    #![allow(unsafe_code)]
    use super::report;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_REASON,
        ICoreWebView2ProcessFailedEventArgs2,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows_core::Interface;

    /// Subscribes an app page's WebView2 to its `ProcessFailed` for the life of the WebView: the GPU process's end goes
    /// to Node as `app.childProcessGone`, which names no page.
    pub fn watch(webview: &tauri::Webview) -> Result<(), String> {
        webview
            .with_webview(move |view| {
                // SAFETY: Tauri hands this closure the live controller on the owning UI thread.
                let core = match unsafe { view.controller().CoreWebView2() } {
                    Ok(core) => core,
                    Err(error) => {
                        eprintln!("[tauri-shell] ProcessFailed: no WebView2 core: {error}");
                        return;
                    }
                };
                let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                    // SAFETY: WebView2 calls the handler on the UI thread with live event args.
                    unsafe { args.ProcessFailedKind(&mut kind)? };
                    let (reason, exit) = match args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                        Ok(args) => {
                            let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                            let mut exit = 0;
                            // SAFETY: as above; both are plain out-values.
                            let read =
                                unsafe { args.Reason(&mut reason).and(args.ExitCode(&mut exit)) };
                            if read.is_ok() {
                                (Some(reason.0), Some(exit))
                            } else {
                                (None, None)
                            }
                        }
                        Err(_) => (None, None),
                    };
                    if let Some(details) = report(kind.0, reason, exit) {
                        crate::gpu_process_gone(details);
                    }
                    Ok(())
                }));
                let mut token = 0;
                // SAFETY: the live WebView2 interface on its owning UI thread; WebView2 keeps the handler while the
                // WebView lives.
                if let Err(error) = unsafe { core.add_ProcessFailed(&handler, &mut token) } {
                    eprintln!("[tauri-shell] ProcessFailed subscription failed: {error}");
                }
            })
            .map_err(|error| error.to_string())
    }
}

#[cfg(windows)]
pub use windows::watch;

#[cfg(test)]
mod tests {
    use super::report;
    use serde_json::json;

    #[test]
    fn a_crashed_gpu_process_reads_as_electron_reports_it() {
        assert_eq!(
            report(6, Some(3), Some(-1073741819)),
            Some(json!({"reason": "crashed", "exitCode": -1073741819, "type": "GPU"}))
        );
        assert_eq!(
            report(6, Some(2), Some(1)),
            Some(json!({"reason": "killed", "exitCode": 1, "type": "GPU"}))
        );
        assert_eq!(
            report(6, None, None),
            Some(json!({"reason": "abnormal-exit", "exitCode": null, "type": "GPU"}))
        );
    }

    #[test]
    fn the_page_renderer_and_processes_the_app_has_no_event_for_report_nothing() {
        // The page's renderer exited or hung (page_watch reports both), subframe renderer, utility, browser, unknown.
        for kind in [1, 2, 3, 4, 0, 9] {
            assert_eq!(report(kind, Some(3), Some(1)), None, "kind {kind}");
        }
    }
}
