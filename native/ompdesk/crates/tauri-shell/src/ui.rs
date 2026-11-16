pub fn run(work: impl FnOnce() + Send + 'static) {
    if let Err(error) = crate::runtime().app.run_on_main_thread(work) {
        crate::log::log(
            "ui.dispatch_failed",
            serde_json::json!({"error": error.to_string()}),
        );
    }
}

pub fn post(work: impl FnOnce() + Send + 'static) {
    // Tauri runs UI-thread dispatch inline; hopping through its executor preserves queued menu/tray callbacks.
    tauri::async_runtime::spawn(async move { run(work) });
}

pub fn window_handle(id: u64) -> Option<isize> {
    use tauri::Manager;

    let runtime = crate::runtime();
    let label = runtime
        .registry
        .lock()
        .expect("registry")
        .by_window(id)?
        .label
        .clone();
    let Some(window) = runtime.app.get_webview_window(&label) else {
        return Some(0);
    };
    #[cfg(windows)]
    let handle = window.hwnd().map(|handle| handle.0 as isize);
    #[cfg(target_os = "macos")]
    let handle = window.ns_window().map(|handle| handle as isize);
    match handle {
        Ok(handle) => Some(handle),
        Err(error) => {
            crate::log::log(
                "ui.window_handle_failed",
                serde_json::json!({"winId": id, "error": error.to_string()}),
            );
            None
        }
    }
}
