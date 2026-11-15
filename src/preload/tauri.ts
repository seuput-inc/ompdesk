import type { OmpApi } from "../shared/ipc-types";
import { createOmpApi, type OmpTransport } from "../shared/omp-api";
import { describePreloadFailure } from "../shared/preload-failure";

type Kind = "invoke" | "send" | "ready" | "evaluateResult" | "preloadError";
type NativeInvoke = (command: string, args: { kind: Kind; payload: string }) => Promise<unknown>;

const nativeWindow = window as unknown as { __TAURI_INTERNALS__?: { invoke?: NativeInvoke }; omp: OmpApi };
const invoke = nativeWindow.__TAURI_INTERNALS__?.invoke;

function encode(value: unknown): string {
	return JSON.stringify(value, (_key, item) => {
		if (item instanceof ArrayBuffer) item = new Uint8Array(item);
		if (item instanceof Uint8Array) {
			let text = "";
			for (let i = 0; i < item.length; i += 0x8000) text += String.fromCharCode(...item.subarray(i, i + 0x8000));
			return { $bin: btoa(text) };
		}
		return item;
	});
}

function decode(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value), (_key, item) => {
		if (item !== null && typeof item === "object" && "$bin" in item && typeof item.$bin === "string") {
			const raw = atob(item.$bin);
			const bytes = new Uint8Array(raw.length);
			for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
			return bytes;
		}
		return item;
	});
}

const ready = Promise.withResolvers<number>();
let generation: number | undefined;
void ready.promise.catch(() => undefined);

function nativeCall(kind: Kind, payload: string): Promise<unknown> {
	if (!invoke) throw new Error("Tauri invoke is unavailable");
	return invoke("omp_ipc", { kind, payload }).catch(error => {
		if (error instanceof Error) throw error;
		if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
			throw new Error(error.message);
		throw new Error(String(error));
	});
}

function reportFailure(error: unknown): void {
	try {
		const failure = describePreloadFailure(error);
		void nativeCall("preloadError", encode(generation === undefined ? failure : { ...failure, generation })).catch(
			() => undefined,
		);
	} catch {
		// Native invoke may not be available during startup.
	}
}

function call(kind: Exclude<Kind, "ready">, payload: object): Promise<unknown> {
	const snapshot = JSON.parse(encode(payload));
	return ready.promise.then(generation => nativeCall(kind, JSON.stringify({ ...snapshot, generation })));
}

const listeners = new Map<string, Set<(data: unknown) => void>>();
const droppedFiles = new Map<string, string>();

function dropFiles(entries: unknown): void {
	droppedFiles.clear();
	if (!Array.isArray(entries)) return;
	for (const entry of entries) {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.name !== "string" ||
			typeof entry.path !== "string" ||
			!entry.name ||
			!entry.path
		) {
			droppedFiles.clear();
			return;
		}
		droppedFiles.set(entry.name, entry.path);
	}
}
let pendingReset: object | null = null;
const resetListeners = new Set<() => void>();
const shellStream = {
	onReset(listener: () => void): () => void {
		resetListeners.add(listener);
		if (pendingReset) listener();
		return () => {
			resetListeners.delete(listener);
		};
	},
	pending: () => pendingReset,
	acknowledge(token: object): void {
		if (pendingReset === token) pendingReset = null;
	},
};

function resetStream(): void {
	pendingReset = {};
	for (const listener of [...resetListeners]) listener();
}

function push(raw: unknown): void {
	let message: unknown;
	try {
		message = decode(raw);
	} catch {
		resetStream();
		return;
	}
	if (message && typeof message === "object" && "stream" in message && message.stream === "reset") {
		resetStream();
		return;
	}
	if (
		!message ||
		typeof message !== "object" ||
		!("channel" in message) ||
		typeof message.channel !== "string" ||
		!("args" in message) ||
		!Array.isArray(message.args)
	) {
		resetStream();
		return;
	}
	const set = listeners.get(message.channel);
	if (set) for (const listener of [...set]) listener(message.args[0]);
}

let sends: Promise<unknown> = Promise.resolve();
const transport: OmpTransport = {
	async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
		const answer = decode(await call("invoke", { channel, args })) as { value?: T; error?: { message: string } };
		if (answer.error) throw new Error(answer.error.message);
		return answer.value as T;
	},
	send(channel: string, ...args: unknown[]): void {
		const payload = encode({ channel, args });
		sends = sends
			.then(() => call("send", JSON.parse(payload)))
			.catch(error => {
				console.error("Tauri IPC send failed", error);
			});
	},
	on(channel: string, listener: (data: unknown) => void): () => void {
		let set = listeners.get(channel);
		if (!set) {
			set = new Set();
			listeners.set(channel, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	},
};

async function evaluate(id: unknown, expectedGeneration: number, run: () => unknown): Promise<void> {
	if ((await ready.promise) !== expectedGeneration) return;
	let result: object;
	try {
		const value: unknown = await run();
		result = { id, ok: true, value };
		// Serialization can fail for values such as cyclic objects or BigInt.
		encode(result);
	} catch (error) {
		result = { id, ok: false, error: { message: describePreloadFailure(error).message } };
	}
	await call("evaluateResult", result);
}

try {
	if (!invoke) throw new Error("Tauri invoke is unavailable");
	Object.defineProperty(window, "__ompShellStream", { value: shellStream });
	Object.defineProperty(window, "__ompTauriPush", {
		value: (expectedGeneration: number, raw: unknown) => {
			return ready.promise
				.then(current => {
					if (current === expectedGeneration) push(raw);
				})
				.catch(() => undefined);
		},
	});
	Object.defineProperty(window, "__ompTauriDropFiles", { value: dropFiles });
	Object.defineProperty(window, "__ompTauriEvaluate", {
		value: (id: unknown, expectedGeneration: number, run: () => unknown) => {
			return evaluate(id, expectedGeneration, run).catch(error =>
				console.error("Tauri evaluation response failed", error),
			);
		},
	});
	const shared = createOmpApi(transport);
	const api: OmpApi = {
		...shared,
		fs: {
			...shared.fs,
			pathForFile: file => {
				const path = droppedFiles.get(file.name);
				if (!path) throw new Error("Native dropped-file path is unavailable");
				return path;
			},
		},
	};
	nativeWindow.omp = api;
	void nativeCall("ready", encode({ userAgent: navigator.userAgent }))
		.then(answer => {
			if (
				!answer ||
				typeof answer !== "object" ||
				!("generation" in answer) ||
				typeof answer.generation !== "number" ||
				!Number.isSafeInteger(answer.generation)
			)
				throw new Error("Tauri ready returned an invalid generation");
			generation = answer.generation;
			ready.resolve(answer.generation);
		})
		.catch(error => {
			ready.reject(error);
			reportFailure(error);
			console.error("Tauri preload readiness failed", error);
		});
} catch (error) {
	ready.reject(error);
	reportFailure(error);
	throw error;
}
