//! `webContents.executeJavaScript` run by the engine, outside the page's Content-Security-Policy, as Electron's runs it.
//! The page's own `script-src` stays what `index.html` declares ('self': no `eval`), so a script from Node cannot go
//! through an `eval` in the page.
//!
//! macOS: WKWebView's `callAsyncJavaScript` (the body is `return (<code>)`, so an expression's value comes back and a
//! Promise is awaited; a script that is not an expression runs as the body itself and answers `null`).
//! Windows: WebView2's DevTools `Runtime.evaluate` with `awaitPromise` and `returnByValue` (a Promise is awaited, as
//! Electron's is; an exception rejects).

use crate::host::Call;
use tauri::WebviewWindow;

/// Starts the evaluation; the call is answered when the engine does (a value, or the script's exception).
pub fn run(window: &WebviewWindow, call: Call, code: String) {
    #[cfg(windows)]
    windows::run(window, call, code);
    #[cfg(target_os = "macos")]
    macos::run(window, call, code);
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (window, code);
        call.err(
            "unsupported",
            "executeJavaScript is not implemented on this platform",
        );
    }
}

/// What a `Runtime.evaluate` answer says: the value, or the exception's text.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn outcome(answer: &str) -> Result<serde_json::Value, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(answer).map_err(|e| format!("unreadable evaluation answer: {e}"))?;
    if let Some(details) = parsed.get("exceptionDetails") {
        let text = details["exception"]["description"]
            .as_str()
            .or_else(|| details["text"].as_str())
            .unwrap_or("script failed");
        return Err(text.to_owned());
    }
    Ok(parsed["result"]["value"].clone())
}

#[cfg(windows)]
mod windows {
    #![allow(unsafe_code)]
    use super::{Call, WebviewWindow, outcome};
    use serde_json::json;
    use std::cell::RefCell;
    use std::rc::Rc;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    pub fn run(window: &WebviewWindow, call: Call, code: String) {
        let call = std::sync::Arc::new(std::sync::Mutex::new(Some(call)));
        let failed = call.clone();
        let started = window.with_webview(move |view| {
            let call = call;
            let answer = move |result: Result<serde_json::Value, (&str, String)>| {
                if let Some(call) = call.lock().expect("evaluation call").take() {
                    match result {
                        Ok(value) => call.ok(json!({"result": value})),
                        Err((code, message)) => call.err(code, message),
                    }
                }
            };
            // SAFETY: Tauri hands this closure the live controller on the owning UI thread.
            let core = match unsafe { view.controller().CoreWebView2() } {
                Ok(core) => core,
                Err(e) => return answer(Err(("failed", format!("WebView2 core: {e}")))),
            };
            let params = json!({
                "expression": code,
                "awaitPromise": true,
                "returnByValue": true,
            })
            .to_string();
            let answer = Rc::new(RefCell::new(Some(answer)));
            let reply = answer.clone();
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |result, json| {
                    if let Some(answer) = reply.borrow_mut().take() {
                        answer(match result {
                            Ok(()) => outcome(&json).map_err(|message| ("failed", message)),
                            Err(e) => Err(("failed", format!("Runtime.evaluate: {e}"))),
                        });
                    }
                    Ok(())
                },
            ));
            // SAFETY: the live WebView2 interface is called on its owning UI thread; the handler is retained by
            // WebView2 until the protocol call answers.
            let sent = unsafe {
                core.CallDevToolsProtocolMethod(
                    &HSTRING::from("Runtime.evaluate"),
                    &HSTRING::from(params),
                    &handler,
                )
            };
            if let Err(e) = sent
                && let Some(answer) = answer.borrow_mut().take()
            {
                answer(Err(("failed", format!("Runtime.evaluate start: {e}"))));
            }
        });
        if let Err(e) = started
            && let Some(call) = failed.lock().expect("evaluation call").take()
        {
            call.err("failed", e.to_string());
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    #![allow(unsafe_code)]
    use super::{Call, WebviewWindow};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    use serde_json::{Value, json};
    use std::ffi::{CStr, c_char};
    use std::sync::{Arc, Mutex};

    type Shared = Arc<Mutex<Option<Call>>>;

    fn finish(call: &Shared, result: Result<Value, String>) {
        if let Some(call) = call.lock().unwrap_or_else(|e| e.into_inner()).take() {
            match result {
                Ok(value) => call.ok(json!({"result": value})),
                Err(message) => call.err("failed", message),
            }
        }
    }

    // SAFETY: the caller passes a live NSString or nil, on the main thread.
    unsafe fn text(value: *mut AnyObject) -> Option<String> {
        if value.is_null() {
            return None;
        }
        // SAFETY: value is a live NSString.
        let bytes: *const c_char = unsafe { msg_send![value, UTF8String] };
        // SAFETY: NSString owns a NUL-terminated UTF-8 string while it lives.
        (!bytes.is_null()).then(|| {
            unsafe { CStr::from_ptr(bytes) }
                .to_string_lossy()
                .into_owned()
        })
    }

    /// `return (<code>)` as a function body, with the JSON of what it gives (what the page returns is a string).
    fn expression_body(code: &str) -> String {
        let code = code.trim().trim_end_matches(';').trim_end();
        format!(
            "const value = await ({code}\n); return value === undefined ? \"null\" : JSON.stringify(value);"
        )
    }

    fn attempt(webview: Retained<AnyObject>, body: String, fallback: Option<String>, call: Shared) {
        let again = webview.clone();
        let answer = call.clone();
        let callback = RcBlock::new(move |value: *mut AnyObject, error: *mut AnyObject| {
            // SAFETY: WebKit calls the handler on the main thread with a live result and NSError (or nil).
            unsafe {
                if error.is_null() {
                    let parsed = text(value)
                        .map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
                        .unwrap_or(Ok(Value::Null));
                    return finish(&answer, parsed);
                }
                let info: *mut AnyObject = msg_send![error, userInfo];
                let key = NSString::from_str("WKJavaScriptExceptionMessage");
                let exception: *mut AnyObject = if info.is_null() {
                    std::ptr::null_mut()
                } else {
                    msg_send![info, objectForKey: &*key]
                };
                let description: *mut AnyObject = msg_send![error, localizedDescription];
                let message = text(exception)
                    .or_else(|| text(description))
                    .unwrap_or_else(|| "WKWebView JavaScript evaluation failed".into());
                match &fallback {
                    Some(raw) if message.contains("SyntaxError") => {
                        attempt(again.clone(), raw.clone(), None, answer.clone())
                    }
                    _ => finish(&answer, Err(message)),
                }
            }
        });
        let source = NSString::from_str(&body);
        let nil: *mut AnyObject = std::ptr::null_mut();
        // SAFETY: called on the main thread with a live WKWebView; WebKit copies the block.
        unsafe {
            let world: *mut AnyObject = msg_send![class!(WKContentWorld), pageWorld];
            let _: () = msg_send![&*webview, callAsyncJavaScript: &*source, arguments: nil, inFrame: nil, inContentWorld: world, completionHandler: &*callback];
        }
    }

    pub fn run(window: &WebviewWindow, call: Call, code: String) {
        let call: Shared = Arc::new(Mutex::new(Some(call)));
        let failed = call.clone();
        let started = window.with_webview(move |view| {
            // SAFETY: the pointer is the live WKWebView Tauri hands this closure on the main thread.
            let Some(webview) = (unsafe { Retained::retain(view.inner().cast::<AnyObject>()) })
            else {
                return finish(&call, Err("WKWebView is unavailable".into()));
            };
            let body = expression_body(&code);
            attempt(webview, body, Some(code), call);
        });
        if let Err(e) = started {
            finish(&failed, Err(e.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::outcome;

    #[test]
    fn a_runtime_evaluate_answer_is_its_value_or_its_exception() {
        assert_eq!(
            outcome(r#"{"result":{"type":"string","value":"x"}}"#).unwrap(),
            "x"
        );
        assert!(
            outcome(r#"{"result":{"type":"undefined"}}"#)
                .unwrap()
                .is_null()
        );
        assert_eq!(
            outcome(r#"{"exceptionDetails":{"text":"Uncaught","exception":{"description":"Error: boom"}}}"#)
                .unwrap_err(),
            "Error: boom"
        );
        assert!(outcome("not json").is_err());
    }
}
