use std::fmt::Write as _;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const MAX_HEAD: usize = 32 * 1024;
const MAX_BODY: usize = 1024 * 1024;
const BAD_REQUEST: Rejection = Rejection {
    status: 400,
    reason: "Bad Request",
};

#[derive(Debug)]
pub(super) struct Request {
    pub method: String,
    pub target: String,
    pub host: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub(super) struct Rejection {
    pub status: u16,
    pub reason: &'static str,
}

fn token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

fn value(s: &str) -> bool {
    s.bytes().all(|b| b == b'\t' || (b >= 32 && b != 127))
}

fn decimal(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn nominated(headers: &[(String, String)], name: &str) -> bool {
    headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case("connection"))
        .flat_map(|(_, value)| value.split(','))
        .any(|item| item.trim().eq_ignore_ascii_case(name))
}

fn request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept"
            | "accept-charset"
            | "accept-encoding"
            | "accept-language"
            | "cache-control"
            | "pragma"
            | "range"
            | "if-range"
            | "if-match"
            | "if-none-match"
            | "if-modified-since"
            | "if-unmodified-since"
            | "content-type"
            | "content-encoding"
            | "content-language"
            | "content-range"
            | "user-agent"
    )
}

pub(super) async fn read_request<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Request, Rejection> {
    let mut bytes = Vec::with_capacity(4096);
    let mut scratch = [0_u8; 4096];
    let (end, method, target, host, headers, length) = loop {
        let mut slots = [httparse::EMPTY_HEADER; 128];
        let mut parsed = httparse::Request::new(&mut slots);
        match parsed.parse(&bytes) {
            Ok(httparse::Status::Complete(end)) => {
                if end > MAX_HEAD || !matches!(parsed.version, Some(0 | 1)) {
                    return Err(BAD_REQUEST);
                }
                let method = parsed.method.ok_or(BAD_REQUEST)?.to_owned();
                let target = parsed.path.ok_or(BAD_REQUEST)?.to_owned();
                if !token(&method)
                    || method.eq_ignore_ascii_case("CONNECT")
                    || !target.starts_with('/')
                    || target.starts_with("//")
                    || target
                        .bytes()
                        .any(|b| b <= 32 || b == 127 || b == b'#' || b == b'\\')
                {
                    return Err(BAD_REQUEST);
                }
                let mut host = None;
                let mut length = None;
                let mut raw = Vec::with_capacity(parsed.headers.len());
                for header in parsed.headers.iter() {
                    let text = std::str::from_utf8(header.value).map_err(|_| BAD_REQUEST)?;
                    if !token(header.name) || !value(text) {
                        return Err(BAD_REQUEST);
                    }
                    if header.name.eq_ignore_ascii_case("host") {
                        if host.replace(text.to_owned()).is_some() || text.is_empty() {
                            return Err(BAD_REQUEST);
                        }
                    } else if header.name.eq_ignore_ascii_case("content-length") {
                        if length.is_some() {
                            return Err(BAD_REQUEST);
                        }
                        length = Some(decimal(text).ok_or(BAD_REQUEST)?);
                    } else if header.name.eq_ignore_ascii_case("transfer-encoding")
                        || header.name.eq_ignore_ascii_case("expect")
                    {
                        return Err(BAD_REQUEST);
                    }
                    raw.push((header.name.to_owned(), text.to_owned()));
                }
                let host = host.ok_or(BAD_REQUEST)?;
                let length = length.unwrap_or(0);
                if length > MAX_BODY as u64 {
                    return Err(Rejection {
                        status: 413,
                        reason: "Payload Too Large",
                    });
                }
                let headers = raw
                    .iter()
                    .filter(|(name, _)| request_header(name) && !nominated(&raw, name))
                    .cloned()
                    .collect();
                break (end, method, target, host, headers, length as usize);
            }
            Ok(httparse::Status::Partial) => {}
            Err(httparse::Error::TooManyHeaders) => {
                return Err(Rejection {
                    status: 431,
                    reason: "Request Header Fields Too Large",
                });
            }
            Err(_) => return Err(BAD_REQUEST),
        }
        if bytes.len() >= MAX_HEAD {
            return Err(Rejection {
                status: 431,
                reason: "Request Header Fields Too Large",
            });
        }
        let limit = scratch.len().min(MAX_HEAD - bytes.len());
        let count = reader
            .read(&mut scratch[..limit])
            .await
            .map_err(|_| BAD_REQUEST)?;
        if count == 0 {
            return Err(BAD_REQUEST);
        }
        bytes.extend_from_slice(&scratch[..count]);
    };
    let available = (bytes.len() - end).min(length);
    let mut body = Vec::with_capacity(length);
    body.extend_from_slice(&bytes[end..end + available]);
    while body.len() < length {
        let limit = scratch.len().min(length - body.len());
        let count = reader
            .read(&mut scratch[..limit])
            .await
            .map_err(|_| BAD_REQUEST)?;
        if count == 0 {
            return Err(BAD_REQUEST);
        }
        body.extend_from_slice(&scratch[..count]);
    }
    Ok(Request {
        method,
        target,
        host,
        headers,
        body,
    })
}

fn hop_or_sensitive(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "connection"
            | "keep-alive"
            | "transfer-encoding"
            | "te"
            | "trailer"
            | "upgrade"
            | "cookie"
            | "cookie2"
            | "set-cookie"
            | "set-cookie2"
            | "authorization"
            | "www-authenticate"
            | "authentication-info"
            | "referrer-policy"
    ) || lower.starts_with("proxy-")
}

pub(super) async fn write_response<W: AsyncWrite + Unpin>(
    writer: &mut W,
    response: crate::sessions::protocol::Response,
    head: bool,
) -> Result<(), String> {
    let crate::sessions::protocol::Response {
        status,
        status_text,
        headers,
        mut body,
    } = response;
    if !(200..=599).contains(&status) || !value(&status_text) || !status_text.is_ascii() {
        return Err("invalid response".into());
    }
    let mut length = None;
    for (name, field) in &headers {
        if !token(name) || !value(field) {
            return Err("invalid response".into());
        }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err("invalid response".into());
            }
            length = Some(decimal(field.trim()).ok_or_else(|| "invalid response".to_owned())?);
            if nominated(&headers, name) {
                return Err("invalid response".into());
            }
        }
    }
    let no_body = head || status == 204 || status == 304;
    let mut out = String::new();
    write!(&mut out, "HTTP/1.1 {status} {status_text}\r\n")
        .map_err(|_| "invalid response".to_owned())?;
    for (name, field) in &headers {
        if hop_or_sensitive(name)
            || nominated(&headers, name)
            || (status == 204 && name.eq_ignore_ascii_case("content-length"))
        {
            continue;
        }
        write!(&mut out, "{name}: {field}\r\n").map_err(|_| "invalid response".to_owned())?;
    }
    if !no_body && length.is_none() {
        out.push_str("Transfer-Encoding: chunked\r\n");
    }
    out.push_str("Referrer-Policy: no-referrer\r\nConnection: close\r\n\r\n");
    writer
        .write_all(out.as_bytes())
        .await
        .map_err(|_| "response write failed".to_owned())?;
    writer
        .flush()
        .await
        .map_err(|_| "response write failed".to_owned())?;
    if no_body {
        return Ok(());
    }

    let mut sent = 0_u64;
    while let Some(result) = body.next().await {
        let chunk = result.map_err(|_| "response body failed".to_owned())?;
        let count = chunk.len() as u64;
        if let Some(expected) = length {
            sent = sent
                .checked_add(count)
                .ok_or_else(|| "response body length mismatch".to_owned())?;
            if sent > expected {
                return Err("response body length mismatch".into());
            }
            writer
                .write_all(chunk.as_slice())
                .await
                .map_err(|_| "response write failed".to_owned())?;
        } else if count != 0 {
            let mut prefix = [0_u8; 2 * std::mem::size_of::<usize>() + 2];
            let mut pos = prefix.len() - 2;
            prefix[pos..].copy_from_slice(b"\r\n");
            let mut n = chunk.len();
            while n != 0 {
                pos -= 1;
                prefix[pos] = b"0123456789abcdef"[n & 15];
                n >>= 4;
            }
            writer
                .write_all(&prefix[pos..])
                .await
                .map_err(|_| "response write failed".to_owned())?;
            writer
                .write_all(chunk.as_slice())
                .await
                .map_err(|_| "response write failed".to_owned())?;
            writer
                .write_all(b"\r\n")
                .await
                .map_err(|_| "response write failed".to_owned())?;
        }
        writer
            .flush()
            .await
            .map_err(|_| "response write failed".to_owned())?;
        drop(chunk);
    }
    if let Some(expected) = length {
        if sent != expected {
            return Err("response body length mismatch".into());
        }
    } else {
        writer
            .write_all(b"0\r\n\r\n")
            .await
            .map_err(|_| "response write failed".to_owned())?;
    }
    writer
        .flush()
        .await
        .map_err(|_| "response write failed".to_owned())
}

pub(super) async fn reject<W: AsyncWrite + Unpin>(
    writer: &mut W,
    rejection: &Rejection,
) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: 0\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n",
        rejection.status, rejection.reason
    );
    writer
        .write_all(response.as_bytes())
        .await
        .map_err(|_| "response write failed".to_owned())?;
    writer
        .flush()
        .await
        .map_err(|_| "response write failed".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn parse(input: &[u8]) -> Result<Request, Rejection> {
        read_request(&mut &input[..]).await
    }

    #[tokio::test]
    async fn forwards_representation_headers_only_and_reads_one_body() {
        let request = parse(b"POST /media?q=1 HTTP/1.1\r\nHost: localhost:5\r\nRange: bytes=3-\r\nIf-Range: tag\r\nCookie: secret\r\nAuthorization: secret\r\nOrigin: https://example.com\r\nSec-Fetch-Site: same-origin\r\nConnection: Accept\r\nAccept: text/html\r\nContent-Length: 3\r\n\r\nabcGET / HTTP/1.1\r\n\r\n").await.unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/media?q=1");
        assert_eq!(request.host, "localhost:5");
        assert_eq!(request.body, b"abc");
        assert_eq!(
            request.headers,
            vec![
                ("Range".into(), "bytes=3-".into()),
                ("If-Range".into(), "tag".into())
            ]
        );
    }

    #[tokio::test]
    async fn rejects_ambiguous_requests() {
        for input in [
            "GET / HTTP/1.1\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: a\r\nHost: a\r\n\r\n",
            "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
            "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 1, 1\r\n\r\nx",
            "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n",
            "POST / HTTP/1.1\r\nHost: a\r\nExpect: 100-continue\r\n\r\n",
            "GET //example.com/a HTTP/1.1\r\nHost: a\r\n\r\n",
            "CONNECT example.com:443 HTTP/1.1\r\nHost: a\r\n\r\n",
            "CONNECT / HTTP/1.1\r\nHost: a\r\n\r\n",
            "GET /a#frag HTTP/1.1\r\nHost: a\r\n\r\n",
            "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 2\r\n\r\nx",
        ] {
            assert!(parse(input.as_bytes()).await.is_err(), "accepted {input:?}");
        }
    }

    #[tokio::test]
    async fn enforces_header_and_body_limits() {
        let too_large = format!(
            "POST / HTTP/1.0\r\nHost: a\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert_eq!(parse(too_large.as_bytes()).await.unwrap_err().status, 413);
        let many = format!(
            "GET / HTTP/1.1\r\nHost: a\r\n{}\r\n",
            "X: a\r\n".repeat(128)
        );
        assert_eq!(parse(many.as_bytes()).await.unwrap_err().status, 431);
        let long = format!(
            "GET / HTTP/1.1\r\nHost: a\r\nX: {}\r\n\r\n",
            "a".repeat(MAX_HEAD)
        );
        assert_eq!(parse(long.as_bytes()).await.unwrap_err().status, 431);
    }
}
