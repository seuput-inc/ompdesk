//! What proxy the system would use for a URL, as Chromium's PAC result syntax: `PROXY host:port; DIRECT`,
//! `SOCKS5 host:port; DIRECT` or `DIRECT`. Windows reads the WinINET / WinHTTP settings (a fixed proxy and its
//! bypass list, or a PAC / WPAD script run through WinHTTP); macOS reads `CFNetworkCopySystemProxySettings` and runs a
//! PAC script through CFNetwork; elsewhere the answer is `DIRECT`. Blocking: a PAC script is fetched and run, so call
//! it off any thread that must stay responsive.

pub mod mac_settings;
pub mod rules;
#[cfg(any(windows, target_os = "macos"))]
mod sys;

pub fn resolve(url: &str) -> String {
    #[cfg(any(windows, target_os = "macos"))]
    {
        sys::resolve_proxy(url)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = url;
        "DIRECT".to_string()
    }
}
