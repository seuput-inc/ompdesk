//! File viewer types can fall back to a suffix. Markdown images require a signature.

use std::path::Path;

pub(super) const HEAD_BYTES: usize = 512;
const OCTET_STREAM: &str = "application/octet-stream";
const DOCX: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX: &str = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

fn magic(head: &[u8]) -> Option<&'static str> {
    let mime = if head.starts_with(b"%PDF-") {
        "application/pdf"
    } else if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if head.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        "image/gif"
    } else if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WAVE") {
        "audio/wav"
    } else if head.len() >= 12 && &head[4..8] == b"ftyp" {
        match &head[8..12] {
            b"avif" | b"avis" => "image/avif",
            b"qt  " => "video/quicktime",
            b"M4A " | b"M4B " => "audio/mp4",
            _ => "video/mp4",
        }
    } else if head.starts_with(b"\x1a\x45\xdf\xa3") {
        if head[..head.len().min(64)].windows(4).any(|w| w == b"webm") {
            "video/webm"
        } else {
            "video/x-matroska"
        }
    } else if head.starts_with(b"ID3") {
        "audio/mpeg"
    } else if head.starts_with(b"OggS") {
        "audio/ogg"
    } else if head.starts_with(b"fLaC") {
        "audio/flac"
    } else if matches!(
        head,
        [b'P', b'K', 3, 4, ..] | [b'P', b'K', 5, 6, ..] | [b'P', b'K', 7, 8, ..]
    ) {
        "application/zip"
    } else if head.starts_with(b"\x1f\x8b") {
        "application/gzip"
    } else if head.starts_with(b"SQLite format 3\0") {
        "application/vnd.sqlite3"
    } else if head.starts_with(b"BM") && head.get(6..10) == Some(b"\0\0\0\0") {
        "image/bmp"
    } else if matches!(head, [0, 0, 1, 0, low, high, ..] if *low != 0 || *high != 0) {
        "image/x-icon"
    } else if matches!(head, [0xff, n, ..] if n & 0xe0 == 0xe0 && n & 0x18 != 0x08 && n & 0x06 != 0)
    {
        "audio/mpeg"
    } else {
        return None;
    };
    Some(mime)
}

fn extension(path: &str) -> &'static str {
    let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) else {
        return OCTET_STREAM;
    };
    // The longest known suffix is sqlite3. Lowercase like JS, including the Kelvin sign in MKV.
    let mut lower = [0; 7];
    let mut len = 0;
    for c in ext.chars().flat_map(char::to_lowercase) {
        if len == lower.len() || !c.is_ascii() {
            return OCTET_STREAM;
        }
        lower[len] = c as u8;
        len += 1;
    }
    match &lower[..len] {
        b"pdf" => "application/pdf",
        b"png" => "image/png",
        b"jpg" | b"jpeg" => "image/jpeg",
        b"gif" => "image/gif",
        b"webp" => "image/webp",
        b"avif" => "image/avif",
        b"bmp" => "image/bmp",
        b"ico" => "image/x-icon",
        b"svg" => "image/svg+xml",
        b"mp4" | b"m4v" => "video/mp4",
        b"mov" => "video/quicktime",
        b"webm" => "video/webm",
        b"mkv" => "video/x-matroska",
        b"ogv" => "video/ogg",
        b"mp3" => "audio/mpeg",
        b"m4a" => "audio/mp4",
        b"aac" => "audio/aac",
        b"wav" => "audio/wav",
        b"ogg" | b"oga" | b"opus" => "audio/ogg",
        b"weba" => "audio/webm",
        b"flac" => "audio/flac",
        b"docx" => DOCX,
        b"xlsx" => XLSX,
        b"pptx" => PPTX,
        b"zip" => "application/zip",
        b"gz" | b"tgz" => "application/gzip",
        b"tar" => "application/x-tar",
        b"7z" => "application/x-7z-compressed",
        b"sqlite" | b"sqlite3" => "application/vnd.sqlite3",
        b"wasm" => "application/wasm",
        _ => OCTET_STREAM,
    }
}

pub(super) fn viewer(bytes: &[u8], path: &str) -> &'static str {
    match magic(bytes) {
        None => extension(path),
        Some(container @ ("application/zip" | "video/mp4" | "audio/ogg" | "video/webm")) => {
            let ext = extension(path);
            match (container, ext) {
                ("application/zip", DOCX | XLSX | PPTX)
                | ("video/mp4", "audio/mp4")
                | ("audio/ogg", "video/ogg")
                | ("video/webm", "audio/webm") => ext,
                _ => container,
            }
        }
        Some(mime) => mime,
    }
}

pub(crate) fn image(bytes: &[u8]) -> Option<&'static str> {
    let head = &bytes[..bytes.len().min(HEAD_BYTES)];
    if let Some(mime) = magic(head) {
        return mime.starts_with("image/").then_some(mime);
    }
    let start = head.iter().position(|&b| b == b'<')?;
    if !std::str::from_utf8(&head[..start])
        .ok()?
        .chars()
        .all(super::order::is_js_space)
    {
        return None;
    }
    let tag = &head[start..];
    let svg = |w: &[u8]| w.eq_ignore_ascii_case(b"<svg");
    (tag.get(..4).is_some_and(svg)
        || (tag
            .get(..5)
            .is_some_and(|w| w.eq_ignore_ascii_case(b"<?xml"))
            && tag.windows(4).any(svg)))
    .then_some("image/svg+xml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewer_matches_captured_typescript_signatures() {
        let cases: &[(&[u8], &str, &str)] = &[
            (b"\x1a\x45\xdf\xa3webm", "x.weba", "audio/webm"),
            (b"BM\0\0\0\0\0\0\0\0", "x", "image/bmp"),
            (b"\0\0\x01\0\x01\0", "x", "image/x-icon"),
            (b"\0\0\0\0ftypavis", "x", "image/avif"),
            (b"\0\0\0\0ftypM4B ", "x", "audio/mp4"),
            (b"PK\x05\x06", "x", "application/zip"),
            (b"PK\x07\x08", "x", "application/zip"),
            (b"\xff\xe8", "x", OCTET_STREAM),
            (b"\xff\xf9", "x", OCTET_STREAM),
            (b"\xff\xfe", "x", "audio/mpeg"),
            (b"GIF87a", "x", "image/gif"),
            (b"", "x.mKv", "video/x-matroska"),
        ];
        for &(head, path, expected) in cases {
            assert_eq!(viewer(head, path), expected, "{head:x?} {path}");
        }
    }

    #[test]
    fn empty_files_match_the_captured_typescript_extensions() {
        let cases = [
            ("pdf", "application/pdf"),
            ("png", "image/png"),
            ("jpg jpeg", "image/jpeg"),
            ("gif", "image/gif"),
            ("webp", "image/webp"),
            ("avif", "image/avif"),
            ("bmp", "image/bmp"),
            ("ico", "image/x-icon"),
            ("svg", "image/svg+xml"),
            ("mp4 m4v", "video/mp4"),
            ("mov", "video/quicktime"),
            ("webm", "video/webm"),
            ("mkv", "video/x-matroska"),
            ("ogv", "video/ogg"),
            ("mp3", "audio/mpeg"),
            ("m4a", "audio/mp4"),
            ("aac", "audio/aac"),
            ("wav", "audio/wav"),
            ("ogg oga opus", "audio/ogg"),
            ("weba", "audio/webm"),
            ("flac", "audio/flac"),
            (
                "docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
            (
                "xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
            (
                "pptx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ),
            ("zip", "application/zip"),
            ("gz tgz", "application/gzip"),
            ("tar", "application/x-tar"),
            ("7z", "application/x-7z-compressed"),
            ("sqlite sqlite3", "application/vnd.sqlite3"),
            ("wasm", "application/wasm"),
        ];
        for (suffixes, expected) in cases {
            for suffix in suffixes.split_whitespace() {
                assert_eq!(viewer(&[], &format!("empty.{suffix}")), expected);
            }
        }
    }
}
