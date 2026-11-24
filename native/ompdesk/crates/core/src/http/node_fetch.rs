//! A GET to the internet as main's Node `fetch` made it (was the global `fetch` of `src/main/model-release-dates.ts`),
//! for a request a person's network may have been set up for Node:
//! - **Trust**: Node's bundled roots (Mozilla's list, which `webpki-roots` carries from the same source) plus the
//!   certificates `NODE_EXTRA_CA_CERTS` names; the machine's store as well only when `NODE_USE_SYSTEM_CA=1` or
//!   `--use-system-ca` in `NODE_OPTIONS` asked Node for it.
//! - **Proxy**: none unless `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` in `NODE_OPTIONS`; then undici's
//!   `EnvHttpProxyAgent` rules: `https_proxy` ?? `HTTPS_PROXY` for an `https` address, else `http_proxy` ??
//!   `HTTP_PROXY`; `no_proxy` ?? `NO_PROXY` (`*` = never; an entry is a host or a domain whose subdomains it also
//!   covers, with an optional `:port`); a `CONNECT` tunnel, with Basic credentials from the proxy URL's user and
//!   password. An `https` proxy is reached over TLS with the same trust.
//! - **Request**: `fetch`'s default headers, redirects as `http.rs` follows them, `br, gzip, deflate` answers decoded.
//!
//! Node read its environment once, at start; so does this, at the first request.

use std::sync::{Arc, LazyLock};
use std::time::Instant;

use base64::Engine;
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::LOCATION;
use hyper_util::rt::TokioIo;
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, RootCertStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use url::{Host, Url};

use super::{BODY_MAX, Failure, Io, REDIRECT_MAX, Response, Target, decode, extra_roots, target};

/// The longest `CONNECT` answer head read from a proxy.
const CONNECT_HEAD_MAX: usize = 16 * 1024;

/// What Node read of its environment.
struct Settings {
    system_ca: bool,
    proxy: Option<Proxies>,
}

struct Proxies {
    http: Option<Url>,
    https: Option<Url>,
    /// `NO_PROXY` as written (`*` is never) and its entries.
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
            let excluded = self.entries.iter().any(|(entry, entry_port)| {
                (*entry_port == 0 || *entry_port == port)
                    && (host == *entry || host.ends_with(&format!(".{entry}")))
            });
            if excluded {
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

/// Node's trust: the bundled roots and `NODE_EXTRA_CA_CERTS`, the machine's store too when asked.
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

static TLS: LazyLock<Result<Arc<ClientConfig>, String>> = LazyLock::new(|| {
    client_config(
        SETTINGS.system_ca,
        extra_roots(std::env::var_os("NODE_EXTRA_CA_CERTS")),
    )
});

fn server_name(host: &Host<String>) -> Result<ServerName<'static>, Failure> {
    Ok(match host {
        Host::Domain(name) => ServerName::try_from(name.clone()).map_err(|_| Failure::Request)?,
        Host::Ipv4(address) => ServerName::from(std::net::IpAddr::V4(*address)),
        Host::Ipv6(address) => ServerName::from(std::net::IpAddr::V6(*address)),
    })
}

async fn tls_over(
    stream: Box<dyn Io>,
    host: &Host<String>,
    config: &Arc<ClientConfig>,
) -> Result<Box<dyn Io>, Failure> {
    let stream = TlsConnector::from(config.clone())
        .connect(server_name(host)?, stream)
        .await
        .map_err(|error| {
            match error
                .get_ref()
                .and_then(|inner| inner.downcast_ref::<rustls::Error>())
            {
                Some(refused) => Failure::Tls(refused.to_string()),
                None => Failure::Broken,
            }
        })?;
    Ok(Box::new(stream))
}

async fn dial(host: &Host<String>, port: u16) -> Result<Box<dyn Io>, Failure> {
    let stream = match host {
        Host::Domain(name) => TcpStream::connect((name.as_str(), port)).await,
        Host::Ipv4(address) => TcpStream::connect((*address, port)).await,
        Host::Ipv6(address) => TcpStream::connect((*address, port)).await,
    }
    .map_err(|_| Failure::Connect)?;
    let _ = stream.set_nodelay(true);
    Ok(Box::new(stream))
}

/// A tunnel to `target` through `proxy`: the proxy's own connection (TLS for an `https` proxy), then `CONNECT`.
async fn tunnel(
    target: &Target,
    proxy: &Url,
    config: &Arc<ClientConfig>,
) -> Result<Box<dyn Io>, Failure> {
    let host = proxy.host().ok_or(Failure::Request)?.to_owned();
    let port = proxy.port_or_known_default().ok_or(Failure::Request)?;
    let mut stream = dial(&host, port).await?;
    match proxy.scheme() {
        "http" => {}
        "https" => stream = tls_over(stream, &host, config).await?,
        _ => return Err(Failure::Request),
    }
    let authority = format!("{}:{}", host_text(&target.host), target.port);
    let mut head = format!("CONNECT {authority} HTTP/1.1\r\nhost: {authority}\r\n");
    if !proxy.username().is_empty() || proxy.password().is_some() {
        let decode = |text: &str| {
            percent_encoding::percent_decode_str(text)
                .decode_utf8_lossy()
                .into_owned()
        };
        let credentials = format!(
            "{}:{}",
            decode(proxy.username()),
            decode(proxy.password().unwrap_or(""))
        );
        let encoded = base64::engine::general_purpose::STANDARD.encode(credentials);
        head.push_str(&format!("proxy-authorization: Basic {encoded}\r\n"));
    }
    head.push_str("proxy-connection: keep-alive\r\n\r\n");
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|_| Failure::Connect)?;
    let mut answer = Vec::new();
    let mut byte = [0_u8; 1];
    while !answer.ends_with(b"\r\n\r\n") {
        if answer.len() >= CONNECT_HEAD_MAX
            || stream.read(&mut byte).await.map_err(|_| Failure::Connect)? == 0
        {
            return Err(Failure::Connect);
        }
        answer.push(byte[0]);
    }
    let status = answer
        .split(|byte| *byte == b' ')
        .nth(1)
        .unwrap_or_default();
    if status != b"200" {
        return Err(Failure::Connect);
    }
    Ok(stream)
}

fn host_text(host: &Host<String>) -> String {
    match host {
        Host::Ipv6(address) => format!("[{address}]"),
        host => host.to_string(),
    }
}

/// One GET of `url`, answered at its head.
async fn get_once(
    url: &Url,
    settings: &Settings,
    config: &Arc<ClientConfig>,
) -> Result<hyper::Response<Incoming>, Failure> {
    let target = target(url)?;
    let proxy = settings
        .proxy
        .as_ref()
        .and_then(|proxies| proxies.for_url(url));
    let stream = match proxy {
        Some(proxy) => tunnel(&target, proxy, config).await?,
        None => dial(&target.host, target.port).await?,
    };
    let stream = if target.tls {
        tls_over(stream, &target.host, config).await?
    } else {
        stream
    };
    let encodings = if target.tls {
        "br, gzip, deflate"
    } else {
        "gzip, deflate"
    };
    let message = hyper::Request::builder()
        .method("GET")
        .uri(target.path.as_str())
        .header("host", target.authority.as_str())
        .header("connection", "close")
        .header("accept", "*/*")
        .header("accept-language", "*")
        .header("sec-fetch-mode", "cors")
        .header("user-agent", "node")
        .header("accept-encoding", encodings)
        .body(Full::new(Bytes::new()))
        .map_err(|_| Failure::Request)?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|_| Failure::Broken)?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    sender
        .send_request(message)
        .await
        .map_err(|_| Failure::Broken)
}

async fn get_with(
    input: &str,
    settings: &Settings,
    config: &Arc<ClientConfig>,
    deadline: Instant,
) -> Result<Response, Failure> {
    let mut url = Url::parse(input).map_err(|_| Failure::Request)?;
    for _ in 0..=REDIRECT_MAX {
        let response = get_once(&url, settings, config).await?;
        let status = response.status().as_u16();
        if let Some(location) = response.headers().get(LOCATION)
            && matches!(status, 301 | 302 | 303 | 307 | 308)
        {
            url = url
                .join(&String::from_utf8_lossy(location.as_bytes()))
                .ok()
                .filter(|next| matches!(next.scheme(), "http" | "https"))
                .ok_or(Failure::Redirect)?;
            continue;
        }
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
        return Ok(Response {
            status,
            body: body.to_vec(),
        });
    }
    Err(Failure::Redirect)
}

/// A GET of `url` as Node's `fetch` made it, its answer decoded. The caller bounds the time (`tokio::time::timeout`)
/// and passes the same `deadline` for decoding.
pub(crate) async fn node_get(url: &str, deadline: Instant) -> Result<Response, Failure> {
    let config = TLS.clone().map_err(Failure::Tls)?;
    get_with(url, &SETTINGS, &config, deadline).await
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

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
        let set = [("HTTPS_PROXY", "http://proxy.test:3128")];
        assert!(env(&set).proxy.is_none());
        assert_eq!(
            proxied(
                &env(&[set[0], ("NODE_USE_ENV_PROXY", "1")]),
                "https://models.dev/catalog.json"
            ),
            Some("http://proxy.test:3128/".into())
        );
        assert_eq!(
            proxied(
                &env(&[
                    set[0],
                    ("NODE_OPTIONS", "--max-old-space-size=4096 --use-env-proxy")
                ]),
                "https://a.b/"
            ),
            Some("http://proxy.test:3128/".into())
        );
        assert!(
            env(&[set[0], ("NODE_USE_ENV_PROXY", "true")])
                .proxy
                .is_none()
        );
    }

    #[test]
    fn picks_the_proxy_as_undici_does() {
        let on = ("NODE_USE_ENV_PROXY", "1");
        // Lowercase first, even empty; https falls back to the http proxy.
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

    fn trusting(system_ca: bool) -> Arc<ClientConfig> {
        client_config(system_ca, vec![TRUSTED.der.clone()]).unwrap()
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(5)
    }

    #[tokio::test]
    async fn the_bundled_roots_refuse_what_only_an_extra_certificate_vouches_for() {
        let (port, _) = serve(Some(server_tls(&TRUSTED.issuer, &["localhost"])), |_| {
            ok("{}")
        })
        .await;
        let url = format!("https://localhost:{port}/");
        let direct = settings(&|_| None);
        let answer = get_with(&url, &direct, &trusting(false), deadline())
            .await
            .unwrap();
        assert_eq!((answer.status, answer.body), (200, b"{}".to_vec()));
        let bundled = client_config(false, Vec::new()).unwrap();
        assert!(matches!(
            get_with(&url, &direct, &bundled, deadline()).await,
            Err(Failure::Tls(_))
        ));
        let other = authority("Another CA");
        let (port, _) = serve(Some(server_tls(&other.issuer, &["localhost"])), |_| {
            ok("{}")
        })
        .await;
        let url = format!("https://localhost:{port}/");
        assert!(matches!(
            get_with(&url, &direct, &trusting(true), deadline()).await,
            Err(Failure::Tls(_))
        ));
    }

    #[tokio::test]
    async fn tunnels_through_the_proxy_with_its_credentials() {
        let (origin, seen) = serve(Some(server_tls(&TRUSTED.issuer, &["localhost"])), |_| {
            ok("{\"ok\":true}")
        })
        .await;
        let proxy = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let proxy_port = proxy.local_addr().unwrap().port();
        let connects = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let kept = connects.clone();
        tokio::spawn(async move {
            while let Ok((mut client, _)) = proxy.accept().await {
                let kept = kept.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0_u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        if client.read(&mut byte).await.unwrap() == 0 {
                            return;
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
                });
            }
        });
        let through = env(&[
            ("NODE_USE_ENV_PROXY", "1"),
            (
                "HTTPS_PROXY",
                &format!("http://us%40er:p%3Ass@127.0.0.1:{proxy_port}"),
            ),
        ]);
        let url = format!("https://localhost:{origin}/catalog.json");
        let answer = get_with(&url, &through, &trusting(false), deadline())
            .await
            .unwrap();
        assert_eq!(
            (answer.status, answer.body),
            (200, b"{\"ok\":true}".to_vec())
        );
        let connect = connects.lock().unwrap()[0].clone();
        assert!(
            connect.starts_with(&format!("CONNECT localhost:{origin} HTTP/1.1\r\n")),
            "{connect}"
        );
        let expected = base64::engine::general_purpose::STANDARD.encode("us@er:p:ss");
        assert!(
            connect.contains(&format!("proxy-authorization: Basic {expected}\r\n")),
            "{connect}"
        );
        let request = String::from_utf8_lossy(&seen.lock().unwrap()[0]).to_lowercase();
        assert!(
            request.contains("accept-encoding: br, gzip, deflate\r\n"),
            "{request}"
        );
        assert!(request.contains("user-agent: node\r\n"), "{request}");
        // A proxy that refuses the tunnel is a failed connect.
        let refusing = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let refusing_port = refusing.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut client, _)) = refusing.accept().await {
                let mut buffer = [0_u8; 1024];
                let _ = client.read(&mut buffer).await;
                let _ = client
                    .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                    .await;
            }
        });
        let refused = env(&[
            ("NODE_USE_ENV_PROXY", "1"),
            ("HTTPS_PROXY", &format!("http://127.0.0.1:{refusing_port}")),
        ]);
        assert!(matches!(
            get_with(&url, &refused, &trusting(false), deadline()).await,
            Err(Failure::Connect)
        ));
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
