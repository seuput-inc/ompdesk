import { once } from "node:events";
import { connect } from "node:net";
import { Duplex } from "node:stream";
import { createInterface } from "node:readline";
import { ShellClient } from "../../../../../../src/main/shell-host/client.ts";
import { Host } from "../../../../../../src/main/shell-host/electron/host.ts";
import { Protocol, serveProtocolRequests } from "../../../../../../src/main/shell-host/electron/session.ts";
import { MediaStreams } from "../../../../../../src/main/media-stream.ts";
import { encodeFrame, FrameReader } from "../../../../../../src/main/shell-host/wire.ts";

const [socket, token, mediaFile] = process.argv.slice(2);
if (!socket || !token || !mediaFile) throw new Error("fixture needs socket, token and media file");
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const socketConnection = connect(socket);
await once(socketConnection, "connect");
socketConnection.setNoDelay(true);
const outgoing = new FrameReader();
const heldFrames = [];
let heldBytes = 0;
let holdingHead = false;
let headReleased = false;
let lateRequestId;
let lateCancels = 0;
let wireCancels = 0;
const transport = new Duplex({
  writableHighWaterMark: 1,
  read() { socketConnection.resume(); },
  write(bytes, _encoding, callback) {
    const frames = outgoing.push(bytes);
    if (frames.length !== 1 || outgoing.buffered !== 0) throw new Error("expected one actual wire frame per write");
    const head = frames[0].head;
    const lateHead = head.ok === true && head.result?.headers?.some(
      header => header[0].toLowerCase() === "x-fixture-late-head",
    );
    if (lateHead) {
      if (lateRequestId !== undefined || head.id !== head.result.streamId) throw new Error("head lost canonical request identity");
      lateRequestId = head.id;
      holdingHead = true;
    }
    if (!holdingHead) {
      socketConnection.write(bytes, callback);
      return;
    }
    heldBytes += bytes.byteLength;
    if (heldBytes > 96 * 1024) throw new Error("late-head wire gate exceeded its bound");
    heldFrames.push({ bytes, callback: lateHead ? undefined : callback });
    if (lateHead) {
      callback();
      // ShellClient's synchronous write/finally has released #running before this turn.
      setImmediate(() => send({ event: "head-held", requestId: head.id, streamId: head.result.streamId }));
    }
  },
  final(callback) { socketConnection.end(callback); },
  destroy(error, callback) {
    socketConnection.destroy();
    for (const frame of heldFrames.splice(0)) frame.callback?.(error ?? new Error("wire gate closed"));
    callback(error);
  },
});
socketConnection.on("data", bytes => { if (!transport.push(bytes)) socketConnection.pause(); });
socketConnection.on("end", () => transport.push(null));
socketConnection.on("close", () => transport.destroy());
socketConnection.on("error", error => transport.destroy(error));
const client = new ShellClient(transport);
const { facts } = await client.call("hello", { token });
const host = new Host(client, facts);
const visual = new Protocol(host, "visual-a");
const other = new Protocol(host, "visual-b");
const system = new Protocol(host, "visual-system");
const app = new Protocol(host, "app");
const sessions = new Map([["visual-a", { protocol: visual }], ["visual-b", { protocol: other }], ["visual-system", { protocol: system }], ["app", { protocol: app }]]);
serveProtocolRequests(host, partition => {
  const session = sessions.get(partition);
  if (!session) throw new Error(`unexpected partition ${partition}`);
  return session;
});
client.on("host.cancelRequest", ({ requestId }) => {
  if (requestId === lateRequestId || requestId === Number.MAX_SAFE_INTEGER) {
    wireCancels++;
    send({ event: "wire-cancel", requestId, path: requestId === lateRequestId ? "/late-head" : "/unknown" });
  }
});
const media = new MediaStreams();
const mediaUrl = media.open(mediaFile, "audio/wav", 7);
app.handle("omp-media", request => media.handle(request));
let release;
const gate = new Promise(resolve => { release = resolve; });
let releaseControl;
const controlGate = new Promise(resolve => { releaseControl = resolve; });
const never = new Promise(() => {});
let creditPulls = 0;
const browserAssets = new Map([
  ["/browser/index.html", ["text/html", `<!doctype html><html><head>
    <link rel="stylesheet" href="./assets/fixture.css">
    <script defer src="./assets/fixture.js"></script>
    <script>document.documentElement.dataset.inlineRan = "yes"</script>
    </head><body><strong id="fixture">waiting</strong><img id="pixel" src="/assets/pixel.svg"></body></html>`]],
  ["/browser/assets/fixture.js", ["text/javascript", `document.querySelector("#fixture").textContent = "browser-route-ready";`]],
  ["/browser/assets/fixture.css", ["text/css", `#fixture { color: rgb(17, 34, 51); } #pixel { width: 6px; height: 9px; }`]],
  ["/assets/pixel.svg", ["image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3" fill="green"/></svg>`]],
  ["/browser/assets/data.json", ["application/json", JSON.stringify({ route: "actual-browser-network" })]],
]);
function visualHandler(partition) {
  return request => {
    send({ event: "request", partition, url: request.url, method: request.method, headers: [...request.headers] });
    const url = new URL(request.url);
    const path = url.pathname;
    if (url.protocol === "omp-visual:" && url.hostname === "browser-fixture") {
      const asset = browserAssets.get(path);
      if (!asset) return new Response("missing fixture asset", { status: 404 });
      return new Response(asset[1], { headers: {
        "Content-Type": asset[0],
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'",
      } });
    }
    if (path === "/late-head") {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(65536).fill(7)); },
        pull() { return never; },
        cancel() {
          lateCancels++;
          send({ event: "cancel", path, count: lateCancels, released: headReleased });
        },
      }), { headers: { "Content-Type": "application/octet-stream", "X-Fixture-Late-Head": "yes" } });
    }
    if (path === "/credit") {
      return new Response(new ReadableStream({
        pull(controller) {
          creditPulls++;
          send({ event: "pull", count: creditPulls });
          controller.enqueue(new Uint8Array(65536).fill(creditPulls & 255));
        },
        cancel() { send({ event: "cancel", path }); },
      }), { headers: { "Content-Type": "application/octet-stream" } });
    }
    let stage = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        if (stage++ === 0) {
          controller.enqueue(new Uint8Array([0, 255, 65, 128]));
          send({ event: "first", path });
          return;
        }
        await (path === "/control" ? controlGate : path === "/cancel" ? never : gate);
        controller.enqueue(new Uint8Array([66, 0, 254]));
        controller.close();
        send({ event: "end", path });
      },
      cancel() { send({ event: "cancel", path }); },
    }), { status: 201, headers: { "Content-Type": "application/octet-stream", "Set-Cookie": "secret=1", "X-Fixture": "yes" } });
  };
}
visual.handle("omp-visual", visualHandler("visual-a"));
other.handle("omp-visual", visualHandler("visual-b"));
system.handle("omp-visual", visualHandler("visual-system"));
for (const [partition, scheme] of [["app", "omp-media"], ["visual-a", "omp-visual"], ["visual-b", "omp-visual"], ["visual-system", "omp-visual"]]) {
  await client.call("session.op", { partition, op: "handleScheme", args: { scheme } });
}
for (const partition of ["visual-a", "visual-b"]) {
  await client.call("session.op", {
    partition,
    op: "setProxy",
    args: { mode: "fixed_servers", proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9" },
  });
  await client.call("session.create", { partition });
}
await client.call("session.create", { partition: "visual-system" });
send({ event: "ready", mediaUrl });
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command === "release") release();
  else if (command === "release-control") releaseControl();
  else if (command === "release-media") {
    media.release(mediaUrl, 7);
    send({ event: "media-released", size: media.size });
  } else if (command === "credit-count") send({ event: "credit-count", count: creditPulls });
  else if (command === "replay-cancels") {
    if (!holdingHead || lateRequestId === undefined) throw new Error("no held head to cancel");
    transport.push(Buffer.concat([
      encodeFrame({ cancel: lateRequestId }),
      encodeFrame({ cancel: Number.MAX_SAFE_INTEGER }),
    ]));
    await new Promise(resolve => setImmediate(resolve));
    send({ event: "cancels-replayed", cancels: lateCancels, wireCancels, released: headReleased });
  } else if (command === "release-head") {
    if (!holdingHead) throw new Error("no head held");
    holdingHead = false;
    headReleased = true;
    for (const frame of heldFrames.splice(0)) {
      await new Promise((resolve, reject) => socketConnection.write(frame.bytes, error => error ? reject(error) : resolve()));
      frame.callback?.();
    }
    send({ event: "head-released", cancels: lateCancels, heldBytes });
  }
  else if (command === "quit") break;
  else throw new Error(`unknown command ${command}`);
}
client.close();
