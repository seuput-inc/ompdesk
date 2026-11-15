//! Untrusted repository artwork never uses the trusted memory client's address/redirect policy.
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use super::{BodyExt, Failure, LOCATION, Limited, Url, exchange_at, machine_tls};

pub(crate) struct PublicResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub url: Url,
}

const REDIRECTS: usize = 3;
const MAX_BYTES: usize = 512 * 1024;
const TIMEOUT: Duration = Duration::from_secs(4);

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 168 || b == 0 || (b == 2) || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let [a, b, ..] = ip.segments();
            // Global unicast only; exclude protocol assignments, documentation and 6to4 gateways.
            (0x2000..=0x3fff).contains(&a)
                && !(a == 0x2001 && (b < 0x0200 || b == 0x0db8))
                && a != 0x2002
                && !(a == 0x3fff && b < 0x1000)
        }
    }
}

fn checked_url(input: &str) -> Result<Url, Failure> {
    let url = Url::parse(input).map_err(|_| Failure::Request)?;
    let port = match url.scheme() {
        "https" => 443,
        "http" => 80,
        _ => return Err(Failure::Request),
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(port)
        || url.query().is_some()
        || url.fragment().is_some()
        || input.len() > 2048
    {
        return Err(Failure::Request);
    }
    match url.host().ok_or(Failure::Request)? {
        url::Host::Ipv4(ip) if !public_ip(ip.into()) => return Err(Failure::Request),
        url::Host::Ipv6(ip) if !public_ip(ip.into()) => return Err(Failure::Request),
        url::Host::Domain(host) => {
            let name = host.trim_end_matches('.');
            if !name.contains('.')
                || [
                    "localhost",
                    "local",
                    "internal",
                    "invalid",
                    "test",
                    "example",
                    "onion",
                    "home.arpa",
                ]
                .iter()
                .any(|suffix| name == *suffix || name.ends_with(&format!(".{suffix}")))
            {
                return Err(Failure::Request);
            }
        }
        _ => {}
    }
    Ok(url)
}

fn checked_addresses(addresses: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, Failure> {
    if addresses.is_empty()
        || addresses.len() > 16
        || addresses.iter().any(|address| !public_ip(address.ip()))
    {
        return Err(Failure::Request);
    }
    Ok(addresses)
}

#[cfg(test)]
tokio::task_local! { static FIXTURE_SOCKET: SocketAddr; }

#[cfg(test)]
pub(crate) async fn fixture_request<F: std::future::Future>(
    socket: SocketAddr,
    future: F,
) -> F::Output {
    FIXTURE_SOCKET.scope(socket, future).await
}

async fn addresses(url: &Url) -> Result<Vec<SocketAddr>, Failure> {
    let host = url.host_str().ok_or(Failure::Request)?;
    // Only test builds can dial a local stand-in for this one synthetic public origin. Production DNS admission,
    // redirect validation and transport are unchanged; no test bypass is exported in the application.
    #[cfg(test)]
    if host == "repository-artwork-fixture.example.org" {
        if let Ok(socket) = FIXTURE_SOCKET.try_with(|socket| *socket) {
            return Ok(vec![socket]);
        }
    }
    // Validate the entire DNS answer, then connect to these exact sockets. TLS still authenticates URL.hostname.
    let resolved =
        tokio::net::lookup_host((host, url.port_or_known_default().ok_or(Failure::Request)?))
            .await
            .map_err(|_| Failure::Connect)?;
    checked_addresses(resolved.take(17).collect())
}

fn redirect(url: &Url, location: &str) -> Result<Url, Failure> {
    let mut next = url.join(location).map_err(|_| Failure::Redirect)?;
    next.set_query(None);
    next.set_fragment(None);
    if url.scheme() == "https" && next.scheme() != "https" {
        return Err(Failure::Redirect);
    }
    checked_url(next.as_str()).map_err(|_| Failure::Redirect)
}

async fn fetch(input: &str, max_bytes: usize) -> Result<PublicResponse, Failure> {
    let mut url = checked_url(input)?;
    for hop in 0..=REDIRECTS {
        let pinned = addresses(&url).await?;
        let response = exchange_at(&url, &[], None, machine_tls, Some(&pinned)).await?;
        let status = response.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            if hop == REDIRECTS {
                return Err(Failure::Redirect);
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(Failure::Redirect)?;
            url = redirect(&url, location)?;
            continue;
        }
        if response
            .headers()
            .get("content-encoding")
            .is_some_and(|value| value != "identity")
        {
            return Err(Failure::Request);
        }
        let bytes = Limited::new(response.into_body(), max_bytes.min(MAX_BYTES))
            .collect()
            .await
            .map_err(|_| Failure::TooLarge)?;
        return Ok(PublicResponse {
            status,
            body: bytes.to_bytes().to_vec(),
            url,
        });
    }
    Err(Failure::Redirect)
}

/// A credential-free, bounded public GET. No caller headers, cookies, proxies or referrer cross this boundary.
pub(crate) async fn public_get(input: &str, max_bytes: usize) -> Result<PublicResponse, Failure> {
    tokio::time::timeout(TIMEOUT, fetch(input, max_bytes))
        .await
        .map_err(|_| Failure::Connect)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_private_and_special_addresses_including_encoded_ip_literals() {
        for address in [
            "0.0.0.0",
            "10.2.3.4",
            "127.0.0.1",
            "100.100.100.200",
            "169.254.169.254",
            "172.31.0.1",
            "192.168.1.1",
            "192.0.0.8",
            "198.19.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "64:ff9b::7f00:1",
            "2001::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "3fff::1",
        ] {
            assert!(!public_ip(address.parse().unwrap()), "{address}");
        }
        for url in [
            "http://2130706433/",
            "http://0x7f000001/",
            "http://127.1/",
            "http://[::1]/",
            "http://localhost./",
            "https://metadata.google.internal/",
            "file:///logo.png",
            "https://user:secret@github.com/",
            "https://github.com:8443/",
            "https://github.com/image?token=secret",
        ] {
            assert!(checked_url(url).is_err(), "{url}");
        }
        assert!(checked_url("https://github.com/synthetic-owner.png").is_ok());
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn one_private_dns_answer_refuses_the_entire_resolution() {
        let public: SocketAddr = "1.1.1.1:443".parse().unwrap();
        let private: SocketAddr = "127.0.0.1:443".parse().unwrap();
        assert!(checked_addresses(vec![public, private]).is_err());
        assert!(checked_addresses(vec![private, public]).is_err());
        assert!(checked_addresses(Vec::new()).is_err());
        assert_eq!(checked_addresses(vec![public]).unwrap(), vec![public]);
    }

    #[test]
    fn every_redirect_rejects_private_credentials_and_downgrades() {
        let base = Url::parse("https://github.com/synthetic.png").unwrap();
        for location in [
            "http://github.com/image",
            "https://127.0.0.1/image",
            "https://[::ffff:127.0.0.1]/image",
            "https://secret@public.com/image",
            "//metadata.google.internal/image",
        ] {
            assert!(redirect(&base, location).is_err(), "{location}");
        }
        assert_eq!(
            redirect(&base, "https://avatars.githubusercontent.com/u/1?v=4#icon")
                .unwrap()
                .as_str(),
            "https://avatars.githubusercontent.com/u/1"
        );
    }

    #[tokio::test]
    async fn pinned_transport_never_resolves_the_url_hostname_again() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let served = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut input = [0; 4096];
            let size = stream.read(&mut input).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
            String::from_utf8(input[..size].to_vec()).unwrap()
        });
        // Only the private transport primitive is exercised here. public_get never admits this loopback socket.
        let response = exchange_at(
            &Url::parse("http://never-resolve.invalid/logo").unwrap(),
            &[],
            None,
            machine_tls,
            Some(&[address]),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            b"ok"
        );
        assert!(
            served
                .await
                .unwrap()
                .to_ascii_lowercase()
                .contains("host: never-resolve.invalid")
        );
    }
}
