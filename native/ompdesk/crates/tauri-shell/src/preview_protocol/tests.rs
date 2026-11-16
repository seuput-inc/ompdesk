use std::collections::VecDeque;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::TcpStream;
use tokio::process::{ChildStdin, ChildStdout, Command};
use url::{Position, Url};

use super::Gateway;
use crate::{host, sessions};

const BROWSER_DOCUMENT: &str = "omp-visual://browser-fixture/browser/index.html";

struct LocalNavigation {
    gateway: Arc<Gateway>,
    approved: Arc<std::sync::Mutex<Vec<String>>>,
}

impl shell_preview::NavigationHandler for LocalNavigation {
    fn allow(
        &self,
        navigation: shell_preview::Navigation,
    ) -> Pin<Box<dyn Future<Output = bool> + Send>> {
        let gateway = self.gateway.clone();
        let approved = self.approved.clone();
        Box::pin(async move {
            if navigation.url == "about:blank" {
                return true;
            }
            match gateway.original_url("visual-a", &navigation.url).await {
                Ok(Some(original)) if original == BROWSER_DOCUMENT => {
                    approved.lock().unwrap().push(original);
                    true
                }
                _ => false,
            }
        })
    }
}

fn request(call: host::Call) {
    HOST_CONNECTED.store(true, Ordering::Release);
    if let Some(call) = sessions::dispatch(call) {
        call.unsupported();
    }
}

fn event(name: &str, data: Value, bytes: Option<Vec<u8>>) {
    sessions::protocol::event(name, &data, bytes);
}
static HOST_CONNECTED: AtomicBool = AtomicBool::new(false);
static HOST_CLOSED: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);

fn closed() {
    sessions::protocol::disconnected();
    HOST_CLOSED.notify_one();
}

struct Scratch {
    dir: PathBuf,
    #[cfg(unix)]
    socket: Option<PathBuf>,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(socket) = &self.socket {
            let _ = std::fs::remove_file(socket);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct Fixture {
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
    lines: Lines<BufReader<ChildStdout>>,
    pending: VecDeque<Value>,
}

impl Fixture {
    async fn command(&mut self, command: &str) {
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(format!("{}\n", json!(command)).as_bytes())
            .await
            .unwrap();
        stdin.flush().await.unwrap();
    }

    async fn event(&mut self, name: &str, path: Option<&str>) -> Value {
        loop {
            if let Some(index) = self
                .pending
                .iter()
                .position(|value| value["event"] == name && path.is_none_or(|p| value["path"] == p))
            {
                return self.pending.remove(index).unwrap();
            }
            let line = self
                .lines
                .next_line()
                .await
                .unwrap()
                .expect("fixture exited before event");
            self.pending
                .push_back(serde_json::from_str(&line).expect("fixture output is JSON"));
        }
    }
}

async fn connect(mapped: &str, method: &str, headers: &str) -> TcpStream {
    let url = Url::parse(mapped).unwrap();
    let port = url.port().unwrap();
    let host = format!("{}:{port}", url.host_str().unwrap());
    let target = &url[Position::BeforePath..Position::AfterQuery];
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream
        .write_all(
            format!("{method} {target} HTTP/1.1\r\nHost: {host}\r\n{headers}\r\n").as_bytes(),
        )
        .await
        .unwrap();
    stream
}

async fn head(stream: &mut (impl tokio::io::AsyncRead + Unpin)) -> String {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        bytes.push(stream.read_u8().await.unwrap());
        assert!(bytes.len() < 32768);
    }
    String::from_utf8(bytes).unwrap().to_ascii_lowercase()
}

async fn complete(mapped: &str, method: &str, headers: &str) -> (String, Vec<u8>) {
    let mut stream = connect(mapped, method, headers).await;
    let headers = head(&mut stream).await;
    let mut body = Vec::new();
    stream.read_to_end(&mut body).await.unwrap();
    (headers, body)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires isolated process and trusted OMPDESK_GATEWAY_TEST_BUN, OMPDESK_GATEWAY_TEST_BROWSER and OMPDESK_GATEWAY_TEST_SCRATCH"]
async fn real_node_gateway_loopback_and_credit() {
    let bun = std::env::var_os("OMPDESK_GATEWAY_TEST_BUN").expect("trusted Bun path required");
    let executable = PathBuf::from(
        std::env::var_os("OMPDESK_GATEWAY_TEST_BROWSER").expect("trusted browser path required"),
    );
    assert!(executable.is_absolute(), "browser path must be absolute");
    let scratch = PathBuf::from(
        std::env::var_os("OMPDESK_GATEWAY_TEST_SCRATCH").expect("scratch path required"),
    );
    assert!(scratch.is_absolute());
    let dir = scratch.join(format!("gateway-{}", std::process::id()));
    std::fs::create_dir(&dir).unwrap();
    #[cfg(unix)]
    let socket = scratch
        .join(format!("g-{}.sock", std::process::id()))
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    let socket = format!(r"\\.\pipe\ompdesk-gateway-proof-{}", std::process::id());
    let mut scratch_guard = Scratch {
        dir: dir.clone(),
        #[cfg(unix)]
        socket: None,
    };
    let media = dir.join("media.wav");
    std::fs::write(&media, b"0123456789").unwrap();
    sessions::init(dir.clone()).unwrap();
    sessions::protocol::declare_schemes(&json!({"schemes":[
        {"scheme":"omp-media","privileges":{"standard":true,"secure":true,"stream":true}},
        {"scheme":"omp-visual","privileges":{"standard":true,"secure":true,"supportFetchAPI":true}}
    ]}))
    .unwrap();
    let gateway = Arc::new(Gateway::new());
    let app_base = gateway.reserve_app_media("app").await.unwrap();
    let visual_a = gateway.reserve_preview_partition("visual-a").await.unwrap();
    let visual_b = gateway.reserve_preview_partition("visual-b").await.unwrap();
    let _visual_system = gateway
        .reserve_preview_partition("visual-system")
        .await
        .unwrap();
    let consumer = sessions::protocol::install_gateway_consumer().unwrap();
    gateway.activate(consumer).await.unwrap();

    let listener = shell_core::conn::Listener::bind(&socket).unwrap();
    #[cfg(unix)]
    {
        scratch_guard.socket = Some(PathBuf::from(&socket));
    }
    #[cfg(windows)]
    let _ = &mut scratch_guard;
    let navigation = Arc::new(LocalNavigation {
        gateway: gateway.clone(),
        approved: Arc::new(std::sync::Mutex::new(Vec::new())),
    });
    let browser = match shell_preview::Browser::launch_with_hooks(
        shell_preview::LaunchConfig {
            executable,
            profile_root: dir.join("browser"),
            command_timeout: Duration::from_secs(15),
        },
        navigation.clone(),
        Arc::new(sessions::preview::Initializer),
    )
    .await
    {
        Ok(browser) => Arc::new(browser),
        Err(error) => {
            let _ = gateway.shutdown().await;
            panic!("browser launch failed: {error}");
        }
    };
    if let Err(error) = sessions::preview::install(browser.clone(), gateway.clone()) {
        let _ = gateway.shutdown().await;
        let _ = browser.shutdown().await;
        panic!("browser install failed: {error}");
    }
    let token = "gateway-proof-token";
    host::serve(
        listener,
        token.into(),
        json!({}),
        host::Handlers {
            request,
            event,
            closed,
        },
    );
    let script =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/preview_protocol/node-fixture.mjs");
    let child = Command::new(bun)
        .arg(script)
        .arg(&socket)
        .arg(token)
        .arg(&media)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            let _ = gateway.shutdown().await;
            let _ = browser.shutdown().await;
            panic!("fixture spawn failed: {error}");
        }
    };
    let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take().unwrap()));
    let stdout = child.stdout.take().unwrap();
    let fixture = Fixture {
        stdin: stdin.clone(),
        lines: BufReader::new(stdout).lines(),
        pending: VecDeque::new(),
    };
    let mut scenario = tokio::spawn(exercise(
        gateway.clone(),
        browser.clone(),
        navigation,
        app_base,
        visual_a,
        visual_b,
        fixture,
    ));
    let outcome = match tokio::time::timeout(Duration::from_secs(45), &mut scenario).await {
        Ok(result) => Some(result),
        Err(_) => {
            scenario.abort();
            let _ = scenario.await;
            None
        }
    };
    let shutdown = gateway.shutdown().await;
    let browser_shutdown = browser.shutdown().await;
    let success = matches!(&outcome, Some(Ok(())));
    let quit = if success {
        stdin.lock().await.write_all(b"\"quit\"\n").await
    } else {
        Ok(())
    };
    drop(stdin);
    let status = if success {
        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(result) => result,
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                Err(std::io::Error::other("fixture did not exit after quit"))
            }
        }
    } else {
        let _ = child.start_kill();
        child.wait().await
    };
    let host_closed = if HOST_CONNECTED.load(Ordering::Acquire) {
        tokio::time::timeout(Duration::from_secs(5), HOST_CLOSED.notified())
            .await
            .is_ok()
    } else {
        true
    };
    match outcome {
        Some(Err(error)) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Some(Err(error)) => panic!("gateway scenario failed: {error}"),
        None => panic!("gateway proof timed out"),
        Some(Ok(())) => {}
    }
    quit.expect("fixture quit failed");
    shutdown.expect("gateway shutdown failed");
    browser_shutdown.expect("browser shutdown failed");
    assert!(
        status.expect("fixture wait failed").success(),
        "fixture exited unsuccessfully"
    );
    assert!(host_closed, "host reader did not report connection closure");
}

async fn exercise(
    gateway: Arc<Gateway>,
    browser: Arc<shell_preview::Browser>,
    navigation: Arc<LocalNavigation>,
    app_base: String,
    visual_a: super::PreviewTransport,
    visual_b: super::PreviewTransport,
    mut fixture: Fixture,
) {
    let ready = fixture.event("ready", None).await;
    let protected_a = sessions::preview::protected_transport("visual-a").unwrap();
    let protected_b = sessions::preview::protected_transport("visual-b").unwrap();
    assert!(protected_a.is_live());
    assert!(protected_b.is_live());
    assert_eq!(protected_a.proxy_bypass_rule, visual_a.proxy_bypass_rule);
    assert_eq!(protected_b.proxy_bypass_rule, visual_b.proxy_bypass_rule);
    assert_ne!(protected_a.proxy_bypass_rule, protected_b.proxy_bypass_rule);
    assert!(sessions::preview::protected_transport("uncreated").is_err());
    assert!(sessions::preview::protected_transport("visual-system").is_err());
    let system_original = "omp-visual://example/system";
    assert!(
        gateway
            .map_url("visual-system", system_original)
            .await
            .is_err()
    );
    // Issue a capability below the mapping gate to exercise HTTP admission independently.
    let system_mapped = {
        let state = gateway.state.lock().await;
        let super::State::Live(live) = &*state else {
            panic!("gateway stopped");
        };
        let origin = live.preview.get("visual-system").unwrap();
        let super::mapping::Route::Preview(routes) = &origin.config.route else {
            panic!("system route is not Preview");
        };
        let source = super::mapping::SourceOrigin::parse(
            "visual-system",
            &Url::parse(system_original).unwrap(),
        )
        .unwrap();
        let authority = routes.map_authority(source, origin.port).unwrap();
        format!("http://{authority}/system")
    };
    let mut denied = connect(&system_mapped, "GET", "").await;
    assert!(head(&mut denied).await.starts_with("http/1.1 404"));
    drop(denied);
    let media_url = ready["mediaUrl"].as_str().unwrap();
    let mapped_media = gateway.app_media_url("app", media_url).await.unwrap();
    assert!(mapped_media.starts_with(&app_base));
    assert_eq!(
        gateway
            .original_url("", &mapped_media)
            .await
            .unwrap()
            .as_deref(),
        Some(media_url)
    );
    assert!(
        gateway
            .original_url("visual-a", &mapped_media)
            .await
            .is_err()
    );
    assert!(gateway.original_url("app", "http://00000000000000000000000000000000.00000000000000000000000000000000.00000000000000000000000000000000.00000000000000000000000000000000.localhost:1/a").await.is_err());

    let original = "omp-visual://example/stream?q=%2F";
    let mapped = gateway
        .map_url("visual-a", original)
        .await
        .unwrap()
        .unwrap();
    let second = gateway
        .map_url("visual-b", original)
        .await
        .unwrap()
        .unwrap();
    let other_origin = gateway
        .map_url("visual-a", "omp-visual://other/stream?q=%2F")
        .await
        .unwrap()
        .unwrap();
    assert_ne!(
        Url::parse(&mapped).unwrap().origin(),
        Url::parse(&second).unwrap().origin()
    );
    assert_ne!(
        Url::parse(&mapped).unwrap().origin(),
        Url::parse(&other_origin).unwrap().origin()
    );
    let first_url = Url::parse(&mapped).unwrap();
    let second_url = Url::parse(&second).unwrap();
    let other_url = Url::parse(&other_origin).unwrap();
    assert_eq!(first_url.port(), other_url.port());
    assert_ne!(first_url.port(), second_url.port());
    let namespace = |url: &Url| {
        let labels: Vec<_> = url.host_str().unwrap().split('.').collect();
        assert_eq!(labels.len(), 5);
        assert_eq!(labels[4], "localhost");
        for label in &labels[..4] {
            assert_eq!(label.len(), 32);
            assert!(
                label
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            );
        }
        format!(
            "*.{}.{}.localhost:{}",
            labels[2],
            labels[3],
            url.port().unwrap()
        )
    };
    assert_eq!(visual_a.proxy_bypass_rule, namespace(&first_url));
    assert_eq!(visual_a.proxy_bypass_rule, namespace(&other_url));
    assert_eq!(visual_b.proxy_bypass_rule, namespace(&second_url));
    assert_ne!(visual_a.proxy_bypass_rule, visual_b.proxy_bypass_rule);
    assert!(visual_a.is_live());
    assert!(visual_b.is_live());
    assert_eq!(
        gateway
            .original_url("visual-a", &mapped)
            .await
            .unwrap()
            .as_deref(),
        Some(original)
    );
    assert!(gateway.original_url("visual-b", &mapped).await.is_err());

    let browser_mapped = gateway
        .map_url("visual-a", BROWSER_DOCUMENT)
        .await
        .unwrap()
        .unwrap();
    let context = sessions::preview::context_for("visual-a").await.unwrap();
    let page = browser
        .create_page(
            &context,
            shell_preview::Viewport {
                width: 320,
                height: 240,
                device_scale_factor: 1.0,
            },
        )
        .await
        .unwrap();
    page.command("Page.setLifecycleEventsEnabled", json!({"enabled":true}))
        .await
        .unwrap();
    let mut events = browser.subscribe();
    let navigated = page.navigate(&browser_mapped).await.unwrap();
    let loader = navigated["loaderId"].as_str().expect("document loader");
    loop {
        let event = events.recv().await.expect("actual browser lifecycle event");
        if event.session_id.as_deref() == Some(page.session_id.as_str())
            && event.method == "Page.lifecycleEvent"
            && event.params["name"] == "load"
            && event.params["loaderId"] == loader
        {
            break;
        }
    }
    let rendered = page
        .evaluate(
            r##"(async () => {
                const image = document.querySelector("#pixel");
                await image.decode();
                const data = await fetch("./assets/data.json").then(response => {
                    if (!response.ok) throw new Error(`fixture fetch ${response.status}`);
                    return response.json();
                });
                const bounds = image.getBoundingClientRect();
                return {
                    url: location.href,
                    text: document.querySelector("#fixture").textContent,
                    color: getComputedStyle(document.querySelector("#fixture")).color,
                    image: [image.naturalWidth, image.naturalHeight, bounds.width, bounds.height],
                    inlineRan: document.documentElement.dataset.inlineRan === "yes",
                    data
                };
            })()"##,
            false,
        )
        .await
        .unwrap();
    assert_eq!(rendered["url"], browser_mapped);
    assert_eq!(rendered["text"], "browser-route-ready");
    assert_eq!(rendered["color"], "rgb(17, 34, 51)");
    assert_eq!(rendered["image"], json!([2, 3, 6, 9]));
    assert_eq!(rendered["inlineRan"], false, "CSP must block inline script");
    assert_eq!(rendered["data"], json!({"route":"actual-browser-network"}));
    let mut expected: std::collections::HashSet<&str> = [
        BROWSER_DOCUMENT,
        "omp-visual://browser-fixture/browser/assets/fixture.js",
        "omp-visual://browser-fixture/browser/assets/fixture.css",
        "omp-visual://browser-fixture/assets/pixel.svg",
        "omp-visual://browser-fixture/browser/assets/data.json",
    ].into_iter().collect();
    while !expected.is_empty() {
        let requested = fixture.event("request", None).await;
        if requested["url"].as_str().is_some_and(|url| expected.remove(url)) {
            assert_eq!(requested["partition"], "visual-a");
            assert_eq!(requested["method"], "GET");
        }
    }
    page.close().await.unwrap();
    assert!(navigation.approved.lock().unwrap().iter().any(|url| url == BROWSER_DOCUMENT));

    assert!(gateway.is_gateway_origin(&mapped).await);
    let mapped_url = Url::parse(&mapped).unwrap();
    let mut wrong_host = TcpStream::connect(("127.0.0.1", mapped_url.port().unwrap()))
        .await
        .unwrap();
    wrong_host
        .write_all(b"GET /stream HTTP/1.1\r\nHost: attacker.example\r\n\r\n")
        .await
        .unwrap();
    assert!(head(&mut wrong_host).await.starts_with("http/1.1 404"));

    let mut stream = connect(&mapped, "POST", "Accept: application/octet-stream\r\nCookie: private\r\nAuthorization: secret\r\nContent-Length: 0\r\n").await;
    let headers = head(&mut stream).await;
    assert!(headers.starts_with("http/1.1 201"));
    assert!(headers.contains("x-fixture: yes\r\n"));
    assert!(!headers.contains("set-cookie:"));
    let received = fixture.event("request", None).await;
    assert_eq!(received["partition"], "visual-a");
    assert_eq!(received["url"], original);
    assert_eq!(received["method"], "POST");
    let forwarded = received["headers"].as_array().unwrap();
    assert!(
        forwarded
            .iter()
            .any(|h| h[0] == "accept" && h[1] == "application/octet-stream")
    );
    assert!(
        !forwarded
            .iter()
            .any(|h| h[0] == "cookie" || h[0] == "authorization")
    );
    fixture.event("first", Some("/stream")).await;
    let mut first = [0; 9];
    stream.read_exact(&mut first).await.unwrap();
    assert_eq!(&first, b"4\r\n\x00\xffA\x80\r\n");
    assert!(!fixture.pending.iter().any(|v| v["event"] == "end"));
    fixture.command("release").await;
    fixture.event("end", Some("/stream")).await;
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).await.unwrap();
    assert_eq!(rest, b"3\r\nB\x00\xfe\r\n0\r\n\r\n");

    let (headers, bytes) = complete(&mapped_media, "GET", "Range: bytes=2-5\r\n").await;
    assert!(headers.starts_with("http/1.1 206"));
    assert!(headers.contains("content-range: bytes 2-5/10\r\n"));
    assert!(headers.contains("content-length: 4\r\n"));
    assert_eq!(bytes, b"2345");
    let (headers, bytes) = complete(&mapped_media, "HEAD", "").await;
    assert!(headers.starts_with("http/1.1 200"));
    assert!(headers.contains("content-length: 10\r\n"));
    assert!(bytes.is_empty());
    let tampered = mapped_media.replace("url=omp-media", "url=omp-mediB");
    assert_ne!(tampered, mapped_media);
    assert!(
        complete(&tampered, "GET", "")
            .await
            .0
            .starts_with("http/1.1 404")
    );
    fixture.command("release-media").await;
    assert_eq!(fixture.event("media-released", None).await["size"], 0);
    assert!(
        complete(&mapped_media, "GET", "")
            .await
            .0
            .starts_with("http/1.1 404")
    );

    let cancel_url = gateway
        .map_url("visual-a", "omp-visual://example/cancel")
        .await
        .unwrap()
        .unwrap();
    let mut cancelled = connect(&cancel_url, "GET", "").await;
    assert!(head(&mut cancelled).await.starts_with("http/1.1 201"));
    let mut chunk = [0; 9];
    cancelled.read_exact(&mut chunk).await.unwrap();
    assert_eq!(&chunk, b"4\r\n\x00\xffA\x80\r\n");
    drop(cancelled);
    fixture.event("cancel", Some("/cancel")).await;
    let response = sessions::protocol::open(sessions::protocol::Request {
        partition: "visual-a".into(),
        scheme: "omp-visual".into(),
        url: "omp-visual://example/credit".into(),
        method: "GET".into(),
        headers: Vec::new(),
        body: Vec::new(),
    })
    .await
    .unwrap();
    let (mut reader, mut writer) = tokio::io::duplex(1024);
    let mut writing = tokio::task::JoinSet::new();
    writing.spawn(async move { super::http::write_response(&mut writer, response, false).await });
    // The 1 MiB window allows 16 chunks, plus one pending read and one stream prefetch.
    for expected in 1..=17 {
        assert_eq!(fixture.event("pull", None).await["count"], expected);
    }
    fixture.command("credit-count").await;
    let count = fixture.event("credit-count", None).await["count"]
        .as_u64()
        .unwrap();
    assert!(
        count <= 18,
        "producer exceeded the 1 MiB window plus two 64 KiB prefetches: {count}"
    );
    assert!(head(&mut reader).await.starts_with("http/1.1 200"));
    let mut first_frame = vec![0; 7 + 65536 + 2];
    reader.read_exact(&mut first_frame).await.unwrap();
    assert_eq!(&first_frame[..7], b"10000\r\n");
    assert!(first_frame[7..7 + 65536].iter().all(|byte| *byte == 1));
    assert_eq!(&first_frame[7 + 65536..], b"\r\n");
    loop {
        if fixture.event("pull", None).await["count"].as_u64().unwrap() > count {
            break;
        }
    }
    drop(reader);
    assert!(writing.join_next().await.unwrap().unwrap().is_err());
    fixture.event("cancel", Some("/credit")).await;

    gateway.close_partition("visual-a").await.unwrap();
    // The context still exists; this checks stale receipt rejection, not context disposal.
    assert!(sessions::preview::protected_transport("visual-a").is_err());
    assert!(!visual_a.is_live());
    assert!(visual_b.is_live());
    assert!(
        TcpStream::connect(("127.0.0.1", Url::parse(&mapped).unwrap().port().unwrap()))
            .await
            .is_err()
    );
    gateway.shutdown().await.unwrap();
    for value in [&app_base, &second] {
        assert!(
            TcpStream::connect(("127.0.0.1", Url::parse(value).unwrap().port().unwrap()))
                .await
                .is_err()
        );
    }
}
