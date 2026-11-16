//! The browser's actual partition cookie store, shared with native HTTP, not a second jar.
//! Main installs the concrete app WebView / Preview BrowserContext adapter before admitting requests.

use std::sync::{Arc, OnceLock};

/// Called off the UI and host-reader threads. Each operation waits for the actual browser store.
/// `store_response` must apply all Set-Cookie values with the response URL as their origin.
/// No method may answer success before the native/browser operation has completed.
pub trait CookieAuthority: Send + Sync {
    fn cookie_header(&self, partition: &str, url: &str) -> Result<Option<String>, String>;
    fn store_response(
        &self,
        partition: &str,
        url: &str,
        set_cookie: &[String],
    ) -> Result<(), String>;
    fn clear(&self, partition: &str) -> Result<(), String>;
}

static AUTHORITY: OnceLock<Arc<dyn CookieAuthority>> = OnceLock::new();

pub fn install_cookie_authority(authority: Arc<dyn CookieAuthority>) -> Result<(), String> {
    AUTHORITY
        .set(authority)
        .map_err(|_| "partition cookie authority is already installed".into())
}

#[derive(Default)]
pub struct NetworkPolicy {
    pub user_agent: Option<String>,
    pub accept_languages: Option<String>,
    pub deny_network: bool,
}

type PolicySource = dyn Fn(&str) -> Result<NetworkPolicy, String> + Send + Sync;
static POLICY_SOURCE: OnceLock<Box<PolicySource>> = OnceLock::new();

pub fn install_policy_source(
    source: impl Fn(&str) -> Result<NetworkPolicy, String> + Send + Sync + 'static,
) -> Result<(), String> {
    POLICY_SOURCE
        .set(Box::new(source))
        .map_err(|_| "session network policy is already installed".into())
}

pub(super) fn policy(partition: &str) -> Result<NetworkPolicy, String> {
    POLICY_SOURCE
        .get()
        .ok_or("session network policy is not initialized")?(canonical_partition(partition))
}

/// Empty and `app` identify the same persistent profile. `persist:*` is persistent;
/// every other name must route to an in-memory browser context, including private Preview.
pub fn canonical_partition(partition: &str) -> &str {
    if partition.is_empty() {
        "app"
    } else {
        partition
    }
}

fn authority() -> Result<&'static dyn CookieAuthority, String> {
    AUTHORITY
        .get()
        .map(Arc::as_ref)
        .ok_or_else(|| "partition cookie authority is not initialized".into())
}

pub(super) fn cookie_header(partition: &str, url: &str) -> Result<Option<String>, String> {
    authority()?.cookie_header(canonical_partition(partition), url)
}

pub(super) fn response_cookies(
    partition: &str,
    url: &str,
    headers: &[(String, String)],
) -> Result<(), String> {
    let cookies: Vec<String> = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("set-cookie"))
        .flat_map(|(_, value)| split_set_cookie(value).into_iter().map(str::to_owned))
        .collect();
    if cookies.is_empty() {
        return Ok(());
    }
    authority()?.store_response(canonical_partition(partition), url, &cookies)
}

/// Clears only this partition's cookies. Main also clears that browser context's other storage.
pub fn clear_cookies(partition: &str) -> Result<(), String> {
    authority()?.clear(canonical_partition(partition))
}

/// Foundation coalesces repeated Set-Cookie fields. A separator comma is followed by a
/// cookie-name and `=`, unlike the comma inside an Expires date or a quoted cookie value.
fn split_set_cookie(value: &str) -> Vec<&str> {
    let bytes = value.as_bytes();
    let mut result = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (index, &byte) in bytes.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && byte == b'\\' {
            escaped = true;
            continue;
        }
        if byte == b'"' {
            quoted = !quoted;
            continue;
        }
        if quoted || byte != b',' {
            continue;
        }
        let rest = &bytes[index + 1..];
        let name_start = rest
            .iter()
            .position(|byte| !byte.is_ascii_whitespace())
            .unwrap_or(rest.len());
        let rest = &rest[name_start..];
        let name_length = rest.iter().take_while(|&&byte| token(byte)).count();
        if name_length > 0 && rest.get(name_length) == Some(&b'=') {
            let cookie = value[start..index].trim();
            if !cookie.is_empty() {
                result.push(cookie);
            }
            start = index + 1;
        }
    }
    let cookie = value[start..].trim();
    if !cookie.is_empty() {
        result.push(cookie);
    }
    result
}

fn token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_cookies_keep_expiration_dates_and_quoted_values() {
        assert_eq!(
            split_set_cookie("a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/, b=2; Secure"),
            [
                "a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/",
                "b=2; Secure"
            ]
        );
        assert_eq!(
            split_set_cookie("a=\"value, b=not-a-cookie\"; Path=/, c=3"),
            ["a=\"value, b=not-a-cookie\"; Path=/", "c=3"]
        );
        assert_eq!(
            split_set_cookie("a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT, a=2; Path=/next"),
            [
                "a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
                "a=2; Path=/next"
            ]
        );
    }

    #[test]
    fn app_alias_does_not_merge_private_or_persistent_partitions() {
        assert_eq!(canonical_partition(""), "app");
        assert_eq!(canonical_partition("app"), "app");
        assert_eq!(canonical_partition("preview-private"), "preview-private");
        assert_eq!(canonical_partition("persist:preview"), "persist:preview");
    }
}
