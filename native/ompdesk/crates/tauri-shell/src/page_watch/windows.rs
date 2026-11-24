//! WebView2. The probe is `ExecuteScript`, which the browser process carries to the renderer: no page IPC, no
//! resource load. The kill ends the renderer process that runs the page's main frame, as
//! `ICoreWebView2Environment13::GetProcessExtendedInfos` lists it: learned right after the page answered a probe and
//! checked against the environment's live renderers (`GetProcessInfos`), else looked up at the kill (the list answers
//! while the page's main thread is held). DevTools `Page.crash` ended nothing on the Windows runner (19 Nov 2026).
//! `ProcessFailed` reports a renderer that ended, and one the engine itself found unresponsive.
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use tauri::WebviewWindow;
use tauri::webview::PlatformWebview;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE, COREWEBVIEW2_PROCESS_KIND,
    COREWEBVIEW2_PROCESS_KIND_RENDERER, ICoreWebView2, ICoreWebView2_20,
    ICoreWebView2Environment13, ICoreWebView2FrameInfo2, ICoreWebView2ProcessExtendedInfo,
    ICoreWebView2ProcessExtendedInfoCollection, ICoreWebView2ProcessFailedEventArgs2,
};
use webview2_com::{
    ExecuteScriptCompletedHandler, GetProcessExtendedInfosCompletedHandler,
    NavigationCompletedEventHandler, NavigationStartingEventHandler, ProcessFailedEventHandler,
    take_pwstr,
};
use windows::core::{BOOL, HSTRING, Interface, PWSTR};
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
    let window = window.clone();
    let started = window.clone().with_webview(move |view| {
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, _value| {
            super::settled(wc, probe, result.is_ok());
            // The renderer is learned right after the page answered, while it runs script.
            if result.is_ok() {
                let _ = window.with_webview(move |view| learn(&view, wc));
            }
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
    // SAFETY: the live environment on its UI thread; WebView2 retains the handler until the list answers.
    if let Err(error) = unsafe { environment.GetProcessExtendedInfos(&handler) } {
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

/// Whether the renderer `process` runs the frame `frame`. The walk follows `MoveNext`'s own answer and stops at
/// [`FRAMES_PER_RENDERER`]. The frame collection is held for as long as its iterator is used: the walk that let it go
/// right after `GetIterator` ended the shell on the Windows runner (19 Nov 2026, nothing on stderr); held, it has not
/// (inferred: the iterator does not keep its collection alive).
fn runs_frame(
    process: &ICoreWebView2ProcessExtendedInfo,
    frame: u32,
) -> windows::core::Result<bool> {
    // SAFETY: live WebView2 objects on their UI thread, with out-parameters that outlive each call; `collection`
    // outlives `frames`.
    unsafe {
        let collection = process.AssociatedFrameInfos()?;
        let frames = collection.GetIterator()?;
        let mut more = BOOL::default();
        frames.HasCurrent(&mut more)?;
        let mut walked = 0;
        while more.as_bool() && walked < FRAMES_PER_RENDERER {
            let current = frames.GetCurrent()?.cast::<ICoreWebView2FrameInfo2>()?;
            let mut id = 0;
            current.FrameId(&mut id)?;
            if id == frame {
                return Ok(true);
            }
            walked += 1;
            frames.MoveNext(&mut more)?;
        }
        Ok(false)
    }
}

/// More frames than any app page has; the walk stops there.
const FRAMES_PER_RENDERER: usize = 256;

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

pub fn kill(window: &WebviewWindow, wc: u64) {
    let asked = window.with_webview(move |view| {
        let known = RENDERERS.with_borrow_mut(|known| known.remove(&wc));
        match known.map(|pid| (pid, live_renderer(&view, pid))) {
            Some((pid, Ok(true))) => end(wc, Ok(pid), "learned"),
            known => {
                // Not learned (the page never answered), or that renderer is gone: ask now, which a stuck renderer
                // may never answer.
                crate::log::log(
                    "page.kill_lookup",
                    serde_json::json!({"wcId": wc, "learned": known.map(|(pid, live)| {
                        serde_json::json!({"pid": pid, "live": live.map_err(|e| e.to_string())})
                    })}),
                );
                lookup(&view, move |found| end(wc, found, "looked up"));
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

fn end(wc: u64, renderer: Result<i32, String>, how: &str) {
    let ended = renderer.and_then(|pid| {
        crate::log::log(
            "page.kill_pid",
            serde_json::json!({"wcId": wc, "pid": pid, "found": how}),
        );
        super::killing(wc, true);
        end_process(pid).inspect_err(|_| super::killing(wc, false))
    });
    super::killed(wc, ended.map_err(crate::failed));
}

/// WebView2 may wait for its cookie store between admitting a navigation and invoking our scheme handler.
fn watch_migration(core: &ICoreWebView2, wc: u64) -> windows::core::Result<()> {
    let mut token = 0;
    // SAFETY: the view owns these handlers; their event arguments are live on its UI thread.
    unsafe {
        core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, event| {
                if let Some(event) = event {
                    let mut success = BOOL::default();
                    event.IsSuccess(&mut success)?;
                    if !success.as_bool() {
                        let mut id = 0;
                        event.NavigationId(&mut id)?;
                        crate::runtime()
                            .migration
                            .lock()
                            .expect("migration")
                            .watches
                            .navigation_failed(wc, id);
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
        core.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, event| {
                if let Some(event) = event {
                    let mut uri = PWSTR::null();
                    event.Uri(&mut uri)?;
                    if crate::profile_bootstrap(&take_pwstr(uri)) {
                        let mut cancelled = BOOL::default();
                        event.Cancel(&mut cancelled)?;
                        if !cancelled.as_bool() {
                            let mut id = 0;
                            event.NavigationId(&mut id)?;
                            crate::runtime()
                                .migration
                                .lock()
                                .expect("migration")
                                .watches
                                .navigation_started(wc, id);
                        }
                    }
                }
                Ok(())
            })),
            &mut token,
        )
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
        let added = unsafe { view.controller().CoreWebView2() }.and_then(|core| {
            unsafe { core.add_ProcessFailed(&handler, &mut token) }?;
            if crate::runtime()
                .migration
                .lock()
                .expect("migration")
                .profile
                .pending()
            {
                watch_migration(&core, wc)?;
            }
            Ok(())
        });
        if let Err(error) = added {
            crate::log::log(
                "page.watch_failed",
                serde_json::json!({"wcId": wc, "error": error.to_string()}),
            );
        }
    })
}
