use shell_core::range::{ParsedRange, parse_range};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use tauri::http::{Method, Request, Response, StatusCode, header};

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("valid response")
}

fn path_from_uri(uri: &tauri::http::Uri) -> Option<PathBuf> {
    let origin = (uri.scheme_str(), uri.authority().map(|a| a.as_str()));
    let valid_origin = origin == (Some("app"), Some("ompdesk"))
        || (cfg!(windows)
            && matches!(
                origin,
                (Some("app"), Some("localhost")) | (Some("http"), Some("app.localhost"))
            ));
    if !valid_origin {
        return None;
    }
    let raw = uri.path().strip_prefix('/')?;
    if raw.is_empty() {
        return Some(PathBuf::from("index.html"));
    }
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let byte = if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            let value = u8::from_str_radix(hex, 16).ok()?;
            if matches!(value, b'/' | b'\\' | 0 | b'%') {
                return None;
            }
            i += 3;
            value
        } else {
            let value = bytes[i];
            i += 1;
            value
        };
        if byte == b'\\' || byte == 0 {
            return None;
        }
        decoded.push(byte);
    }
    let text = std::str::from_utf8(&decoded).ok()?;
    if text
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.contains(':'))
    {
        return None;
    }
    let path = PathBuf::from(text);
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
        .then_some(path)
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "map" | "webmanifest" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// Serves renderer files. The caller must run this function off the UI thread.
pub fn serve(root: &Path, request: Request<Vec<u8>>, policy: &str) -> Response<Vec<u8>> {
    let head = request.method() == Method::HEAD;
    if request.method() != Method::GET && !head {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "GET, HEAD")
            .body(Vec::new())
            .expect("valid response");
    }
    let Some(relative) = path_from_uri(request.uri()) else {
        return empty(StatusCode::NOT_FOUND);
    };
    if relative == Path::new("__profile/migrate") {
        let body = if head {
            Vec::new()
        } else {
            b"<!doctype html><html><head><meta charset=\"utf-8\"><title>OMPdesk</title></head><body><p id=\"omp-profile-error\" role=\"alert\"></p><button id=\"omp-profile-retry\" hidden onclick=\"location.reload()\">Retry / \xeb\x8b\xa4\xec\x8b\x9c \xec\x8b\x9c\xeb\x8f\x84</button></body></html>".to_vec()
        };
        return Response::builder().status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; script-src 'unsafe-inline'; connect-src ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'")
            .body(body).expect("bootstrap response");
    }
    let Ok(root) = root.canonicalize() else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(path) = root.join(&relative).canonicalize() else {
        return empty(StatusCode::NOT_FOUND);
    };
    if !path.starts_with(&root) {
        return empty(StatusCode::NOT_FOUND);
    }
    let Ok(mut file) = File::open(path) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(metadata) = file.metadata() else {
        return empty(StatusCode::NOT_FOUND);
    };
    if !metadata.is_file() {
        return empty(StatusCode::NOT_FOUND);
    }
    let size = metadata.len();
    let selected = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|v| parse_range(v, size))
        .unwrap_or(ParsedRange::None);
    let selected = match selected {
        ParsedRange::None => None,
        ParsedRange::Range(start, end) => Some((start, end)),
        ParsedRange::Unsatisfiable => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .header(header::CONTENT_LENGTH, "0")
                .body(Vec::new())
                .expect("valid response");
        }
    };
    let (start, length) = selected.map_or((0, size), |(start, end)| (start, end - start + 1));
    let mut builder = Response::builder()
        .status(if selected.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, mime(&relative))
        .header(header::CONTENT_LENGTH, length.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-cache");
    if mime(&relative) == "text/html" {
        builder = builder.header(header::CONTENT_SECURITY_POLICY, policy);
    }
    if let Some((start, end)) = selected {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    let mut body = Vec::new();
    if !head
        && (file.seek(SeekFrom::Start(start)).is_err()
            || file.take(length).read_to_end(&mut body).is_err()
            || body.len() as u64 != length)
    {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    }
    builder.body(body).expect("valid response")
}

pub fn content_policy(media_origin: Option<&str>) -> Result<String, String> {
    if let Some(origin) = media_origin {
        let parsed = url::Url::parse(origin).map_err(|_| "Invalid native media origin")?;
        if parsed.scheme() != "http"
            || parsed.host_str() != Some("127.0.0.1")
            || parsed.port().is_none_or(|port| port == 0)
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.origin().ascii_serialization() != origin
        {
            return Err("Native media CSP requires the exact allocated loopback origin".into());
        }
    }
    let media_origin = media_origin.unwrap_or("");
    let registered_media = if cfg!(windows) {
        "http://omp-media.localhost"
    } else {
        ""
    };
    Ok(format!(
        "default-src 'self' app: http://app.localhost; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: omp-media: {registered_media} {media_origin}; media-src 'self' blob: omp-media: {registered_media} {media_origin}; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'; base-uri 'self'"
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_gateway_permission_is_exact_and_does_not_allow_network_connections() {
        let origin = "http://127.0.0.1:49152";
        let policy = content_policy(Some(origin)).unwrap();
        let permitted: Vec<_> = policy
            .split(';')
            .filter(|directive| directive.contains(origin))
            .collect();
        assert_eq!(permitted.len(), 2);
        assert!(
            permitted
                .iter()
                .any(|directive| directive.trim_start().starts_with("img-src "))
        );
        assert!(
            permitted
                .iter()
                .any(|directive| directive.trim_start().starts_with("media-src "))
        );
        assert!(
            !policy
                .split(';')
                .find(|directive| directive.trim_start().starts_with("connect-src "))
                .unwrap()
                .contains(origin)
        );
        let fixture = Fixture::new();
        let response = serve(
            &fixture.0,
            Request::builder()
                .uri("app://ompdesk/index.html")
                .body(Vec::new())
                .unwrap(),
            &policy,
        );
        assert_eq!(response.headers()[header::CONTENT_SECURITY_POLICY], policy);
    }
    #[cfg(windows)]
    #[test]
    fn windows_player_response_permits_initial_media_request_and_exact_redirect() {
        let initial =
            crate::preview::media::for_webview("omp-media://stream/native-player").unwrap();
        let initial = url::Url::parse(&initial)
            .unwrap()
            .origin()
            .ascii_serialization();
        let redirect = "http://127.0.0.1:49152";
        let fixture = Fixture::new();
        let response = serve(
            &fixture.0,
            Request::builder()
                .uri("http://app.localhost/index.html")
                .body(Vec::new())
                .unwrap(),
            &content_policy(Some(redirect)).unwrap(),
        );
        let header = response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        let sources = |name| {
            header
                .split(';')
                .find_map(|directive| {
                    let mut fields = directive.split_ascii_whitespace();
                    (fields.next() == Some(name)).then(|| fields.collect::<Vec<_>>())
                })
                .unwrap()
        };
        let media = sources("media-src");
        assert!(
            media.contains(&initial.as_str()),
            "audio/video must reach the native 302 handler"
        );
        assert!(
            media.contains(&redirect),
            "audio/video must follow the allocated stream redirect"
        );
        assert!(!media.contains(&"http://127.0.0.1:*"));
        assert!(!media.contains(&"http://127.0.0.1:49153"));
        let connections = sources("connect-src");
        assert!(!connections.contains(&initial.as_str()));
        assert!(!connections.contains(&redirect));
    }
    #[test]
    fn media_policy_rejects_wildcards_and_unrelated_or_injected_origins() {
        for origin in [
            "http://127.0.0.1:*",
            "http://localhost:49152",
            "https://127.0.0.1:49152",
            "http://127.0.0.1:49152/path",
            "http://name@127.0.0.1:49152",
            "http://127.0.0.1:49152#fragment",
            "http://127.0.0.1:49152; connect-src *",
        ] {
            assert!(content_policy(Some(origin)).is_err(), "{origin}");
        }
    }
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    use std::fs;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ompdesk-assets-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("index.html"), b"index").unwrap();
            fs::write(dir.join("app.js"), b"abcdef").unwrap();
            Self(dir)
        }
        fn get(&self, uri: &str) -> Response<Vec<u8>> {
            serve(
                &self.0,
                Request::builder().uri(uri).body(Vec::new()).unwrap(),
                &content_policy(None).unwrap(),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn serves_only_assets_from_the_expected_origin() {
        let f = Fixture::new();
        assert_eq!(f.get("app://ompdesk/?v=1").body(), b"index");
        if cfg!(windows) {
            assert_eq!(f.get("http://app.localhost/app.js?x=1").body(), b"abcdef");
            assert_eq!(f.get("app://localhost/app.js?x=1").body(), b"abcdef");
        }
        assert_eq!(f.get("app://other/app.js").status(), StatusCode::NOT_FOUND);
        assert_eq!(
            f.get("app://ompdesk/missing").status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            f.get("app://ompdesk/app.js").headers()[header::CONTENT_TYPE],
            "text/javascript"
        );
        for path in [
            "%2e%2e/secret",
            "%2e/secret",
            "a%2fb",
            "a%5cb",
            "%252e%252e/secret",
            "a//b",
            "C:%5csecret",
        ] {
            assert_eq!(
                f.get(&format!("app://ompdesk/{path}")).status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_outside_root() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = Fixture::new();
        symlink(&outside.0, f.0.join("outside")).unwrap();
        assert_eq!(
            f.get("app://ompdesk/outside/index.html").status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn handles_methods_and_ranges() {
        let f = Fixture::new();
        let request = |method, range_value: Option<&str>| {
            let mut builder = Request::builder()
                .method(method)
                .uri("app://ompdesk/app.js");
            if let Some(value) = range_value {
                builder = builder.header(header::RANGE, value);
            }
            serve(
                &f.0,
                builder.body(Vec::new()).unwrap(),
                &content_policy(None).unwrap(),
            )
        };
        let partial = request(Method::GET, Some("bytes=1-3"));
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(partial.body(), b"bcd");
        assert_eq!(partial.headers()[header::CONTENT_RANGE], "bytes 1-3/6");
        let head = request(Method::HEAD, Some("bytes=-2"));
        assert_eq!(head.status(), StatusCode::PARTIAL_CONTENT);
        assert!(head.body().is_empty());
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "2");
        let unsatisfiable = request(Method::GET, Some("bytes=9-"));
        assert_eq!(unsatisfiable.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(unsatisfiable.headers()[header::CONTENT_RANGE], "bytes */6");
        assert_eq!(
            request(Method::POST, None).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }
}
