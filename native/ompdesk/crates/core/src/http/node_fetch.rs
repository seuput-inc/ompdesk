//! A GET to the internet as main's Node `fetch` made it (was the global `fetch` of `src/main/model-release-dates.ts`),
//! for a request a person's network may have been set up for Node. This module only decides what Node decided; the
//! request goes through `http.rs` (its proxy tunnel, redirects and bounds):
//! - **Trust**: Node's bundled roots (Mozilla's list, which `webpki-roots` carries from the same source) plus the
//!   certificates `NODE_EXTRA_CA_CERTS` names; the machine's store only when `NODE_USE_SYSTEM_CA=1` or
//!   `--use-system-ca` in `NODE_OPTIONS` asked Node for it. An `https` proxy is reached with the same trust.
//! - **Proxy**: none unless `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` in `NODE_OPTIONS`; then undici's
//!   `EnvHttpProxyAgent` picks it: `https_proxy` ?? `HTTPS_PROXY` for an `https` address, falling back to the `http`
//!   one, `http_proxy` ?? `HTTP_PROXY` for an `http` address; `no_proxy` ?? `NO_PROXY` exempts a host (`*`: every host;
//!   an entry is a host or a domain whose subdomains it also covers, with an optional `:port`). The proxy URL's user
//!   and password go as `Basic` credentials (`http.rs`). Picked for the address asked; a redirect keeps that pick.
//! - **Request**: `fetch`'s default headers and its `accept-encoding`, the answer decoded (`decode.rs`).
//!
//! Node read its environment once, at start; so does this, at the first request.

use std::sync::{Arc, LazyLock};
use std::time::Instant;

use http_body_util::{BodyExt, LengthLimitError, Limited};
use rustls::pki_types::CertificateDer;
use rustls::{ClientConfig, RootCertStore};
use url::{Host, Url};

use super::{BODY_MAX, Failure, Request, Response, Tls, decode, extra_roots, open_with};

/// What Node read of its environment.
struct Settings {
    system_ca: bool,
    proxy: Option<Proxies>,
}

struct Proxies {
    http: Option<Url>,
    https: Option<Url>,
    /// `NO_PROXY` as written (`*` is every host) and its entries.
    no_proxy: String,
    entries: Vec<(String, u16)>,
}

fn settings(var: &dyn Fn(&str) -> Option<String>) -> Settings {
    let options = var("NODE_OPTIONS").unwrap_or_default();
    let asked = |flag: &str, env: &str| {
        var(env).as_deref() == Some("1") || options.split_whitespace().any(|option| option == flag)
    };
    // `??` keeps the first variable that is set, even empty; an empty one is no proxy.
    let first = |lower: &str, upper: &str| var(lower).or_else(|| var(upper));
    let proxy_url = |value: Option<String>| {
        value
            .filter(|value| !value.is_empty())
            .and_then(|value| Url::parse(&value).ok())
    };
    let proxy = asked("--use-env-proxy", "NODE_USE_ENV_PROXY").then(|| {
        let http = proxy_url(first("http_proxy", "HTTP_PROXY"));
        let https = proxy_url(first("https_proxy", "HTTPS_PROXY")).or_else(|| http.clone());
        let no_proxy = first("no_proxy", "NO_PROXY").unwrap_or_default();
        let entries = no_proxy
            .split([',', ' ', '\t', '\n', '\r', '\u{b}', '\u{c}'])
            .filter(|entry| !entry.is_empty())
            .map(|entry| {
                let (host, port) = match entry.rsplit_once(':') {
                    Some((host, port))
                        if !host.is_empty()
                            && !port.is_empty()
                            && port.bytes().all(|byte| byte.is_ascii_digit()) =>
                    {
                        (host, port.parse().unwrap_or(0))
                    }
                    _ => (entry, 0),
                };
                let host = host
                    .strip_prefix("*.")
                    .or_else(|| host.strip_prefix('.'))
                    .unwrap_or(host);
                (host.to_lowercase(), port)
            })
            .collect();
        Proxies {
            http,
            https,
            no_proxy,
            entries,
        }
    });
    Settings {
        system_ca: asked("--use-system-ca", "NODE_USE_SYSTEM_CA"),
        proxy,
    }
}

static SETTINGS: LazyLock<Settings> = LazyLock::new(|| settings(&|name| std::env::var(name).ok()));

impl Proxies {
    /// The proxy a request to `url` goes through, if any.
    fn for_url(&self, url: &Url) -> Option<&Url> {
        // `url.host` without its port: an IPv6 address keeps its brackets.
        let host = match url.host()? {
            Host::Ipv6(address) => format!("[{address}]"),
            host => host.to_string().to_lowercase(),
        };
        let port = url.port_or_known_default().unwrap_or(0);
        if !self.entries.is_empty() {
            if self.no_proxy == "*" {
                return None;
            }
            let exempt = self.entries.iter().any(|(entry, entry_port)| {
                (*entry_port == 0 || *entry_port == port)
                    && (host == *entry || host.ends_with(&format!(".{entry}")))
            });
            if exempt {
                return None;
            }
        }
        if url.scheme() == "https" {
            self.https.as_ref()
        } else {
            self.http.as_ref()
        }
    }
}

/// Node's trust: the bundled roots and `NODE_EXTRA_CA_CERTS`, the machine's store when asked.
fn client_config(
    system_ca: bool,
    extra: Vec<CertificateDer<'static>>,
) -> Result<Arc<ClientConfig>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?;
    let config = if system_ca {
        // rustls's platform verifier takes extra roots as certificates, which Mozilla's list is not (only trust
        // anchors): asked for the machine's store, this trusts it plus `NODE_EXTRA_CA_CERTS`, where Node also kept its
        // bundled list. The machines OMPdesk runs on carry Mozilla's roots in their own store.
        let verifier = rustls_platform_verifier::Verifier::new_with_extra_roots(extra, provider)
            .map_err(|error| error.to_string())?;
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth()
    } else {
        let mut store = RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        store.add_parsable_certificates(extra);
        builder.with_root_certificates(store).with_no_client_auth()
    };
    Ok(Arc::new(config))
}

static NODE_TLS: LazyLock<Result<Arc<ClientConfig>, String>> = LazyLock::new(|| {
    client_config(
        SETTINGS.system_ca,
        extra_roots(std::env::var_os("NODE_EXTRA_CA_CERTS")),
    )
});

fn node_tls() -> Result<Arc<ClientConfig>, Failure> {
    NODE_TLS.clone().map_err(Failure::Tls)
}

async fn get_with(
    input: &str,
    settings: &Settings,
    tls: Tls,
    deadline: Instant,
) -> Result<Response, Failure> {
    let url = Url::parse(input).map_err(|_| Failure::Request)?;
    let proxy = settings
        .proxy
        .as_ref()
        .and_then(|proxies| proxies.for_url(&url))
        .map(Url::to_string);
    let encodings = if url.scheme() == "https" {
        "br, gzip, deflate"
    } else {
        "gzip, deflate"
    };
    let headers = [
        ("accept", "*/*"),
        ("accept-language", "*"),
        ("sec-fetch-mode", "cors"),
        ("user-agent", "node"),
        ("accept-encoding", encodings),
    ];
    let request = Request {
        url: input,
        headers: &headers,
        body: None,
        proxy: proxy.as_deref(),
    };
    let response = open_with(request, tls).await?;
    let status = response.status().as_u16();
    let (parts, body) = response.into_parts();
    let body = Limited::new(body, BODY_MAX)
        .collect()
        .await
        .map_err(|error| {
            if error.is::<LengthLimitError>() {
                Failure::TooLarge
            } else {
                Failure::Broken
            }
        })?;
    let body = tokio::task::spawn_blocking(move || {
        decode(&parts.headers, body.to_bytes(), BODY_MAX, deadline)
    })
    .await
    .map_err(|_| Failure::Broken)?
    .map_err(|_| Failure::Broken)?;
    Ok(Response {
        status,
        body: body.to_vec(),
    })
}

/// A GET of `url` as Node's `fetch` made it, its answer decoded. The caller bounds the time (`tokio::time::timeout`)
/// and passes the same `deadline` for decoding.
pub(crate) async fn node_get(url: &str, deadline: Instant) -> Result<Response, Failure> {
    get_with(url, &SETTINGS, node_tls, deadline).await
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use hyper::body::Bytes;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use super::*;
    use crate::http::tests::{TRUSTED, authority, ok, serve, server_tls};

    fn env(pairs: &[(&str, &str)]) -> Settings {
        let vars: HashMap<String, String> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        settings(&move |name| vars.get(name).cloned())
    }

    fn proxied(settings: &Settings, url: &str) -> Option<String> {
        settings
            .proxy
            .as_ref()?
            .for_url(&Url::parse(url).unwrap())
            .map(Url::to_string)
    }

    #[test]
    fn a_proxy_only_when_node_was_asked_for_one() {
        let set = ("HTTPS_PROXY", "http://proxy.test:3128");
        assert!(env(&[set]).proxy.is_none());
        assert_eq!(
            proxied(
                &env(&[set, ("NODE_USE_ENV_PROXY", "1")]),
                "https://models.dev/catalog.json"
            ),
            Some("http://proxy.test:3128/".into())
        );
        let options = ("NODE_OPTIONS", "--max-old-space-size=4096 --use-env-proxy");
        assert_eq!(
            proxied(&env(&[set, options]), "https://a.b/"),
            Some("http://proxy.test:3128/".into())
        );
        assert!(env(&[set, ("NODE_USE_ENV_PROXY", "true")]).proxy.is_none());
    }

    #[test]
    fn picks_the_proxy_as_undici_does() {
        let on = ("NODE_USE_ENV_PROXY", "1");
        // Lowercase first, even empty; an https address falls back to the http proxy.
        let both = env(&[
            on,
            ("https_proxy", ""),
            ("HTTPS_PROXY", "http://upper:1"),
            ("HTTP_PROXY", "http://plain:2"),
        ]);
        assert_eq!(
            proxied(&both, "https://x.y/"),
            Some("http://plain:2/".into())
        );
        assert_eq!(
            proxied(&both, "http://x.y/"),
            Some("http://plain:2/".into())
        );
        let https_only = env(&[on, ("HTTPS_PROXY", "http://secure:3")]);
        assert_eq!(proxied(&https_only, "http://x.y/"), None);
    }

    #[test]
    fn no_proxy_matches_hosts_domains_and_ports_as_undici_does() {
        let with = |no_proxy: &str| {
            env(&[
                ("NODE_USE_ENV_PROXY", "1"),
                ("HTTPS_PROXY", "http://p:1"),
                ("NO_PROXY", no_proxy),
            ])
        };
        let rules = with("example.com, .internal.test,*.corp.test localhost:8443\t[::1]");
        for (url, direct) in [
            ("https://example.com/", true),
            ("https://api.example.com/", true),
            ("https://notexample.com/", false),
            ("https://a.internal.test/", true),
            ("https://internal.test/", true),
            ("https://x.corp.test/", true),
            ("https://localhost:8443/", true),
            ("https://localhost/", false),
            ("https://[::1]/", true),
            ("https://EXAMPLE.COM/", true),
        ] {
            assert_eq!(proxied(&rules, url).is_none(), direct, "{url}");
        }
        assert!(proxied(&with("*"), "https://any.where/").is_none());
        assert!(proxied(&with(""), "https://any.where/").is_some());
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(5)
    }

    fn bundled_and_test_ca() -> Result<Arc<ClientConfig>, Failure> {
        static CONFIG: LazyLock<Arc<ClientConfig>> =
            LazyLock::new(|| client_config(false, vec![TRUSTED.der.clone()]).unwrap());
        Ok(CONFIG.clone())
    }

    fn bundled_only() -> Result<Arc<ClientConfig>, Failure> {
        static CONFIG: LazyLock<Arc<ClientConfig>> =
            LazyLock::new(|| client_config(false, Vec::new()).unwrap());
        Ok(CONFIG.clone())
    }

    fn machine_and_test_ca() -> Result<Arc<ClientConfig>, Failure> {
        static CONFIG: LazyLock<Arc<ClientConfig>> =
            LazyLock::new(|| client_config(true, vec![TRUSTED.der.clone()]).unwrap());
        Ok(CONFIG.clone())
    }

    #[tokio::test]
    async fn the_bundled_roots_refuse_what_only_an_extra_certificate_vouches_for() {
        let (port, seen) = serve(Some(server_tls(&TRUSTED.issuer, &["localhost"])), |_| {
            ok("{}")
        })
        .await;
        let url = format!("https://localhost:{port}/");
        let direct = settings(&|_| None);
        let answer = get_with(&url, &direct, bundled_and_test_ca, deadline())
            .await
            .unwrap();
        assert_eq!((answer.status, answer.body), (200, b"{}".to_vec()));
        let request = String::from_utf8_lossy(&seen.lock().unwrap()[0]).to_lowercase();
        for header in [
            "accept-encoding: br, gzip, deflate\r\n",
            "user-agent: node\r\n",
            "accept: */*\r\n",
        ] {
            assert!(request.contains(header), "{request}");
        }
        assert!(matches!(
            get_with(&url, &direct, bundled_only, deadline()).await,
            Err(Failure::Tls(_))
        ));
        let other = authority("Another CA");
        let (port, _) = serve(Some(server_tls(&other.issuer, &["localhost"])), |_| {
            ok("{}")
        })
        .await;
        let url = format!("https://localhost:{port}/");
        assert!(matches!(
            get_with(&url, &direct, machine_and_test_ca, deadline()).await,
            Err(Failure::Tls(_))
        ));
    }

    #[tokio::test]
    async fn the_picked_proxy_carries_the_request_with_its_credentials() {
        let (origin, _) = serve(
            Some(server_tls(&TRUSTED.issuer, &["upstream.test"])),
            |_| ok("{\"ok\":true}"),
        )
        .await;
        let proxy = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_port = proxy.local_addr().unwrap().port();
        let heads = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let kept = heads.clone();
        tokio::spawn(async move {
            while let Ok((mut client, _)) = proxy.accept().await {
                let mut head = Vec::new();
                let mut byte = [0_u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if client.read(&mut byte).await.unwrap() == 0 {
                        break;
                    }
                    head.push(byte[0]);
                }
                kept.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&head).into_owned());
                let mut upstream = TcpStream::connect(("127.0.0.1", origin)).await.unwrap();
                client
                    .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                    .await
                    .unwrap();
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            }
        });
        let through = env(&[
            ("NODE_USE_ENV_PROXY", "1"),
            (
                "HTTPS_PROXY",
                &format!("http://us%40er:p%3Ass@127.0.0.1:{proxy_port}"),
            ),
            ("NO_PROXY", "elsewhere.test"),
        ]);
        let answer = get_with(
            "https://upstream.test/catalog.json",
            &through,
            bundled_and_test_ca,
            deadline(),
        )
        .await
        .unwrap();
        assert_eq!(
            (answer.status, answer.body),
            (200, b"{\"ok\":true}".to_vec())
        );
        let head = heads.lock().unwrap()[0].clone();
        assert!(
            head.starts_with("CONNECT upstream.test:443 HTTP/1.1\r\n"),
            "{head}"
        );
        assert!(
            head.contains("proxy-authorization: Basic dXNAZXI6cDpzcw==\r\n"),
            "{head}"
        );
    }

    #[test]
    fn a_gzip_answer_is_decoded() {
        use std::io::Write;
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gzip.write_all(b"{\"ok\":true}").unwrap();
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            hyper::header::CONTENT_ENCODING,
            hyper::header::HeaderValue::from_static("gzip"),
        );
        let body = decode(
            &headers,
            Bytes::from(gzip.finish().unwrap()),
            1024,
            deadline(),
        )
        .unwrap();
        assert_eq!(&body[..], b"{\"ok\":true}");
    }
}
