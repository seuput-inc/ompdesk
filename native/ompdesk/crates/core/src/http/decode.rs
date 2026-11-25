//! An answer's `content-encoding` undone as `fetch` undoes it: at most five layers, in reverse order; gzip, deflate
//! (zlib-wrapped or raw, as the first byte says), Brotli; one coding it does not know leaves the whole body raw. Each
//! layer is bounded by `max_bytes` and by the deadline.

use std::io::{self, Read};
use std::time::Instant;

use flate2::read::{DeflateDecoder, MultiGzDecoder, ZlibDecoder};
use hyper::HeaderMap;
use hyper::body::Bytes;
use hyper::header::CONTENT_ENCODING;

/// Why a body could not be decoded.
#[derive(Debug, PartialEq)]
pub(crate) enum Undecoded {
    /// A coding `fetch` knows that is not decoded here (zstd, Brotli's large-window extension).
    Unsupported,
    /// A layer past `max_bytes`, or the deadline passed.
    Bounds,
    /// A layer is not what its coding says.
    Corrupt,
}

#[derive(Clone, Copy, PartialEq)]
enum Coding {
    Gzip,
    Deflate,
    Brotli,
    Zstd,
    Other,
}

pub(crate) fn decode(
    headers: &HeaderMap,
    mut body: Bytes,
    max_bytes: usize,
    deadline: Instant,
) -> Result<Bytes, Undecoded> {
    let mut layers = [Coding::Other; 5];
    let mut count = 0;
    for header in headers.get_all(CONTENT_ENCODING) {
        for coding in header.to_str().unwrap_or("").split(',').map(str::trim) {
            *layers.get_mut(count).ok_or(Undecoded::Unsupported)? =
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
                        return Err(Undecoded::Unsupported);
                    }
                    expand(
                        brotli::Decompressor::new(&body[..], 4096),
                        max_bytes,
                        deadline,
                    )
                }
                Coding::Zstd => return Err(Undecoded::Unsupported),
                Coding::Other => unreachable!(),
            };
            body = result
                .map_err(|_| Undecoded::Corrupt)?
                .ok_or(Undecoded::Bounds)?;
        }
    }
    if Instant::now() < deadline {
        Ok(body)
    } else {
        Err(Undecoded::Bounds)
    }
}

fn expand(mut reader: impl Read, max_bytes: usize, deadline: Instant) -> io::Result<Option<Bytes>> {
    let mut out = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];
    while Instant::now() < deadline {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) if n > max_bytes - out.len() => return Ok(None),
            Ok(n) => out.extend_from_slice(&chunk[..n]),
            // Node uses Z_SYNC_FLUSH at EOF; a missing gzip trailer need not invalidate a complete body.
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error),
        }
    }
    Ok((Instant::now() < deadline).then(|| out.into()))
}
