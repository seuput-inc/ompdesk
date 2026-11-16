# Chromium Preview driver

This standalone crate controls one real Chromium target per Preview page over private CDP pipes. It does not embed CEF, Electron, a second WebKit page, or a browser downloader. The Tauri compositor and phone stream must consume frames from this same target.

## Host contract

`Browser::launch(LaunchConfig { executable, profile_root, command_timeout })` takes an absolute executable chosen by trusted packaging and an application-owned disposable storage root. There is no PATH search, installed-browser discovery, user-profile reuse, caller-supplied Chromium flag, or runtime download. Each launch makes a new private profile. Each `create_partition()` makes an off-the-record browser context, denies all permissions and downloads, and returns Chromium's actual `context_id`.

`create_page(&partition, Viewport { width, height, device_scale_factor })` returns a `Page` with actual `target_id` and flattened `session_id`. Native `wcId`, `viewId`, frame sequence counters, viewer ownership, and authorization remain in Main and the Tauri host. This crate creates no second authorization registry.

| API | Result or effect |
| --- | --- |
| `Browser::subscribe()` | `broadcast::Receiver<Event>` with `method`, shared `Arc<Value>` `params`, and optional actual CDP `session_id` |
| `Browser::command(method, params, session)` | Raw CDP result on the browser or a trusted actual session |
| `Page::command(method, params)` | Raw CDP result on this page's session, including Input, Accessibility, DOM, Network, and nested target attach |
| `Page::navigate(url)` | HTTP(S) or empty-document navigation, rejects `Page.navigate.errorText` |
| `Page::evaluate(expression, user_gesture)` | Awaited by-value result; script exceptions fail the call |
| `Page::isolated_world(name)` | Actual isolated execution context ID, without universal access |
| `Page::capture(options)` | Actual PNG or JPEG bytes; CDP clip and scale options pass unchanged |
| `Page::pdf(options)` | Actual PDF bytes, using CDP ReturnAsBase64 |
| `Page::resize(viewport)` | CDP device metrics override |
| `Page::start_screencast(options)` | Actual `Page.screencastFrame` events, not a screenshot loop or a mirror |
| `Page::ack_frame(id)` | ACKs the frame ID from `params.sessionId` on this page |
| `Page::stop_screencast()` | Ends this page's stream |
| `Page::close()` | Closes the actual target |
| `Browser::close_partition(partition)` | Disposes its actual browser context and targets |
| `Browser::shutdown()` | Joins the exact process exit, then removes only the profile this launch created |

Use `launch_with_navigation(config, Arc<dyn NavigationHandler>)` to adapt Main's existing `wc.navigate` policy. `allow(Navigation { session_id, frame_id, url })` returns a boxed `Future<Output = bool>`. Document requests stay paused until the host answers. The driver denies on a two-second timeout, before continuing the request. It also applies the HTTP(S) and empty-document restriction. The host maps the actual session and frame back to its existing checked owner. It must install this adapter for remote-tab and visual navigation rules.

`launch_with_hooks(config, navigation, initializer)` adds the host's `PageInitializer`. Its `initialize(AttachedPage)` returns `Pin<Box<dyn Future<Output = Result<()>> + Send>>`. The capability has actual `target_id`, `session_id`, and `context_id` strings plus `command(method, params)` on that actual session. It needs no reference back to `Browser` while launch is in progress. Store `Arc<Browser>` externally rather than cloning its shutdown ownership or introducing a strong callback cycle.

The callback applies the canonical host registry's UA, Accept-Language, and pre-document scripts while a page or iframe is paused. `create_page` waits for target initialization before returning. Competing CDP attachments join one actual-target completion rather than injecting the preload twice. The completion map contains only actual target/session lifecycle facts and is removed on detach; partition names, proxy rules, cookies, native IDs, and permission authority stay with the host.

Popups attach paused, arm document interception, and request closure before releasing the debugger pause so the opener's input cannot deadlock. Any popup document request is denied using the actual target's opener metadata. Downloads and permission checks are denied at context creation, not after a page asks. Raw CDP is a trusted-host interface, not a renderer, phone, or unauthenticated socket API. A host granting raw Browser/Target/Fetch commands must preserve its existing command authorization.

## Frames, coordinates, and ordering

`Page.screencastFrame` retains Chromium's `data`, `metadata`, and numeric frame `sessionId`. Base64 image bytes and metadata refer to the same actual target as evaluation and input. Subscribers share the payload without copying an encoded image per receiver. Subscribe before enabling events and handle channel closure or lag as failure, never as an empty successful frame.

Security-policy events have a separate bounded consumer. A slow raw observer receives `Lagged` without ending other pages. A missing or lagging policy consumer ends the browser instead of losing a paused navigation or popup decision. Navigation approvals run concurrently with event intake, each with its own two-second deadline.

The compositor decodes the image and retains `offsetTop`, `pageScaleFactor`, `deviceWidth`, `deviceHeight`, and scroll offsets. The phone adapter maps it to its existing checked frame sequence and binary JPEG wire. It ACKs this target's CDP frame only after consumption. It must not treat the CDP ACK number as the phone's global sequence counter.

CDP input coordinates are CSS pixels. The host subtracts its compositor or panel offset and accounts for displayed-image scaling once. `device_scale_factor` changes image pixels, not mouse coordinates. `capture.clip.scale` is passed through, so a half-scale clip at device scale two has one image pixel per CSS pixel. The single pipe writer preserves enqueue order, while response IDs route out-of-order completion. An awaited JavaScript promise does not hold input behind it. Callers await dependent operations such as resize then capture.

Explicitly call `shutdown()` before ending the Tokio runtime. Dropping a browser schedules cleanup when a runtime is alive, but is not a joined shutdown receipt. A cancelled context or target creation ends the browser because its CDP side effect may already have happened. A sent CDP operation cannot in general be rolled back after cancellation. Request IDs are not reused and late replies cannot satisfy another caller.

On POSIX, Chromium's blocking child endpoint is mapped to fd3 and fd4 of a private `socketpair`; only the parent endpoint is nonblocking. There is no listening socket or TCP debugging port. Named FIFOs are not used: on Darwin, a large blocking write can wait for a reader while the reader waits for the vnode notification posted only after that write completes. The actual PDF regression exposed this deadlock.

The host must also prevent unrelated child launches from inheriting unlisted descriptors. [Rust 1.95's macOS `Socket::new_pair`](https://github.com/rust-lang/rust/blob/1.95.0/library/std/src/sys/net/connection/socket/unix.rs#L111-L138) sets CLOEXEC after `socketpair`, rather than atomically. A concurrent inheriting spawn can race that interval. Main's process-launch boundary must use close-unlisted-fd semantics or a shared spawn fence. This is a confirmed standard-library interval, not a measured leak in the integrated host. This crate cannot impose a fence on spawns its host performs elsewhere.

## Runtime supply evidence

The repository's `bun.lock` pins Playwright 1.63.0. Its `browsers.json` pins chrome-headless-shell revision 1243, Chromium 153.0.8010.12. This is a development proof runtime, not an approved production browser version.

The inspected binary's `LICENSE.headless_shell` begins with the Chromium BSD redistribution terms and includes its third-party notices. Redistribution must retain the actual binary's complete license and notice file, not only Playwright's Apache-2.0 license or Chromium's top-level license. No Playwright source is copied into this crate. Main owns the packaged browser provenance, current security version, verification, signing, notices, and update cadence.

Sources:

- [Chromium license](https://raw.githubusercontent.com/chromium/chromium/main/LICENSE)
- [Chromium headless shell documentation](https://raw.githubusercontent.com/chromium/chromium/main/headless/README.md)
- [Playwright license](https://raw.githubusercontent.com/microsoft/playwright/main/LICENSE)
- [Chrome for Testing usage guidance](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing/)

The official Chrome for Testing guidance limits its intended use to automation and trustworthy content. That is security and usage guidance, not evidence of a legal redistribution prohibition. Production Preview browses untrusted content and needs a current, sandboxed packaged Chromium supply. This crate does not approve the older cached testing build for that use.

## Integration not provided by a frame stream

The driver exposes real CDP Accessibility trees, `Input.imeSetComposition`, `Input.insertText`, key and pointer dispatch, drag dispatch, runtime bindings, and dialog events through `command` and `subscribe`. It does not bridge these to native accessibility APIs, native IME candidate positioning, the operating system clipboard, native drag-and-drop, context menus, spellchecking UI, or an audio output/phone audio stream. Those are real host integration requirements, not parity supplied by a canvas.

`Page.javascriptDialogOpening` requires the host's existing dialog UI and a `Page.handleJavaScriptDialog` response. Chromium's pipe does not implement the previous synchronous `__ompdeskSendSync` preload. `omp-visual:` and `omp-media:` protocol streaming are not automatically registered in standalone Chromium. Main must preserve their checked request and response semantics through its actual host transport. This crate alone is not a whole-app or Preview-parity completion claim.

## Narrow proof

The real-browser test requires an explicit test executable and scratch root. It serves deterministic local HTTP content and uses the actual driver for input, isolated worlds, context isolation, permission denial, PNG scales, PDF, resize, screencast and ACK, download denial, and popup policy. The runtime is never discovered or downloaded by the test. `--ignored` is explicit so a normal source-only unit run does not launch a browser or silently claim runtime coverage.

The same real-browser scenario also holds one host navigation approval while another partition emits 100 console events, closes the held page, and proves the other partition still evaluates. The unit suite covers out-of-order replies, fragmented frames, cancellation before send, late replies, timeout, wrong-session replies, observer lag versus policy lag, event EOF, and exact joined shutdown.

```sh
ompdesk check -- cargo +1.95 test --locked --offline --manifest-path native/ompdesk/crates/shell-preview/Cargo.toml --lib
OMPDESK_PREVIEW_TEST_BROWSER=<trusted-test-executable> \
OMPDESK_PREVIEW_TEST_SCRATCH=<owned-scratch-directory> \
ompdesk check -- cargo +1.95 test --locked --offline --manifest-path native/ompdesk/crates/shell-preview/Cargo.toml --test browser -- --ignored
```

Windows inherits only the CDP and standard handles using STARTUPINFOEX, passes actual read/write handles with `--remote-debugging-io-pipes`, creates the process hidden and suspended, assigns a kill-on-close job, then resumes it. Windows execution is not performed on this macOS host. Cross-platform compilation and runtime parity remain Main's hosted checks.
