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
    let valid_origin = matches!(
        (uri.scheme_str(), uri.authority().map(|a| a.as_str())),
        (Some("app"), Some("ompdesk")) | (Some("http"), Some("app.ompdesk"))
    );
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
pub fn serve(root: &Path, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
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
        builder = builder.header(header::CONTENT_SECURITY_POLICY, "default-src 'self' app: http://app.ompdesk; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: omp-media:; media-src 'self' blob: omp-media:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'; base-uri 'self'");
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

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(f.get("http://app.ompdesk/app.js?x=1").body(), b"abcdef");
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
            serve(&f.0, builder.body(Vec::new()).unwrap())
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
