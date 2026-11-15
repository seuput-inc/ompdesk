import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { IPC_EVENTS } from "../../../../../src/shared/ipc-types";
const source = fileURLToPath(new URL("../../../../../src/preload/tauri.ts", import.meta.url));
const built = await Bun.build({ entrypoints: [source], target: "browser", format: "iife" });
assert.equal(built.success, true, String(built.logs));
const frames: Array<{ kind: string; payload: Record<string, unknown> }> = [];
const ready = Promise.withResolvers<{ generation: number }>();
const replies: unknown[] = [];
const context: Record<string, unknown> = {
	console,
	Uint8Array,
	ArrayBuffer,
	Promise,
	Map,
	Set,
	Object,
	Number,
	JSON,
	Error,
	String,
	btoa,
	atob,
	navigator: { userAgent: "probe-agent" },
};
context.window = context;
context.__TAURI_INTERNALS__ = {
	invoke: async (command: string, args: { kind: string; payload: string }) => {
		assert.equal(command, "omp_ipc");
		const payload = JSON.parse(args.payload);
		frames.push({ kind: args.kind, payload });
		if (args.kind === "ready") return ready.promise;
		assert.equal(payload.generation, 7);
		if (args.kind === "evaluateResult") {
			replies.push(payload);
			return {};
		}
		return { value: { $bin: "AQID" } };
	},
};
vm.runInNewContext(await built.outputs[0].text(), context);
const page = context as unknown as {
	omp: {
		prefs: { get(key: string): Promise<Uint8Array>; onChanged(callback: (data: unknown) => void): () => void };
		fs: { pathForFile(file: { name: string }): string };
	};
	__ompTauriPush(generation: number, message: unknown): Promise<void>;
	__ompTauriDropFiles(files: unknown): void;
	__ompTauriEvaluate(id: number, generation: number, run: () => unknown): Promise<void>;
	__ompShellStream: { pending(): object | null; acknowledge(token: object): void };
};
const pending = page.omp.prefs.get("before-ready");
assert.deepEqual(
	frames.map(f => f.kind),
	["ready"],
);
ready.resolve({ generation: 7 });
assert.deepEqual(Array.from(await pending), [1, 2, 3]);
let pushed: unknown;
const off = page.omp.prefs.onChanged((data: unknown) => {
	pushed = data;
});
await page.__ompTauriPush(7, { channel: IPC_EVENTS.PREFS_CHANGED, args: [{ theme: "dark" }] });
assert.deepEqual(pushed, { theme: "dark" });
await page.__ompTauriPush(6, { channel: IPC_EVENTS.PREFS_CHANGED, args: [{ theme: "wrong-document" }] });
assert.deepEqual(pushed, { theme: "dark" });
off();
await page.__ompTauriPush(7, { stream: "reset" });
const reset = page.__ompShellStream.pending();
assert.ok(reset);
page.__ompShellStream.acknowledge(reset);
assert.equal(page.__ompShellStream.pending(), null);
page.__ompTauriDropFiles([{ name: "example.txt", path: "/safe/example.txt" }]);
assert.equal(page.omp.fs.pathForFile({ name: "example.txt" }), "/safe/example.txt");
await page.__ompTauriEvaluate(11, 7, () => Promise.resolve({ preserved: true }));
assert.deepEqual(replies, [{ id: 11, ok: true, value: { preserved: true }, generation: 7 }]);
let staleRan = false;
await page.__ompTauriEvaluate(12, 6, () => {
	staleRan = true;
});
assert.equal(staleRan, false);
assert.equal(replies.length, 1);
console.log(
	"PASS preload readiness fencing, binary decode, shared API push, stream reset, dropped-file mapping and asynchronous evaluation result",
);
