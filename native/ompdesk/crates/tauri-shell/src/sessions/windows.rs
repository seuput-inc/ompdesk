#![allow(unsafe_code)]

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use super::native::{Done, Operation, Snapshot};
use webview2_com::{
    AddScriptToExecuteOnDocumentCreatedCompletedHandler, ClearBrowsingDataCompletedHandler,
    ExecuteScriptCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, ICoreWebView2, ICoreWebView2_13,
        ICoreWebView2Profile2, ICoreWebView2Settings2,
    },
    take_pwstr,
};
use windows::{
    Win32::{
        Globalization::{ISpellCheckerFactory, SpellCheckerFactory},
        System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
    },
    core::{IUnknown, Interface, PCWSTR, PWSTR},
};

type ScriptIds = Rc<RefCell<Vec<String>>>;

thread_local! {
    static SCRIPTS: RefCell<HashMap<usize, ScriptIds>> = RefCell::new(HashMap::new());
}

fn identity(view: &ICoreWebView2) -> Result<usize, String> {
    view.cast::<IUnknown>()
        .map(|identity| identity.as_raw() as usize)
        .map_err(|e| format!("WebView2 identity: {e}"))
}

pub fn forget(view: tauri::webview::PlatformWebview) {
    if let Ok(key) = webview(&view).and_then(|view| identity(&view)) {
        SCRIPTS.with(|scripts| {
            scripts.borrow_mut().remove(&key);
        });
    }
}

fn remove_script(view: &ICoreWebView2, id: &str) -> Result<(), String> {
    let id = wide(id)?;
    // SAFETY: the WebView2 interface and NUL-terminated ID are live on the UI thread.
    unsafe { view.RemoveScriptToExecuteOnDocumentCreated(PCWSTR(id.as_ptr())) }
        .map_err(|e| format!("WebView2 remove preload: {e}"))
}

fn add_preloads(
    view: ICoreWebView2,
    key: usize,
    ids: ScriptIds,
    mut sources: std::vec::IntoIter<(String, String)>,
    done: Done<()>,
) {
    let Some((_, source)) = sources.next() else {
        return done(Ok(()));
    };
    let source = match wide(&source) {
        Ok(source) => source,
        Err(error) => return done(Err(error)),
    };
    let done = Rc::new(RefCell::new(Some(done)));
    let completion = Rc::clone(&done);
    let callback_view = view.clone();
    let handler =
        AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, id| {
            let Some(done) = completion.borrow_mut().take() else {
                return Ok(());
            };
            if let Err(error) = result {
                done(Err(format!("WebView2 add preload: {error}")));
                return Ok(());
            }
            if id.is_empty() {
                done(Err(
                    "WebView2 add preload returned an empty script ID".into()
                ));
                return Ok(());
            }
            let attached = SCRIPTS.with(|scripts| {
                scripts
                    .borrow()
                    .get(&key)
                    .is_some_and(|current| Rc::ptr_eq(current, &ids))
            });
            if !attached {
                let result = remove_script(&callback_view, &id);
                done(Err(match result {
                    Ok(()) => "WebView2 detached while adding preload".into(),
                    Err(error) => format!("WebView2 detached while adding preload; {error}"),
                }));
                return Ok(());
            }
            ids.borrow_mut().push(id);
            add_preloads(callback_view, key, ids, sources, done);
            Ok(())
        }));
    // SAFETY: WebView2 copies the source and retains the callback during this UI-thread call.
    if let Err(error) =
        unsafe { view.AddScriptToExecuteOnDocumentCreated(PCWSTR(source.as_ptr()), &handler) }
        && let Some(done) = done.borrow_mut().take()
    {
        done(Err(format!("WebView2 start adding preload: {error}")));
    }
}

fn available_spell_languages() -> Result<Vec<String>, String> {
    // SAFETY: Tauri invokes this on the COM-initialized WebView2 UI thread.
    let factory: ISpellCheckerFactory =
        unsafe { CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER) }
            .map_err(|e| format!("Windows spellchecker factory: {e}"))?;
    // SAFETY: the factory is a live COM interface on its owning thread.
    let enumerator = unsafe { factory.SupportedLanguages() }
        .map_err(|e| format!("Windows spellchecker languages: {e}"))?;
    let mut languages = Vec::new();
    loop {
        let mut value = [PWSTR::null()];
        let mut fetched = 0;
        // SAFETY: the output buffer and count are valid, and the enumerator is live.
        let result = unsafe { enumerator.Next(&mut value, Some(&mut fetched)) };
        result
            .ok()
            .map_err(|e| format!("Windows spellchecker language enumeration: {e}"))?;
        if fetched == 0 {
            break;
        }
        languages.push(take_pwstr(value[0]));
    }
    Ok(languages)
}

fn wide(value: &str) -> Result<Vec<u16>, String> {
    if value.contains('\0') {
        return Err("WebView2 string contains a NUL character".into());
    }
    Ok(value.encode_utf16().chain(Some(0)).collect())
}

fn webview(view: &tauri::webview::PlatformWebview) -> Result<ICoreWebView2, String> {
    // SAFETY: Tauri provides the live controller on its UI thread.
    unsafe { view.controller().CoreWebView2() }.map_err(|e| format!("WebView2 controller: {e}"))
}

fn settings(view: &ICoreWebView2) -> Result<ICoreWebView2Settings2, String> {
    // SAFETY: the WebView2 interface is used on its owning UI thread.
    unsafe { view.Settings() }
        .and_then(|settings| settings.cast())
        .map_err(|e| format!("WebView2 user-agent settings: {e}"))
}

pub fn describe(view: tauri::webview::PlatformWebview, done: Done<Snapshot>) {
    let result = (|| {
        let view = webview(&view)?;
        let settings = settings(&view)?;
        let mut value = PWSTR::null();
        // SAFETY: WebView2 writes an allocated string into value on the UI thread.
        unsafe { settings.UserAgent(&mut value) }
            .map_err(|e| format!("WebView2 get user agent: {e}"))?;
        let user_agent = take_pwstr(value);
        let available_spell_languages = available_spell_languages()?;
        Ok::<_, String>((view, user_agent, available_spell_languages))
    })();
    let (view, user_agent, available_spell_languages) = match result {
        Ok(result) => result,
        Err(error) => return done(Err(error)),
    };
    let done = Rc::new(RefCell::new(Some(done)));
    let completion = Rc::clone(&done);
    let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, json| {
        let result = result
            .map_err(|e| format!("WebView2 read navigator.languages: {e}"))
            .and_then(|()| {
                serde_json::from_str::<Vec<String>>(&json)
                    .map_err(|e| format!("WebView2 navigator.languages result: {e}"))
            })
            .map(|languages| Snapshot {
                user_agent,
                accept_languages: languages.join(","),
                spell_languages: Vec::new(),
                available_spell_languages,
            });
        if let Some(done) = completion.borrow_mut().take() {
            done(result);
        }
        Ok(())
    }));
    let script = wide("navigator.languages").expect("constant contains no NUL");
    // SAFETY: the script and handler remain valid for the duration of the call; WebView2 retains the handler.
    if let Err(error) = unsafe { view.ExecuteScript(PCWSTR(script.as_ptr()), &handler) }
        && let Some(done) = done.borrow_mut().take()
    {
        done(Err(format!("WebView2 start navigator.languages: {error}")));
    }
}

pub fn apply(view: tauri::webview::PlatformWebview, op: Operation, done: Done<()>) {
    let view = match webview(&view) {
        Ok(view) => view,
        Err(error) => return done(Err(error)),
    };
    match op {
        Operation::SetUserAgent(value) => {
            let result = settings(&view).and_then(|settings| {
                let value = wide(&value)?;
                // SAFETY: the NUL-terminated value is live throughout this UI-thread COM call.
                unsafe { settings.SetUserAgent(PCWSTR(value.as_ptr())) }
                    .map_err(|e| format!("WebView2 set user agent: {e}"))
            });
            done(result);
        }
        Operation::ClearHttpCache => {
            let profile = view
                .cast::<ICoreWebView2_13>()
                // SAFETY: the WebView2 interface is used on its owning UI thread.
                .and_then(|view| unsafe { view.Profile() })
                .and_then(|profile| profile.cast::<ICoreWebView2Profile2>());
            let profile = match profile {
                Ok(profile) => profile,
                Err(error) => return done(Err(format!("WebView2 cache profile: {error}"))),
            };
            let done = Rc::new(RefCell::new(Some(done)));
            let completion = Rc::clone(&done);
            let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                if let Some(done) = completion.borrow_mut().take() {
                    done(result.map_err(|e| format!("WebView2 clear HTTP cache: {e}")));
                }
                Ok(())
            }));
            // SAFETY: the profile and handler are valid on the UI thread; WebView2 retains the handler.
            if let Err(error) = unsafe {
                profile.ClearBrowsingData(COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, &handler)
            } && let Some(done) = done.borrow_mut().take()
            {
                done(Err(format!("WebView2 start clearing HTTP cache: {error}")));
            }
        }
        Operation::SetSpellLanguages => done(Err(
            "WebView2 has no public spellchecking language setter".into(),
        )),
        Operation::LearnWord(..) => done(Err(
            "WebView2 does not expose its spellchecking dictionary or a public API to add a word"
                .into(),
        )),
        Operation::SetPreloads(preloads) => {
            let key = match identity(&view) {
                Ok(key) => key,
                Err(error) => return done(Err(error)),
            };
            let ids =
                SCRIPTS.with(|scripts| Rc::clone(scripts.borrow_mut().entry(key).or_default()));
            loop {
                let id = ids.borrow().last().cloned();
                let Some(id) = id else {
                    break;
                };
                if let Err(error) = remove_script(&view, &id) {
                    return done(Err(error));
                }
                ids.borrow_mut().pop();
            }
            add_preloads(view, key, ids, preloads.into_iter(), done);
        }
    }
}
