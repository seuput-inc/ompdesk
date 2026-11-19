//! A process of an app page's WebView2 ended (`ICoreWebView2::ProcessFailed`), told to Node as Electron tells it: the
//! page's renderer as `wc.event render-process-gone` (src/main/window.ts reloads the page), the GPU process as
//! `app.childProcessGone` (src/main/gpu-fallback.ts logs it; WebView2 restarts the GPU process and repaints by itself).
//! Without it a crashed renderer left WebView2's "This page is having a problem" page up for good, and nothing reached
//! main's log (installer-check run 44616509774, open-work G12). macOS (WKWebView) has no such event: only the mapping
//! and its tests build there.
#![cfg_attr(not(windows), allow(dead_code))]

use serde_json::{Value, json};

/// What one `ProcessFailed` is, from WebView2's raw `COREWEBVIEW2_PROCESS_FAILED_KIND` and `_REASON` values.
#[derive(Debug, PartialEq)]
pub enum Report {
    /// The page's own renderer: `render-process-gone` with Electron's details.
    Render(Value),
    /// The GPU process: `app.childProcessGone` with Electron's details.
    Gpu(Value),
}

/// Electron's `reason` for WebView2's `COREWEBVIEW2_PROCESS_FAILED_REASON`.
fn reason(code: i32) -> &'static str {
    match code {
        2 => "killed",
        3 => "crashed",
        4 => "launch-failed",
        5 => "oom",
        // UNEXPECTED, UNRESPONSIVE (a hung renderer WebView2 ended), PROFILE_DELETED.
        _ => "abnormal-exit",
    }
}

/// The report for a failure of `kind` (and `reason`, `exit_code` where WebView2 gave them), or none for a process the
/// app has no event for (a subframe's renderer, utility and plugin processes) and for a renderer that is only
/// unresponsive: WebView2 raises that while the process still runs, and Electron's `unresponsive` is no exit.
pub fn report(kind: i32, reason_code: Option<i32>, exit_code: Option<i32>) -> Option<Report> {
    let details = |extra: Value| {
        let mut value = json!({"reason": reason(reason_code.unwrap_or(0)), "exitCode": exit_code});
        if let (Some(object), Value::Object(extra)) = (value.as_object_mut(), extra) {
            object.extend(extra);
        }
        value
    };
    match kind {
        1 => Some(Report::Render(details(json!({})))),
        6 => Some(Report::Gpu(details(json!({"type": "GPU"})))),
        _ => None,
    }
}

#[cfg(windows)]
mod windows {
    #![allow(unsafe_code)]
    use super::{Report, report};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_REASON,
        ICoreWebView2ProcessFailedEventArgs2,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows_core::Interface;

    /// Subscribes the app page `wc` to its WebView2's `ProcessFailed` for the life of the WebView.
    pub fn watch(webview: &tauri::Webview, wc: u64) -> Result<(), String> {
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
                    match report(kind.0, reason, exit) {
                        Some(Report::Render(details)) => {
                            crate::wc_event(wc, "render-process-gone", serde_json::json!([details]))
                        }
                        Some(Report::Gpu(details)) => {
                            crate::host::event("app.childProcessGone", details)
                        }
                        None => {}
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
    use super::{Report, report};
    use serde_json::json;

    #[test]
    fn a_crashed_renderer_and_gpu_process_read_as_electron_reports_them() {
        assert_eq!(
            report(1, Some(3), Some(-1073741819)),
            Some(Report::Render(
                json!({"reason": "crashed", "exitCode": -1073741819})
            ))
        );
        assert_eq!(
            report(6, Some(3), Some(-1073741819)),
            Some(Report::Gpu(
                json!({"reason": "crashed", "exitCode": -1073741819, "type": "GPU"})
            ))
        );
        assert_eq!(
            report(6, Some(2), Some(1)),
            Some(Report::Gpu(
                json!({"reason": "killed", "exitCode": 1, "type": "GPU"})
            ))
        );
        assert_eq!(
            report(1, None, None),
            Some(Report::Render(
                json!({"reason": "abnormal-exit", "exitCode": null})
            ))
        );
    }

    #[test]
    fn processes_the_app_has_no_event_for_report_nothing() {
        // Unresponsive renderer (still running), subframe renderer, utility, browser, unknown.
        for kind in [2, 3, 4, 0, 9] {
            assert_eq!(report(kind, Some(3), Some(1)), None, "kind {kind}");
        }
    }
}
