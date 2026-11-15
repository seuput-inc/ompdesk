use std::path::Path;

use serde_json::Value;
use tokio::io::AsyncReadExt;
use url::Url;

use super::{Artwork, Source, raster};

const FILES: &[&str] = &[
    ".github/logo.png",
    ".github/logo.webp",
    "logo.png",
    "logo.webp",
    "icon.png",
    "public/favicon.png",
    "public/favicon.ico",
    "public/icon.png",
    "public/apple-touch-icon.png",
    "static/favicon.png",
    "static/favicon.ico",
    "assets/logo.png",
    "app/icon.png",
    "src/app/icon.png",
    "src/app/favicon.ico",
    "favicon.png",
    "favicon.ico",
];

async fn read(root: &Path, relative: &str, limit: usize) -> Option<Vec<u8>> {
    let path = tokio::fs::canonicalize(root.join(relative)).await.ok()?;
    if !path.starts_with(root) {
        return None;
    }
    let file = tokio::fs::File::open(path).await.ok()?;
    if !file.metadata().await.ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    (bytes.len() <= limit).then_some(bytes)
}

async fn raster(bytes: Vec<u8>, source: Source) -> Option<Artwork> {
    let data_url = tokio::task::spawn_blocking(move || raster::data_url(&bytes))
        .await
        .ok()??;
    Some(Artwork { data_url, source })
}

fn external_url(value: &str) -> Option<Url> {
    let mut url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
    {
        return None;
    }
    url.set_fragment(None);
    Some(url)
}

async fn fetch_image(url: &Url, source: Source) -> Option<Artwork> {
    let response = crate::http::public_get(url.as_str(), raster::INPUT_BYTES)
        .await
        .ok()?;
    if response.status != 200 {
        return None;
    }
    raster(response.body, source).await
}

// Only icon links are considered. OpenGraph/social-preview metadata is not a repository logo.
fn icon_links(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut rest = lower.as_str();
    let mut offset = 0;
    let mut links = Vec::new();
    while let Some(start) = rest.find("<link") {
        let start = offset + start;
        let Some(next) = lower.as_bytes().get(start + 5) else {
            break;
        };
        if !next.is_ascii_whitespace() && *next != b'/' {
            offset = start + 5;
            rest = &lower[offset..];
            continue;
        }
        let mut quote = None;
        let mut end = start + 5;
        for byte in lower.as_bytes().iter().skip(end) {
            if quote == Some(*byte) {
                quote = None;
            } else if quote.is_none() && matches!(*byte, b'\'' | b'"') {
                quote = Some(*byte);
            } else if quote.is_none() && *byte == b'>' {
                break;
            }
            end += 1;
        }
        if end == lower.len() {
            break;
        }
        let tag = &html[start + 5..end];
        if attribute(tag, "rel").is_some_and(|rel| {
            rel.split_ascii_whitespace().any(|part| {
                part.eq_ignore_ascii_case("icon") || part.eq_ignore_ascii_case("apple-touch-icon")
            })
        }) && let Some(href) = attribute(tag, "href")
        {
            links.push(href.replace("&amp;", "&"));
        }
        if links.len() == 4 {
            break;
        }
        offset = end + 1;
        rest = &lower[offset..];
    }
    links
}

fn attribute<'a>(tag: &'a str, wanted: &str) -> Option<&'a str> {
    let bytes = tag.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        while at < bytes.len() && (bytes[at].is_ascii_whitespace() || bytes[at] == b'/') {
            at += 1;
        }
        let name = at;
        while at < bytes.len() && !bytes[at].is_ascii_whitespace() && bytes[at] != b'=' {
            at += 1;
        }
        let key = &tag[name..at];
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        if bytes.get(at) != Some(&b'=') {
            continue;
        }
        at += 1;
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        let quote = bytes
            .get(at)
            .copied()
            .filter(|byte| matches!(byte, b'\'' | b'"'));
        if quote.is_some() {
            at += 1;
        }
        let value = at;
        while at < bytes.len()
            && match quote {
                Some(quote) => bytes[at] != quote,
                None => !bytes[at].is_ascii_whitespace(),
            }
        {
            at += 1;
        }
        if key.eq_ignore_ascii_case(wanted) {
            return Some(&tag[value..at]);
        }
        if quote.is_some() && at < bytes.len() {
            at += 1;
        }
    }
    None
}

/// Extract only github.com's public owner name. Neither a repository path, token nor raw origin becomes a request.
pub(super) fn github_owner(remote: &str) -> Option<String> {
    if let Ok(url) = Url::parse(remote)
        && (url.password().is_some()
            || !(url.username().is_empty() || url.scheme() == "ssh" && url.username() == "git"))
    {
        return None;
    }
    let canonical = crate::git::parse::remote_web_base(remote)?;
    let web = Url::parse(&canonical).ok()?;
    if web.host_str()? != "github.com" {
        return None;
    }
    // A web URL must not turn a malformed SCP path into a different public owner while normalizing dot segments.
    let raw_path = canonical.splitn(4, '/').nth(3)?;
    if web.path().strip_prefix('/')? != raw_path {
        return None;
    }
    let mut parts = web.path_segments()?;
    let owner = parts.next()?;
    let repository = parts.next()?;
    if repository.is_empty() || parts.next().is_some() {
        return None;
    }
    if owner.is_empty()
        || owner.len() > 39
        || owner.starts_with('-')
        || owner.ends_with('-')
        || !owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    Some(owner.to_owned())
}

pub(super) async fn discover(root: &Path, remote: Option<&str>) -> Option<Artwork> {
    for relative in FILES {
        if let Some(bytes) = read(root, relative, raster::INPUT_BYTES).await
            && let Some(image) = raster(bytes, Source::Repository).await
        {
            return Some(image);
        }
    }
    let homepage = async {
        if let Some(bytes) = read(root, "package.json", 64 * 1024).await
            && let Ok(package) = serde_json::from_slice::<Value>(&bytes)
            && let Some(homepage) = package["homepage"].as_str().and_then(external_url)
        {
            let mut base = homepage.clone();
            if let Ok(response) = crate::http::public_get(homepage.as_str(), 64 * 1024).await
                && response.status == 200
            {
                base = response.url;
                if let Ok(html) = std::str::from_utf8(&response.body) {
                    for href in icon_links(html) {
                        if let Ok(icon) = base.join(&href)
                            && let Some(icon) = external_url(icon.as_str())
                            && let Some(image) = fetch_image(&icon, Source::Homepage).await
                        {
                            return Some(image);
                        }
                    }
                }
            }
            if let Ok(icon) = base.join("/favicon.ico")
                && let Some(image) = fetch_image(&icon, Source::Homepage).await
            {
                return Some(image);
            }
        }
        None
    };
    // Reserve a separate attempt for the owner fallback when a homepage is offline or slow.
    if let Ok(Some(image)) = tokio::time::timeout(std::time::Duration::from_secs(4), homepage).await
    {
        return Some(image);
    }
    if let Some(owner) = remote.and_then(github_owner)
        && let Ok(url) = Url::parse(&format!("https://github.com/{owner}.png"))
    {
        return fetch_image(&url, Source::Owner).await;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_icon_links_are_distinct_from_generated_social_previews() {
        assert_eq!(
            icon_links(
                r#"<meta property="og:image" content="generated-social.png"><LINK href='/brand/icon.png' REL='shortcut icon'><link rel=apple-touch-icon href=/touch.png>"#
            ),
            ["/brand/icon.png", "/touch.png"]
        );
        assert!(icon_links("<meta property='og:image' content='custom-social.png'>").is_empty());
        assert!(external_url("https://private.invalid/?token=synthetic").is_none());
    }

    #[test]
    fn owner_avatar_never_receives_the_private_repository_or_credentials() {
        assert_eq!(
            github_owner("git@github.com:synthetic-owner/private-project.git").as_deref(),
            Some("synthetic-owner")
        );
        assert_eq!(
            github_owner("https://github.com/synthetic-owner/private-project.git").as_deref(),
            Some("synthetic-owner")
        );
        for remote in [
            "https://synthetic-token@github.com/owner/private.git",
            "https://internal.example/owner/private.git",
            "git@github.com:../../private.git",
            "https://github.com.evil.invalid/owner/project",
        ] {
            assert!(github_owner(remote).is_none());
        }
        assert!(github_owner("git@github.com:../../synthetic-owner/private.git").is_none());
    }

    #[test]
    fn standard_ssh_remote_keeps_only_the_canonical_public_owner() {
        assert_eq!(
            github_owner("ssh://git@github.com/synthetic-owner/private-project.git").as_deref(),
            Some("synthetic-owner")
        );
        assert!(
            github_owner("ssh://secret:token@github.com/synthetic-owner/private-project.git")
                .is_none()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn homepage_redirect_uses_the_final_directory_for_relative_icons() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let temp = super::super::test_support::Fixture::new("homepage-final-origin");
        std::fs::write(
            temp.dir.join("package.json"),
            br#"{"homepage":"http://repository-artwork-fixture.example.org/start"}"#,
        )
        .unwrap();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(16, 16, image::Rgba([20, 100, 180, 255]))
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let png = bytes.into_inner();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket = listener.local_addr().unwrap();
        let served = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let length = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..length]);
                let path = request.split_whitespace().nth(1).unwrap_or("");
                let (status, extra, body): (&str, &str, &[u8]) = match path {
                    "/start" => ("302 Found", "Location: /app/\r\n", b""),
                    "/app/" => ("200 OK", "", br#"<link rel="icon" href="brand/icon.png">"#),
                    "/app/brand/icon.png" => ("200 OK", "", &png),
                    _ => ("404 Not Found", "", b""),
                };
                stream.write_all(format!("HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
                stream.write_all(body).await.unwrap();
            }
        });
        let result = crate::http::fixture_request(socket, discover(&temp.dir, None)).await;
        served.abort();
        let _ = served.await;
        assert!(matches!(
            result.map(|image| image.source),
            Some(Source::Homepage)
        ));
    }
}
