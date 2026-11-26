//! What a web page says about itself, for the link card a conversation's link shows on hover or keyboard focus (Orca's
//! link preview, `src/main/link-preview/`, MIT). `webPeek.get {url}` answers `{title, description, siteName?}`, or
//! null when the page names neither.
//!
//! The links are written by a model, so the read is `fetch_capped`'s: https only, no cookies, credentials or caller
//! headers, every DNS answer and every redirect hop (three at most) checked against loopback, private, link-local,
//! CGNAT and tailnet, unspecified, multicast and special ranges and their IPv4-mapped forms, the connection made to the
//! checked address (`http::public_link`). A page is `text/html`, read for 5 s and 256 KiB at most; only its `<title>`
//! and its `og:*` and `description` meta are kept.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::http::{Past, public_link};
use crate::repo_images::{attribute, tags};
use crate::server::{Fault, Registry, Reply};

const PAGE_BYTES: usize = 256 * 1024;
/// The most a caller may ask for: a page's 512 KiB, a picture's 5 MiB.
const HTML_MAX_BYTES: usize = 512 * 1024;
const IMAGE_MAX_BYTES: usize = 5 * 1024 * 1024;
const PAGE_TIMEOUT: Duration = Duration::from_secs(5);
const TITLE_CHARS: usize = 300;
const DESCRIPTION_CHARS: usize = 600;
/// Where a page must declare its charset in a `<meta>` (the HTML standard's prescan reads the first 1024 bytes).
const CHARSET_PRESCAN: usize = 1024;

/// What a read accepts as the answer's `content-type`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Accepted {
    /// `text/html`, read up to the cap (a page's head is what counts) and the rest left unread.
    Html,
    /// `image/png`, `jpeg`, `gif`, `webp` or `avif`, never svg; one past the cap is refused whole.
    Image,
}

impl Accepted {
    fn admits(self, mime: &str) -> bool {
        match self {
            Accepted::Html => mime == "text/html",
            Accepted::Image => matches!(
                mime,
                "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
            ),
        }
    }
}

/// A public resource read by `fetch_capped`.
pub(crate) struct Fetched {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// One credential-free GET of a public https resource of the `accept` kind, bounded by `timeout` and `max_bytes` (at
/// most 512 KiB for a page, 5 MiB for a picture), under the module's address and redirect rules.
pub(crate) async fn fetch_capped(
    url: &str,
    accept: Accepted,
    max_bytes: usize,
    timeout: Duration,
) -> Result<Fetched, Fault> {
    let mut target = Url::parse(url).map_err(|_| Fault::new("web_peek_refused", "not a URL"))?;
    if target.scheme() != "https" {
        return Err(Fault::new("web_peek_refused", "only https is read"));
    }
    target.set_fragment(None);
    // A page keeps what it read up to its cap (its head is what counts); a picture past its cap is refused whole.
    let (past, cap) = match accept {
        Accepted::Html => (Past::Cut, max_bytes.min(HTML_MAX_BYTES)),
        Accepted::Image => (Past::Refuse, max_bytes.min(IMAGE_MAX_BYTES)),
    };
    let response = public_link(target.as_str(), cap, past, timeout)
        .await
        .map_err(|failure| Fault::new("web_peek_failed", format!("{failure:?}")))?;
    if response.status != 200 {
        return Err(Fault::new(
            "web_peek_failed",
            format!("HTTP {}", response.status),
        ));
    }
    let mime = response
        .content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !accept.admits(&mime) {
        return Err(Fault::new(
            "web_peek_refused",
            format!("not {accept:?}: {mime}"),
        ));
    }
    Ok(Fetched {
        content_type: response.content_type,
        bytes: response.body,
    })
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Peek {
    title: Option<String>,
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    site_name: Option<String>,
}

/// The charset a `content-type` value names (`text/html; charset=EUC-KR`).
fn charset_of(value: &str) -> Option<&str> {
    let at = value.to_ascii_lowercase().find("charset=")?;
    let label = value[at + "charset=".len()..]
        .trim_start_matches(['"', '\''])
        .split(|c: char| c == ';' || c == '"' || c == '\'' || c.is_whitespace())
        .next()?;
    (!label.is_empty()).then_some(label)
}

/// The page as text: the header's charset, else a `<meta charset>` or `http-equiv` one near the top, else UTF-8 (a
/// byte order mark wins over both, as in a browser).
fn decode_page(bytes: &[u8], content_type: &str) -> String {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(CHARSET_PRESCAN)]);
    let label = charset_of(content_type).map(str::to_owned).or_else(|| {
        tags(&head, "meta").into_iter().find_map(|tag| {
            attribute(tag, "charset")
                .or_else(|| attribute(tag, "content").and_then(charset_of))
                .map(str::to_owned)
        })
    });
    let encoding = label
        .and_then(|label| encoding_rs::Encoding::for_label(label.trim().as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(bytes).0.into_owned()
}

/// `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;` and numeric references; anything else stays as written.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let name = match rest[1..].find(';') {
            Some(end) if end <= 10 => Some(&rest[1..=end]),
            _ => None,
        };
        let decoded = name.and_then(|name| match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .map(|hex| u32::from_str_radix(hex, 16))
                .or_else(|| name.strip_prefix('#').map(str::parse::<u32>))
                .and_then(Result::ok)
                .and_then(char::from_u32),
        });
        match (name, decoded) {
            (Some(name), Some(decoded)) => {
                out.push(decoded);
                rest = &rest[name.len() + 2..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Entities decoded, whitespace runs made one space, at most `max` characters (the last one an ellipsis when cut);
/// None when nothing is left.
fn clean(raw: &str, max: usize) -> Option<String> {
    let text = decode_entities(raw)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= max {
        return Some(text);
    }
    let mut cut: String = text.chars().take(max - 1).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    Some(cut)
}

/// The text of the page's first `<title>`.
fn title_text(html: &str) -> Option<&str> {
    // ASCII lowercasing keeps every byte offset, so offsets found in `lower` cut `html`.
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<title") {
        let start = from + found + "<title".len();
        match lower.as_bytes().get(start) {
            Some(b'>') => {
                let end = lower[start..].find("</title")?;
                return Some(&html[start + 1..start + end]);
            }
            Some(byte) if byte.is_ascii_whitespace() => {
                let open = start + lower[start..].find('>')?;
                let end = lower[open..].find("</title")?;
                return Some(&html[open + 1..open + end]);
            }
            _ => from = start,
        }
    }
    None
}

/// `og:title` else `<title>`, `og:description` else `description`, and `og:site_name`.
fn read_peek(html: &str) -> Option<Peek> {
    let mut og_title = None;
    let mut og_description = None;
    let mut description = None;
    let mut site_name = None;
    for tag in tags(html, "meta") {
        let Some(content) = attribute(tag, "content").filter(|content| !content.trim().is_empty())
        else {
            continue;
        };
        let Some(key) = attribute(tag, "property").or_else(|| attribute(tag, "name")) else {
            continue;
        };
        let slot = match key.to_ascii_lowercase().as_str() {
            "og:title" => &mut og_title,
            "og:description" => &mut og_description,
            "description" => &mut description,
            "og:site_name" => &mut site_name,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(content);
        }
    }
    let peek = Peek {
        title: og_title
            .or_else(|| title_text(html))
            .and_then(|title| clean(title, TITLE_CHARS)),
        description: og_description
            .or(description)
            .and_then(|text| clean(text, DESCRIPTION_CHARS)),
        site_name: site_name.and_then(|name| clean(name, TITLE_CHARS)),
    };
    (peek.title.is_some() || peek.description.is_some()).then_some(peek)
}

#[derive(Deserialize)]
struct Ask {
    url: String,
}

pub fn register(registry: &mut Registry) {
    registry.add("webPeek.get", |call| {
        Box::pin(async move {
            let Ask { url } = call.params()?;
            let page = fetch_capped(&url, Accepted::Html, PAGE_BYTES, PAGE_TIMEOUT).await?;
            Reply::json(&read_peek(&decode_page(&page.bytes, &page.content_type)))
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_the_title_and_the_og_and_description_meta() {
        let html = r#"<html><head>
            <TITLE>  Plain &amp; simple
              title </TITLE>
            <meta name="twitter:title" content="Not this one">
            <meta property="og:description" content="The page&#39;s &quot;own&quot; words&#x21;">
            <meta name="description" content="Second choice">
            <META Property='og:site_name' Content='Example Site'>
            </head><body><title>A title in the body</title></body></html>"#;
        assert_eq!(
            read_peek(html),
            Some(Peek {
                title: Some("Plain & simple title".into()),
                description: Some("The page's \"own\" words!".into()),
                site_name: Some("Example Site".into()),
            })
        );
        let og = r#"<title>Fallback</title><meta property="og:title" content="Open Graph title"><meta name="description" content="Only the description">"#;
        assert_eq!(
            read_peek(og),
            Some(Peek {
                title: Some("Open Graph title".into()),
                description: Some("Only the description".into()),
                site_name: None,
            })
        );
        assert_eq!(read_peek("<meta charset=utf-8><body>nothing</body>"), None);
        assert_eq!(read_peek("<titlebar>x</titlebar>"), None);
    }

    #[test]
    fn long_text_is_cut_to_its_cap_with_an_ellipsis() {
        let long = "word ".repeat(200);
        let html = format!(r#"<title>{long}</title><meta name="description" content="{long}">"#);
        let peek = read_peek(&html).unwrap();
        let title = peek.title.unwrap();
        let description = peek.description.unwrap();
        assert!(title.chars().count() <= TITLE_CHARS);
        assert!(title.ends_with('…'));
        assert!(description.chars().count() <= DESCRIPTION_CHARS);
        assert!(description.ends_with('…'));
        assert_eq!(clean("  \n ", 10), None);
        assert_eq!(
            clean("a &bogus; &amp", 20).as_deref(),
            Some("a &bogus; &amp")
        );
    }

    #[test]
    fn a_page_is_decoded_in_the_charset_it_declares() {
        // "한" in EUC-KR.
        let declared = b"<meta charset=\"euc-kr\"><title>\xc7\xd1</title>";
        assert_eq!(
            read_peek(&decode_page(declared, "text/html"))
                .unwrap()
                .title
                .as_deref(),
            Some("한")
        );
        let header = b"<title>\xc7\xd1</title>";
        assert_eq!(
            read_peek(&decode_page(header, "text/html; charset=EUC-KR"))
                .unwrap()
                .title
                .as_deref(),
            Some("한")
        );
        assert_eq!(
            read_peek(&decode_page("<title>한</title>".as_bytes(), ""))
                .unwrap()
                .title
                .as_deref(),
            Some("한")
        );
        assert_eq!(charset_of("text/html;charset='utf-8'"), Some("utf-8"));
        assert_eq!(charset_of("text/html"), None);
    }

    #[test]
    fn only_the_asked_kinds_of_content_are_admitted() {
        assert!(Accepted::Html.admits("text/html"));
        assert!(!Accepted::Html.admits("application/xhtml+xml"));
        assert!(!Accepted::Html.admits("image/png"));
        for image in [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/avif",
        ] {
            assert!(Accepted::Image.admits(image), "{image}");
        }
        assert!(!Accepted::Image.admits("image/svg+xml"));
        assert!(!Accepted::Image.admits("text/html"));
    }

    #[tokio::test]
    async fn plain_http_and_non_urls_are_refused_before_any_connection() {
        for url in [
            "http://example.com/",
            "ftp://example.com/",
            "not a url",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://10.0.0.1/",
        ] {
            assert!(
                fetch_capped(url, Accepted::Html, PAGE_BYTES, PAGE_TIMEOUT)
                    .await
                    .is_err(),
                "{url}"
            );
        }
    }

    #[tokio::test]
    async fn a_redirect_to_loopback_is_refused_without_being_followed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket = listener.local_addr().unwrap();
        let served = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let length = stream.read(&mut request).await.unwrap();
            assert!(length > 0);
            stream
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/inside\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        // The stand-in public origin answers 302 to a loopback address; the hop is checked before it is dialed.
        let result = crate::http::fixture_request(
            socket,
            public_link(
                "http://repository-artwork-fixture.example.org/start?q=1",
                PAGE_BYTES,
                Past::Cut,
                PAGE_TIMEOUT,
            ),
        )
        .await;
        served.await.unwrap();
        assert!(matches!(result, Err(crate::http::Failure::Redirect)));
    }
}
