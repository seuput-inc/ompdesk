# Private resource gateway

This module adapts the canonical Node protocol stream to private HTTP. It never opens a caller-supplied file or dials another server. Its only resource backend is `sessions::protocol::open`. It does not replace native WKURLSchemeTask handling, the Node media owner registry, the Preview browser, or the host's navigation authorization.

## Installation and direct API

`Gateway::new()` allocates no browser and advertises no custom-scheme consumer. The host retains it in an `Arc`.

1. Initialize canonical sessions and call `protocol::declare_schemes` from the actual `app.init` declaration.
2. Await `reserve_app_media("app")` before the first app navigation. It binds only `127.0.0.1:0` and returns the fixed HTTP origin. Repeated calls return that same live origin.
3. Install the host's actual Preview URL mapper and Windows `omp-media` native callback. The callback validates its existing native label and current Registry identity, then returns an empty 302 with `app_media_url(partition, original)` as Location. Add only the exact reserved app-media origin to the app's image and media CSP sources, never `connect-src` or wildcard loopback.
4. Acquire `protocol::install_gateway_consumer()` and pass its owned `GatewayConsumer` to `activate`. The gateway retains that canonical token until shutdown. Reservation alone is not successful scheme registration.
5. Register the original custom schemes through the existing canonical session operations. Both mapping and each actual request still require `handles_scheme`; `protocol::open` checks it again.
6. C awaits `reserve_preview_partition(partition)` before creating that canonical Chromium BrowserContext or its metadata page. It retains the returned `PreviewTransport` and applies only its `proxy_bypass_rule`, after `<-loopback>`, without replacing the context or resetting cookies. Mapping refuses an unreserved Preview partition.
7. Before stopping Node or the Tokio runtime, await `shutdown()`. It cancels listeners, joins their request tasks, drops response Bodies and withdraws the installed-consumer token. A cancelled shutdown retains join ownership for the next call.

| Method | Effect |
| --- | --- |
| `reserve_preview_partition(partition).await` | Reserves one IPv4 listener and fresh 256-bit namespace for this canonical partition; returns the same receipt on repeated live reservations |
| `map_url(partition, original).await` | `Some(mapped)` for a registered hierarchical custom URL, `None` for ordinary engine URLs, or an explicit error |
| `original_url(partition, mapped).await` | Restores the original URL before navigation approval or outward metadata; wrong-partition, forged or retired gateway URLs fail closed |
| `is_gateway_origin(url).await` | Identifies reserved transport endpoints; a caller must not treat an unrecognized internal endpoint as ordinary external HTTP |
| `app_media_url(partition, original).await` | Creates a signed resource capability for a registered original `omp-media://stream/...` URL in the canonical app session |
| `shutdown().await` | Cancels every listener and joins all request tasks; cancellation and concurrent retries retain the original stopping resources |

Preview URLs use distinct HTTP origins for each original scheme, authority and canonical partition. One listener is reserved per canonical partition before context creation. Its random 256-bit namespace uses two 32-hex DNS labels under `.localhost`. Each original origin receives a different HMAC-SHA256 hostname under that namespace, on the same assigned port. The signing key is separate from the namespace. The receipt's exact proxy rule is `*.<namespace32>.<namespace32>.localhost:<port>`, not a wildcard over localhost or ports. Unknown full Host names, ports and unmapped capabilities are rejected before Node is called.

`PreviewTransport` is cloneable, exposes `proxy_bypass_rule: String`, and holds only a private weak reference to the actual listener. `is_live()` reads its real actor liveness. Dropping a receipt does not close a context or keep a listener alive. Preview partitions live until the actual Browser shuts down; the host then joins Gateway shutdown. There is no independent partition-disposal API.

Both Preview mapping and actual HTTP admission consume C's `sessions::preview::protected_transport(partition)` receipt. They compare its private weak identity with the real listener configuration and its exact rule, not only a public policy string. C returns that receipt only after the same canonical BrowserContext was successfully created with an explicit proxy server and private bypass. Chromium ignores `proxyBypassList` without `proxyServer`; a live listener or registered scheme alone is not proof of protection. Registration may precede proxy setup, but usable mapping cannot. No system-proxy mode is changed to DIRECT.

The original path, query and fragment remain in their normal positions. Relative and root-relative asset paths stay on their own mapped origin, and the existing response CSP `'self'` does not merge unrelated visuals. No HTML or JavaScript is rewritten.

App media uses the one fixed literal-IP origin. Each URL contains an HMAC-SHA256 capability, generated with a random 256-bit per-gateway key and bound to the canonical app partition and entire original resource URL. Verification is constant-time. There is no second media-owner table, stored response body, or independent expiry rule. Every GET or HEAD still reaches the original Node handler, so `MediaStreams.release` and `releaseOwner` continue to return Node's real 404. Reload expiry is not claimed.

## Stream and HTTP boundary

The listener validates its exact Host and capability before resource admission. Requests carry the captured canonical partition, original scheme and original URL to Node. Range and conditional representation headers survive; cookies, authorization, proxy headers, Host, Origin, Referer and browser security headers do not cross that boundary. App media accepts only GET and HEAD with no request body.

Responses preserve status, safe representation headers, CSP, content type, Content-Range, Content-Length and HEAD semantics. Set-Cookie, authentication and hop-by-hop headers are removed. The gateway sets `Referrer-Policy: no-referrer` rather than forwarding the backend's referrer policy. Unknown response lengths use real chunked HTTP framing. An error never writes a successful chunked terminator.

`Body.next()` returns C's owned `Chunk`. The HTTP writer retains each Chunk through all writes and flush for that chunk, drops it to return byte/slot credit, and only then pulls another. It never clones or collects a media response. TCP backpressure and the canonical producer's 1 MiB, 16-slot, 64 KiB-chunk window bound pending response memory. Disconnect, request abandonment and shutdown drop the Body, triggering canonical Node cancellation.

The module bounds concurrent connections at 64, live Preview partition listeners at 1024, live original-origin mappings at 1024 through owned routing slots, request headers at 32 KiB and 128 fields, request upload bodies at 1 MiB, and original custom URLs at 8192 bytes. These request-upload and origin limits are explicit; they are not limits on streamed media response size. Each socket serves one request with `Connection: close`. Chunked uploads and Expect negotiation are rejected, not silently reinterpreted.

## Integration evidence and remaining gates

The source consumes C packet `d021620d8915fbc647a6af5ffd3026387d67a3c0` and its typed-receipt follow-up `3a34a506432f2eed6c68b1acd309d638c2b82de8`: actual `GatewayConsumer`, `declare_schemes`, RAII protocol-open cancellation, owned ACK-on-Drop Chunk, and protected BrowserContext receipt. Main also integrates that packet's real Node producer and the host request-cancellation helper. Using the earlier Node producer is not a valid credit test.

The late-head cancellation regression additionally requires C's production Node bridge `3ad421e6d903c71170b5f9223f9bfa779bc1d57f`: the actual wire request ID is the stream ID, and a real incoming wire cancel notifies the producer after the request-head handler has left `ShellClient.#running`. No alternate cancellation registry is supplied by this fixture.

`tests.rs` includes an explicitly ignored isolated-process proof. It launches the explicitly supplied trusted browser with a fresh scratch profile and C's real initializer, installs the one Browser/gateway backend, and configures real explicit-proxy BrowserContexts before mapping. It uses the actual shell host socket, canonical session dispatch, actual Node `ShellClient` and `serveProtocolRequests`, and a real `MediaStreams` fixture. Its TCP cases cover first binary bytes before END, exact original request metadata, safe headers, Range 206, HEAD, capability tampering, canonical release, disconnect cancellation, origin separation and closed listeners. The delayed-consumer subcase uses the actual canonical Body and a small duplex HTTP writer to make credit starvation deterministic; that subcase is not a TCP-kernel-buffer measurement. The fixture shuts down the gateway and browser and joins the Node child before reporting scenario failure.

The same scenario also creates an actual Page in C's existing protected `visual-a` BrowserContext, navigates its mapped `.localhost` URL under the fixed unreachable proxy, and waits for that exact session and document loader's load lifecycle event. Its navigation handler reverses the mapped URL through `original_url` and permits only the exact original fixture document (plus required blank initialization), not localhost generally. Browser observations require a relative external script's DOM update, relative stylesheet computed color, root-relative SVG decode and rendered dimensions, and a relative fetch's actual JSON. CSP `'self'` must admit those external assets while blocking the fixture's inline script. Actual Node request events must name every original fixture asset and the canonical partition. No raw-TCP helper is used for this browser subcase.

The same scenario pauses the real listener join mutex, polls and drops the first close future, requires both retry and concurrent close futures to remain pending, and closes another partition independently. After the shared actual join, it checks retirement resource release, old-capability rejection and an ordinary HTTP server successfully rebinding that exact IPv4 port.

A bounded 96 KiB duplex fault gate delays the actual Node outgoing head and subsequent wire bytes. It accepts the real head write callback, then signals on a later event-loop turn, after ShellClient's synchronous head-write/finally deleted `#running`. Incoming socket bytes continue through the real ShellClient. The HTTP client disconnects before Rust receives the head; the real producer's reader must cancel once before releasing held bytes. Duplicate and unknown safe-positive-ID cancel frames are replayed into that same framed receive path, without extra reader cancellation. Original held bytes are then flushed to the actual socket, and a subsequent canonical media request must still return Node's real result. This is byte-delay fault injection around the real transport and producer, not a fake protocol response.

Main owns dependency/module integration and final hosted execution. No local compile, test, lint, browser or Windows run is claimed for this source packet. The narrow invocation, after integration, is:

```sh
OMPDESK_GATEWAY_TEST_BUN=<trusted-Bun-executable> \
OMPDESK_GATEWAY_TEST_BROWSER=<trusted-browser-executable> \
OMPDESK_GATEWAY_TEST_SCRATCH=<owned-scratch-directory> \
ompdesk check -- cargo +1.95 test --locked --manifest-path native/ompdesk/crates/tauri-shell/Cargo.toml preview_protocol::tests::real_node_gateway_loopback_and_credit -- --ignored --exact --test-threads=1
```

The Chromium route/rendering subcase above remains unexecuted until Main runs this integrated scenario. Fixed/system proxy routing beyond its explicit fixture and Windows WebView2 302/Range/first-byte behavior still require Main's engine/native fixtures. The listener binds IPv4 only as requested; `.localhost` IPv6-to-IPv4 connection behavior must succeed through the actual browser, not an IP override. This module does not change DNS, system proxy settings or browser flags. The namespace receipt supplies an exact transport exception before context creation. System-proxy contexts without C's actual protected receipt fail closed rather than assuming a bypass. This module alone is not generic custom-URL, cookie/storage-origin, native UI or whole-app parity.

Chromium source: [`TargetHandler::CreateBrowserContext`](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/target_handler.cc), where the bypass parser is inside the `proxyServer` branch.

Direct dependencies used here are `httparse` 1.10.1, `hmac` 0.12, existing `sha2`, `getrandom`, `url` and Tokio `net`, `io-util`, `rt`, `macros`, `sync` and `time`. The hosted fixture additionally needs Tokio `process` and `rt-multi-thread`. Main owns Cargo and lock changes.
