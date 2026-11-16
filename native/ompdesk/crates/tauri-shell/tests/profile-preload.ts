import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../../../src/preload/tauri.ts", import.meta.url));
const built = await Bun.build({ entrypoints: [source], target: "browser", format: "iife" });
assert.equal(built.success, true, String(built.logs));
const preload = await built.outputs[0].text();

type Frame = { kind: string; payload: Record<string, unknown> };
type Options = {
	items?: unknown;
	answer?: unknown;
	completeRead?: boolean;
	storage?: Map<string, string>;
	failSet?: string;
	mismatch?: string;
	rejectAck?: boolean;
	loading?: boolean;
	location?: { pathname: string; protocol: string; host: string };
	read?: Promise<unknown>;
	afterStart?: (context: Record<string, unknown>) => void;
};

async function run(options: Options = {}) {
	const storage = options.storage ?? new Map<string, string>();
	const frames: Frame[] = [];
	const error = { textContent: "" };
	const retry = { hidden: true };
	const terminal = Promise.withResolvers<void>();
	let domReady: (() => void) | undefined;
	const context: Record<string, unknown> = {
		console,
		Promise,
		navigator: { userAgent: "synthetic" },
		location: options.location ?? { pathname: "/__profile/migrate", protocol: "app:", host: "ompdesk" },
		localStorage: {
			getItem(key: string) {
				if (key === options.mismatch && storage.has(key)) return "incorrect";
				return storage.get(key) ?? null;
			},
			setItem(key: string, value: string) {
				if (key === options.failSet) throw new Error(`quota ${key} ${value}`);
				storage.set(key, value);
			},
		},
		document: {
			readyState: options.loading ? "loading" : "complete",
			getElementById(id: string) {
				return id === "omp-profile-error" ? error : id === "omp-profile-retry" ? retry : null;
			},
			addEventListener(_event: string, listener: () => void) {
				domReady = listener;
			},
		},
		__TAURI_INTERNALS__: {
			async invoke(command: string, args: { kind: string; payload: string }) {
				assert.equal(command, "omp_ipc");
				frames.push({ kind: args.kind, payload: JSON.parse(args.payload) });
				if (args.kind === "profileRead") {
					if (options.completeRead) {
						return {
							generation: 7,
							get complete() {
								terminal.resolve();
								return true;
							},
						};
					}
					return options.read ?? options.answer ?? { id: "snapshot", items: options.items ?? {}, generation: 7 };
				}
				if (args.kind === "profileAck" && options.rejectAck) throw new Error("ack rejected with secret");
				if (args.kind === "profileAck" || args.kind === "preloadError" || args.kind === "ready") terminal.resolve();
				if (args.kind === "ready") return { generation: 7 };
				return {};
			},
		},
	};
	context.window = context;
	vm.runInNewContext(preload, context);
	options.afterStart?.(context);
	await terminal.promise;
	return { storage, frames, error, retry, context, showAfterLoad: () => domReady?.() };
}

const korean = "안녕하세요. 첨부한 메모입니다.\n".repeat(8192);
const attachments = JSON.stringify([{ name: "사진.png", data: "AQID+/=".repeat(8192) }]);
const snapshot = { draft: "old draft", korean, attachments };
const storage = new Map([["draft", "newer draft"]]);
const imported = await run({ items: snapshot, storage });
assert.deepEqual(Object.fromEntries(storage), { draft: "newer draft", korean, attachments });
assert.deepEqual(imported.frames, [
	{ kind: "profileRead", payload: {} },
	{ kind: "profileAck", payload: { id: "snapshot", verifiedKeys: 3, generation: 7 } },
]);
assert.equal(imported.context.omp, undefined);
assert.equal(imported.error.textContent, "");
assert.equal(imported.retry.hidden, true);

const complete = await run({ completeRead: true });
assert.deepEqual(complete.frames, [{ kind: "profileRead", payload: {} }]);
assert.equal(complete.storage.size, 0);
assert.equal(complete.context.omp, undefined);
assert.equal(complete.error.textContent, "");
assert.equal(complete.retry.hidden, true);

const partialStorage = new Map<string, string>();
const failed = await run({ items: snapshot, storage: partialStorage, failSet: "korean", loading: true });
assert.equal(partialStorage.get("draft"), "old draft");
assert.equal(partialStorage.has("korean"), false);
assert.deepEqual(
	failed.frames.map(frame => frame.kind),
	["profileRead", "preloadError"],
);
assert.equal(failed.error.textContent, "");
assert.equal(failed.retry.hidden, true);
failed.showAfterLoad();
assert.match(failed.error.textContent, /migration failed/i);
assert.equal(failed.retry.hidden, false);
assert.equal(JSON.stringify(failed.frames).includes("old draft"), false);
assert.equal(JSON.stringify(failed.frames).includes("korean"), false);
assert.equal(failed.context.omp, undefined);

partialStorage.set("draft", "edited after failure");
const retried = await run({ items: snapshot, storage: partialStorage });
assert.deepEqual(Object.fromEntries(partialStorage), { draft: "edited after failure", korean, attachments });
assert.deepEqual(retried.frames[1], {
	kind: "profileAck",
	payload: { id: "snapshot", verifiedKeys: 3, generation: 7 },
});

const mismatch = await run({ items: { value: "source" }, mismatch: "value" });
assert.deepEqual(
	mismatch.frames.map(frame => frame.kind),
	["profileRead", "preloadError"],
);
assert.match(mismatch.error.textContent, /migration failed/i);
assert.equal(mismatch.context.omp, undefined);

const rejected = await run({ items: { value: "source" }, rejectAck: true });
assert.deepEqual(
	rejected.frames.map(frame => frame.kind),
	["profileRead", "profileAck", "preloadError"],
);
assert.match(rejected.error.textContent, /migration failed/i);
assert.equal(rejected.retry.hidden, false);
assert.equal(rejected.context.omp, undefined);
assert.equal(JSON.stringify(rejected.frames).includes("ack rejected with secret"), false);

for (const answer of [
	{ id: 1, items: {}, generation: 7 },
	{ id: "snapshot", items: [], generation: 7 },
	{ id: "snapshot", items: { value: 1 }, generation: 7 },
	{ id: "snapshot", items: {}, generation: 0 },
	{ complete: true, generation: 0 },
	{ id: "snapshot", items: {}, generation: Number.MAX_SAFE_INTEGER + 1 },
]) {
	const invalid = await run({ answer });
	assert.deepEqual(
		invalid.frames.map(frame => frame.kind),
		["profileRead", "preloadError"],
	);
	assert.equal(invalid.storage.size, 0);
}

const gate = Promise.withResolvers<unknown>();
const captured = await run({
	read: gate.promise,
	afterStart(context) {
		context.__TAURI_INTERNALS__ = {
			invoke: () => {
				throw new Error("page replaced native invoke");
			},
		};
		gate.resolve({ id: "snapshot", items: { key: "value" }, generation: 7 });
	},
});
assert.deepEqual(
	captured.frames.map(frame => frame.kind),
	["profileRead", "profileAck"],
);
assert.equal(captured.storage.get("key"), "value");

const windows = await run({ location: { pathname: "/__profile/migrate", protocol: "http:", host: "app.localhost" } });
assert.deepEqual(
	windows.frames.map(frame => frame.kind),
	["profileRead", "profileAck"],
);
const other = await run({ location: { pathname: "/__profile/migrate", protocol: "https:", host: "attacker.example" } });
assert.deepEqual(
	other.frames.map(frame => frame.kind),
	["ready"],
);
assert.ok(other.context.omp);

console.log("PASS profile preload imports, retries, verification, failures and origin gating");
