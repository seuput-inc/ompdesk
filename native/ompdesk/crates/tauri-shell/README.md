# Tauri system-WebView host

`ompdesk-tauri-shell` pins Tauri 2.12.5. WKWebView on macOS and WebView2 on Windows host the existing React page. The crate imports the existing shell's authenticated host wire, Node child supervisor and logger by path. `shell_core` is linked with default features disabled. This crate does not depend on CEF.

The runtime finds the actual Node main from `OMPDESK_APP_DIR` or the packaged `resources/app` layout. `OMPDESK_APP_ENTRY` can select an existing main bundle. Its sibling `renderer/index.html` and `preload/tauri.js` must exist. Missing assets are startup errors, not a fallback UI.

Node assigns window and webContents IDs. The registry never reuses them. Tauri labels bind native IPC callers to those IDs. App pages can load only the app custom origin. New-window requests and remote navigation are denied. The app document has no remote Tauri capabilities or child frames. Navigation advances a document generation, invalidates pending evaluations and rejects late invoke responses. Generation numbers travel in the preload's captured closure, not in React's API.

`createOmpApi` uses the native `omp_ipc` command. Binary values retain the existing `$bin` representation. Node pushes queue until the preload is ready. Queue overflow produces the renderer's stream-reset signal. Native drag-enter paths feed the synchronous `fs.pathForFile` mapping. Node-requested JavaScript runs through the native evaluator and its asynchronous result collector. This requires `unsafe-eval` in the app document CSP. The evaluator is not a CDP implementation.

The host implements app initialization, authenticated Node startup, app exit receipt, relaunch, ordinary app windows, native geometry/focus/visibility changes, app-page load, JavaScript evaluation, zoom and native Web Inspector. State updates precede their corresponding events. Exit keeps the host writer and Node stdin alive while Node receives its receipt, then joins the Node child before relaunch.

## Incomplete runtime paths

This source is not a released application or a claim of parity. A real isolated-profile run with the actual Node bundle, handler invoke, push, second-window close and exit receipt is still required. A local cold Tauri build is intentionally not run by this worker. Main owns the hosted native compile and final artifact run.

Preview belongs to the separate `shell-preview` crate. This host currently rejects `view.*`, offscreen windows, `wc.frame` and `wc.cdp.*` explicitly. It does not open a substitute browser target or claim WKWebView has CDP.

Native services outside the app-window path, session policy, streamed media protocols, menus, tray, dialogs, notifications, system integration, app URL history, detailed page failure/process events and the full constructor option set are not yet integrated here. Unknown operations return `unsupported`. Window state publishes measured native fields only. Page state does not fabricate history, renderer health or Chromium version facts. WebKit page-load callbacks do not expose an HTTP response status, so navigation events omit it.

Storage migration, automatic update/relaunch packaging, credentials and Windows/macOS parity still need the application-level gates. WebKit's native website store is selected by a deterministic identifier derived from the profile path. The resource tree must be immutable while the app runs; canonical-path checking does not protect against a hostile local writer replacing files during an open.
