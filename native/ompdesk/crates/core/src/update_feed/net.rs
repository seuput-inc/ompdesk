//! The app updater's requests to GitHub (was Electron's `net` in `src/main/updater.ts`, `update-provider.ts` and
//! `update-auth.ts`, and electron-updater's NSIS download): the release lookup and the repository probe
//! (`updateFeed.fetch`), and an installer's download (`updateFeed.download`). They go through the core's client, with
//! the proxy `proxy.resolve` picked and the platform's certificate verifier; a token goes as `authorization: Bearer`
//! and is dropped by `http` at the first redirect to another origin, which is how the API's asset endpoint hands the
//! signed CDN address (the CDN refuses a second credential).
//!
//! - `updateFeed.fetch {url, accept, token?, proxy?, mirror?, timeoutMs}` answers `{status, body, rateLimitRemaining}`
//!   (`rateLimitRemaining` the `x-ratelimit-remaining` header, or null). Past `timeoutMs` (the body included) it fails
//!   `update_timeout`; a transport failure is `update_network` with what failed.
//! - `updateFeed.download {id, url, token?, proxy?, mirror?, file, size, sha512}` answers `{}` once `file` holds bytes
//!   whose SHA-512 (base64) is `sha512`. A `file` already there with that hash is kept and nothing is fetched. Bytes
//!   land in `<file>.partial` first, which a later download continues with `Range` when the server answers 206 at its
//!   end (anything else writes it again from the top) and which stays when the transfer fails, so the next attempt
//!   resumes; a hash that does not match removes it. Failures: `update_status` (message: the HTTP status; a 416 also
//!   removes the partial), `update_stalled` (nothing arrived for 30 s), `update_network`, `update_hash`,
//!   `update_write`. Progress: `updateFeed.downloadProgress {id, received, total}` with `total` = `size`, at most every
//!   100 ms and once at the end.
//! - `mirror` is a test's server on 127.0.0.1 standing in for every host (`setup::net::routed`).

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use http_body_util::BodyExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha512};
use tokio::time::{Instant, timeout};

use crate::http::{self, Request};
use crate::server::{Call, Fault, Reply};
use crate::setup::net::{describe, routed};

/// Every request's user agent: the GitHub API refuses a request without one.
const USER_AGENT: &str = "ompdesk-updater";
/// What GitHub's REST API version the requests are written for.
const API_VERSION: &str = "2022-11-28";
/// A transfer that receives nothing for this long fails; its partial stays for the next attempt.
pub(crate) const IDLE: Duration = Duration::from_secs(30);
/// How often the bytes received so far are reported while they grow.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// The headers of a request to the API: its `accept`, the API version, the token when there is one.
fn headers<'a>(accept: &'a str, bearer: Option<&'a str>) -> Vec<(&'static str, &'a str)> {
    let mut headers = vec![
        ("accept", accept),
        ("x-github-api-version", API_VERSION),
        ("user-agent", USER_AGENT),
    ];
    if let Some(bearer) = bearer {
        headers.push(("authorization", bearer));
    }
    headers
}

fn network(failure: &http::Failure) -> Fault {
    Fault::new("update_network", describe(failure))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchParams {
    url: String,
    accept: String,
    token: Option<String>,
    proxy: Option<String>,
    mirror: Option<String>,
    timeout_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Fetched {
    status: u16,
    body: String,
    rate_limit_remaining: Option<String>,
}

async fn fetch(call: Call) -> Result<Reply, Fault> {
    let params: FetchParams = call.params()?;
    let target = routed(&params.url, params.mirror.as_deref());
    let bearer = params.token.as_ref().map(|token| format!("Bearer {token}"));
    let headers = headers(&params.accept, bearer.as_deref());
    let request = Request {
        url: &target,
        headers: &headers,
        body: None,
        proxy: params.proxy.as_deref(),
    };
    let exchange = async {
        let response = http::open(request)
            .await
            .map_err(|failure| network(&failure))?;
        let status = response.status().as_u16();
        let rate_limit_remaining = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = http_body_util::Limited::new(response.into_body(), http::BODY_MAX)
            .collect()
            .await
            .map_err(|_| Fault::new("update_network", "the connection ended"))?
            .to_bytes();
        // `Response.text()`: UTF-8 with a leading byte order mark dropped, invalid bytes U+FFFD.
        let body = String::from_utf8_lossy(body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&body))
            .into_owned();
        Ok::<_, Fault>(Fetched {
            status,
            body,
            rate_limit_remaining,
        })
    };
    let answer = timeout(Duration::from_millis(params.timeout_ms), exchange)
        .await
        .map_err(|_| {
            Fault::new(
                "update_timeout",
                format!("no answer within {} s", params.timeout_ms / 1000),
            )
        })??;
    Reply::json(&answer)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadParams {
    id: u64,
    url: String,
    token: Option<String>,
    proxy: Option<String>,
    mirror: Option<String>,
    file: String,
    size: u64,
    sha512: String,
}

#[derive(Serialize)]
struct Progress {
    id: u64,
    received: u64,
    total: u64,
}

fn partial_of(file: &str) -> PathBuf {
    PathBuf::from(format!("{file}.partial"))
}

/// Where a transfer starts: the partial's bytes are kept only when the server answered 206 for exactly the bytes after
/// them. Anything else (a server that ignored `Range`, one that answered for other bytes) writes from the top, because
/// appending foreign bytes makes an installer that fails its hash.
pub(crate) fn resume_at(existing: u64, status: u16, content_range: Option<&str>) -> u64 {
    if existing == 0 || status != 206 {
        return 0;
    }
    let start = content_range
        .map(str::trim_start)
        .and_then(|range| {
            range
                .get(..6)
                .filter(|unit| unit.eq_ignore_ascii_case("bytes "))
                .map(|_| &range[6..])
        })
        .map(str::trim_start)
        .and_then(|range| range.split_once('-'))
        .and_then(|(start, _)| start.parse::<u64>().ok());
    if start == Some(existing) { existing } else { 0 }
}

/// The SHA-512 of a whole file, base64 as the release metadata writes it.
fn sha512_of(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha512::new();
    let mut buffer = vec![0_u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(hash.finalize()))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(io::Error::other)?
}

fn write_failed(error: &io::Error) -> Fault {
    Fault::new("update_write", error.to_string())
}

fn stalled() -> Fault {
    Fault::new(
        "update_stalled",
        format!("No data received for {} s", IDLE.as_secs()),
    )
}

async fn download(call: Call) -> Result<Reply, Fault> {
    let params: DownloadParams = call.params()?;
    let file = PathBuf::from(&params.file);
    let partial = partial_of(&params.file);
    let (kept, expected) = (file.clone(), params.sha512.clone());
    // The installer a former download left (electron-updater's cache too): kept when it is this release's.
    if blocking(move || Ok(sha512_of(&kept).ok() == Some(expected)))
        .await
        .unwrap_or(false)
    {
        return Reply::json(&json!({}));
    }
    if let Some(parent) = file
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        let parent = parent.to_path_buf();
        blocking(move || std::fs::create_dir_all(parent))
            .await
            .map_err(|error| write_failed(&error))?;
    }
    let held = partial.clone();
    let mut existing = blocking(move || Ok(std::fs::metadata(held).map(|m| m.len()).unwrap_or(0)))
        .await
        .unwrap_or(0);
    if existing > params.size {
        let stale = partial.clone();
        let _ = blocking(move || std::fs::remove_file(stale)).await;
        existing = 0;
    }

    let target = routed(&params.url, params.mirror.as_deref());
    let bearer = params.token.as_ref().map(|token| format!("Bearer {token}"));
    let range = format!("bytes={existing}-");
    let mut headers = headers("application/octet-stream", bearer.as_deref());
    if existing > 0 {
        headers.push(("range", &range));
    }
    let request = Request {
        url: &target,
        headers: &headers,
        body: None,
        proxy: params.proxy.as_deref(),
    };
    let response = tokio::select! {
        biased;
        () = call.scope.on_cancel() => return Err(Fault::cancelled()),
        response = timeout(IDLE, http::open(request)) => response,
    }
    .map_err(|_| stalled())?
    .map_err(|failure| network(&failure))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) || matches!(status, 204 | 205) {
        // Past the release's bytes: this partial could never complete.
        if status == 416 {
            let stale = partial.clone();
            let _ = blocking(move || std::fs::remove_file(stale)).await;
        }
        return Err(Fault::new("update_status", status.to_string()));
    }
    let content_range = response
        .headers()
        .get("content-range")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let offset = resume_at(existing, status, content_range.as_deref());
    let path = partial.clone();
    let mut out = blocking(move || {
        if offset > 0 {
            OpenOptions::new().append(true).open(path)
        } else {
            File::create(path)
        }
    })
    .await
    .map_err(|error| write_failed(&error))?;

    let (id, total) = (params.id, params.size);
    let report = |received: u64| {
        call.events.send(
            "updateFeed.downloadProgress",
            &Progress {
                id,
                received,
                total,
            },
        );
    };
    let mut received = offset;
    let mut reported_at: Option<Instant> = None;
    report(received);
    let mut body = response.into_body();
    loop {
        let frame = tokio::select! {
            biased;
            () = call.scope.on_cancel() => return Err(Fault::cancelled()),
            frame = timeout(IDLE, body.frame()) => frame.map_err(|_| stalled())?,
        };
        let Some(frame) = frame else { break };
        let frame = frame.map_err(|_| Fault::new("update_network", "the connection ended"))?;
        let Ok(chunk) = frame.into_data() else {
            continue;
        };
        let length = chunk.len() as u64;
        // A chunk at a time: a slow disk holds the body back, never the memory.
        out = blocking(move || {
            out.write_all(&chunk)?;
            Ok(out)
        })
        .await
        .map_err(|error| write_failed(&error))?;
        received += length;
        let now = Instant::now();
        if reported_at.is_none_or(|at| now - at >= PROGRESS_EVERY) || received == total {
            reported_at = Some(now);
            report(received);
        }
    }
    blocking(move || out.sync_all())
        .await
        .map_err(|error| write_failed(&error))?;

    let hashed = partial.clone();
    let actual = blocking(move || sha512_of(&hashed))
        .await
        .map_err(|error| write_failed(&error))?;
    if actual != params.sha512 {
        let bad = partial.clone();
        let _ = blocking(move || std::fs::remove_file(bad)).await;
        return Err(Fault::new(
            "update_hash",
            "the downloaded installer does not match the release's SHA-512",
        ));
    }
    blocking(move || std::fs::rename(partial, file))
        .await
        .map_err(|error| write_failed(&error))?;
    Reply::json(&json!({}))
}

pub(crate) fn register(registry: &mut crate::server::Registry) {
    registry.add("updateFeed.fetch", |call| Box::pin(fetch(call)));
    registry.add("updateFeed.download", |call| Box::pin(download(call)));
}
