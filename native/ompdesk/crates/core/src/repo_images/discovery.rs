use std::path::Path;

use serde_json::Value;
use tokio::io::AsyncReadExt;
use url::Url;

use super::{Artwork, Source, raster};

const FILES: &[&str] = &[
    ".github/logo.png", ".github/logo.webp", "logo.png", "logo.webp", "icon.png",
    "public/favicon.png", "public/favicon.ico", "public/icon.png", "public/apple-touch-icon.png",
    "static/favicon.png", "static/favicon.ico", "assets/logo.png", "app/icon.png", "src/app/icon.png",
    "src/app/favicon.ico", "favicon.png", "favicon.ico",
];

async fn read(root: &Path, relative: &str, limit: usize) -> Option<Vec<u8>> {
    let path = tokio::fs::canonicalize(root.join(relative)).await.ok()?;
    if !path.starts_with(root) { return None; }
    let file = tokio::fs::File::open(path).await.ok()?;
    if !file.metadata().await.ok()?.is_file() { return None; }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes).await.ok()?;
    (bytes.len() <= limit).then_some(bytes)
}

async fn raster(bytes: Vec<u8>, source: Source) -> Option<Artwork> {
    let data_url = tokio::task::spawn_blocking(move || raster::data_url(&bytes)).await.ok()??;
    Some(Artwork { data_url, source })
}

fn external_url(value: &str) -> Option<Url> {
    let mut url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "https" | "http") || !url.username().is_empty() || url.password().is_some() || url.query().is_some() { return None; }
    url.set_fragment(None);
    Some(url)
}

async fn fetch_image(url: &Url, source: Source) -> Option<Artwork> {
    let response = crate::http::public_get(url.as_str(), raster::INPUT_BYTES).await.ok()?;
    if response.status != 200 { return None; }
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
        let Some(next) = lower.as_bytes().get(start + 5) else { break; };
        if !next.is_ascii_whitespace() && *next != b'/' {
            offset = start + 5; rest = &lower[offset..]; continue;
        }
        let mut quote = None;
        let mut end = start + 5;
        for byte in lower.as_bytes().iter().skip(end) {
            if quote == Some(*byte) { quote = None; }
            else if quote.is_none() && matches!(*byte, b'\'' | b'"') { quote = Some(*byte); }
            else if quote.is_none() && *byte == b'>' { break; }
            end += 1;
        }
        if end == lower.len() { break; }
        let tag = &html[start + 5..end];
        if attribute(tag, "rel").is_some_and(|rel| rel.split_ascii_whitespace().any(|part| part.eq_ignore_ascii_case("icon") || part.eq_ignore_ascii_case("apple-touch-icon"))) {
            if let Some(href) = attribute(tag, "href") { links.push(href.replace("&amp;", "&")); }
        }
        if links.len() == 4 { break; }
        offset = end + 1; rest = &lower[offset..];
    }
    links
}

fn attribute<'a>(tag: &'a str, wanted: &str) -> Option<&'a str> {
    let bytes = tag.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        while at < bytes.len() && (bytes[at].is_ascii_whitespace() || bytes[at] == b'/') { at += 1; }
        let name = at;
        while at < bytes.len() && !bytes[at].is_ascii_whitespace() && bytes[at] != b'=' { at += 1; }
        let key = &tag[name..at];
        while at < bytes.len() && bytes[at].is_ascii_whitespace() { at += 1; }
        if bytes.get(at) != Some(&b'=') { continue; }
        at += 1;
        while at < bytes.len() && bytes[at].is_ascii_whitespace() { at += 1; }
        let quote = bytes.get(at).copied().filter(|byte| matches!(byte, b'\'' | b'"'));
        if quote.is_some() { at += 1; }
        let value = at;
        while at < bytes.len() && match quote { Some(quote) => bytes[at] != quote, None => !bytes[at].is_ascii_whitespace() } { at += 1; }
        if key.eq_ignore_ascii_case(wanted) { return Some(&tag[value..at]); }
        if quote.is_some() && at < bytes.len() { at += 1; }
    }
    None
}

/// Extract only github.com's public owner name. Neither a repository path, token nor raw origin becomes a request.
pub(super) fn github_owner(remote: &str) -> Option<&str> {
    let path = remote.strip_prefix("git@github.com:").or_else(|| remote.strip_prefix("https://github.com/"))?;
    let (owner, repo) = path.split_once('/')?;
    if repo.is_empty() || owner.is_empty() || owner.len() > 39 || owner.starts_with('-') || owner.ends_with('-')
        || !owner.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') { return None; }
    Some(owner)
}

pub(super) async fn discover(root: &Path, remote: Option<&str>) -> Option<Artwork> {
    for relative in FILES {
        if let Some(bytes) = read(root, relative, raster::INPUT_BYTES).await {
            if let Some(image) = raster(bytes, Source::Repository).await { return Some(image); }
        }
    }
    let homepage = async {
    if let Some(bytes) = read(root, "package.json", 64 * 1024).await {
        if let Ok(package) = serde_json::from_slice::<Value>(&bytes) {
            if let Some(homepage) = package["homepage"].as_str().and_then(external_url) {
                if let Ok(response) = crate::http::public_get(homepage.as_str(), 64 * 1024).await {
                    if response.status == 200 {
                        if let Ok(html) = std::str::from_utf8(&response.body) {
                            for href in icon_links(html) {
                                if let Ok(icon) = homepage.join(&href) {
                                    if let Some(icon) = external_url(icon.as_str()) {
                                        if let Some(image) = fetch_image(&icon, Source::Homepage).await { return Some(image); }
                                    }
                                }
                            }
                        }
                    }
                }
                if let Ok(icon) = homepage.join("/favicon.ico") {
                    if let Some(image) = fetch_image(&icon, Source::Homepage).await { return Some(image); }
                }
            }
        }
    }
    None
    };
    // Reserve a separate attempt for the owner fallback when a homepage is offline or slow.
    if let Ok(Some(image)) = tokio::time::timeout(std::time::Duration::from_secs(4), homepage).await {
        return Some(image);
    }
    if let Some(owner) = remote.and_then(github_owner) {
        if let Ok(url) = Url::parse(&format!("https://github.com/{owner}.png")) {
            return fetch_image(&url, Source::Owner).await;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_icon_links_are_distinct_from_generated_social_previews() {
        assert_eq!(icon_links(r#"<meta property="og:image" content="generated-social.png"><LINK href='/brand/icon.png' REL='shortcut icon'><link rel=apple-touch-icon href=/touch.png>"#), ["/brand/icon.png", "/touch.png"]);
        assert!(icon_links("<meta property='og:image' content='custom-social.png'>").is_empty());
        assert!(external_url("https://private.invalid/?token=synthetic").is_none());
    }

    #[test]
    fn owner_avatar_never_receives_the_private_repository_or_credentials() {
        assert_eq!(github_owner("git@github.com:synthetic-owner/private-project.git"), Some("synthetic-owner"));
        assert_eq!(github_owner("https://github.com/synthetic-owner/private-project.git"), Some("synthetic-owner"));
        for remote in ["https://synthetic-token@github.com/owner/private.git", "https://internal.example/owner/private.git", "git@github.com:../../private.git", "https://github.com.evil.invalid/owner/project"] {
            assert!(github_owner(remote).is_none());
        }
    }
}
