import type { OmpApi } from "../shared/ipc-types";
import { createOmpApi, type OmpTransport } from "../shared/omp-api";
import { describePreloadFailure } from "../shared/preload-failure";

type Kind = "invoke" | "send" | "ready" | "preloadError" | "profileRead" | "profileAck" | "windowControl";
type NativeInvoke = (command: string, args: { kind: Kind; payload: string }) => Promise<unknown>;

const nativeWindow = window as unknown as { __TAURI_INTERNALS__?: { invoke?: NativeInvoke }; omp: OmpApi };
const invoke = nativeWindow.__TAURI_INTERNALS__?.invoke;

/**
 * What went wrong in this page before anything else could say so, for a failed native check to read back
 * (scripts/tauri-native-smoke.ts): scripts and styles that failed to load, errors nothing caught, CSP refusals and
 * every IPC call the host refused. The renderer's console never reaches main on this host. Capped; the app never reads it.
 */
const diagnostics = {
	events: [] as string[],
	calls: { invokes: 0, answered: 0, failed: 0, sends: 0, delivered: 0, pushed: 0, pushesDropped: 0 },
};
const startedAt = Date.now();
function note(kind: string, detail: unknown): void {
	if (diagnostics.events.length >= 60) return;
	const text = detail instanceof Error ? detail.message : String(detail);
	diagnostics.events.push(`+${Date.now() - startedAt}ms ${kind}: ${text.slice(0, 300)}`);
}

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
		diagnostics.calls.invokes++;
		const answer = decode(
			await call("invoke", { channel, args }).catch(error => {
				diagnostics.calls.failed++;
				note(`invoke ${channel} failed`, error);
				throw error;
			}),
		) as { value?: T; error?: { message: string } };
		if (answer.error) {
			diagnostics.calls.failed++;
			note(`invoke ${channel} answered with an error`, answer.error.message);
			throw new Error(answer.error.message);
		}
		diagnostics.calls.answered++;
		return answer.value as T;
	},
	send(channel: string, ...args: unknown[]): void {
		diagnostics.calls.sends++;
		const payload = encode({ channel, args });
		sends = sends
			.then(() => call("send", JSON.parse(payload)).then(() => void diagnostics.calls.delivered++))
			.catch(error => {
				diagnostics.calls.failed++;
				note(`send ${channel} failed`, error);
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

// HWND-backed WebView2 handles CSS drag regions, but CSS cannot mark a Windows maximize button.
// Report only the top row, in client physical pixels (including the page's current zoom).
function watchCaptionRegions(): void {
	const layers = ".omp-dialog-overlay,.omp-action-sheet-overlay,[data-sheet-placement],.omp-pop-in,dialog[open],[popover]:popover-open,[role=dialog],[role=menu]";
	const controls = "button,a,input,textarea,select,[role=button],[role=tab],[contenteditable=true]";
	const chrome = `.drag-region,.no-drag,[data-caption],${layers}`;
	const watched = new Set<Element>();
	let frame = 0;
	let sent = "";
	let sending = false;
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(sync);
	};
	const resize = new ResizeObserver(schedule);
	function sync(): void {
		frame = 0;
		if (sending) return;
		const dpr = window.devicePixelRatio;
		const width = Math.round(window.innerWidth * dpr);
		const height = Math.round(36 * dpr);
		const cells: Array<[string, number, number, number, number]> = [];
		const current = new Set<Element>();
		const add = (el: Element, kind: string) => {
			current.add(el);
			if (!watched.has(el)) resize.observe(el);
			const rect = el.getBoundingClientRect();
			const l = Math.max(0, Math.round(rect.left * dpr));
			const t = Math.max(0, Math.round(rect.top * dpr));
			const r = Math.min(width, Math.round(rect.right * dpr));
			const b = Math.min(height, Math.round(rect.bottom * dpr));
			if (l >= r || t >= b || getComputedStyle(el).visibility !== "visible") return;
			const cell: [string, number, number, number, number] = [kind, l, t, r, b];
			cells.push(cell);
			return cell;
		};
		for (const el of document.querySelectorAll(".drag-region")) add(el, "drag");
		for (const el of document.querySelectorAll(`.no-drag,.drag-region :is(${controls})`)) add(el, "client");
		const buttons = new Map<Element, (typeof cells)[number]>();
		for (const el of document.querySelectorAll<HTMLElement>("[data-caption]")) {
			const action = el.dataset.caption;
			if (action === "minimize" || action === "maximize" || action === "close") {
				const cell = add(el, action);
				if (cell) buttons.set(el, cell);
			}
		}
		const front: typeof cells = [];
		for (const el of document.querySelectorAll(layers)) {
			const layer = add(el, "client");
			if (!layer) continue;
			for (const [button, cell] of buttons) {
				const l = Math.max(cell[1], layer[1]), t = Math.max(cell[2], layer[2]);
				const r = Math.min(cell[3], layer[3]), b = Math.min(cell[4], layer[4]);
				if (l < r && t < b && button.contains(document.elementFromPoint((l + r) / (2 * dpr), (t + b) / (2 * dpr)))) {
					front.push([cell[0], l, t, r, b]);
				}
			}
		}
		cells.push(...front);
		for (const el of watched) if (!current.has(el)) resize.unobserve(el);
		watched.clear();
		for (const el of current) watched.add(el);
		const payload = { action: "regions", width, height, cells };
		const key = JSON.stringify(payload);
		if (key === sent) return;
		sending = true;
		void call("windowControl", payload).then(() => {
			sent = key;
			schedule(); // A reflow during the call must publish the newest geometry last.
		}).catch(error => note("window hit regions", error)).finally(() => { sending = false; });
	}
	new MutationObserver(records => {
		for (const record of records) {
			const target = record.target;
			if (target instanceof Element && (watched.has(target) || target.closest(chrome))) return schedule();
			for (const node of [...record.addedNodes, ...record.removedNodes]) {
				if (node instanceof Element && (node.matches(chrome) || node.querySelector(chrome))) return schedule();
			}
		}
	}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "data-state"] });
	window.addEventListener("resize", schedule);
	document.addEventListener("scroll", event => {
		if (event.target instanceof Element && event.target.closest(".drag-region")) schedule();
	}, true);
	transport.on("window-chrome:hover", action => {
		if (action === "minimize" || action === "maximize" || action === "close") document.documentElement.dataset.captionHover = action;
		else delete document.documentElement.dataset.captionHover;
	});
	schedule();
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
	style.textContent = `html[data-platform="win32"]:root{--sc-caption-buttons:${CAPTION_BUTTON_WIDTH * 3}px!important;--sc-caption-band:36px!important}
[data-caption-buttons]{position:fixed;top:0;right:0;height:36px;z-index:2147483647;display:flex;-webkit-app-region:no-drag;app-region:no-drag;background:var(--omp-caption-bg,var(--sc-bg,#fff));color:var(--omp-caption-fg,var(--sc-text,#1b1b1f));font:10px "Segoe MDL2 Assets","Segoe Fluent Icons",system-ui}
[data-caption-buttons] button{all:unset;box-sizing:border-box;width:${CAPTION_BUTTON_WIDTH}px;height:100%;display:grid;place-items:center;cursor:default;-webkit-app-region:no-drag;app-region:no-drag}
[data-caption-buttons] button:hover,html[data-caption-hover=minimize] [data-caption=minimize],html[data-caption-hover=maximize] [data-caption=maximize]{background:color-mix(in srgb,currentColor 12%,transparent)}
[data-caption-buttons] button[data-caption="close"]:hover,html[data-caption-hover=close] [data-caption=close]{background:#c42b1c;color:#fff}`;
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
		watchCaptionRegions();
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

// Tauri adds an initialization script to every subframe on Windows (its docs: "scripts are always added to subframes"),
// and Electron's preload ran in the top frame only. A frame inside the page (a document viewer, a sandboxed reply
// frame) gets no `window.omp`, no caption buttons and no readiness handshake: it would throw "Tauri invoke is
// unavailable" there, as a page error of the window that holds it.
if (window.top !== window) {
	// Subframe: nothing to install.
} else if (profileBootstrap) {
	void migrateProfile();
} else
	try {
		if (!invoke) throw new Error("Tauri invoke is unavailable");
		Object.defineProperty(window, "__ompDiagnostics", { value: diagnostics });
		if (typeof window.addEventListener === "function") {
			// Capture phase: a `<script>` or `<link>` that fails to load fires `error` on the element and never bubbles.
			window.addEventListener(
				"error",
				event => {
					const target = event.target as { tagName?: string; src?: string; href?: string } | null;
					if (target?.tagName) note(`${target.tagName.toLowerCase()} did not load`, target.src || target.href);
					else note("uncaught error", event.error ?? event.message);
				},
				true,
			);
			window.addEventListener("unhandledrejection", event => note("unhandled rejection", event.reason));
			window.addEventListener("securitypolicyviolation", event =>
				note("CSP refused", `${event.violatedDirective} ${event.blockedURI}`),
			);
		}
		Object.defineProperty(window, "__ompShellStream", { value: shellStream });
		Object.defineProperty(window, "__ompTauriPush", {
			value: (expectedGeneration: number, raw: unknown) => {
				return ready.promise
					.then(current => {
						if (current === expectedGeneration) {
							diagnostics.calls.pushed++;
							push(raw);
						} else {
							diagnostics.calls.pushesDropped++;
							note("push dropped", `for document ${expectedGeneration}, this is ${current}`);
						}
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
