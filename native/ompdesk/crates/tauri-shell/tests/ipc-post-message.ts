import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = await Bun.file(fileURLToPath(new URL("../src/ipc_post_message.js", import.meta.url))).text();
assert.equal(source.split("__INVOKE_KEY__").length, 2, "one token for tauri::Builder::invoke_system to fill");

const posted: unknown[] = [];
const internals: { postMessage?: (message: object) => void } = {};
const context: Record<string, unknown> = {
	__TAURI_INTERNALS__: internals,
	ipc: { postMessage: (message: unknown) => posted.push(message) },
	fetch: () => assert.fail("an IPC call must not start a resource load"),
};
context.window = context;
vm.runInNewContext(source.replace("__INVOKE_KEY__", JSON.stringify("key-1")), context);
assert.equal(typeof internals.postMessage, "function");

// What Tauri's `invoke` (scripts/core.js) hands `__TAURI_INTERNALS__.postMessage` for the preload's call.
const payload = { kind: "invoke", payload: JSON.stringify({ channel: "tabs:list", args: [], generation: 3 }) };
internals.postMessage?.({ cmd: "omp_ipc", callback: 11, error: 12, payload, options: undefined });
internals.postMessage?.({ cmd: "omp_ipc", callback: 13, error: 14, payload, options: { headers: { a: "b" } } });

// The fields Tauri's `handle_ipc_message` reads from the posted string (src/ipc/protocol.rs `Message`).
assert.equal(typeof posted[0], "string");
assert.deepEqual(JSON.parse(posted[0] as string), {
	cmd: "omp_ipc",
	callback: 11,
	error: 12,
	options: { customProtocolIpcBlocked: true },
	payload,
	__TAURI_INVOKE_KEY__: "key-1",
});
assert.deepEqual(JSON.parse(posted[1] as string).options, { headers: { a: "b" }, customProtocolIpcBlocked: true });
assert.equal(posted.length, 2);
console.log("ipc-post-message: ok");
