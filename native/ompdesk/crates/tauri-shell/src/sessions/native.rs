pub type Done<T> = Box<dyn FnOnce(Result<T, String>) + Send>;

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub user_agent: String,
    pub accept_languages: String,
    pub spell_languages: Vec<String>,
    pub available_spell_languages: Vec<String>,
}

#[derive(Clone, Debug)]
pub enum Operation {
    SetUserAgent(String),
    SetPreloads(Vec<(String, String)>),
    ClearHttpCache,
    SetSpellLanguages,
    LearnWord(#[cfg(target_os = "macos")] String),
}

#[cfg(target_os = "macos")]
use super::macos as platform;
#[cfg(windows)]
use super::windows as platform;

pub fn dispatch<T: Send + 'static>(
    webview: &tauri::Webview,
    done: Done<T>,
    work: impl FnOnce(tauri::webview::PlatformWebview, Done<T>) + Send + 'static,
) {
    let done = std::sync::Arc::new(std::sync::Mutex::new(Some(done)));
    let callback = done.clone();
    if let Err(error) = webview.with_webview(move |view| {
        let done = callback
            .lock()
            .expect("session callback")
            .take()
            .expect("one callback");
        work(view, done);
    }) && let Some(done) = done.lock().expect("session callback").take()
    {
        done(Err(error.to_string()));
    }
}

pub fn describe(webview: &tauri::Webview, done: Done<Snapshot>) {
    dispatch(webview, done, platform::describe);
}

pub fn apply(webview: &tauri::Webview, op: Operation, done: Done<()>) {
    let op = match op {
        Operation::SetPreloads(preloads) => Operation::SetPreloads(
            preloads
                .into_iter()
                .map(|(id, source)| (id, format!("(function(){{{source}\n}})();")))
                .collect(),
        ),
        op => op,
    };
    dispatch(webview, done, move |view, done| {
        platform::apply(view, op, done)
    });
}
