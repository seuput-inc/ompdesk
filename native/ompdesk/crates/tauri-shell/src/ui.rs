pub fn run(work: impl FnOnce() + Send + 'static) {
    if let Err(error) = crate::runtime().app.run_on_main_thread(work) {
        crate::log::log(
            "ui.dispatch_failed",
            serde_json::json!({"error": error.to_string()}),
        );
    }
}
