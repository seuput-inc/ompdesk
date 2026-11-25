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
    // A desktop app's own icon where Electron, electron-builder and Tauri keep it.
    "build/icon.png",
    "resources/icon.png",
    "assets/icon.png",
    "src-tauri/icons/128x128.png",
    "public/logo.png",
];

async fn read(root: &Path, relative: &str, limit: usize) -> Option<Vec<u8>> {
    let path = crate::fs::disk::real(root.join(relative)).await?;
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

/// A homepage that is the repository's own site. A code host's page (`"homepage": "https://github.com/o/r#readme"`,
/// npm's default) would give the host's favicon to every repository, so the owner's avatar is tried instead.
fn homepage_url(value: &str) -> Option<Url> {
    const CODE_HOSTS: &[&str] = &[
        "github.com",
        "www.github.com",
        "gitlab.com",
        "www.gitlab.com",
        "bitbucket.org",
        "www.bitbucket.org",
        "npmjs.com",
        "www.npmjs.com",
    ];
    let url = external_url(value)?;
    let host = url.host_str()?.to_ascii_lowercase();
    (!CODE_HOSTS.contains(&host.as_str())).then_some(url)
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

/// Each `<name …>` tag's attribute text, in page order, quotes respected.
fn tags<'a>(html: &'a str, name: &str) -> Vec<&'a str> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{name}");
    let mut offset = 0;
    let mut found = Vec::new();
    while let Some(start) = lower[offset..].find(&open) {
        let start = offset + start;
        let inner = start + open.len();
        let Some(next) = lower.as_bytes().get(inner) else {
            break;
        };
        if !next.is_ascii_whitespace() && *next != b'/' {
            offset = inner;
            continue;
        }
        let mut quote = None;
        let mut end = inner;
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
        found.push(&html[inner..end]);
        offset = end + 1;
    }
    found
}

// Only icon links are considered. OpenGraph/social-preview metadata is not a repository logo.
fn icon_links(html: &str) -> Vec<String> {
    tags(html, "link")
        .into_iter()
        .filter(|tag| {
            attribute(tag, "rel").is_some_and(|rel| {
                rel.split_ascii_whitespace().any(|part| {
                    part.eq_ignore_ascii_case("icon")
                        || part.eq_ignore_ascii_case("apple-touch-icon")
                })
            })
        })
        .filter_map(|tag| attribute(tag, "href"))
        .map(|href| href.replace("&amp;", "&"))
        .take(4)
        .collect()
}

/// Where GitHub keeps a social preview the repository's owner uploaded. The one GitHub draws for every repository
/// (`opengraph.githubassets.com`) is not the repository's own picture.
const UPLOADED_PREVIEWS: &str = "repository-images.githubusercontent.com";

/// A repository page's uploaded social preview, from its `og:image`.
fn uploaded_preview(html: &str) -> Option<Url> {
    let content = tags(html, "meta").into_iter().find_map(|tag| {
        attribute(tag, "property")
            .is_some_and(|property| property.eq_ignore_ascii_case("og:image"))
            .then(|| attribute(tag, "content"))
            .flatten()
    })?;
    let url = external_url(&content.replace("&amp;", "&"))?;
    (url.scheme() == "https" && url.host_str() == Some(UPLOADED_PREVIEWS)).then_some(url)
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

/// github.com's owner and repository name of `remote`, when it is one. Neither a token nor the raw origin becomes a
/// request: only these two names, each checked against GitHub's own spelling rules.
fn github_repository(remote: &str) -> Option<(String, String)> {
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
    let repository = repository.strip_suffix(".git").unwrap_or(repository);
    if parts.next().is_some()
        || repository.is_empty()
        || repository.len() > 100
        || repository == "."
        || repository == ".."
        || !repository
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
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
    Some((owner.to_owned(), repository.to_owned()))
}

/// github.com's owner name of `remote`.
pub(super) fn github_owner(remote: &str) -> Option<String> {
    github_repository(remote).map(|(owner, _)| owner)
}

/// The social preview the owner uploaded for a public github.com repository. Only the page's head is read (its
/// `og:image` sits about 24 KB in); a private repository's page answers 404 and the owner's avatar follows.
async fn github_preview(owner: &str, repository: &str) -> Option<Artwork> {
    let page = Url::parse(&format!("https://github.com/{owner}/{repository}")).ok()?;
    let response = crate::http::public_head(page.as_str(), 64 * 1024)
        .await
        .ok()?;
    if response.status != 200 {
        return None;
    }
    let html = String::from_utf8_lossy(&response.body);
    fetch_image(&uploaded_preview(&html)?, Source::Repository).await
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
            && let Some(homepage) = package["homepage"].as_str().and_then(homepage_url)
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
    // Each step keeps its own bound, so the owner fallback still has time when a homepage or GitHub is slow.
    if let Ok(Some(image)) = tokio::time::timeout(std::time::Duration::from_secs(4), homepage).await
    {
        return Some(image);
    }
    let (owner, repository) = github_repository(remote?)?;
    if let Ok(Some(image)) = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        github_preview(&owner, &repository),
    )
    .await
    {
        return Some(image);
    }
    let url = Url::parse(&format!("https://github.com/{owner}.png")).ok()?;
    fetch_image(&url, Source::Owner).await
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
        assert!(homepage_url("https://github.com/synthetic-owner/project#readme").is_none());
        assert!(homepage_url("https://WWW.GitHub.com/synthetic-owner/project").is_none());
        assert!(homepage_url("https://synthetic-owner.github.io/project/").is_some());
    }

    #[test]
    fn only_a_social_preview_the_owner_uploaded_counts_as_the_repository_image() {
        let uploaded =
            "https://repository-images.githubusercontent.com/1406736637/2fda291f-b0a0-4798";
        assert_eq!(
            uploaded_preview(&format!(
                r#"<meta name="viewport" content="x"><META content='{uploaded}' Property="og:image">"#
            ))
            .map(String::from),
            Some(uploaded.to_owned())
        );
        for page in [
            r#"<meta property="og:image" content="https://opengraph.githubassets.com/e1ce/owner/project">"#,
            r#"<meta property="og:image" content="http://repository-images.githubusercontent.com/1/2">"#,
            r#"<meta property="og:image" content="https://repository-images.githubusercontent.com.evil.invalid/1">"#,
            r#"<meta property="twitter:image" content="https://repository-images.githubusercontent.com/1/2">"#,
            "<meta property='og:image' content='/relative.png'>",
        ] {
            assert!(uploaded_preview(page).is_none(), "{page}");
        }
        assert_eq!(
            github_repository("git@github.com:synthetic-owner/private.project-1.git"),
            Some(("synthetic-owner".into(), "private.project-1".into()))
        );
        assert!(github_repository("https://github.com/synthetic-owner/..").is_none());
        assert!(github_repository("https://github.com/synthetic-owner/a%2Fb").is_none());
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
