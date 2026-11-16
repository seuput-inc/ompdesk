import type { OmpApi } from "../shared/ipc-types";
import { createOmpApi, type OmpTransport } from "../shared/omp-api";
import { describePreloadFailure } from "../shared/preload-failure";

type Kind = "invoke" | "send" | "ready" | "preloadError" | "profileRead" | "profileAck" | "windowControl";
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

async function migrateProfile(): Promise<void> {
	try {
		const answer = await nativeCall("profileRead", "{}");
		if (
			!answer ||
			typeof answer !== "object" ||
			!("generation" in answer) ||
			typeof answer.generation !== "number" ||
			!Number.isSafeInteger(answer.generation) ||
			answer.generation <= 0
		)
			throw new Error("Invalid profile snapshot");
		if ("complete" in answer && answer.complete === true) return;
		if (
			!("id" in answer) ||
			typeof answer.id !== "string" ||
			!("items" in answer) ||
			!answer.items ||
			typeof answer.items !== "object" ||
			Array.isArray(answer.items)
		)
			throw new Error("Invalid profile snapshot");
		const entries = Object.entries(answer.items);
		if (entries.some(([, value]) => typeof value !== "string")) throw new Error("Invalid profile snapshot");
		generation = answer.generation;
		for (const [key, source] of entries) {
			const existing = localStorage.getItem(key);
			if (existing === null) localStorage.setItem(key, source as string);
			if (localStorage.getItem(key) !== (existing === null ? source : existing))
				throw new Error("Profile storage verification failed");
		}
		await nativeCall("profileAck", encode({ id: answer.id, verifiedKeys: entries.length, generation }));
	} catch {
		const failure = new Error("Local storage migration failed. Your existing data has not been overwritten.");
		reportFailure(failure);
		const showError = () => {
			const element = document.getElementById("omp-profile-error");
			if (element) element.textContent = failure.message;
			const retry = document.getElementById("omp-profile-retry");
			if (retry) retry.hidden = false;
		};
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showError, { once: true });
		else showError();
	}
}

/**
 * Windows: the host's windows have no OS caption (`decorations` off, as Electron's `titleBarStyle: "hidden"` with a
 * `titleBarOverlay`), so the three caption buttons are drawn here, over the top-right corner, in the colors main last
 * set (`__ompTauriCaption`, from `setTitleBarOverlay`; the theme's own until then). Their room is the Window Controls
 * Overlay's `env(titlebar-area-*)` that WebView2 does not have, so the stylesheet's two variables are set to it.
 */
const CAPTION_BUTTON_WIDTH = 46;
function installCaptionButtons(): void {
	// At once, before the first paint: the top bars' room for the buttons must not arrive after it (a layout shift).
	const style = document.createElement("style");
	style.textContent = `html[data-platform="win32"]:root{--sc-caption-buttons:${CAPTION_BUTTON_WIDTH * 3}px!important;--sc-caption-band:48px!important}
[data-caption-buttons]{position:fixed;top:0;right:0;height:48px;z-index:2147483647;display:flex;-webkit-app-region:no-drag;app-region:no-drag;background:var(--omp-caption-bg,var(--sc-bg,#fff));color:var(--omp-caption-fg,var(--sc-text,#1b1b1f));font:10px "Segoe MDL2 Assets","Segoe Fluent Icons",system-ui}
[data-caption-buttons] button{all:unset;box-sizing:border-box;width:${CAPTION_BUTTON_WIDTH}px;height:100%;display:grid;place-items:center;cursor:default;-webkit-app-region:no-drag;app-region:no-drag}
[data-caption-buttons] button:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
[data-caption-buttons] button[data-caption="close"]:hover{background:#c42b1c;color:#fff}`;
	document.documentElement.appendChild(style);
	const build = () => {
		const bar = document.createElement("div");
		bar.dataset.captionButtons = "";
		const maximize = document.createElement("button");
		const glyphs: Array<[string, string, string]> = [
			["minimize", "\uE921", "Minimize"],
			["maximize", "\uE922", "Maximize"],
			["close", "\uE8BB", "Close"],
		];
		for (const [action, glyph, label] of glyphs) {
			const button = action === "maximize" ? maximize : document.createElement("button");
			button.dataset.caption = action;
			button.type = "button";
			button.tabIndex = -1;
			button.setAttribute("aria-label", label);
			button.textContent = glyph;
			button.addEventListener("click", () => void call("windowControl", { action }).catch(() => undefined));
			bar.appendChild(button);
		}
		const sync = () => {
			const filled = window.outerWidth >= screen.availWidth && window.outerHeight >= screen.availHeight;
			maximize.textContent = filled ? "\uE923" : "\uE922";
			maximize.setAttribute("aria-label", filled ? "Restore" : "Maximize");
		};
		window.addEventListener("resize", sync);
		sync();
		document.body.appendChild(bar);
		Object.defineProperty(window, "__ompTauriCaption", {
			value: (colors: { color?: string; symbolColor?: string }) => {
				if (colors.color) bar.style.setProperty("--omp-caption-bg", colors.color);
				if (colors.symbolColor) bar.style.setProperty("--omp-caption-fg", colors.symbolColor);
			},
		});
	};
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build, { once: true });
	else build();
}

const location = window.location;
const profileBootstrap =
	location?.pathname === "/__profile/migrate" &&
	((location.protocol === "app:" && location.host === "ompdesk") ||
		(location.protocol === "http:" && location.host === "app.localhost"));

if (profileBootstrap) {
	void migrateProfile();
} else
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
		const shared = createOmpApi(transport);
		const api: OmpApi = {
			...shared,
			fs: {
				...shared.fs,
				// WKWebView/WebView2 File objects expose bytes, not an authenticated local path.
				pathForFile: () => "",
			},
		};
		nativeWindow.omp = api;
		try {
			if (navigator.platform.toLowerCase().startsWith("win")) installCaptionButtons();
		} catch (error) {
			console.error("Tauri caption buttons failed", error);
		}
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
