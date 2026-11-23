//! Probe an engine's model list. Stock itself discovers the models after main registers a provider.
use std::fmt;
use std::io::{self, Read};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use flate2::read::{DeflateDecoder, MultiGzDecoder, ZlibDecoder};
use http_body_util::{BodyExt, LengthLimitError, Limited};
use hyper::HeaderMap;
use hyper::body::{Body, Bytes};
use hyper::header::{CONTENT_ENCODING, LOCATION};
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use tokio::time::{Instant, timeout_at};
use url::Url;

use crate::http::{self, Failure};
use crate::server::{Answer, Call, Reply};

// Ports refused by Node fetch (undici's badPortsSet), including on redirects.
const BAD_PORTS: &[u16] = &[
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
    103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
    512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
    995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
    6669, 6679, 6697, 10080,
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    base_url: String,
}

pub(super) fn handle(call: Call) -> Answer {
    Box::pin(async move {
        let params: Params = call.params()?;
        Reply::json(&probe(&params.base_url, http::BODY_MAX).await)
    })
}

// No hostname leaves this function. The HTTP request still carries the URL's original Host header.
fn destination(url: &Url) -> Option<(SocketAddr, Option<SocketAddr>)> {
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let port = url.port_or_known_default()?;
    if BAD_PORTS.binary_search(&port).is_ok() {
        return None;
    }
    let v4 = (Ipv4Addr::LOCALHOST, port).into();
    let v6 = (Ipv6Addr::LOCALHOST, port).into();
    match url.host_str()? {
        "localhost" => Some((v4, Some(v6))),
        "127.0.0.1" => Some((v4, None)),
        "[::1]" => Some((v6, None)),
        _ => None,
    }
}

async fn probe(base: &str, max_bytes: usize) -> Option<bool> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let (headers, body) = match timeout_at(deadline, fetch(base, max_bytes)).await {
        Ok(Ok(reply)) => reply,
        Ok(Err(Failure::TooLarge)) => return None,
        _ => return Some(false),
    };
    let decoded = tokio::task::spawn_blocking(move || decode(&headers, body, max_bytes, deadline));
    timeout_at(deadline, decoded).await.ok()?.ok()?
}

async fn fetch(base: &str, max_bytes: usize) -> Result<(HeaderMap, Bytes), Failure> {
    let mut url = Url::parse(&format!("{}/models", base.trim_end_matches('/')))
        .map_err(|_| Failure::Request)?;
    for _ in 0..=20 {
        let (first, fallback) = destination(&url).ok_or(Failure::Request)?;
        let sockets: &[SocketAddr] = match fallback {
            Some(second) => &[first, second],
            None => std::slice::from_ref(&first),
        };
        let response = http::get_at(&url, sockets).await?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            let location = response.headers().get(LOCATION).ok_or(Failure::Redirect)?;
            url = url
                .join(&String::from_utf8_lossy(location.as_bytes()))
                .map_err(|_| Failure::Redirect)?;
            continue;
        }
        if !response.status().is_success() {
            return Err(Failure::Request);
        }
        let (parts, body) = response.into_parts();
        if body.size_hint().lower() > max_bytes as u64 {
            return Err(Failure::TooLarge);
        }
        let body = Limited::new(body, max_bytes)
            .collect()
            .await
            .map_err(|error| {
                if error.is::<LengthLimitError>() {
                    Failure::TooLarge
                } else {
                    Failure::Broken
                }
            })?;
        return Ok((parts.headers, body.to_bytes()));
    }
    Err(Failure::Redirect)
}

#[derive(Clone, Copy, PartialEq)]
enum Coding {
    Gzip,
    Deflate,
    Brotli,
    Zstd,
    Other,
}

fn decode(
    headers: &HeaderMap,
    mut body: Bytes,
    max_bytes: usize,
    deadline: Instant,
) -> Option<bool> {
    // Fetch decodes at most five layers, in reverse order. One unknown coding leaves the entire body raw.
    let mut layers = [Coding::Other; 5];
    let mut count = 0;
    for header in headers.get_all(CONTENT_ENCODING) {
        for coding in header.to_str().unwrap_or("").split(',').map(str::trim) {
            *layers.get_mut(count)? =
                if coding.eq_ignore_ascii_case("gzip") || coding.eq_ignore_ascii_case("x-gzip") {
                    Coding::Gzip
                } else if coding.eq_ignore_ascii_case("deflate") {
                    Coding::Deflate
                } else if coding.eq_ignore_ascii_case("br") {
                    Coding::Brotli
                } else if coding.eq_ignore_ascii_case("zstd") {
                    Coding::Zstd
                } else {
                    Coding::Other
                };
            count += 1;
        }
    }
    let layers = &layers[..count];
    if !layers.contains(&Coding::Other) {
        for coding in layers.iter().rev() {
            let result = match coding {
                Coding::Gzip => expand(MultiGzDecoder::new(&body[..]), max_bytes, deadline),
                Coding::Deflate if body.first().is_some_and(|first| first & 15 == 8) => {
                    expand(ZlibDecoder::new(&body[..]), max_bytes, deadline)
                }
                Coding::Deflate => expand(DeflateDecoder::new(&body[..]), max_bytes, deadline),
                Coding::Brotli => {
                    // 0x11 is the large-window extension, not RFC 7932. Refuse before it can allocate its window.
                    if body.first() == Some(&0x11) {
                        return None;
                    }
                    expand(
                        brotli::Decompressor::new(&body[..], 4096),
                        max_bytes,
                        deadline,
                    )
                }
                Coding::Zstd => return None,
                Coding::Other => unreachable!(),
            };
            match result {
                Ok(next) => body = next?,
                Err(_) => return Some(false),
            }
        }
    }
    (Instant::now() < deadline).then(|| model_list(&body))
}

fn expand(mut reader: impl Read, max_bytes: usize, deadline: Instant) -> io::Result<Option<Bytes>> {
    let mut out = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];
    while Instant::now() < deadline {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) if n > max_bytes - out.len() => return Ok(None),
            Ok(n) => out.extend_from_slice(&chunk[..n]),
            // Node uses Z_SYNC_FLUSH at EOF; a missing gzip trailer need not invalidate complete JSON.
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error),
        }
    }
    Ok((Instant::now() < deadline).then(|| out.into()))
}

// Keep only the last `data` field as JSON.parse does, without allocating a model catalog.
struct ModelList;

impl<'de> Visitor<'de> for ModelList {
    type Value = bool;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a model list object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<bool, A::Error> {
        #[derive(Deserialize)]
        #[serde(field_identifier, rename_all = "lowercase")]
        enum Key {
            Data,
            #[serde(other)]
            Other,
        }
        let mut found = false;
        while let Some(key) = map.next_key::<Key>()? {
            let value: &RawValue = map.next_value()?;
            if matches!(key, Key::Data) {
                found = value.get().starts_with('[');
            }
        }
        Ok(found)
    }
}

fn model_list(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body.strip_prefix(b"\xef\xbb\xbf").unwrap_or(body));
    let text = crate::json::whole_surrogates(&text);
    let mut parser = serde_json::Deserializer::from_str(&text);
    matches!(parser.deserialize_map(ModelList), Ok(true)) && parser.end().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    #[test]
    fn captured_model_list_shapes() {
        for (body, expected) in [
            ("\u{feff}{\"data\":[]}", true),
            (r#"{"data":{},"data":[]}"#, true),
            (r#"{"data":[1e400,"\ud800"]}"#, true),
            (r#"{"data":"x"}"#, false),
            ("null", false),
            ("[]", false),
            ("no", false),
            (r#"{"data":[],"data":null}"#, false),
            (r#"{"d\u0061ta":[{}, null]}"#, true),
            (r#"{"data":[1,]}"#, false),
            (r#"{"data":[]} extra"#, false),
        ] {
            assert_eq!(model_list(body.as_bytes()), expected, "{body}");
        }
    }

    #[test]
    fn only_admits_the_three_canonical_loopback_hosts_before_connecting() {
        for (base, expected) in [
            ("http://127.0.0.1:8555/v1///", true),
            ("http://LOCALHOST:8555/v1", true),
            ("http://[::1]:8555/v1", true),
            ("http://127.1:8555/v1", true),
            ("http://127.0.0.2:8555/v1", false),
            ("http://localhost.:8555/v1", false),
            ("https://127.0.0.1:8555/v1", false),
            ("http://example.invalid/v1", false),
            ("http://192.168.1.5:8000/v1", false),
            ("http://127.0.0.1@outside.invalid/v1", false),
            ("http://user@localhost:8555/v1", false),
            ("http://localhost:25/v1", false),
            ("not a url", false),
        ] {
            let accepted = Url::parse(base).is_ok_and(|url| destination(&url).is_some());
            assert_eq!(accepted, expected, "{base}");
        }
    }

    #[test]
    fn localhost_is_pinned_to_numeric_sockets_without_consulting_dns() {
        let url = Url::parse("http://LOCALHOST:45678/v1").unwrap();
        assert_eq!(
            destination(&url),
            Some((
                (Ipv4Addr::LOCALHOST, 45678).into(),
                Some((Ipv6Addr::LOCALHOST, 45678).into())
            ))
        );
    }

    #[test]
    fn an_oversize_final_or_intermediate_expansion_is_inconclusive() {
        use std::io::Write;

        let gzip = |body: &[u8], name: &[u8]| {
            let mut writer = flate2::GzBuilder::new()
                .filename(name)
                .write(Vec::new(), flate2::Compression::fast());
            writer.write_all(body).unwrap();
            Bytes::from(writer.finish().unwrap())
        };
        let check = |coding: &'static str, body, max| {
            let mut headers = HeaderMap::new();
            headers.insert(
                CONTENT_ENCODING,
                hyper::header::HeaderValue::from_static(coding),
            );
            decode(&headers, body, max, Instant::now() + Duration::from_secs(2))
        };
        let mut padded = br#"{"data":[]}"#.to_vec();
        padded.resize(139, b' ');
        let packed = gzip(&padded, b"");
        assert!(packed.len() < 138);
        assert_eq!(check("gzip", packed.clone(), 139), Some(true));
        assert_eq!(check("gzip", packed, 138), None);

        let inner = gzip(br#"{"data":[]}"#, &[b'x'; 160]);
        let packed = gzip(&inner, b"");
        assert!(packed.len() < 128 && inner.len() > 128);
        assert_eq!(check("gzip, gzip", packed.clone(), inner.len()), Some(true));
        assert_eq!(check("gzip, gzip", packed, 128), None);
        assert_eq!(check("br", Bytes::from_static(b"\x11"), 128), None);
        assert_eq!(check("br,br,br,br,br,br", Bytes::new(), 128), None);
    }

    #[tokio::test]
    async fn bounds_chunked_bodies_without_trusting_content_length() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let serving = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                crate::http::tests::read_request(&mut socket).await;
                let reply = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n6\r\n{\"data\r\n5\r\n\":[]}\r\n0\r\n\r\n";
                socket.write_all(reply).await.unwrap();
            }
        });
        assert_eq!(probe(&base, 11).await, Some(true));
        assert_eq!(probe(&base, 10).await, None);
        serving.await.unwrap();
    }
}
