#![allow(unsafe_code)]

use std::ffi::{CStr, c_char};
use std::sync::Mutex;

use block2::RcBlock;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSArray, NSString};

use super::native::{Done, Operation, Snapshot};

const SCRIPT_MARKER: &str = "/* ompdesk-session-preload */\n";

#[link(name = "WebKit", kind = "framework")]
unsafe extern "C" {
    static WKWebsiteDataTypeDiskCache: &'static NSString;
    static WKWebsiteDataTypeMemoryCache: &'static NSString;
}

// SAFETY: Callers pass a live NSString (or nil) on the main thread and copy its bytes immediately.
unsafe fn string_of(value: *mut AnyObject) -> Result<String, String> {
    if value.is_null() {
        return Err("native string is nil".into());
    }
    // SAFETY: The caller guarantees that value is a live NSString.
    let bytes: *const c_char = unsafe { msg_send![value, UTF8String] };
    if bytes.is_null() {
        return Err("native string has no UTF-8 representation".into());
    }
    // SAFETY: NSString owns a NUL-terminated UTF-8 string until it is released.
    Ok(unsafe { CStr::from_ptr(bytes) }
        .to_string_lossy()
        .into_owned())
}

// SAFETY: The array and its NSString elements remain live for this call on the main thread.
unsafe fn strings(array: *mut AnyObject) -> Result<Vec<String>, String> {
    if array.is_null() {
        return Err("spellchecker returned no language list".into());
    }
    // SAFETY: array is an NSArray of NSString objects.
    let count: usize = unsafe { msg_send![array, count] };
    (0..count)
        .map(|index| {
            // SAFETY: index is within the NSArray and its elements are NSString objects.
            let item: *mut AnyObject = unsafe { msg_send![array, objectAtIndex: index] };
            // SAFETY: item belongs to the live array.
            unsafe { string_of(item) }
        })
        .collect()
}

pub fn describe(view: tauri::webview::PlatformWebview, done: Done<Snapshot>) {
    let webview = view.inner().cast::<AnyObject>();
    if webview.is_null() {
        done(Err("WKWebView is unavailable".into()));
        return;
    }
    // SAFETY: Tauri invokes this on the UI thread with a live WKWebView. AppKit's spellchecker and
    // WebKit's JavaScript completion handler are used according to their public contracts.
    unsafe {
        let checker: *mut AnyObject = msg_send![class!(NSSpellChecker), sharedSpellChecker];
        if checker.is_null() {
            done(Err("NSSpellChecker is unavailable".into()));
            return;
        }
        let available: *mut AnyObject = msg_send![checker, availableLanguages];
        let automatic: bool = msg_send![checker, automaticallyIdentifiesLanguages];
        let preferred: Result<Vec<String>, String> = if automatic {
            let list: *mut AnyObject = msg_send![checker, userPreferredLanguages];
            strings(list)
        } else {
            let language: *mut AnyObject = msg_send![checker, language];
            string_of(language).map(|s| vec![s])
        };
        let (spell_languages, available_spell_languages) = match (preferred, strings(available)) {
            (Ok(preferred), Ok(available)) => (preferred, available),
            (Err(error), _) | (_, Err(error)) => {
                done(Err(error));
                return;
            }
        };
        let done = Mutex::new(Some(done));
        let callback = RcBlock::new(move |value: *mut AnyObject, error: *mut AnyObject| {
            let Some(done) = done.lock().unwrap_or_else(|e| e.into_inner()).take() else {
                return;
            };
            if !error.is_null() {
                let description: *mut AnyObject = msg_send![error, localizedDescription];
                done(Err(string_of(description).unwrap_or_else(|_| {
                    "WKWebView JavaScript evaluation failed".into()
                })));
                return;
            }
            let result = string_of(value).and_then(|text| {
                let json: serde_json::Value =
                    serde_json::from_str(&text).map_err(|e| e.to_string())?;
                let ua = json
                    .get("userAgent")
                    .and_then(|v| v.as_str())
                    .ok_or("navigator.userAgent is unavailable")?;
                let languages = json
                    .get("languages")
                    .and_then(|v| v.as_array())
                    .ok_or("navigator.languages is unavailable")?;
                let languages = languages
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .ok_or("navigator.languages contains a non-string")
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .join(",");
                Ok(Snapshot {
                    user_agent: ua.to_owned(),
                    accept_languages: languages,
                    spell_languages: spell_languages.clone(),
                    available_spell_languages: available_spell_languages.clone(),
                })
            });
            done(result);
        });
        let script = NSString::from_str(
            "JSON.stringify({userAgent: navigator.userAgent, languages: navigator.languages})",
        );
        let _: () = msg_send![webview, evaluateJavaScript: &*script, completionHandler: &*callback];
    }
}

pub fn apply(view: tauri::webview::PlatformWebview, op: Operation, done: Done<()>) {
    let webview = view.inner().cast::<AnyObject>();
    if webview.is_null() {
        done(Err("WKWebView is unavailable".into()));
        return;
    }
    // SAFETY: The platform view and every object obtained from it are live on Tauri's UI thread.
    // Objective-C arguments and return values match the public WebKit and AppKit declarations.
    unsafe {
        match op {
            Operation::SetUserAgent(agent) => {
                let _: () = msg_send![webview, setCustomUserAgent: &*NSString::from_str(&agent)];
                done(Ok(()));
            }
            Operation::SetSpellLanguages(_) => done(Err(
                "WKWebView has no public per-webview spellchecker language setter".into(),
            )),
            Operation::LearnWord(word) => {
                let checker: *mut AnyObject = msg_send![class!(NSSpellChecker), sharedSpellChecker];
                if checker.is_null() {
                    done(Err("NSSpellChecker is unavailable".into()));
                    return;
                }
                let _: () = msg_send![checker, learnWord: &*NSString::from_str(&word)];
                done(Ok(()));
            }
            Operation::ClearHttpCache => {
                let configuration: *mut AnyObject = msg_send![webview, configuration];
                let store: *mut AnyObject = msg_send![configuration, websiteDataStore];
                if store.is_null() {
                    done(Err("WKWebsiteDataStore is unavailable".into()));
                    return;
                }
                let types: Retained<AnyObject> = msg_send![class!(NSMutableSet), set];
                let _: () = msg_send![&*types, addObject: WKWebsiteDataTypeDiskCache];
                let _: () = msg_send![&*types, addObject: WKWebsiteDataTypeMemoryCache];
                let date: Retained<AnyObject> =
                    msg_send![class!(NSDate), dateWithTimeIntervalSince1970: 0.0f64];
                let done = Mutex::new(Some(done));
                let callback = RcBlock::new(move || {
                    if let Some(done) = done.lock().unwrap_or_else(|e| e.into_inner()).take() {
                        done(Ok(()));
                    }
                });
                let _: () = msg_send![store, removeDataOfTypes: &*types, modifiedSince: &*date, completionHandler: &*callback];
            }
            Operation::SetPreloads(preloads) => {
                let configuration: *mut AnyObject = msg_send![webview, configuration];
                let controller: *mut AnyObject = msg_send![configuration, userContentController];
                if controller.is_null() {
                    done(Err("WKUserContentController is unavailable".into()));
                    return;
                }
                let scripts: Retained<NSArray<AnyObject>> = msg_send![controller, userScripts];
                let count: usize = msg_send![&*scripts, count];
                let mut retained = Vec::with_capacity(count);
                for index in 0..count {
                    let script: Retained<AnyObject> = msg_send![&*scripts, objectAtIndex: index];
                    let source: *mut AnyObject = msg_send![&*script, source];
                    match string_of(source) {
                        Ok(source) if source.starts_with(SCRIPT_MARKER) => {}
                        Ok(_) => retained.push(script),
                        Err(error) => {
                            done(Err(error));
                            return;
                        }
                    }
                }
                let mut added = Vec::with_capacity(preloads.len());
                for (_id, source) in preloads {
                    let source = NSString::from_str(&format!("{SCRIPT_MARKER}{source}"));
                    let script: Allocated<AnyObject> = msg_send![class!(WKUserScript), alloc];
                    let script: Retained<AnyObject> = msg_send![script, initWithSource: &*source, injectionTime: 0isize, forMainFrameOnly: false];
                    added.push(script);
                }
                let _: () = msg_send![controller, removeAllUserScripts];
                for script in retained.iter().chain(added.iter()) {
                    let _: () = msg_send![controller, addUserScript: &**script];
                }
                done(Ok(()));
            }
        }
    }
}
