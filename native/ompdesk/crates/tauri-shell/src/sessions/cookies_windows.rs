#![allow(unsafe_code)]

use std::cell::RefCell;
use std::rc::Rc;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
    COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
    ICoreWebView2, ICoreWebView2_2, ICoreWebView2_13, ICoreWebView2CookieManager,
    ICoreWebView2Profile2,
};
use webview2_com::{ClearBrowsingDataCompletedHandler, GetCookiesCompletedHandler};
use windows::core::{HSTRING, Interface, PCWSTR};

use super::cookie_spec::Cookie;
use super::native::Done;

fn error(context: &str, error: windows::core::Error) -> String {
    format!("WebView2 cookie {context} failed ({})", error.code())
}

fn webview(view: &tauri::webview::PlatformWebview) -> Result<ICoreWebView2, String> {
    // SAFETY: Tauri hands this function the live controller on the owning UI thread.
    unsafe { view.controller().CoreWebView2() }.map_err(|e| error("controller", e))
}

fn manager(view: &ICoreWebView2) -> Result<ICoreWebView2CookieManager, String> {
    let view = view
        .cast::<ICoreWebView2_2>()
        .map_err(|e| error("interface", e))?;
    // SAFETY: the live WebView2 interface is used only on its owning UI thread.
    unsafe { view.CookieManager() }.map_err(|e| error("manager", e))
}

pub fn store(view: tauri::webview::PlatformWebview, cookies: Vec<Cookie>, done: Done<()>) {
    let result = (|| {
        let manager = manager(&webview(&view)?)?;
        for cookie in cookies {
            let domain = if cookie.host_only {
                cookie.domain
            } else {
                format!(".{}", cookie.domain)
            };
            let result: windows::core::Result<()> = (|| {
                // SAFETY: fields were normalized against the originating HTTP URL before this UI-thread call.
                unsafe {
                    let native = manager.CreateCookie(
                        &HSTRING::from(cookie.name),
                        &HSTRING::from(cookie.value),
                        &HSTRING::from(domain),
                        &HSTRING::from(cookie.path),
                    )?;
                    if cookie.delete {
                        manager.DeleteCookie(&native)?;
                    } else {
                        native.SetIsSecure(cookie.secure)?;
                        native.SetIsHttpOnly(cookie.http_only)?;
                        if let Some(expires) = cookie.expires {
                            native.SetExpires(expires)?;
                        }
                        if let Some(site) = cookie.same_site {
                            let site = match site.as_str() {
                                "None" => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
                                "Strict" => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
                                _ => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
                            };
                            native.SetSameSite(site)?;
                        }
                        manager.AddOrUpdateCookie(&native)?;
                    }
                }
                Ok(())
            })();
            if let Err(e) = result {
                // HTTP ignores a cookie the browser rejects as invalid; operational COM failures are not ignored.
                if e.code().0 != 0x80070057_u32 as i32 {
                    return Err(error("write", e));
                }
            }
        }
        Ok(manager)
    })();
    let manager = match result {
        Ok(manager) => manager,
        Err(error) => return done(Err(error)),
    };
    let completion = Rc::new(RefCell::new(Some(done)));
    let output = completion.clone();
    let handler = GetCookiesCompletedHandler::create(Box::new(move |result, _cookies| {
        if let Some(done) = output.borrow_mut().take() {
            done(result.map_err(|e| error("write completion", e)));
        }
        Ok(())
    }));
    // SAFETY: GetCookies runs after the preceding cookie writes on this native manager; its callback is an
    // asynchronous browser round trip, not a UI-thread wait or a second cookie jar.
    if let Err(e) = unsafe { manager.GetCookies(PCWSTR::null(), &handler) } {
        if let Some(done) = completion.borrow_mut().take() {
            done(Err(error("write completion", e)));
        }
    }
}

pub fn clear(view: tauri::webview::PlatformWebview, done: Done<()>) {
    let profile = (|| {
        let view = webview(&view)?
            .cast::<ICoreWebView2_13>()
            .map_err(|e| error("profile interface", e))?;
        // SAFETY: the live WebView2 interface is called on its owning UI thread.
        let profile = unsafe { view.Profile() }.map_err(|e| error("profile", e))?;
        profile
            .cast::<ICoreWebView2Profile2>()
            .map_err(|e| error("clear interface", e))
    })();
    let profile = match profile {
        Ok(profile) => profile,
        Err(error) => return done(Err(error)),
    };
    let completion = Rc::new(RefCell::new(Some(done)));
    let output = completion.clone();
    let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
        if let Some(done) = output.borrow_mut().take() {
            done(result.map_err(|e| error("clear", e)));
        }
        Ok(())
    }));
    // SAFETY: the mask contains cookies only, preserving LocalStorage, IndexedDB and the HTTP cache. WebView2
    // retains the completion handler and answers only after the native profile deletion operation completes.
    if let Err(e) =
        unsafe { profile.ClearBrowsingData(COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES, &handler) }
    {
        if let Some(done) = completion.borrow_mut().take() {
            done(Err(error("start clear", e)));
        }
    }
}

pub fn secure_scopes(
    view: tauri::webview::PlatformWebview,
    done: Done<Vec<super::cookie_spec::Scope>>,
) {
    let manager = match webview(&view).and_then(|view| manager(&view)) {
        Ok(manager) => manager,
        Err(error) => return done(Err(error)),
    };
    let completion = Rc::new(RefCell::new(Some(done)));
    let output = completion.clone();
    let handler = GetCookiesCompletedHandler::create(Box::new(move |status, cookies| {
        let result = (|| {
            status.map_err(|e| error("secure scope read", e))?;
            let cookies = cookies.ok_or("WebView2 cookie list is unavailable")?;
            let mut count = 0;
            // SAFETY: WebView2 invokes the callback with a live cookie list on its UI thread.
            unsafe { cookies.Count(&mut count) }.map_err(|e| error("secure scope count", e))?;
            let mut scopes = Vec::new();
            for index in 0..count {
                // SAFETY: index is within the count returned by the same live list.
                let cookie = unsafe { cookies.GetValueAtIndex(index) }
                    .map_err(|e| error("secure scope cookie", e))?;
                let mut secure = Default::default();
                // SAFETY: output is a valid BOOL; cookie is live on this UI thread.
                unsafe { cookie.IsSecure(&mut secure) }.map_err(|e| error("secure flag", e))?;
                if !secure.as_bool() {
                    continue;
                }
                let mut name = windows::core::PWSTR::null();
                // SAFETY: the output points to a native string which take_pwstr frees after copying.
                unsafe { cookie.Name(&mut name) }.map_err(|e| error("secure scope name", e))?;
                let name = webview2_com::take_pwstr(name);
                let mut domain = windows::core::PWSTR::null();
                // SAFETY: same live cookie and allocated-string output contract.
                unsafe { cookie.Domain(&mut domain) }
                    .map_err(|e| error("secure scope domain", e))?;
                let domain = webview2_com::take_pwstr(domain);
                let mut path = windows::core::PWSTR::null();
                // SAFETY: same live cookie and allocated-string output contract.
                unsafe { cookie.Path(&mut path) }.map_err(|e| error("secure scope path", e))?;
                scopes.push(super::cookie_spec::Scope {
                    name,
                    domain: domain.trim_start_matches('.').to_string(),
                    path: webview2_com::take_pwstr(path),
                });
            }
            Ok(scopes)
        })();
        if let Some(done) = output.borrow_mut().take() {
            done(result);
        }
        Ok(())
    }));
    // SAFETY: null URL requests all unexpired cookies in this actual WebView2 partition; no UI thread is blocked.
    if let Err(e) = unsafe { manager.GetCookies(PCWSTR::null(), &handler) } {
        if let Some(done) = completion.borrow_mut().take() {
            done(Err(error("start secure scope read", e)));
        }
    }
}
