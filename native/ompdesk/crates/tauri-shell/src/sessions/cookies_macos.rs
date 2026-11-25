#![allow(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;
use url::Url;

use super::cookie_spec;
use super::native::Done;

#[link(name = "Foundation", kind = "framework")]
unsafe extern "C" {
    static NSHTTPCookieExpires: &'static NSString;
    static NSHTTPCookieMaximumAge: &'static NSString;
}

// SAFETY: The caller supplies the live platform view on the UI thread.
unsafe fn cookie_store(
    view: &tauri::webview::PlatformWebview,
) -> Result<Retained<AnyObject>, String> {
    let webview = view.inner().cast::<AnyObject>();
    if webview.is_null() {
        return Err("WKWebView is unavailable".into());
    }
    // SAFETY: The objects are obtained from the supplied live WKWebView on its UI thread.
    unsafe {
        let configuration: *mut AnyObject = msg_send![webview, configuration];
        if configuration.is_null() {
            return Err("WKWebView configuration is unavailable".into());
        }
        let data_store: *mut AnyObject = msg_send![configuration, websiteDataStore];
        if data_store.is_null() {
            return Err("WKWebsiteDataStore is unavailable".into());
        }
        let store: Option<Retained<AnyObject>> = msg_send![data_store, httpCookieStore];
        store.ok_or_else(|| "WKHTTPCookieStore is unavailable".into())
    }
}

// SAFETY: cookie is a live NSHTTPCookie on the UI thread and selector names a string property.
unsafe fn cookie_string(cookie: *mut AnyObject, selector: &str) -> Result<String, String> {
    // SAFETY: Each selector is a documented NSHTTPCookie NSString property.
    let value: *mut NSString = unsafe {
        match selector {
            "name" => msg_send![cookie, name],
            "value" => msg_send![cookie, value],
            "domain" => msg_send![cookie, domain],
            "path" => msg_send![cookie, path],
            _ => return Err("invalid native cookie property".into()),
        }
    };
    if value.is_null() {
        return Err("native cookie property is unavailable".into());
    }
    // SAFETY: The NSString is owned by the live cookie for the duration of this conversion.
    Ok(unsafe { &*value }.to_string())
}

// SAFETY: cookie is a live NSHTTPCookie on the UI thread.
unsafe fn expired(cookie: *mut AnyObject) -> bool {
    // SAFETY: expiresDate is an optional NSDate and timeIntervalSinceNow returns an NSTimeInterval.
    unsafe {
        let date: *mut AnyObject = msg_send![cookie, expiresDate];
        if date.is_null() {
            return false;
        }
        let remaining: f64 = msg_send![date, timeIntervalSinceNow];
        remaining <= 0.0
    }
}

pub fn header(view: tauri::webview::PlatformWebview, url: Url, done: Done<Option<String>>) {
    // SAFETY: Tauri calls this entry point on the UI thread with its live platform view.
    let store = match unsafe { cookie_store(&view) } {
        Ok(store) => store,
        Err(error) => {
            done(Err(error));
            return;
        }
    };
    let done = RefCell::new(Some(done));
    let callback = RcBlock::new(move |cookies: *mut AnyObject| {
        let Some(done) = done.borrow_mut().take() else {
            return;
        };
        if cookies.is_null() {
            done(Err("WKHTTPCookieStore returned no cookie list".into()));
            return;
        }
        // SAFETY: WebKit supplies a live NSArray of NSHTTPCookie objects to this main-thread block.
        let result = unsafe {
            (|| -> Result<Option<String>, String> {
                let count: usize = msg_send![cookies, count];
                let mut selected = Vec::new();
                for index in 0..count {
                    let cookie: *mut AnyObject = msg_send![cookies, objectAtIndex: index];
                    if cookie.is_null() {
                        return Err("native cookie is unavailable".into());
                    }
                    if expired(cookie) {
                        continue;
                    }
                    let domain = cookie_string(cookie, "domain")?;
                    let path = cookie_string(cookie, "path")?;
                    let secure: bool = msg_send![cookie, isSecure];
                    if !cookie_spec::matches(
                        domain.trim_start_matches('.'),
                        !domain.starts_with('.'),
                        &path,
                        secure,
                        &url,
                    ) {
                        continue;
                    }
                    let name = cookie_string(cookie, "name")?;
                    let value = cookie_string(cookie, "value")?;
                    selected.push((path.len(), format!("{name}={value}")));
                }
                selected.sort_by_key(|b| std::cmp::Reverse(b.0));
                if selected.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(
                        selected
                            .into_iter()
                            .map(|(_, value)| value)
                            .collect::<Vec<_>>()
                            .join("; "),
                    ))
                }
            })()
        };
        done(result);
    });
    // SAFETY: WebKit copies the block and calls it with the cookie array on the UI thread.
    unsafe {
        let _: () = msg_send![&*store, getAllCookies: &*callback];
    }
}

pub fn secure_scopes(view: tauri::webview::PlatformWebview, done: Done<Vec<cookie_spec::Scope>>) {
    // SAFETY: Tauri calls this entry point on the UI thread with its live platform view.
    let store = match unsafe { cookie_store(&view) } {
        Ok(store) => store,
        Err(error) => {
            done(Err(error));
            return;
        }
    };
    let done = RefCell::new(Some(done));
    let callback = RcBlock::new(move |cookies: *mut AnyObject| {
        let Some(done) = done.borrow_mut().take() else {
            return;
        };
        if cookies.is_null() {
            done(Err("WKHTTPCookieStore returned no cookie list".into()));
            return;
        }
        // SAFETY: WebKit supplies a live NSArray of NSHTTPCookie objects to this UI-thread block.
        let result = unsafe {
            (|| -> Result<Vec<cookie_spec::Scope>, String> {
                let count: usize = msg_send![cookies, count];
                let mut scopes = Vec::new();
                for index in 0..count {
                    let cookie: *mut AnyObject = msg_send![cookies, objectAtIndex: index];
                    if cookie.is_null() {
                        return Err("native cookie is unavailable".into());
                    }
                    let secure: bool = msg_send![cookie, isSecure];
                    if !secure || expired(cookie) {
                        continue;
                    }
                    let domain = cookie_string(cookie, "domain")?;
                    scopes.push(cookie_spec::Scope {
                        name: cookie_string(cookie, "name")?,
                        domain: domain.trim_start_matches('.').to_owned(),
                        path: cookie_string(cookie, "path")?,
                    });
                }
                Ok(scopes)
            })()
        };
        done(result);
    });
    // SAFETY: WebKit copies the block and calls it with the cookie array on the UI thread.
    unsafe {
        let _: () = msg_send![&*store, getAllCookies: &*callback];
    }
}

enum Action {
    Set(Retained<AnyObject>),
    FindDeletion {
        name: String,
        domain: String,
        path: String,
        host_only: bool,
    },
    Delete(Retained<AnyObject>),
}

struct Pending {
    store: Retained<AnyObject>,
    actions: VecDeque<Action>,
    done: Option<Done<()>>,
}

fn finish(pending: &Rc<RefCell<Pending>>, result: Result<(), String>) {
    let done = pending.borrow_mut().done.take();
    if let Some(done) = done {
        done(result);
    }
}

fn advance(pending: Rc<RefCell<Pending>>) {
    let action = pending.borrow_mut().actions.pop_front();
    let Some(action) = action else {
        finish(&pending, Ok(()));
        return;
    };
    match action {
        Action::FindDeletion {
            name,
            domain,
            path,
            host_only,
        } => {
            let next = pending.clone();
            let fired = Cell::new(false);
            let callback = RcBlock::new(move |cookies: *mut AnyObject| {
                if fired.replace(true) {
                    return;
                }
                if cookies.is_null() {
                    finish(
                        &next,
                        Err("WKHTTPCookieStore returned no cookie list".into()),
                    );
                    return;
                }
                // SAFETY: WebKit supplies a live NSArray of cookies to this UI-thread block.
                let result = unsafe {
                    (|| -> Result<Vec<Retained<AnyObject>>, String> {
                        let count: usize = msg_send![cookies, count];
                        let mut found = Vec::new();
                        for index in 0..count {
                            let cookie: Retained<AnyObject> =
                                msg_send![cookies, objectAtIndex: index];
                            let ptr = (&*cookie as *const AnyObject).cast_mut();
                            let native_domain = cookie_string(ptr, "domain")?;
                            if cookie_string(ptr, "name")? == name
                                && native_domain
                                    .trim_start_matches('.')
                                    .eq_ignore_ascii_case(&domain)
                                && native_domain.starts_with('.') != host_only
                                && cookie_string(ptr, "path")? == path
                            {
                                found.push(cookie);
                            }
                        }
                        Ok(found)
                    })()
                };
                match result {
                    Ok(found) => {
                        let mut state = next.borrow_mut();
                        for cookie in found.into_iter().rev() {
                            state.actions.push_front(Action::Delete(cookie));
                        }
                        drop(state);
                        advance(next.clone());
                    }
                    Err(error) => finish(&next, Err(error)),
                }
            });
            let store = pending.borrow().store.clone();
            // SAFETY: The retained store is the supplied webview's store; WebKit copies the block.
            unsafe {
                let _: () = msg_send![&*store, getAllCookies: &*callback];
            }
        }
        action => {
            let (cookie, is_delete) = match action {
                Action::Set(cookie) => (cookie, false),
                Action::Delete(cookie) => (cookie, true),
                Action::FindDeletion { .. } => unreachable!(),
            };
            let next = pending.clone();
            let fired = Cell::new(false);
            let callback = RcBlock::new(move || {
                if !fired.replace(true) {
                    advance(next.clone());
                }
            });
            let store = pending.borrow().store.clone();
            // SAFETY: The retained store and cookie are live on the UI thread. WebKit copies the block.
            unsafe {
                if is_delete {
                    let _: () =
                        msg_send![&*store, deleteCookie: &*cookie, completionHandler: &*callback];
                } else {
                    let _: () =
                        msg_send![&*store, setCookie: &*cookie, completionHandler: &*callback];
                }
            }
        }
    }
}

pub fn store(
    view: tauri::webview::PlatformWebview,
    url: Url,
    headers: Vec<(String, cookie_spec::Cookie)>,
    done: Done<()>,
) {
    // SAFETY: Tauri calls this entry point on the UI thread with its live platform view.
    let store = match unsafe { cookie_store(&view) } {
        Ok(store) => store,
        Err(error) => {
            done(Err(error));
            return;
        }
    };
    let mut actions = VecDeque::new();
    // SAFETY: The Foundation objects are created and used on this UI-thread call. Each raw header
    // is parsed separately with its response URL so commas inside Expires or values are not merged.
    unsafe {
        let text = NSString::from_str(url.as_str());
        let native_url: Option<Retained<AnyObject>> =
            msg_send![class!(NSURL), URLWithString: &*text];
        let Some(native_url) = native_url else {
            done(Err("invalid native cookie URL".into()));
            return;
        };
        let key = NSString::from_str("Set-Cookie");
        for (header, spec) in headers {
            let value = NSString::from_str(&header);
            let fields: Option<Retained<AnyObject>> =
                msg_send![class!(NSDictionary), dictionaryWithObject: &*value, forKey: &*key];
            let Some(fields) = fields else {
                done(Err("native cookie header construction failed".into()));
                return;
            };
            let cookies: Option<Retained<AnyObject>> = msg_send![class!(NSHTTPCookie), cookiesWithResponseHeaderFields: &*fields, forURL: &*native_url];
            let Some(cookies) = cookies else {
                done(Err("native cookie parsing failed".into()));
                return;
            };
            let now: f64 = msg_send![class!(NSDate), timeIntervalSinceReferenceDate];
            let expired_at_admission = spec
                .expires
                .is_some_and(|deadline| deadline <= now + 978307200.0);
            if spec.delete || expired_at_admission {
                actions.push_back(Action::FindDeletion {
                    name: spec.name,
                    domain: spec.domain,
                    path: spec.path,
                    host_only: spec.host_only,
                });
            } else {
                let count: usize = msg_send![&*cookies, count];
                for index in 0..count {
                    let cookie: Retained<AnyObject> = msg_send![&*cookies, objectAtIndex: index];
                    let cookie = if let Some(deadline) = spec.expires {
                        let properties: Retained<AnyObject> = msg_send![&*cookie, properties];
                        let properties: Retained<AnyObject> = msg_send![&*properties, mutableCopy];
                        let _: () =
                            msg_send![&*properties, removeObjectForKey: NSHTTPCookieMaximumAge];
                        let date: Retained<AnyObject> =
                            msg_send![class!(NSDate), dateWithTimeIntervalSince1970: deadline];
                        let _: () =
                            msg_send![&*properties, setObject: &*date, forKey: NSHTTPCookieExpires];
                        let fixed: Option<Retained<AnyObject>> =
                            msg_send![class!(NSHTTPCookie), cookieWithProperties: &*properties];
                        let Some(fixed) = fixed else {
                            done(Err("native cookie expiration construction failed".into()));
                            return;
                        };
                        fixed
                    } else {
                        cookie
                    };
                    let ptr = (&*cookie as *const AnyObject).cast_mut();
                    let native_domain = match cookie_string(ptr, "domain") {
                        Ok(domain) => domain,
                        Err(error) => {
                            done(Err(error));
                            return;
                        }
                    };
                    let native_path = match cookie_string(ptr, "path") {
                        Ok(path) => path,
                        Err(error) => {
                            done(Err(error));
                            return;
                        }
                    };
                    let native_name = match cookie_string(ptr, "name") {
                        Ok(name) => name,
                        Err(error) => {
                            done(Err(error));
                            return;
                        }
                    };
                    let native_value = match cookie_string(ptr, "value") {
                        Ok(value) => value,
                        Err(error) => {
                            done(Err(error));
                            return;
                        }
                    };
                    let secure: bool = msg_send![ptr, isSecure];
                    let http_only: bool = msg_send![ptr, isHTTPOnly];
                    let same_site: *mut NSString = msg_send![ptr, sameSitePolicy];
                    let same_site_matches = match spec.same_site.as_deref() {
                        Some("Strict") | Some("Lax") if !same_site.is_null() => {
                            let expected = spec.same_site.as_deref().unwrap_or_default();
                            (&*same_site).to_string().eq_ignore_ascii_case(expected)
                        }
                        Some("Strict") | Some("Lax") => false,
                        _ => same_site.is_null(),
                    };
                    if expired(ptr)
                        || native_name != spec.name
                        || native_value != spec.value
                        || !native_domain
                            .trim_start_matches('.')
                            .eq_ignore_ascii_case(&spec.domain)
                        || native_domain.starts_with('.') == spec.host_only
                        || native_path != spec.path
                        || secure != spec.secure
                        || http_only != spec.http_only
                        || !same_site_matches
                    {
                        done(Err(
                            "native cookie differs from the validated response".into()
                        ));
                        return;
                    }
                    actions.push_back(Action::Set(cookie));
                }
            }
        }
    }
    advance(Rc::new(RefCell::new(Pending {
        store,
        actions,
        done: Some(done),
    })));
}

pub fn clear(view: tauri::webview::PlatformWebview, done: Done<()>) {
    // SAFETY: Tauri calls this entry point on the UI thread with its live platform view.
    let store = match unsafe { cookie_store(&view) } {
        Ok(store) => store,
        Err(error) => {
            done(Err(error));
            return;
        }
    };
    let pending = Rc::new(RefCell::new(Pending {
        store,
        actions: VecDeque::new(),
        done: Some(done),
    }));
    let next = pending.clone();
    let fired = Cell::new(false);
    let callback = RcBlock::new(move |cookies: *mut AnyObject| {
        if fired.replace(true) {
            return;
        }
        if cookies.is_null() {
            finish(
                &next,
                Err("WKHTTPCookieStore returned no cookie list".into()),
            );
            return;
        }
        // SAFETY: WebKit supplies a live NSArray of NSHTTPCookie objects to this UI-thread block.
        unsafe {
            let count: usize = msg_send![cookies, count];
            let mut state = next.borrow_mut();
            for index in 0..count {
                let cookie: Retained<AnyObject> = msg_send![cookies, objectAtIndex: index];
                state.actions.push_back(Action::Delete(cookie));
            }
        }
        advance(next.clone());
    });
    let store = pending.borrow().store.clone();
    // SAFETY: The retained store belongs to the supplied webview, and WebKit copies the block.
    unsafe {
        let _: () = msg_send![&*store, getAllCookies: &*callback];
    }
}
