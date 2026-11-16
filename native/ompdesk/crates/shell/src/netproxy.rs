//! A session's own proxy (Electron's `session.setProxy`) as the native `net.*` transports apply it: the pure
//! parsing of Chromium's `proxyRules` / `proxyBypassRules` and the choice of a route for one URL. The OS transports
//! (WinHTTP, CFNetwork) do the connecting; they ask `ProxyRules::route` per hop, so a redirect to another host is
//! routed again. `cargo test` covers this part.
//!
//! Not carried over: a fallback list's later entries (the first entry of `a,b` is the route), SOCKS or HTTPS proxy
//! entries (refused, not silently sent direct), PAC scripts, and CIDR bypass rules.

use serde_json::Value;

/// One proxy server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

/// Which proxy a session's requests go through.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ProxyMode {
    /// The OS settings (system proxy, PAC, auto-detection): a session nobody called `setProxy` on.
    #[default]
    System,
    /// `mode: "direct"`.
    Direct,
    /// `mode: "fixed_servers"`.
    Fixed(ProxyRules),
}

/// `proxyRules` and `proxyBypassRules` of `mode: "fixed_servers"`. A scheme without an endpoint goes direct.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProxyRules {
    http: Option<Endpoint>,
    https: Option<Endpoint>,
    bypass: Vec<String>,
}

/// `session.setProxy`'s config (`None`: it was never called) as a mode, or the reason this transport cannot apply it.
pub fn parse_proxy(config: Option<&Value>) -> Result<ProxyMode, String> {
    let Some(config) = config else {
        return Ok(ProxyMode::System);
    };
    match config
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("system")
    {
        "system" | "auto_detect" => Ok(ProxyMode::System),
        "direct" => Ok(ProxyMode::Direct),
        "fixed_servers" => {
            let rules = config
                .get("proxyRules")
                .and_then(Value::as_str)
                .ok_or("a fixed_servers proxy has no proxyRules")?;
            let bypass = config
                .get("proxyBypassRules")
                .and_then(Value::as_str)
                .unwrap_or("");
            Ok(ProxyMode::Fixed(ProxyRules::parse(rules, bypass)?))
        }
        other => Err(format!(
            "the system HTTP transport cannot apply the proxy mode \"{other}\""
        )),
    }
}

impl ProxyRules {
    /// Chromium's grammar: `<list>` for every scheme, or `<scheme>=<list>` entries separated by `;` or spaces; a list
    /// is `[<proxy-scheme>://]host[:port]` entries separated by `,`, and `direct://` is a route that skips the proxy.
    pub fn parse(rules: &str, bypass: &str) -> Result<Self, String> {
        let mut parsed = Self {
            bypass: bypass
                .split([',', ';'])
                .map(str::trim)
                .filter(|rule| !rule.is_empty())
                .map(str::to_owned)
                .collect(),
            ..Self::default()
        };
        for part in rules.split(|c: char| c == ';' || c.is_whitespace()) {
            if part.is_empty() {
                continue;
            }
            let (scheme, list) = match part.split_once('=') {
                Some((scheme, list)) => (scheme.to_ascii_lowercase(), list),
                None => ("*".to_string(), part),
            };
            let route = list
                .split(',')
                .map(str::trim)
                .find(|entry| !entry.is_empty())
                .ok_or_else(|| format!("the proxy rule \"{part}\" lists no server"))?;
            let route = endpoint(route)?;
            match scheme.as_str() {
                "http" => parsed.http = route,
                "https" => parsed.https = route,
                "*" => {
                    parsed.http = route.clone();
                    parsed.https = route;
                }
                _ => {}
            }
        }
        Ok(parsed)
    }

    /// The server a request of this URL scheme goes through, before the bypass list.
    pub fn server(&self, scheme: &str) -> Option<&Endpoint> {
        match scheme {
            "http" => self.http.as_ref(),
            "https" => self.https.as_ref(),
            _ => None,
        }
    }

    /// The route of one request: `None` goes direct (no server for the scheme, or the host is bypassed).
    pub fn route(&self, scheme: &str, host: &str, port: u16) -> Option<&Endpoint> {
        let server = self.server(scheme)?;
        if self.bypassed(scheme, host, port) {
            None
        } else {
            Some(server)
        }
    }

    /// Chromium's bypass rules for one request. Loopback (`localhost`, `127/8`, `::1`) bypasses by default, as it does
    /// in Chromium, until `<-loopback>` removes that; `<local>` is a name without a dot; `[scheme://]pattern[:port]`
    /// matches the host with `*` as a wildcard, and a leading `.` means any subdomain.
    pub fn bypassed(&self, scheme: &str, host: &str, port: u16) -> bool {
        let host = host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_ascii_lowercase();
        let loopback = is_loopback(&host);
        if loopback && !self.has("<-loopback>") {
            return true;
        }
        self.bypass.iter().any(|rule| {
            let rule = rule.to_ascii_lowercase();
            match rule.as_str() {
                "<local>" => (!host.contains('.') && !host.contains(':')) || loopback,
                "<loopback>" => loopback,
                "<-loopback>" => false,
                _ => rule_matches(&rule, scheme, &host, port),
            }
        })
    }

    fn has(&self, token: &str) -> bool {
        self.bypass
            .iter()
            .any(|rule| rule.eq_ignore_ascii_case(token))
    }
}

impl Endpoint {
    /// `host:port`, an IPv6 address in brackets: what an OS proxy setting takes.
    pub fn authority(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// `None` for `direct://`, else the server of `[http://]host[:port]` (HTTP proxies listen on 80 unless told).
fn endpoint(entry: &str) -> Result<Option<Endpoint>, String> {
    let (scheme, rest) = match entry.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        None => ("http".to_string(), entry),
    };
    match scheme.as_str() {
        "direct" => return Ok(None),
        "http" => {}
        other => {
            return Err(format!(
                "the system HTTP transport cannot use a \"{other}\" proxy server"
            ));
        }
    }
    let rest = rest.trim_end_matches('/');
    let (host, port) = if let Some(inner) = rest.strip_prefix('[') {
        let (host, after) = inner
            .split_once(']')
            .ok_or_else(|| format!("the proxy server \"{entry}\" has an unclosed bracket"))?;
        (host, after.strip_prefix(':'))
    } else {
        match rest.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (rest, None),
        }
    };
    if host.is_empty() {
        return Err(format!("the proxy server \"{entry}\" has no host"));
    }
    let port = match port {
        Some(port) => port
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or_else(|| format!("the proxy server \"{entry}\" has an invalid port"))?,
        None => 80,
    };
    Ok(Some(Endpoint {
        host: host.to_string(),
        port,
    }))
}

fn is_loopback(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

/// `[scheme://]pattern[:port]`, lowercase.
fn rule_matches(rule: &str, scheme: &str, host: &str, port: u16) -> bool {
    let rest = match rule.split_once("://") {
        Some((rule_scheme, rest)) => {
            if rule_scheme != scheme {
                return false;
            }
            rest
        }
        None => rule,
    };
    let (pattern, rule_port) = match rest.rsplit_once(':') {
        // Only a trailing decimal port is one: an IPv6 literal in a rule is written in brackets.
        Some((pattern, rule_port))
            if !rule_port.is_empty() && rule_port.bytes().all(|b| b.is_ascii_digit()) =>
        {
            match rule_port.parse::<u16>() {
                Ok(number) => (pattern, Some(number)),
                Err(_) => return false,
            }
        }
        _ => (rest, None),
    };
    if rule_port.is_some_and(|number| number != port) {
        return false;
    }
    let pattern = pattern.trim_start_matches('[').trim_end_matches(']');
    if let Some(suffix) = pattern.strip_prefix('.') {
        return host.ends_with(&format!(".{suffix}"));
    }
    crate::proxy_rules::glob(pattern, host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixed(rules: &str, bypass: &str) -> ProxyRules {
        ProxyRules::parse(rules, bypass).unwrap()
    }

    fn endpoint_of(host: &str, port: u16) -> Endpoint {
        Endpoint {
            host: host.into(),
            port,
        }
    }

    #[test]
    fn a_session_nobody_set_a_proxy_on_uses_the_system_settings() {
        assert_eq!(parse_proxy(None), Ok(ProxyMode::System));
        assert_eq!(
            parse_proxy(Some(&json!({"mode": "system"}))),
            Ok(ProxyMode::System)
        );
        assert_eq!(
            parse_proxy(Some(&json!({"mode": "direct"}))),
            Ok(ProxyMode::Direct)
        );
        assert!(parse_proxy(Some(&json!({"mode": "pac_script", "pacScript": "x"}))).is_err());
        assert!(parse_proxy(Some(&json!({"mode": "fixed_servers"}))).is_err());
    }

    #[test]
    fn a_single_server_serves_every_scheme_and_per_scheme_rules_serve_their_own() {
        let one = fixed("127.0.0.1:8080", "");
        assert_eq!(one.server("http"), Some(&endpoint_of("127.0.0.1", 8080)));
        assert_eq!(one.server("https"), Some(&endpoint_of("127.0.0.1", 8080)));
        let per_scheme = fixed("http=127.0.0.1:1234;https=http://secure.corp:3128", "");
        assert_eq!(
            per_scheme.server("http"),
            Some(&endpoint_of("127.0.0.1", 1234))
        );
        assert_eq!(
            per_scheme.server("https"),
            Some(&endpoint_of("secure.corp", 3128))
        );
        let only_http = fixed("http=proxy.corp", "");
        assert_eq!(
            only_http.server("http"),
            Some(&endpoint_of("proxy.corp", 80))
        );
        assert_eq!(only_http.server("https"), None);
        assert_eq!(
            per_scheme.server("https").unwrap().authority(),
            "secure.corp:3128"
        );
    }

    #[test]
    fn a_fallback_list_routes_through_its_first_entry_and_direct_skips_the_proxy() {
        assert_eq!(
            fixed("a.corp:1,b.corp:2", "").server("http"),
            Some(&endpoint_of("a.corp", 1))
        );
        let direct = fixed("direct://", "");
        assert_eq!(direct.server("http"), None);
        assert_eq!(direct.server("https"), None);
    }

    #[test]
    fn a_proxy_the_os_transport_cannot_use_is_refused() {
        assert!(ProxyRules::parse("socks5://127.0.0.1:1080", "").is_err());
        assert!(ProxyRules::parse("https://secure.corp:443", "").is_err());
        assert!(ProxyRules::parse("proxy.corp:notaport", "").is_err());
        assert!(ProxyRules::parse("http=", "").is_err());
    }

    #[test]
    fn bracketed_ipv6_servers_keep_their_port() {
        let rules = fixed("[::1]:3128", "");
        assert_eq!(rules.server("http"), Some(&endpoint_of("::1", 3128)));
        assert_eq!(rules.server("http").unwrap().authority(), "[::1]:3128");
    }

    #[test]
    fn loopback_bypasses_until_the_rule_that_removes_that() {
        let rules = fixed("proxy.corp:80", "");
        assert_eq!(rules.route("http", "localhost", 80), None);
        assert_eq!(rules.route("http", "127.0.0.1", 8080), None);
        assert_eq!(rules.route("http", "[::1]", 8080), None);
        assert!(rules.route("http", "example.com", 80).is_some());
        let through = fixed("proxy.corp:80", "<-loopback>");
        assert!(through.route("http", "127.0.0.1", 8080).is_some());
    }

    #[test]
    fn bypass_rules_match_names_suffixes_wildcards_schemes_and_ports() {
        let rules = fixed(
            "proxy.corp:80",
            "<local>, .intranet.corp; build-*; *.lan; https://secure.corp; slow.corp:8080",
        );
        assert!(rules.bypassed("http", "printer", 80));
        assert!(!rules.bypassed("http", "example.com", 80));
        assert!(rules.bypassed("http", "wiki.intranet.corp", 80));
        assert!(!rules.bypassed("http", "intranet.corp", 80));
        assert!(rules.bypassed("http", "build-7", 80));
        assert!(rules.bypassed("http", "nas.lan", 80));
        assert!(rules.bypassed("https", "secure.corp", 443));
        assert!(!rules.bypassed("http", "secure.corp", 80));
        assert!(rules.bypassed("http", "slow.corp", 8080));
        assert!(!rules.bypassed("http", "slow.corp", 80));
    }
}
