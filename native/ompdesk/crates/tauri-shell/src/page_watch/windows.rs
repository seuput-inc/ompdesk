//! WebView2. The probe is `ExecuteScript`, which the browser process carries to the renderer: no page IPC, no
//! resource load. The kill ends the renderer process that runs the page's main frame, found in
//! `ICoreWebView2Environment13::GetProcessExtendedInfos`. `ProcessFailed` reports a renderer that ended, and one the
//! engine itself found unresponsive.
#![allow(unsafe_code)]

use crate::host::Call;
use shell_core::wire::WireError;
use std::cell::RefCell;
use std::rc::Rc;
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE, COREWEBVIEW2_PROCESS_KIND,
    COREWEBVIEW2_PROCESS_KIND_RENDERER, ICoreWebView2_20, ICoreWebView2Environment13,
    ICoreWebView2FrameInfo2, ICoreWebView2ProcessExtendedInfo,
    ICoreWebView2ProcessExtendedInfoCollection, ICoreWebView2ProcessFailedEventArgs2,
};
use webview2_com::{
    ExecuteScriptCompletedHandler, GetProcessExtendedInfosCompletedHandler,
    ProcessFailedEventHandler,
};
use windows::core::{BOOL, HSTRING, Interface};
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};

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

/// Whether the renderer `process` runs the frame `frame`.
fn runs_frame(
    process: &ICoreWebView2ProcessExtendedInfo,
    frame: u32,
) -> windows::core::Result<bool> {
    // SAFETY: live WebView2 objects on their UI thread, with out-parameters that outlive each call.
    unsafe {
        let frames = process.AssociatedFrameInfos()?.GetIterator()?;
        loop {
            let mut more = BOOL::default();
            frames.HasCurrent(&mut more)?;
            if !more.as_bool() {
                return Ok(false);
            }
            let mut id = 0;
            frames
                .GetCurrent()?
                .cast::<ICoreWebView2FrameInfo2>()?
                .FrameId(&mut id)?;
            if id == frame {
                return Ok(true);
            }
            frames.MoveNext(&mut more)?;
        }
    }
}

/// The renderer process that runs the frame `frame`.
fn renderer(
    processes: &ICoreWebView2ProcessExtendedInfoCollection,
    frame: u32,
) -> windows::core::Result<Option<i32>> {
    // SAFETY: live WebView2 objects on their UI thread, with out-parameters that outlive each call.
    unsafe {
        let mut count = 0;
        processes.Count(&mut count)?;
        for index in 0..count {
            let process = processes.GetValueAtIndex(index)?;
            let info = process.ProcessInfo()?;
            let mut kind = COREWEBVIEW2_PROCESS_KIND::default();
            info.Kind(&mut kind)?;
            if kind == COREWEBVIEW2_PROCESS_KIND_RENDERER && runs_frame(&process, frame)? {
                let mut pid = 0;
                info.ProcessId(&mut pid)?;
                return Ok(Some(pid));
            }
        }
    }
    Ok(None)
}

fn end_process(pid: i32) -> Result<(), String> {
    let id = u32::try_from(pid).map_err(|_| format!("invalid renderer process id {pid}"))?;
    // SAFETY: plain Win32 calls; the handle is checked before use and closed here.
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, id);
        if process.is_null() {
            return Err(format!(
                "OpenProcess {pid}: {}",
                std::io::Error::last_os_error()
            ));
        }
        let ended = TerminateProcess(process, 1);
        let error = std::io::Error::last_os_error();
        CloseHandle(process);
        if ended == 0 {
            return Err(format!("TerminateProcess {pid}: {error}"));
        }
    }
    Ok(())
}

pub fn kill(window: &WebviewWindow, wc: u64, call: Call) {
    // A view that is gone drops the closure, and the call with it: that answers `failed`.
    let _ = window.with_webview(move |view| {
        let found = (|| {
            // SAFETY: Tauri hands this closure the live controller on the owning UI thread; `frame` outlives the call.
            unsafe {
                let mut frame = 0;
                view.controller()
                    .CoreWebView2()?
                    .cast::<ICoreWebView2_20>()?
                    .FrameId(&mut frame)?;
                let environment = view.environment().cast::<ICoreWebView2Environment13>()?;
                windows::core::Result::Ok((environment, frame))
            }
        })();
        let (environment, frame) = match found {
            Ok(found) => found,
            Err(error) => {
                let error = crate::failed(format!("WebView2 process list: {error}"));
                return super::crash_answer(call, Err(error));
            }
        };
        let call = Rc::new(RefCell::new(Some(call)));
        let answer = call.clone();
        let handler =
            GetProcessExtendedInfosCompletedHandler::create(Box::new(move |result, processes| {
                let ended = result
                    .and_then(|()| match &processes {
                        Some(processes) => renderer(processes, frame),
                        None => Ok(None),
                    })
                    .map_err(|error| format!("WebView2 process list: {error}"))
                    .and_then(|pid| {
                        pid.ok_or_else(|| "the page's renderer process was not found".to_owned())
                    })
                    .and_then(|pid| {
                        super::killing(wc, true);
                        end_process(pid).inspect_err(|_| super::killing(wc, false))
                    });
                if let Some(call) = answer.borrow_mut().take() {
                    super::crash_answer(call, ended.map_err(crate::failed));
                }
                Ok(())
            }));
        // SAFETY: the live environment on its UI thread; WebView2 retains the handler until the list answers.
        if let Err(error) = unsafe { environment.GetProcessExtendedInfos(&handler) }
            && let Some(call) = call.borrow_mut().take()
        {
            let error = crate::failed(format!("WebView2 process list: {error}"));
            super::crash_answer(call, Err(error));
        }
    });
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
