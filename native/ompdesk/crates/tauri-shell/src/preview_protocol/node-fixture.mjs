import { createInterface } from "node:readline";
import { ShellClient } from "../../../../../../src/main/shell-host/client.ts";
import { Host } from "../../../../../../src/main/shell-host/electron/host.ts";
import { Protocol, serveProtocolRequests } from "../../../../../../src/main/shell-host/electron/session.ts";
import { MediaStreams } from "../../../../../../src/main/media-stream.ts";

const [socket, token, mediaFile] = process.argv.slice(2);
if (!socket || !token || !mediaFile) throw new Error("fixture needs socket, token and media file");
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const client = await ShellClient.connect(socket);
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
const media = new MediaStreams();
const mediaUrl = media.open(mediaFile, "audio/wav", 7);
app.handle("omp-media", request => media.handle(request));
let release;
const gate = new Promise(resolve => { release = resolve; });
const never = new Promise(() => {});
let creditPulls = 0;
function visualHandler(partition) {
  return request => {
    send({ event: "request", partition, url: request.url, method: request.method, headers: [...request.headers] });
    const path = new URL(request.url).pathname;
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
        await (path === "/cancel" ? never : gate);
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
  else if (command === "release-media") {
    media.release(mediaUrl, 7);
    send({ event: "media-released", size: media.size });
  } else if (command === "credit-count") send({ event: "credit-count", count: creditPulls });
  else if (command === "quit") break;
  else throw new Error(`unknown command ${command}`);
}
client.close();
