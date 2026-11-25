use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha512};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};
use tokio::net::TcpListener;

use super::net::resume_at;
use crate::http::tests::read_request;
use crate::server::Registry;

#[test]
fn continues_a_partial_only_when_the_server_answers_for_exactly_the_bytes_it_holds() {
    // planInstallerTransfer's cases (updater-state.test.ts › manual installer transfer).
    assert_eq!(resume_at(500, 206, Some("bytes 500-999/1000")), 500);
    assert_eq!(resume_at(0, 206, Some("bytes 0-999/1000")), 0);
    assert_eq!(resume_at(500, 200, None), 0);
    assert_eq!(resume_at(500, 206, None), 0);
    assert_eq!(resume_at(500, 206, Some("bytes 0-999/1000")), 0);
    assert_eq!(resume_at(500, 206, Some("BYTES 500-999/1000")), 500);
}

type Lines = BufReader<ReadHalf<DuplexStream>>;

struct Core {
    lines: Lines,
    write: WriteHalf<DuplexStream>,
    next_id: u64,
}

impl Core {
    async fn start() -> Core {
        let (client, server) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server);
        let mut registry = Registry::default();
        super::register(&mut registry);
        tokio::spawn(crate::serve(server_read, server_write, registry));
        let (client_read, write) = tokio::io::split(client);
        let mut core = Core {
            lines: BufReader::new(client_read),
            write,
            next_id: 0,
        };
        assert_eq!(core.next().await["event"], "ready");
        core
    }

    async fn next(&mut self) -> Value {
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(60), self.lines.read_line(&mut line))
            .await
            .expect("the core sent nothing for 60 s")
            .unwrap();
        serde_json::from_str(&line).unwrap()
    }

    /// Every frame up to the answer of the call, which is the last.
    async fn call(&mut self, method: &str, params: Value) -> Vec<Value> {
        self.next_id += 1;
        let id = self.next_id;
        let frame = json!({ "id": id, "method": method, "params": params });
        self.write
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .unwrap();
        let mut frames = Vec::new();
        loop {
            let frame = self.next().await;
            let done = frame["id"] == id;
            frames.push(frame);
            if done {
                return frames;
            }
        }
    }
}

/// What a route answers: its status line's code, its headers, and its body.
#[derive(Clone)]
struct Answer {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn ok(body: &[u8]) -> Answer {
        Answer {
            status: 200,
            headers: vec![("content-length", body.len().to_string())],
            body: body.to_vec(),
        }
    }
}

/// Each request a server saw: its path and its lowercased header lines.
type Seen = Arc<Mutex<Vec<(String, Vec<String>)>>>;

struct Server {
    url: String,
    seen: Seen,
}

/// A server on 127.0.0.1 answering each path with `route(path, header lines)` (404 for `None`).
async fn serve(
    route: impl Fn(&str, &[String]) -> Option<Answer> + Send + Sync + 'static,
) -> Server {
    let route = Arc::new(route);
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let seen: Seen = Arc::default();
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let route = Arc::clone(&route);
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                let request = String::from_utf8_lossy(&read_request(&mut socket).await).to_string();
                let mut lines = request.split("\r\n");
                let path = lines
                    .next()
                    .and_then(|first| first.split(' ').nth(1))
                    .unwrap_or_default()
                    .to_owned();
                let headers: Vec<String> = lines
                    .take_while(|line| !line.is_empty())
                    .map(str::to_ascii_lowercase)
                    .collect();
                log.lock().unwrap().push((path.clone(), headers.clone()));
                let answer = route(&path, &headers).unwrap_or(Answer {
                    status: 404,
                    headers: vec![("content-length", "0".into())],
                    body: Vec::new(),
                });
                let mut head = format!("HTTP/1.1 {} X\r\nconnection: close\r\n", answer.status);
                for (name, value) in &answer.headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&answer.body).await;
                // A route that answers `x-test-stall` keeps the connection open after its bytes: a stalled body.
                if answer
                    .headers
                    .iter()
                    .any(|(name, _)| *name == "x-test-stall")
                {
                    tokio::time::sleep(Duration::from_secs(120)).await;
                }
                let _ = socket.shutdown().await;
            });
        }
    });
    Server { url, seen }
}

fn temp(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("ompdesk-core-update-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn sha512(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes))
}

fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn has(headers: &[String], line: &str) -> bool {
    headers.iter().any(|header| header == line)
}

/// Larger than the 1 MiB the hash reads at a time, and not a multiple of it.
fn installer() -> Vec<u8> {
    (0..1_048_583_u32).map(|n| (n % 251) as u8).collect()
}

fn download(server: &Server, file: &Path, body: &[u8], extra: Value) -> Value {
    let mut params = json!({
        "id": 4,
        "url": "https://api.github.test/repos/o/r/releases/assets/9",
        "file": file.to_string_lossy(),
        "size": body.len(),
        "sha512": sha512(body),
        "mirror": server.url,
    });
    for (key, value) in extra.as_object().unwrap() {
        params[key] = value.clone();
    }
    params
}

#[tokio::test]
async fn fetch_sends_the_api_headers_and_answers_the_status_body_and_rate_limit() {
    let server = serve(|path, _| {
        (path == "/api.github.test/repos/o/r/releases/latest").then(|| {
            let mut answer = Answer::ok("\u{feff}{\"tag_name\":\"v1\"}".as_bytes());
            answer.status = 403;
            answer.headers.push(("x-ratelimit-remaining", "0".into()));
            answer
        })
    })
    .await;
    let mut core = Core::start().await;
    let frames = core
        .call(
            "updateFeed.fetch",
            json!({
                "url": "https://api.github.test/repos/o/r/releases/latest",
                "accept": "application/vnd.github+json",
                "token": "abc",
                "mirror": server.url,
                "timeoutMs": 15_000,
            }),
        )
        .await;
    let answer = &frames.last().unwrap()["result"];
    assert_eq!(answer["status"], 403);
    assert_eq!(answer["body"], "{\"tag_name\":\"v1\"}");
    assert_eq!(answer["rateLimitRemaining"], "0");
    let headers = server.seen.lock().unwrap()[0].1.clone();
    assert!(has(&headers, "accept: application/vnd.github+json"));
    assert!(has(&headers, "x-github-api-version: 2022-11-28"));
    assert!(has(&headers, "user-agent: ompdesk-updater"));
    assert!(has(&headers, "authorization: bearer abc"));

    let frames = core
        .call(
            "updateFeed.fetch",
            json!({"url": "https://api.github.test/none", "accept": "a", "mirror": server.url, "timeoutMs": 15_000}),
        )
        .await;
    let answer = &frames.last().unwrap()["result"];
    assert_eq!(answer["status"], 404);
    assert_eq!(answer["rateLimitRemaining"], Value::Null);
    assert!(
        !server.seen.lock().unwrap()[1]
            .1
            .iter()
            .any(|line| line.starts_with("authorization:")),
        "no token, no authorization"
    );
}

#[tokio::test]
async fn fetch_fails_on_time_when_nothing_answers() {
    // Accepts and never answers.
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket);
        }
    });
    let mut core = Core::start().await;
    let frames = core
        .call(
            "updateFeed.fetch",
            json!({"url": "https://api.github.test/x", "accept": "a", "mirror": url, "timeoutMs": 300}),
        )
        .await;
    assert_eq!(frames.last().unwrap()["error"]["code"], "update_timeout");
}

#[tokio::test]
async fn downloads_through_the_signed_redirect_without_the_token_then_checks_the_sha512() {
    let body = installer();
    let cdn = {
        let body = body.clone();
        serve(move |path, _| (path == "/signed").then(|| Answer::ok(&body))).await
    };
    let cdn_url = cdn.url.clone();
    let api = serve(move |path, _| {
        (path == "/api.github.test/repos/o/r/releases/assets/9").then(|| Answer {
            status: 302,
            headers: vec![
                ("location", format!("{cdn_url}/signed")),
                ("content-length", "0".into()),
            ],
            body: Vec::new(),
        })
    })
    .await;
    let dir = temp("redirect");
    let file = dir.join("ompdesk-windows-setup.exe");
    let mut core = Core::start().await;
    let frames = core
        .call(
            "updateFeed.download",
            download(&api, &file, &body, json!({"token": "abc"})),
        )
        .await;
    assert_eq!(frames.last().unwrap()["ok"], true, "{frames:?}");
    assert_eq!(std::fs::read(&file).unwrap(), body);
    assert_eq!(listing(&dir), vec!["ompdesk-windows-setup.exe"]);
    let progress: Vec<u64> = frames
        .iter()
        .filter(|frame| frame["event"] == "updateFeed.downloadProgress")
        .map(|frame| {
            assert_eq!(frame["data"]["id"], 4);
            assert_eq!(frame["data"]["total"], body.len());
            frame["data"]["received"].as_u64().unwrap()
        })
        .collect();
    assert_eq!(progress.first(), Some(&0));
    assert_eq!(progress.last(), Some(&(body.len() as u64)));
    let api_seen = api.seen.lock().unwrap()[0].1.clone();
    assert!(has(&api_seen, "authorization: bearer abc"));
    assert!(has(&api_seen, "accept: application/octet-stream"));
    let cdn_seen = cdn.seen.lock().unwrap()[0].1.clone();
    assert!(
        !cdn_seen
            .iter()
            .any(|line| line.starts_with("authorization:")),
        "the CDN never sees the token"
    );

    // Already there with the release's hash: nothing is fetched again.
    let frames = core
        .call(
            "updateFeed.download",
            download(&api, &file, &body, json!({})),
        )
        .await;
    assert_eq!(frames.last().unwrap()["ok"], true);
    assert_eq!(api.seen.lock().unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn continues_a_partial_where_the_server_resumes_it_and_rewrites_where_it_does_not() {
    let body = installer();
    let honour = Arc::new(Mutex::new(true));
    let server = {
        let (body, honour) = (body.clone(), Arc::clone(&honour));
        serve(move |_, headers| {
            let start = headers
                .iter()
                .find_map(|line| line.strip_prefix("range: bytes="))
                .and_then(|range| range.trim_end_matches('-').parse::<usize>().ok());
            match start {
                Some(start) if *honour.lock().unwrap() => Some(Answer {
                    status: 206,
                    headers: vec![
                        (
                            "content-range",
                            format!("bytes {start}-{}/{}", body.len() - 1, body.len()),
                        ),
                        ("content-length", (body.len() - start).to_string()),
                    ],
                    body: body[start..].to_vec(),
                }),
                _ => Some(Answer::ok(&body)),
            }
        })
        .await
    };
    let mut core = Core::start().await;
    for honoured in [true, false] {
        *honour.lock().unwrap() = honoured;
        let dir = temp(if honoured { "resume" } else { "rewrite" });
        let file = dir.join("ompdesk-1.2.3-arm64.dmg");
        let partial = dir.join("ompdesk-1.2.3-arm64.dmg.partial");
        // What an interrupted transfer left: the release's first 1000 bytes.
        std::fs::write(&partial, &body[..1000]).unwrap();
        let frames = core
            .call(
                "updateFeed.download",
                download(&server, &file, &body, json!({})),
            )
            .await;
        assert_eq!(frames.last().unwrap()["ok"], true, "{frames:?}");
        assert_eq!(std::fs::read(&file).unwrap(), body);
        assert_eq!(listing(&dir), vec!["ompdesk-1.2.3-arm64.dmg"]);
        let _ = std::fs::remove_dir_all(dir);
    }
    let seen = server.seen.lock().unwrap();
    assert!(
        seen.iter()
            .all(|(_, headers)| has(headers, "range: bytes=1000-"))
    );
}

#[tokio::test]
async fn keeps_no_bytes_that_fail_the_hash_and_keeps_the_partial_of_a_refused_request() {
    let body = installer();
    let server = {
        let body = body.clone();
        serve(move |path, _| match path {
            "/api.github.test/gone" => Some(Answer {
                status: 503,
                headers: vec![("content-length", "0".into())],
                body: Vec::new(),
            }),
            "/api.github.test/past" => Some(Answer {
                status: 416,
                headers: vec![("content-length", "0".into())],
                body: Vec::new(),
            }),
            _ => Some(Answer::ok(&body)),
        })
        .await
    };
    let dir = temp("refusals");
    let file = dir.join("setup.exe");
    let partial = dir.join("setup.exe.partial");
    let mut core = Core::start().await;

    let mut wrong = download(&server, &file, &body, json!({}));
    wrong["sha512"] = sha512(b"another installer").into();
    let frames = core.call("updateFeed.download", wrong).await;
    assert_eq!(frames.last().unwrap()["error"]["code"], "update_hash");
    assert_eq!(listing(&dir), Vec::<String>::new());

    std::fs::write(&partial, &body[..10]).unwrap();
    let frames = core
        .call(
            "updateFeed.download",
            download(
                &server,
                &file,
                &body,
                json!({"url": "https://api.github.test/gone"}),
            ),
        )
        .await;
    let error = &frames.last().unwrap()["error"];
    assert_eq!(error["code"], "update_status");
    assert_eq!(error["message"], "503");
    assert_eq!(
        listing(&dir),
        vec!["setup.exe.partial"],
        "the next attempt resumes"
    );

    let frames = core
        .call(
            "updateFeed.download",
            download(
                &server,
                &file,
                &body,
                json!({"url": "https://api.github.test/past"}),
            ),
        )
        .await;
    assert_eq!(frames.last().unwrap()["error"]["message"], "416");
    assert_eq!(
        listing(&dir),
        Vec::<String>::new(),
        "a 416 partial can never complete"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_partial_longer_than_the_release_starts_over() {
    let body = installer();
    let server = {
        let body = body.clone();
        serve(move |_, _| Some(Answer::ok(&body))).await
    };
    let dir = temp("longer");
    let file = dir.join("setup.exe");
    std::fs::write(dir.join("setup.exe.partial"), vec![0_u8; body.len() + 1]).unwrap();
    let mut core = Core::start().await;
    let frames = core
        .call(
            "updateFeed.download",
            download(&server, &file, &body, json!({})),
        )
        .await;
    assert_eq!(frames.last().unwrap()["ok"], true);
    assert!(
        server.seen.lock().unwrap()[0]
            .1
            .iter()
            .all(|line| !line.starts_with("range:"))
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_body_that_stops_arriving_fails_as_stalled_and_its_bytes_stay_for_the_next_attempt() {
    let body = installer();
    let server = {
        let half = body[..1000].to_vec();
        let total = body.len();
        serve(move |_, _| {
            Some(Answer {
                status: 200,
                headers: vec![
                    ("content-length", total.to_string()),
                    ("x-test-stall", String::new()),
                ],
                body: half.clone(),
            })
        })
        .await
    };
    let dir = temp("stalled");
    let file = dir.join("setup.exe");
    let mut core = Core::start().await;
    let frames = core
        .call(
            "updateFeed.download",
            download(&server, &file, &body, json!({})),
        )
        .await;
    let error = &frames.last().unwrap()["error"];
    assert_eq!(error["code"], "update_stalled");
    assert_eq!(error["message"], "No data received for 1 s");
    assert_eq!(
        std::fs::read(dir.join("setup.exe.partial")).unwrap(),
        body[..1000]
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[tokio::test]
async fn never_writes_through_a_link_in_place_of_the_partial() {
    let body = installer();
    let server = {
        let body = body.clone();
        serve(move |_, _| Some(Answer::ok(&body))).await
    };
    let dir = temp("linked");
    let file = dir.join("setup.exe");
    let other = dir.join("other");
    std::fs::write(&other, b"keep").unwrap();
    std::os::unix::fs::symlink(&other, dir.join("setup.exe.partial")).unwrap();
    let mut core = Core::start().await;
    let frames = core
        .call(
            "updateFeed.download",
            download(&server, &file, &body, json!({})),
        )
        .await;
    assert_eq!(frames.last().unwrap()["error"]["code"], "update_write");
    assert_eq!(std::fs::read(&other).unwrap(), b"keep");
    assert!(server.seen.lock().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(dir);
}
