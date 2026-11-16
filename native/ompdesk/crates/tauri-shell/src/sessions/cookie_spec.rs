use cookie_store::{CookieDomain, CookieExpiration, CookiePath};
use url::Url;

pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub host_only: bool,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<String>,
    pub expires: Option<f64>,
    pub delete: bool,
}

pub struct Scope {
    pub name: String,
    pub domain: String,
    pub path: String,
}

/// RFC 6265bis secure-overlay admission, evaluated while the app partition's exclusive writer is held.
pub fn blocks_overlay(cookie: &Cookie, secure: &Scope) -> bool {
    if cookie.secure || cookie.name != secure.name {
        return false;
    }
    let Ok(mut target) = Url::parse(&format!("https://{}/", cookie.domain)) else {
        return true;
    };
    target.set_path(&cookie.path);
    let Ok(origin) = Url::parse(&format!("https://{}/", secure.domain)) else {
        return true;
    };
    let domains_overlap = matches(&secure.domain, false, "/", false, &target)
        || matches(&cookie.domain, false, "/", false, &origin);
    domains_overlap && CookiePath::parse(&secure.path).is_some_and(|path| path.matches(&target))
}
fn secure_source(url: &Url) -> bool {
    url.scheme() == "https"
        || match url.host() {
            Some(url::Host::Domain(host)) => host == "localhost",
            Some(url::Host::Ipv4(host)) => host.is_loopback(),
            Some(url::Host::Ipv6(host)) => host.is_loopback(),
            None => false,
        }
}

pub fn normalize(url: &Url, header: &str) -> Option<Cookie> {
    if !matches!(url.scheme(), "http" | "https")
        || header
            .bytes()
            .any(|byte| byte < 0x20 && byte != b'\t' || byte == 0x7f)
    {
        return None;
    }
    let parsed = cookie_store::Cookie::parse(header, url).ok()?;
    let secure = parsed.secure().unwrap_or(false);
    let http_only = parsed.http_only().unwrap_or(false);
    let same_site = parsed.same_site().map(|site| site.to_string());
    let has_domain_attribute = header.split(';').skip(1).any(|attribute| {
        attribute
            .split('=')
            .next()
            .is_some_and(|name| name.trim().eq_ignore_ascii_case("domain"))
    });
    if (secure && !secure_source(url))
        || (same_site.as_deref() == Some("None") && !secure)
        || (parsed.name().starts_with("__Secure-") && !secure)
        || (parsed.name().starts_with("__Http-") && (!secure || !http_only))
        || (parsed.name().starts_with("__Host-")
            && (!secure || has_domain_attribute || parsed.path() != Some("/")))
        || (parsed.name().starts_with("__Host-Http-") && !http_only)
    {
        return None;
    }
    let (domain, host_only) = match &parsed.domain {
        CookieDomain::HostOnly(domain) => (domain.as_str(), true),
        CookieDomain::Suffix(domain) => {
            if psl::suffix(domain.as_bytes())
                .is_some_and(|suffix| suffix.is_known() && suffix.as_bytes() == domain.as_bytes())
            {
                if url.host_str() != Some(domain.as_str()) {
                    return None;
                }
                (domain.as_str(), true)
            } else {
                (domain.as_str(), false)
            }
        }
        CookieDomain::Empty | CookieDomain::NotPresent => return None,
    };
    let expires = match &parsed.expires {
        CookieExpiration::AtUtc(time) => Some(time.unix_timestamp_nanos() as f64 / 1_000_000_000.0),
        CookieExpiration::SessionEnd => None,
    };
    Some(Cookie {
        name: parsed.name().to_owned(),
        value: parsed.value().to_owned(),
        domain: domain.to_owned(),
        path: parsed.path.as_ref().to_owned(),
        host_only,
        secure,
        http_only,
        same_site,
        expires,
        delete: parsed.is_expired(),
    })
}

pub fn matches(domain: &str, host_only: bool, path: &str, secure: bool, url: &Url) -> bool {
    let domain = if host_only {
        CookieDomain::HostOnly(domain.to_owned())
    } else {
        CookieDomain::Suffix(domain.to_owned())
    };
    domain.matches(url)
        && CookiePath::parse(path).is_some_and(|path| path.matches(url))
        && (!secure || secure_source(url))
}
#[cfg(test)]
mod tests {
    use super::{Scope, blocks_overlay, matches, normalize};
    use url::Url;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn rejects_unrelated_and_public_suffix_domains() {
        let source = url("https://evil.example/foo");
        assert!(normalize(&source, "a=b; Domain=github.com").is_none());
        assert!(normalize(&url("https://a.github.io/"), "a=b; Domain=github.io").is_none());
        let cookie = normalize(&url("https://github.io/"), "a=b; Domain=github.io").unwrap();
        assert!(cookie.host_only);
    }

    #[test]
    fn protects_prefixes_and_secure_sources() {
        let https = url("https://example.com/");
        for header in [
            "__Secure-a=b",
            "__Host-a=b; Secure",
            "__Host-a=b; Secure; Path=/; Domain=example.com",
            "__Http-a=b; Secure",
            "__Host-a=b; Secure; Path=/; Domain=",
            "__Host-Http-a=b; Secure; Path=/",
            "a=b; SameSite=None",
        ] {
            assert!(normalize(&https, header).is_none());
        }
        assert!(normalize(&url("http://example.com/"), "a=b; Secure").is_none());
        let cookie = normalize(
            &https,
            "__Host-Http-a=b; Secure; HttpOnly; Path=/; SameSite=None",
        )
        .unwrap();
        assert!(cookie.secure && cookie.http_only && cookie.host_only);
        assert_eq!(cookie.same_site.as_deref(), Some("None"));
    }

    #[test]
    fn preserves_host_path_and_expiration() {
        let source = url("https://example.com/a/page");
        let cookie = normalize(&source, "a=b; HttpOnly").unwrap();
        assert_eq!(cookie.domain, "example.com");
        assert_eq!(cookie.path, "/a");
        assert!(cookie.host_only && cookie.http_only && !cookie.delete);
        assert!(cookie.expires.is_none());
        assert!(matches(
            &cookie.domain,
            cookie.host_only,
            &cookie.path,
            false,
            &url("https://example.com/a/next")
        ));
        assert!(!matches(
            &cookie.domain,
            cookie.host_only,
            &cookie.path,
            false,
            &url("https://sub.example.com/a/next")
        ));
        assert!(!matches(
            &cookie.domain,
            cookie.host_only,
            &cookie.path,
            false,
            &url("https://example.com/abc")
        ));
        let expired = normalize(
            &source,
            "a=b; Max-Age=0; Expires=Wed, 09 Jun 2099 10:18:14 GMT",
        )
        .unwrap();
        assert!(expired.delete && expired.expires.is_some());
        let live = normalize(
            &source,
            "a=b; Max-Age=3600; Expires=Wed, 09 Jun 1999 10:18:14 GMT",
        )
        .unwrap();
        assert!(!live.delete && live.expires.is_some());
    }

    #[test]
    fn plaintext_cookies_cannot_overlay_secure_scope() {
        let scope = Scope {
            name: "sid".into(),
            domain: "example.com".into(),
            path: "/login".into(),
        };
        let blocked = normalize(
            &url("http://sub.example.com/login/page"),
            "sid=changed; Path=/login/next",
        )
        .unwrap();
        assert!(blocks_overlay(&blocked, &scope));
        let other_path = normalize(&url("http://example.com/"), "sid=other; Path=/").unwrap();
        assert!(!blocks_overlay(&other_path, &scope));
        let other_name =
            normalize(&url("http://example.com/login"), "other=value; Path=/login").unwrap();
        assert!(!blocks_overlay(&other_name, &scope));
        let secure = normalize(
            &url("https://example.com/login"),
            "sid=new; Secure; Path=/login",
        )
        .unwrap();
        assert!(!blocks_overlay(&secure, &scope));
    }

    #[test]
    fn preserves_local_and_ip_host_only_cookies() {
        for source in ["http://localhost/", "http://127.0.0.1/", "http://[::1]/"] {
            let source = url(source);
            let cookie = normalize(&source, "a=b").unwrap();
            assert!(cookie.host_only);
            assert!(matches(&cookie.domain, true, &cookie.path, false, &source));
        }
    }
}
