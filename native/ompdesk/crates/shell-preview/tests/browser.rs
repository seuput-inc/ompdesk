use std::{
    env,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use ompdesk_shell_preview::{
    AttachedPage, Browser, LaunchConfig, Navigation, NavigationHandler, PageInitializer,
    PausedRequest, RequestDisposition, RequestHandler, Viewport,
};
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
    task::JoinHandle,
    time::timeout,
};

const HTML: &str = r##"<!doctype html>
<meta charset="utf-8">
<title>Preview fixture</title>
<style>
  body { margin: 0; background: white; }
  input { position: absolute; left: 20px; top: 20px; width: 160px; height: 30px; }
  button { position: absolute; left: 20px; top: 80px; width: 100px; height: 30px; }
  #color { position: absolute; left: 150px; top: 80px; width: 80px; height: 80px; background: rgb(20, 80, 180); }
</style>
<input id="input"><button id="button">Click</button><div id="color"></div>
<script>
  window.initializedBeforePage = globalThis.previewInitialized === true;
  window.initializationRuns = globalThis.previewInitializationRuns ?? 0;
  window.clicks = 0;
  window.trustedClick = false;
  window.trustedInput = false;
  document.querySelector('#button').addEventListener('click', e => {
    window.clicks++;
    window.trustedClick = e.isTrusted;
  });
  document.querySelector('#input').addEventListener('input', e => window.trustedInput = e.isTrusted);
</script>"##;

struct Fixture {
    url: String,
    popup_requests: Arc<AtomicUsize>,
    download_requests: Arc<AtomicUsize>,
    handled_requests: Arc<AtomicUsize>,
    request_notify: Arc<Notify>,
    task: JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Fixture {
    async fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let popup_requests = Arc::new(AtomicUsize::new(0));
        let download_requests = Arc::new(AtomicUsize::new(0));
        let handled_requests = Arc::new(AtomicUsize::new(0));
        let request_notify = Arc::new(Notify::new());
        let popup = Arc::clone(&popup_requests);
        let download = Arc::clone(&download_requests);
        let handled = handled_requests.clone();
        let notify = Arc::clone(&request_notify);
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            while let Ok((mut stream, _)) = listener.accept().await {
                let popup = Arc::clone(&popup);
                let download = Arc::clone(&download);
                let handled = handled.clone();
                let notify = Arc::clone(&notify);
                connections.spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0; 2048];
                    while let Ok(n) = stream.read(&mut chunk).await {
                        if n == 0 { break; }
                        request.extend_from_slice(&chunk[..n]);
                        if request.windows(4).any(|part| part == b"\r\n\r\n") || request.len() > 16384 {
                            break;
                        }
                    }
                    let line = request.split(|&byte| byte == b'\n').next().unwrap_or_default();
                    let path = std::str::from_utf8(line).unwrap_or("").split_whitespace().nth(1).unwrap_or("");
                    let request_info = if path == "/headers" {
                        let text = String::from_utf8_lossy(&request);
                        let header = |name: &str| text.lines().filter_map(|line| line.split_once(':'))
                            .find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.trim()).unwrap_or("");
                        json!({"userAgent":header("user-agent"),"language":header("accept-language")}).to_string()
                    } else {
                        String::new()
                    };
                    let (headers, body) = match path {
                        "/" => ("Content-Type: text/html; charset=utf-8\r\n", HTML),
                        "/headers" => ("Content-Type: application/json\r\n", request_info.as_str()),
                        "/frame" => ("Content-Type: text/html\r\n", "<!doctype html><script>parent.postMessage({frameInitialized: globalThis.previewInitialized === true, runs: globalThis.previewInitializationRuns ?? 0}, '*')</script>"),
                        "/popup" => {
                            popup.fetch_add(1, Ordering::SeqCst);
                            notify.notify_one();
                            ("Content-Type: text/html\r\n", "popup")
                        }
                        "/download" => {
                            download.fetch_add(1, Ordering::SeqCst);
                            notify.notify_one();
                            ("Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=preview-test.bin\r\n", "download fixture")
                        }
                        "/handled" | "/handler-error" => {
                            handled.fetch_add(1, Ordering::SeqCst);
                            ("Content-Type: application/json\r\n", "{\"source\":\"server\"}")
                        }
                        _ => ("Content-Type: text/plain\r\n", ""),
                    };
                    let response = format!("HTTP/1.1 200 OK\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        Ok(Self {
            url,
            popup_requests,
            download_requests,
            handled_requests,
            request_notify,
            task,
        })
    }
}

macro_rules! check {
    ($condition:expr, $($message:tt)*) => {
        if !($condition) { return Err(format!($($message)*)); }
    };
}

fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return None;
    }
    Some((
        u32::from_be_bytes(bytes[16..20].try_into().ok()?),
        u32::from_be_bytes(bytes[20..24].try_into().ok()?),
    ))
}

async fn scenario(browser: &Browser, fixture: &Fixture, scratch: &Path) -> Result<(), String> {
    let partition = browser
        .create_partition()
        .await
        .map_err(|e| format!("create partition: {e:?}"))?;
    let other_partition = browser
        .create_partition()
        .await
        .map_err(|e| format!("create other partition: {e:?}"))?;
    let viewport = Viewport {
        width: 320,
        height: 240,
        device_scale_factor: 2.0,
    };
    let denied_page = browser
        .create_page(&partition, viewport)
        .await
        .map_err(|e| format!("create denied-navigation page: {e:?}"))?;
    denied_page
        .navigate(&fixture.url)
        .await
        .map_err(|e| e.to_string())?;
    denied_page.evaluate("new Promise(resolve=>{function ready(){if(document.readyState==='complete'&&document.querySelector('#button')){globalThis.retainedDocument='alive';resolve(true)}else requestAnimationFrame(ready)}ready()})", false).await.map_err(|e| e.to_string())?;
    let denied = denied_page
        .navigate(&format!("{}/denied-handled", fixture.url))
        .await
        .expect_err("host fulfillment must not bypass denied document navigation");
    check!(
        denied.code == "navigation" && denied.message == "net::ERR_ABORTED",
        "denied document did not preserve the actual policy failure: {denied}"
    );
    let retained = denied_page
        .evaluate(
            "({url:location.href, marker:globalThis.retainedDocument})",
            false,
        )
        .await
        .map_err(|e| e.to_string())?;
    check!(
        retained == json!({"url":format!("{}/",fixture.url),"marker":"alive"}),
        "denied navigation replaced the original live document: {retained}"
    );
    let sibling = browser
        .create_page(&partition, viewport)
        .await
        .map_err(|e| format!("create page beside a live same-partition target: {e:?}"))?;
    check!(
        sibling.target_id != denied_page.target_id,
        "same-partition page creation reused the live target"
    );
    sibling.close().await.map_err(|e| e.to_string())?;
    denied_page.close().await.map_err(|e| e.to_string())?;
    let page = browser
        .create_page(&partition, viewport)
        .await
        .map_err(|e| format!("create page: {e:?}"))?;
    let navigation_failure = page
        .navigate("http://127.0.0.1:1/")
        .await
        .expect_err("Chromium must reject the unsafe port before network access");
    check!(
        navigation_failure.code == "navigation"
            && navigation_failure.message == "net::ERR_UNSAFE_PORT",
        "actual navigation failure was lost: {navigation_failure}"
    );
    page.navigate(&fixture.url)
        .await
        .map_err(|e| format!("navigate: {e:?}"))?;
    let ready = page.evaluate("new Promise(resolve => { function poll() { if (document.readyState === 'complete' && document.querySelector('#button')) resolve(document.title); else requestAnimationFrame(poll); } poll(); })", false).await.map_err(|e| format!("wait for DOM: {e:?}"))?;
    check!(ready == json!("Preview fixture"), "unexpected DOM: {ready}");
    let initialized = page.evaluate("({beforePage: initializedBeforePage, runs: initializationRuns, userAgent: navigator.userAgent})", false).await.map_err(|e| e.to_string())?;
    check!(
        initialized == json!({"beforePage":true,"runs":1,"userAgent":"OMPdesk-Preview-Proof"}),
        "host initialization did not precede page scripts: {initialized}"
    );
    let handled = page.evaluate("fetch('/handled', {method:'POST', headers:{'X-Preview-Proof':'present'}, body:'preview body'}).then(r => r.json())", false).await.map_err(|e| format!("host interception: {e}"))?;
    check!(
        handled == json!({"source":"host"}),
        "host interception did not supply the actual response: {handled}"
    );
    let failed = page
        .evaluate(
            "fetch('/handler-error').then(() => false, () => true)",
            false,
        )
        .await
        .map_err(|e| e.to_string())?;
    check!(
        failed == json!(true),
        "host handler failure did not fail the actual request"
    );
    check!(
        fixture.handled_requests.load(Ordering::SeqCst) == 0,
        "a host-handled request leaked to the network"
    );
    let headers = page
        .evaluate("fetch('/headers').then(r => r.json())", false)
        .await
        .map_err(|e| e.to_string())?;
    check!(
        headers["userAgent"] == "OMPdesk-Preview-Proof"
            && headers["language"]
                .as_str()
                .is_some_and(|v| v.starts_with("ko-KR") && v.contains("en-US")),
        "same-target request headers did not inherit host session policy: {headers}"
    );
    let frame = page.evaluate("new Promise(resolve => { window.addEventListener('message', e => { if (e.data && 'frameInitialized' in e.data) resolve(e.data); }); const iframe = document.createElement('iframe'); const url = new URL('/frame', location.href); url.hostname = 'localhost'; iframe.src = url.href; iframe.hidden = true; document.body.append(iframe); })", false).await.map_err(|e| format!("frame initialization: {e}"))?;
    check!(
        frame == json!({"frameInitialized":true,"runs":1}),
        "frame initialization did not precede its scripts: {frame}"
    );
    let info = page
        .command("Target.getTargetInfo", json!({"targetId": page.target_id}))
        .await
        .map_err(|e| format!("target info: {e:?}"))?;
    check!(
        info["targetInfo"]["targetId"] == page.target_id,
        "wrong target: {info}"
    );
    let permissions = page.evaluate("(async () => ({notifications: (await navigator.permissions.query({name: 'notifications'})).state, geolocation: (await navigator.permissions.query({name: 'geolocation'})).state}))()", false).await.map_err(|e| format!("read permissions: {e:?}"))?;
    check!(
        permissions == json!({"notifications": "denied", "geolocation": "denied"}),
        "preview permissions were not denied: {permissions}"
    );

    let png = page
        .capture(json!({}))
        .await
        .map_err(|e| format!("capture: {e:?}"))?;
    check!(
        png_size(&png) == Some((640, 480)),
        "wrong device-scale PNG dimensions: {:?}",
        png_size(&png)
    );
    tokio::fs::write(scratch.join("preview-proof.png"), &png)
        .await
        .map_err(|e| format!("write screenshot proof: {e}"))?;
    let clipped = page
        .capture(json!({"clip": {"x": 0, "y": 0, "width": 100, "height": 80, "scale": 0.5}}))
        .await
        .map_err(|e| format!("clipped capture: {e:?}"))?;
    check!(
        png_size(&clipped) == Some((100, 80)),
        "wrong clip-scale PNG dimensions: {:?}",
        png_size(&clipped)
    );
    let pdf = page
        .pdf(json!({}))
        .await
        .map_err(|e| format!("PDF: {e:?}"))?;
    check!(pdf.starts_with(b"%PDF-"), "capture is not a PDF");

    let listener = page
        .submit_command(
            "Runtime.evaluate",
            json!({
                "expression": "new Promise(resolve => document.querySelector('#button').addEventListener('click', e => resolve({trusted: e.isTrusted}), {once: true}))",
                "awaitPromise": true,
                "returnByValue": true,
            }),
        )
        .map_err(|e| format!("submit click listener: {e:?}"))?;
    for kind in ["mousePressed", "mouseReleased"] {
        page.command(
            "Input.dispatchMouseEvent",
            json!({"type": kind, "x": 50, "y": 95, "button": "left", "clickCount": 1}),
        )
        .await
        .map_err(|e| format!("ordered mouse input: {e:?}"))?;
    }
    let clicked = listener
        .receive()
        .await
        .map_err(|e| format!("click listener result: {e:?}"))?;
    check!(
        clicked["result"]["value"] == json!({"trusted": true}),
        "submitted listener missed the later trusted click: {clicked}"
    );
    for kind in ["mousePressed", "mouseReleased"] {
        page.command(
            "Input.dispatchMouseEvent",
            json!({"type": kind, "x": 50, "y": 35, "button": "left", "clickCount": 1}),
        )
        .await
        .map_err(|e| format!("mouse input: {e:?}"))?;
    }
    page.command("Input.insertText", json!({"text": "hello preview"}))
        .await
        .map_err(|e| format!("text input: {e:?}"))?;
    let state = page
        .evaluate(
            "({clicks, trustedClick, trustedInput, value: document.querySelector('#input').value})",
            false,
        )
        .await
        .map_err(|e| format!("input state: {e:?}"))?;
    check!(
        state
            == json!({"clicks": 1, "trustedClick": true, "trustedInput": true, "value": "hello preview"}),
        "input did not reach the page as trusted events: {state}"
    );

    let world = page
        .isolated_world("preview-test")
        .await
        .map_err(|e| format!("isolated world: {e:?}"))?;
    page.command("Runtime.evaluate", json!({"expression": "globalThis.previewSecret = 42", "contextId": world, "returnByValue": true})).await.map_err(|e| format!("set isolated global: {e:?}"))?;
    let isolated = page.command("Runtime.evaluate", json!({"expression": "globalThis.previewSecret", "contextId": world, "returnByValue": true})).await.map_err(|e| format!("read isolated global: {e:?}"))?;
    check!(
        isolated["result"]["value"] == 42,
        "isolated global missing: {isolated}"
    );
    let main_global = page
        .evaluate("typeof globalThis.previewSecret", false)
        .await
        .map_err(|e| format!("read main global: {e:?}"))?;
    check!(
        main_global == json!("undefined"),
        "isolated global leaked into main world: {main_global}"
    );

    page.evaluate(
        "document.cookie = 'preview=first; path=/'; localStorage.setItem('preview', 'first'); true",
        false,
    )
    .await
    .map_err(|e| format!("set partition data: {e:?}"))?;
    let second = browser
        .create_page(
            &other_partition,
            Viewport {
                width: 320,
                height: 240,
                device_scale_factor: 1.0,
            },
        )
        .await
        .map_err(|e| format!("create second page: {e:?}"))?;
    second
        .navigate(&fixture.url)
        .await
        .map_err(|e| format!("navigate second page: {e:?}"))?;
    let separate = second.evaluate("new Promise(resolve => { function poll() { if (document.readyState === 'complete') resolve({cookie: document.cookie, storage: localStorage.getItem('preview')}); else requestAnimationFrame(poll); } poll(); })", false).await.map_err(|e| format!("read other partition: {e:?}"))?;
    check!(
        separate == json!({"cookie": "", "storage": null}),
        "partition data leaked: {separate}"
    );
    let original = page
        .evaluate(
            "({cookie: document.cookie, storage: localStorage.getItem('preview')})",
            false,
        )
        .await
        .map_err(|e| format!("read original partition: {e:?}"))?;
    check!(
        original == json!({"cookie": "preview=first", "storage": "first"}),
        "original partition data missing: {original}"
    );

    page.resize(Viewport {
        width: 960,
        height: 640,
        device_scale_factor: 0.25,
    })
    .await
    .map_err(|e| format!("quarter-scale layout resize: {e:?}"))?;
    let layout = page
        .evaluate(
            "({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})",
            false,
        )
        .await
        .map_err(|e| format!("quarter-scale layout metrics: {e:?}"))?;
    check!(
        layout == json!({"width": 960, "height": 640, "dpr": 0.25}),
        "quarter-scale layout metrics mismatch: {layout}"
    );
    let quarter = page
        .capture(json!({}))
        .await
        .map_err(|e| format!("capture quarter-scale page: {e:?}"))?;
    check!(
        png_size(&quarter) == Some((240, 160)),
        "quarter-scale screenshot dimensions: {:?}",
        png_size(&quarter)
    );

    page.resize(Viewport {
        width: 240,
        height: 160,
        device_scale_factor: 1.0,
    })
    .await
    .map_err(|e| format!("resize: {e:?}"))?;
    let resized = page
        .capture(json!({}))
        .await
        .map_err(|e| format!("capture resized page: {e:?}"))?;
    check!(
        png_size(&resized) == Some((240, 160)),
        "wrong resized dimensions: {:?}",
        png_size(&resized)
    );
    let mut events = browser.subscribe();
    page.start_screencast(json!({"format": "png", "everyNthFrame": 1}))
        .await
        .map_err(|e| format!("start screencast: {e:?}"))?;
    let frame = timeout(Duration::from_secs(10), async {
        loop {
            let event = events
                .recv()
                .await
                .map_err(|e| format!("receive screencast: {e:?}"))?;
            if event.method == "Page.screencastFrame"
                && event.session_id.as_deref() == Some(page.session_id.as_str())
            {
                break Ok::<_, String>(event.params);
            }
        }
    })
    .await
    .map_err(|_| "timed out waiting for screencast".to_string())??;
    let data = frame["data"].as_str().ok_or("missing screencast data")?;
    let image = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("decode screencast: {e}"))?;
    check!(png_size(&image).is_some(), "screencast frame is not PNG");
    check!(
        frame["metadata"]["deviceWidth"]
            .as_f64()
            .is_some_and(|n| n > 0.0)
            && frame["metadata"]["deviceHeight"]
                .as_f64()
                .is_some_and(|n| n > 0.0),
        "missing screencast dimensions: {frame}"
    );
    let frame_id = frame["sessionId"]
        .as_i64()
        .ok_or("missing screencast frame id")?;
    page.ack_frame(frame_id)
        .await
        .map_err(|e| format!("ack frame: {e:?}"))?;
    page.stop_screencast()
        .await
        .map_err(|e| format!("stop screencast: {e:?}"))?;

    // A 390x700 CSS layout at deviceScaleFactor 2 streams 780x1400 frames, not 390x700, whatever the view's own scale.
    page.resize_framed(
        Viewport {
            width: 390,
            height: 700,
            device_scale_factor: 2.0,
        },
        (780, 1400),
    )
    .await
    .map_err(|e| format!("framed resize: {e:?}"))?;
    let framed_layout = page
        .evaluate(
            "({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})",
            false,
        )
        .await
        .map_err(|e| format!("framed layout metrics: {e:?}"))?;
    check!(
        framed_layout == json!({"width": 390, "height": 700, "dpr": 2}),
        "framed layout metrics mismatch: {framed_layout}"
    );
    let mut framed_events = browser.subscribe();
    page.start_screencast(json!({"format": "png", "everyNthFrame": 1}))
        .await
        .map_err(|e| format!("start framed screencast: {e:?}"))?;
    // Until a surface of the new view size activates, Viz letterboxes the previous 240x160 surface into the new capture
    // size (Windows: a 780x520 first frame). Such a transition frame keeps one side of the capture; the host drops it
    // (tauri-shell `frames::pictures_window`). A 780x1400 frame must follow on this still page without any input.
    let mut seen = Vec::new();
    let framed = timeout(Duration::from_secs(10), async {
        loop {
            let event = framed_events
                .recv()
                .await
                .map_err(|e| format!("receive framed screencast: {e:?}"))?;
            if event.method != "Page.screencastFrame"
                || event.session_id.as_deref() != Some(page.session_id.as_str())
            {
                continue;
            }
            let png = base64::engine::general_purpose::STANDARD
                .decode(
                    event.params["data"]
                        .as_str()
                        .ok_or("missing framed screencast data")?,
                )
                .map_err(|e| format!("decode framed screencast: {e}"))?;
            let size = png_size(&png);
            seen.push(size);
            if size == Some((780, 1400)) {
                break Ok::<_, String>(());
            }
            if !size.is_some_and(|(width, height)| width == 780 || height == 1400) {
                break Err("not a transition frame".to_string());
            }
            let ack = event.params["sessionId"]
                .as_i64()
                .ok_or("missing framed screencast frame id")?;
            page.ack_frame(ack)
                .await
                .map_err(|e| format!("ack transition frame: {e:?}"))?;
        }
    })
    .await;
    eprintln!("framed screencast frames: {seen:?}");
    check!(
        matches!(framed, Ok(Ok(()))),
        "framed screencast frames: {seen:?} ({framed:?})"
    );
    // The emulated page fills the larger view rather than sitting in a corner of it: a trusted click at each CSS
    // corner (sent at the emulation scale Chromium takes input in) lands on the marker laid there.
    page.evaluate(
        "(() => { window.cornerHits = []; window.cornerDone = new Promise(resolve => { for (const [id, side] of [['top-left', 'left:0;top:0'], ['bottom-right', 'right:0;bottom:0']]) { const marker = document.createElement('div'); marker.id = 'corner-' + id; marker.style.cssText = 'position:fixed;width:20px;height:20px;background:#f00;' + side; marker.addEventListener('click', event => { window.cornerHits.push([id, event.isTrusted]); if (window.cornerHits.length === 2) resolve(window.cornerHits); }); document.body.append(marker); } }); return true; })()",
        false,
    )
    .await
    .map_err(|e| format!("install corner markers: {e:?}"))?;
    let emulation_scale = page.emulation_scale();
    for (x, y) in [(10.0, 10.0), (380.0, 690.0)] {
        for kind in ["mousePressed", "mouseReleased"] {
            page.command(
                "Input.dispatchMouseEvent",
                json!({"type": kind, "x": x * emulation_scale, "y": y * emulation_scale, "button": "left", "clickCount": 1}),
            )
            .await
            .map_err(|e| format!("corner click: {e:?}"))?;
        }
    }
    let corner_hits = page
        .evaluate(
            "window.cornerDone.then(hits => { document.querySelectorAll('[id^=corner-]').forEach(marker => marker.remove()); return hits; })",
            false,
        )
        .await
        .map_err(|e| format!("read corner hits: {e:?}"))?;
    check!(
        corner_hits == json!([["top-left", true], ["bottom-right", true]]),
        "framed page does not fill its view: {corner_hits} at emulation scale {emulation_scale}"
    );
    // A wheel is taken in the same space: Blink divides its position and delta by the emulation scale, then the DOM
    // delta by devicePixelRatio (2 here), so the CSS point and a 100 px page delta are sent at the matching multiples.
    page.evaluate(
        "(() => { window.wheelDone = new Promise(resolve => addEventListener('wheel', event => resolve([[event.isTrusted, Math.round(event.clientX), Math.round(event.clientY), Math.round(event.deltaY)]]), {once: true, passive: true})); return true; })()",
        false,
    )
    .await
    .map_err(|e| format!("install wheel listener: {e:?}"))?;
    page.command(
        "Input.dispatchMouseEvent",
        json!({"type": "mouseWheel", "x": 200.0 * emulation_scale, "y": 300.0 * emulation_scale, "deltaX": 0, "deltaY": 100.0 * emulation_scale * 2.0}),
    )
    .await
    .map_err(|e| format!("wheel: {e:?}"))?;
    let wheel_seen = page
        .evaluate("window.wheelDone", false)
        .await
        .map_err(|e| format!("read wheel: {e:?}"))?;
    check!(
        wheel_seen == json!([[true, 200, 300, 100]]),
        "framed page took the wheel at another place or magnitude: {wheel_seen} at emulation scale {emulation_scale}"
    );
    page.ack_frame(
        framed["sessionId"]
            .as_i64()
            .ok_or("missing framed screencast frame id")?,
    )
    .await
    .map_err(|e| format!("ack framed frame: {e:?}"))?;
    page.stop_screencast()
        .await
        .map_err(|e| format!("stop framed screencast: {e:?}"))?;
    page.resize(Viewport {
        width: 240,
        height: 160,
        device_scale_factor: 1.0,
    })
    .await
    .map_err(|e| format!("restore resize: {e:?}"))?;

    page.evaluate("(() => { const a = document.createElement('a'); a.href = '/download'; a.download = 'preview-test.bin'; document.body.append(a); a.click(); a.remove(); return true; })()", false).await.map_err(|e| format!("request download: {e:?}"))?;
    timeout(Duration::from_secs(10), async {
        loop {
            let notified = fixture.request_notify.notified();
            if fixture.download_requests.load(Ordering::SeqCst) > 0 {
                break;
            }
            notified.await;
        }
    })
    .await
    .map_err(|_| "download request did not reach fixture".to_string())?;
    let canceled = timeout(Duration::from_secs(10), async {
        loop {
            let event = events
                .recv()
                .await
                .map_err(|e| format!("receive download event: {e:?}"))?;
            if event.method == "Browser.downloadProgress" && event.params["state"] == "canceled" {
                break Ok::<_, String>(event);
            }
        }
    })
    .await
    .map_err(|_| "timed out waiting for canceled download".to_string())??;
    check!(
        canceled.params["guid"].as_str().is_some(),
        "canceled download has no guid"
    );

    browser
        .command("Target.setDiscoverTargets", json!({"discover": true}), None)
        .await
        .map_err(|e| format!("discover popup targets: {e:?}"))?;
    page.evaluate("document.querySelector('#button').addEventListener('click', () => { window.popupOpened = window.open('/popup', '_blank') !== null; }, {once: true}); true", false).await.map_err(|e| format!("install popup trigger: {e:?}"))?;
    for kind in ["mousePressed", "mouseReleased"] {
        page.command(
            "Input.dispatchMouseEvent",
            json!({"type": kind, "x": 50, "y": 95, "button": "left", "clickCount": 1}),
        )
        .await
        .map_err(|e| format!("trigger popup: {e:?}"))?;
    }
    let popup_opened = page
        .evaluate("window.popupOpened", false)
        .await
        .map_err(|e| format!("read popup attempt: {e:?}"))?;
    check!(
        popup_opened == json!(true),
        "browser did not initiate the popup: {popup_opened}"
    );
    let popup_id = timeout(Duration::from_secs(10), async {
        let mut popup_id = None;
        loop {
            let event = events
                .recv()
                .await
                .map_err(|e| format!("receive popup event: {e:?}"))?;
            if event.method == "Target.targetCreated"
                && event.params["targetInfo"]["openerId"] == page.target_id
            {
                popup_id = event.params["targetInfo"]["targetId"]
                    .as_str()
                    .map(str::to_owned);
            } else if event.method == "Target.targetDestroyed"
                && event.params["targetId"].as_str() == popup_id.as_deref()
                && popup_id.is_some()
            {
                break Ok::<_, String>(popup_id.expect("popup id checked"));
            }
        }
    })
    .await
    .map_err(|_| "timed out waiting for popup closure".to_string())??;
    let targets = browser
        .command("Target.getTargets", json!({}), None)
        .await
        .map_err(|e| format!("inspect targets after popup closure: {e:?}"))?;
    let target_infos = targets["targetInfos"]
        .as_array()
        .ok_or("missing target list")?;
    check!(
        !target_infos
            .iter()
            .any(|target| target["targetId"] == popup_id),
        "popup remained open after policy"
    );
    check!(
        fixture.popup_requests.load(Ordering::SeqCst) == 0,
        "popup requested a URL before policy approval"
    );
    second
        .close()
        .await
        .map_err(|e| format!("close second page: {e:?}"))?;
    page.close()
        .await
        .map_err(|e| format!("close page: {e:?}"))?;
    browser
        .close_partition(&other_partition)
        .await
        .map_err(|e| format!("close other partition: {e:?}"))?;
    browser
        .close_partition(&partition)
        .await
        .map_err(|e| format!("close partition: {e:?}"))?;
    Ok(())
}

struct NavigationGate {
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

impl NavigationHandler for NavigationGate {
    fn allow(&self, navigation: Navigation) -> Pin<Box<dyn Future<Output = bool> + Send>> {
        let hold = navigation.url.ends_with("/hold");
        let denied = navigation.url.ends_with("/denied-handled");
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            if hold {
                let resumed = release.notified();
                entered.notify_one();
                resumed.await;
            }
            !denied
        })
    }
}

impl RequestHandler for NavigationGate {
    fn handle(
        &self,
        request: PausedRequest,
    ) -> Pin<Box<dyn Future<Output = ompdesk_shell_preview::Result<RequestDisposition>> + Send>>
    {
        Box::pin(async move {
            let url = request
                .params
                .pointer("/request/url")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if url.ends_with("/denied-handled") {
                let body = base64::engine::general_purpose::STANDARD
                    .encode(b"<p>Unauthorized document</p>");
                request.page.command("Fetch.fulfillRequest", json!({"requestId":request.request_id,
                    "responseCode":200,"responseHeaders":[{"name":"Content-Type","value":"text/html"}],"body":body})).await?;
                return Ok(RequestDisposition::Handled);
            }
            if url.ends_with("/handler-error") {
                return Err(ompdesk_shell_preview::Error::new(
                    "failed",
                    "Fixture host failure",
                ));
            }
            if !url.ends_with("/handled") {
                return Ok(RequestDisposition::Unhandled);
            }
            let method = request
                .params
                .pointer("/request/method")
                .and_then(serde_json::Value::as_str);
            let body = request
                .params
                .pointer("/request/postData")
                .and_then(serde_json::Value::as_str);
            let header = request
                .params
                .pointer("/request/headers")
                .and_then(serde_json::Value::as_object)
                .is_some_and(|headers| {
                    headers.iter().any(|(name, value)| {
                        name.eq_ignore_ascii_case("x-preview-proof") && value == "present"
                    })
                });
            if method != Some("POST") || body != Some("preview body") || !header {
                return Err(ompdesk_shell_preview::Error::new(
                    "invalid",
                    "Actual paused request metadata changed",
                ));
            }
            let body = base64::engine::general_purpose::STANDARD.encode(br#"{"source":"host"}"#);
            request.page.command("Fetch.fulfillRequest", json!({"requestId":request.request_id,"responseCode":200,
                "responseHeaders":[{"name":"Content-Type","value":"application/json"}],"body":body})).await?;
            Ok(RequestDisposition::Handled)
        })
    }
}

impl PageInitializer for NavigationGate {
    fn initialize(
        &self,
        page: AttachedPage,
    ) -> Pin<Box<dyn Future<Output = ompdesk_shell_preview::Result<()>> + Send>> {
        Box::pin(async move {
            page.command(
                "Network.setUserAgentOverride",
                json!({"userAgent":"OMPdesk-Preview-Proof","acceptLanguage":"ko-KR,en-US"}),
            )
            .await?;
            page.command("Page.addScriptToEvaluateOnNewDocument", json!({"source":"globalThis.previewInitialized = true; globalThis.previewInitializationRuns = (globalThis.previewInitializationRuns ?? 0) + 1;"})).await?;
            Ok(())
        })
    }
}

async fn navigation_lifecycle(
    browser: &Browser,
    fixture: &Fixture,
    gate: &NavigationGate,
) -> Result<(), String> {
    let held_partition = browser
        .create_partition()
        .await
        .map_err(|e| e.to_string())?;
    let live_partition = browser
        .create_partition()
        .await
        .map_err(|e| e.to_string())?;
    let viewport = Viewport {
        width: 320,
        height: 240,
        device_scale_factor: 1.0,
    };
    let held = Arc::new(
        browser
            .create_page(&held_partition, viewport)
            .await
            .map_err(|e| e.to_string())?,
    );
    let live = browser
        .create_page(&live_partition, viewport)
        .await
        .map_err(|e| e.to_string())?;
    let navigating = held.clone();
    let url = format!("{}/hold", fixture.url);
    let navigation = tokio::spawn(async move { navigating.navigate(&url).await });
    timeout(Duration::from_secs(10), gate.entered.notified())
        .await
        .map_err(|_| "host navigation gate was not reached")?;
    let value = live
        .evaluate("for(let i=0;i<100;i++) console.log(i); 42", false)
        .await
        .map_err(|e| e.to_string())?;
    check!(
        value == json!(42),
        "a paused navigation blocked another page's events"
    );
    held.close().await.map_err(|e| e.to_string())?;
    gate.release.notify_waiters();
    let _ = navigation.await.map_err(|e| e.to_string())?;
    browser
        .close_partition(&held_partition)
        .await
        .map_err(|e| e.to_string())?;
    let value = live
        .evaluate("6 * 7", false)
        .await
        .map_err(|e| e.to_string())?;
    check!(
        value == json!(42),
        "closing a paused navigation ended the other partition"
    );
    live.close().await.map_err(|e| e.to_string())?;
    browser
        .close_partition(&live_partition)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires the explicitly supplied packaged Chromium test runtime"]
async fn real_chromium_preview() {
    let executable = PathBuf::from(
        env::var_os("OMPDESK_PREVIEW_TEST_BROWSER")
            .expect("OMPDESK_PREVIEW_TEST_BROWSER is required"),
    );
    let scratch = PathBuf::from(
        env::var_os("OMPDESK_PREVIEW_TEST_SCRATCH")
            .expect("OMPDESK_PREVIEW_TEST_SCRATCH is required"),
    );
    assert!(
        scratch.is_absolute() && scratch.is_dir(),
        "OMPDESK_PREVIEW_TEST_SCRATCH must be an existing absolute directory"
    );
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();
    let profile_root = scratch.join(format!("preview-test-{}-{nonce}", std::process::id()));
    let fixture = Arc::new(Fixture::start().await.expect("start local HTTP fixture"));
    let gate = Arc::new(NavigationGate {
        entered: Arc::new(Notify::new()),
        release: Arc::new(Notify::new()),
    });
    let browser = Arc::new(
        Browser::launch_with_request_handler(
            LaunchConfig {
                executable,
                profile_root,
                command_timeout: Duration::from_secs(10),
            },
            gate.clone(),
            gate.clone(),
            gate.clone(),
        )
        .await
        .expect("launch Chromium"),
    );
    let task_browser = Arc::clone(&browser);
    let task_fixture = Arc::clone(&fixture);
    let task_scratch = scratch.clone();
    let result = tokio::spawn(async move {
        scenario(&task_browser, &task_fixture, &task_scratch).await?;
        navigation_lifecycle(&task_browser, &task_fixture, &gate).await
    })
    .await;
    let shutdown = browser.shutdown().await;
    drop(fixture);
    let status = shutdown.expect("shutdown Chromium");
    assert!(status.success(), "Chromium exited unsuccessfully: {status}");
    result
        .expect("preview scenario panicked")
        .expect("preview scenario failed");
}
