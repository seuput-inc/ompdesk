//! WebView2. The probe is `ExecuteScript`, which the browser process carries to the renderer: no page IPC, no
//! resource load. The kill ends the renderer process that runs the page's main frame. That process is looked up in
//! `ICoreWebView2Environment13::GetProcessExtendedInfos` while the page answers, because a list asked for while its
//! renderer is stuck never came back (19 Nov 2026, the Windows e2e: `page.kill` and nothing after); the kill checks
//! that pid against the environment's live renderers (`GetProcessInfos`, answered at once) before it ends it.
//! `ProcessFailed` reports a renderer that ended, and one the engine itself found unresponsive.
#![allow(unsafe_code)]

use crate::host::Call;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use tauri::WebviewWindow;
use tauri::webview::PlatformWebview;
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

thread_local! {
    /// Each app page's main-frame renderer, learned while it answered. UI thread only, where every WebView2 call and
    /// answer runs.
    static RENDERERS: RefCell<HashMap<u64, i32>> = RefCell::new(HashMap::new());
    /// Pages whose renderer lookup is under way.
    static LOOKING: RefCell<HashSet<u64>> = RefCell::new(HashSet::new());
}

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
        learn(&view, wc);
    });
    if started.is_err() {
        super::settled(wc, probe, false);
    }
}

/// Looks up the page's renderer once per renderer: again only after it ended.
fn learn(view: &PlatformWebview, wc: u64) {
    if RENDERERS.with_borrow(|known| known.contains_key(&wc))
        || !LOOKING.with_borrow_mut(|on| on.insert(wc))
    {
        return;
    }
    lookup(view, move |found| {
        LOOKING.with_borrow_mut(|on| on.remove(&wc));
        match found {
            Ok(pid) => {
                crate::log::log(
                    "page.renderer_learned",
                    serde_json::json!({"wcId": wc, "pid": pid}),
                );
                RENDERERS.with_borrow_mut(|known| known.insert(wc, pid));
            }
            Err(error) => crate::log::log(
                "page.renderer_unknown",
                serde_json::json!({"wcId": wc, "error": error}),
            ),
        }
    });
}

/// The renderer process that runs the page's main frame, answered on the UI thread (or never, while it is stuck).
fn lookup(view: &PlatformWebview, answer: impl FnOnce(Result<i32, String>) + 'static) {
    let answer = Rc::new(RefCell::new(Some(answer)));
    let finish = move |result: Result<i32, String>| {
        if let Some(answer) = answer.borrow_mut().take() {
            answer(result);
        }
    };
    let found = (|| {
        // SAFETY: Tauri hands the caller the live controller on the owning UI thread; `frame` outlives the call.
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
        Err(error) => return finish(Err(format!("WebView2 process list: {error}"))),
    };
    let finish = Rc::new(finish);
    let answered = finish.clone();
    let handler =
        GetProcessExtendedInfosCompletedHandler::create(Box::new(move |result, processes| {
            crate::log::log(
                "page.renderer_list",
                serde_json::json!({"ok": result.is_ok(), "list": processes.is_some()}),
            );
            answered(
                result
                    .and_then(|()| match &processes {
                        Some(processes) => renderer(processes, frame),
                        None => Ok(None),
                    })
                    .map_err(|error| format!("WebView2 process list: {error}"))
                    .and_then(|pid| {
                        pid.ok_or_else(|| "the page's renderer process was not found".to_owned())
                    }),
            );
            Ok(())
        }));
    crate::log::log("page.renderer_lookup", serde_json::json!({"frame": frame}));
    // SAFETY: the live environment on its UI thread; WebView2 retains the handler until the list answers.
    let asked = unsafe { environment.GetProcessExtendedInfos(&handler) };
    crate::log::log(
        "page.renderer_asked",
        serde_json::json!({"frame": frame, "error": asked.as_ref().err().map(|e| e.to_string())}),
    );
    if let Err(error) = asked {
        finish(Err(format!("WebView2 process list: {error}")));
    }
}

/// Whether `pid` is one of the environment's renderers now (a pid of a renderer that ended may name another process).
fn live_renderer(view: &PlatformWebview, pid: i32) -> windows::core::Result<bool> {
    // SAFETY: live WebView2 objects on their UI thread, with out-parameters that outlive each call.
    unsafe {
        let processes = view
            .environment()
            .cast::<ICoreWebView2Environment13>()?
            .GetProcessInfos()?;
        let mut count = 0;
        processes.Count(&mut count)?;
        for index in 0..count {
            let info = processes.GetValueAtIndex(index)?;
            let (mut kind, mut id) = (COREWEBVIEW2_PROCESS_KIND::default(), 0);
            info.Kind(&mut kind)?;
            info.ProcessId(&mut id)?;
            if kind == COREWEBVIEW2_PROCESS_KIND_RENDERER && id == pid {
                return Ok(true);
            }
        }
    }
    Ok(false)
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
    let asked = window.with_webview(move |view| {
        let known = RENDERERS.with_borrow_mut(|known| known.remove(&wc));
        match known.map(|pid| (pid, live_renderer(&view, pid))) {
            Some((pid, Ok(true))) => end(wc, call, Ok(pid), "learned"),
            known => {
                // Not learned (the page never answered), or that renderer is gone: ask now, which a stuck renderer
                // may never answer.
                crate::log::log(
                    "page.kill_lookup",
                    serde_json::json!({"wcId": wc, "learned": known.map(|(pid, live)| {
                        serde_json::json!({"pid": pid, "live": live.map_err(|e| e.to_string())})
                    })}),
                );
                lookup(&view, move |found| end(wc, call, found, "looked up"));
            }
        }
    });
    if let Err(error) = asked {
        crate::log::log(
            "page.kill_failed",
            serde_json::json!({"wcId": wc, "error": format!("with_webview: {error}")}),
        );
    }
}

fn end(wc: u64, call: Call, renderer: Result<i32, String>, how: &str) {
    let ended = renderer.and_then(|pid| {
        crate::log::log(
            "page.kill_pid",
            serde_json::json!({"wcId": wc, "pid": pid, "found": how}),
        );
        super::killing(wc, true);
        end_process(pid).inspect_err(|_| super::killing(wc, false))
    });
    super::crash_answer(wc, call, ended.map_err(crate::failed));
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
                RENDERERS.with_borrow_mut(|known| known.remove(&wc));
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
