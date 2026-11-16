import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { IPC_COMMANDS, IPC_EVENTS, type OmpApi } from "../../../../../src/shared/ipc-types";
import { intakeComposerFiles } from "../../../../../src/renderer/components/layout/composer/composer-files";
const source = fileURLToPath(new URL("../../../../../src/preload/tauri.ts", import.meta.url));
const built = await Bun.build({ entrypoints: [source], target: "browser", format: "iife" });
assert.equal(built.success, true, String(built.logs));
const frames: Array<{ kind: string; payload: Record<string, unknown> }> = [];
const ready = Promise.withResolvers<{ generation: number }>();
const uploads: Array<{ name: string; data: { $bin: string } }> = [];
const events = new EventTarget();
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
context.top = context;
context.addEventListener = events.addEventListener.bind(events);
context.removeEventListener = events.removeEventListener.bind(events);
context.dispatchEvent = events.dispatchEvent.bind(events);
context.__TAURI_INTERNALS__ = {
	invoke: async (command: string, args: { kind: string; payload: string }) => {
		assert.equal(command, "omp_ipc");
		const payload = JSON.parse(args.payload);
		frames.push({ kind: args.kind, payload });
		if (args.kind === "ready") return ready.promise;
		assert.equal(payload.generation, 7);
		if (payload.channel === IPC_COMMANDS.FS_UPLOAD_TO_HOST) {
			const upload = payload.args[0];
			uploads.push(upload);
			return { value: { ok: true, path: `/uploads/${uploads.length}/${upload.name}` } };
		}
		return { value: { $bin: "AQID" } };
	},
};
vm.runInNewContext(await built.outputs[0].text(), context);
const page = context as unknown as {
	omp: OmpApi;
	__ompTauriPush(generation: number, message: unknown): Promise<void>;
	__ompTauriDropFiles?: (files: unknown) => void;
	__ompShellStream: { pending(): object | null; acknowledge(token: object): void };
};
const pending = page.omp.prefs.get("before-ready");
assert.deepEqual(
	frames.map(f => f.kind),
	["ready"],
);
ready.resolve({ generation: 7 });
assert.deepEqual(Array.from((await pending) as Uint8Array), [1, 2, 3]);
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
// A cancelled native drag must not lend its path to a later picker file with the same name.
page.__ompTauriDropFiles?.([{ name: "report.pdf", path: "/private/report.pdf" }]);
events.dispatchEvent(new Event("dragend"));
events.dispatchEvent(new Event("blur"));
const picked = new File(["public picker bytes"], "report.pdf", { type: "application/pdf" });
assert.equal(page.omp.fs.pathForFile(picked), "");
const options = {
	cwd: "/workspace",
	remote: false,
	pathFor: (file: File) => page.omp.fs.pathForFile(file),
	sendToHost: async (file: File): Promise<string> => {
		const result = await page.omp.fs.uploadToHost("tab-1", file);
		assert.equal(result.ok, true);
		assert.ok(result.path);
		return result.path;
	},
};
const selected = await intakeComposerFiles([picked], options);
assert.deepEqual(selected.mentions, ["@/uploads/1/report.pdf"]);
assert.deepEqual(selected.rejected, []);
assert.equal(atob(uploads[0].data.$bin), "public picker bytes");
// With native interception disabled, DOM drop File objects reach this same real composer intake.
const dropped = new File([new Uint8Array([37, 80, 68, 70, 0, 42])], "report.pdf", { type: "application/pdf" });
const drop = await intakeComposerFiles([dropped], options);
assert.deepEqual(drop.mentions, ["@/uploads/2/report.pdf"]);
assert.deepEqual(drop.rejected, []);
assert.deepEqual(
	Array.from(Uint8Array.from(atob(uploads[1].data.$bin), byte => byte.charCodeAt(0))),
	[37, 80, 68, 70, 0, 42],
);
const clipboard = new File(["clipboard text"], "report.txt", { type: "text/plain" });
assert.equal(page.omp.fs.pathForFile(clipboard), "");
const pasted = await intakeComposerFiles([clipboard], options);
assert.deepEqual(pasted.texts, [{ name: "report.txt", content: "clipboard text" }]);
assert.deepEqual(pasted.rejected, []);
assert.equal(uploads.length, 2);
// A subframe (Tauri injects the script into every frame on Windows) installs nothing and invokes nothing.
const subframe: Record<string, unknown> = { ...context, top: {}, omp: undefined, __ompTauriPush: undefined };
subframe.window = subframe;
const subframeCalls: string[] = [];
subframe.__TAURI_INTERNALS__ = {
	invoke: async (_command: string, args: { kind: string }) => {
		subframeCalls.push(args.kind);
		throw new Error("Tauri invoke is unavailable");
	},
};
vm.runInNewContext(await built.outputs[0].text(), subframe);
assert.equal(subframe.omp, undefined);
assert.equal(subframe.__ompTauriPush, undefined);
assert.deepEqual(subframeCalls, []);
console.log(
	"PASS preload readiness fencing, binary decode, shared API push, stream reset, pathless picker/drop/clipboard bytes fallback, subframes untouched",
);
