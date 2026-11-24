//! Windows: the user's WinINET settings (a fixed proxy and its bypass list, or an auto-config / WPAD script resolved
//! through WinHTTP).

use windows_sys::Win32::Foundation::GlobalFree;
use windows_sys::Win32::Networking::WinHttp::{
    WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_AUTO_DETECT_TYPE_DHCP, WINHTTP_AUTO_DETECT_TYPE_DNS_A,
    WINHTTP_AUTOPROXY_AUTO_DETECT, WINHTTP_AUTOPROXY_CONFIG_URL, WINHTTP_AUTOPROXY_OPTIONS,
    WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WINHTTP_PROXY_INFO, WinHttpCloseHandle,
    WinHttpGetIEProxyConfigForCurrentUser, WinHttpGetProxyForUrl, WinHttpOpen,
};

use crate::rules::pac_result;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The system proxy for `url` as a PAC result.
pub fn resolve_proxy(url: &str) -> String {
    let take = |p: *mut u16| -> Option<String> {
        if p.is_null() {
            return None;
        }
        // SAFETY: WinHTTP returns NUL-terminated wide strings allocated with GlobalAlloc.
        let text = unsafe {
            let mut len = 0;
            while *p.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
        };
        // SAFETY: freeing the block WinHTTP allocated for us, once.
        unsafe { GlobalFree(p.cast()) };
        Some(text)
    };
    let mut ie = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG {
        fAutoDetect: 0,
        lpszAutoConfigUrl: std::ptr::null_mut(),
        lpszProxy: std::ptr::null_mut(),
        lpszProxyBypass: std::ptr::null_mut(),
    };
    // SAFETY: the struct is filled by the call; its strings are freed by `take` below.
    if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut ie) } == 0 {
        return "DIRECT".into();
    }
    let auto_detect = ie.fAutoDetect != 0;
    let pac_url = take(ie.lpszAutoConfigUrl);
    let rules = take(ie.lpszProxy);
    let bypass = take(ie.lpszProxyBypass);
    if auto_detect || pac_url.is_some() {
        let agent = wide("ompdesk-shell");
        // SAFETY: a throwaway WinHTTP session used for this one lookup and closed after it.
        let session = unsafe {
            WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_NO_PROXY,
                std::ptr::null(),
                std::ptr::null(),
                0,
            )
        };
        if !session.is_null() {
            let pac = pac_url.as_deref().map(wide);
            let mut options = WINHTTP_AUTOPROXY_OPTIONS {
                dwFlags: if pac.is_some() {
                    WINHTTP_AUTOPROXY_CONFIG_URL
                } else {
                    WINHTTP_AUTOPROXY_AUTO_DETECT
                },
                dwAutoDetectFlags: if pac.is_some() {
                    0
                } else {
                    WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A
                },
                lpszAutoConfigUrl: pac.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
                lpvReserved: std::ptr::null_mut(),
                dwReserved: 0,
                fAutoLogonIfChallenged: 1,
            };
            let target = wide(url);
            let mut info = WINHTTP_PROXY_INFO {
                dwAccessType: 0,
                lpszProxy: std::ptr::null_mut(),
                lpszProxyBypass: std::ptr::null_mut(),
            };
            // SAFETY: valid session, NUL-terminated URL, options and out-struct as the API requires.
            let found =
                unsafe { WinHttpGetProxyForUrl(session, target.as_ptr(), &mut options, &mut info) }
                    != 0;
            // SAFETY: closes the session opened above.
            unsafe { WinHttpCloseHandle(session) };
            if found {
                let proxy = take(info.lpszProxy);
                take(info.lpszProxyBypass);
                return pac_result(proxy.as_deref(), None, url);
            }
        }
    }
    pac_result(rules.as_deref(), bypass.as_deref(), url)
}
