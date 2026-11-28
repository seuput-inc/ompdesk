import type { NativeWindowChrome, NativeWindowState, OmpApi } from "../shared/ipc-types";
import { createOmpApi, type OmpTransport } from "../shared/omp-api";
import { describePreloadFailure } from "../shared/preload-failure";

type Kind = "invoke" | "send" | "ready" | "preloadError" | "profileRead" | "profileAck" | "windowControl";
type NativeInvoke = (command: string, args: { kind: Kind; payload: string }) => Promise<unknown>;
// A lexical binding provided by the host around the top frame's initialization script.
declare const OMP_WINDOW_KEY: string;

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
	const layers =
		".omp-dialog-overlay,.omp-action-sheet-overlay,[data-sheet-placement],.omp-pop-in,dialog[open],[popover]:popover-open,[role=dialog],[role=menu]";
	const controls = "button,a,input,textarea,select,[role=button],[role=tab],[contenteditable=true]";
	const rowSelector = "[data-desktop-titlebar]";
	const changes = new MutationObserver(schedule);
	const watched = new Set<Element>();
	let frame = 0;
	let sent = "";
	let sending = false;
	let dirty = false;
	let bar: Element | null = null;
	function schedule(): void {
		if (sending) dirty = true;
		else if (!frame) frame = requestAnimationFrame(sync);
	}
	const resize = new ResizeObserver(schedule);
	function sync(): void {
		frame = 0;
		if (!bar?.isConnected) bar = document.querySelector(rowSelector);
		// DesktopChrome marks the document when its title bar mounts. Watch the row and the
		// containers that own overlay portals, never transcript descendants.
		changes.disconnect();
		changes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-desktop-chrome"] });
		if (bar)
			changes.observe(bar, {
				subtree: true,
				childList: true,
				attributes: true,
				attributeFilter: ["class", "style", "hidden", "inert"],
			});
		const shells = new Set<Element>([document.body]);
		if (bar?.parentElement) {
			shells.add(bar.parentElement);
			for (const el of bar.parentElement.children) if (el.classList.contains("contents")) shells.add(el);
		}
		const overlays: Element[] = [];
		for (const shell of shells) {
			changes.observe(shell, { childList: true });
			for (const el of shell.children)
				if (el.matches(layers)) {
					overlays.push(el);
					changes.observe(el, { attributes: true, attributeFilter: ["class", "style", "open", "inert"] });
				}
		}
		const dpr = window.devicePixelRatio;
		const width = Math.round(window.innerWidth * dpr);
		const height = Math.round(36 * dpr);
		const cells: Array<[string, number, number, number, number]> = [];
		const current = new Set<Element>();
		const add = (el: Element, kind: string) => {
			if (el.hasAttribute("inert")) return;
			const rect = el.getBoundingClientRect();
			const l = Math.max(0, Math.round(rect.left * dpr));
			const t = Math.max(0, Math.round(rect.top * dpr));
			const r = Math.min(width, Math.round(rect.right * dpr));
			const b = Math.min(height, Math.round(rect.bottom * dpr));
			if (l >= r || t >= b) return;
			const style = getComputedStyle(el);
			if (style.visibility !== "visible" || style.pointerEvents === "none") return;
			current.add(el);
			if (!watched.has(el)) resize.observe(el);
			const cell: [string, number, number, number, number] = [kind, l, t, r, b];
			cells.push(cell);
			return cell;
		};
		if (bar) {
			add(bar, "drag");
			for (const el of bar.querySelectorAll(`.no-drag,${controls}`)) {
				// A no-drag tab strip already covers its clipped/scrolled children.
				if (!el.parentElement?.closest(".no-drag")) add(el, "client");
			}
		}
		const buttons = new Map<Element, (typeof cells)[number]>();
		for (const el of bar?.querySelectorAll<HTMLElement>("[data-caption]") ?? []) {
			const action = el.dataset.caption;
			if (action === "minimize" || action === "maximize" || action === "close") {
				const cell = add(el, action);
				if (cell) buttons.set(el, cell);
			}
		}
		const front: typeof cells = [];
		for (const el of overlays) {
			const layer = add(el, "client");
			if (!layer) continue;
			for (const [button, cell] of buttons) {
				const l = Math.max(cell[1], layer[1]),
					t = Math.max(cell[2], layer[2]);
				const r = Math.min(cell[3], layer[3]),
					b = Math.min(cell[4], layer[4]);
				if (
					l < r &&
					t < b &&
					button.contains(document.elementFromPoint((l + r) / (2 * dpr), (t + b) / (2 * dpr)))
				) {
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
		void windowControl(payload)
			.then(() => {
				sent = key;
			})
			.catch(error => note("window hit regions", error))
			.finally(() => {
				sending = false;
				if (dirty) {
					dirty = false;
					schedule();
				}
			});
	}
	window.addEventListener("resize", schedule);
	document.addEventListener(
		"animationend",
		event => {
			if (event.target instanceof Element && event.target.matches(layers)) schedule();
		},
		true,
	);
	transport.on("window-chrome:hover", action => {
		if (action === "minimize" || action === "maximize" || action === "close")
			document.documentElement.dataset.captionHover = action;
		else delete document.documentElement.dataset.captionHover;
	});
	schedule();
}

function windowControl(payload: { action: string; x?: number; y?: number }): Promise<unknown> {
	return call("windowControl", { ...payload, key: OMP_WINDOW_KEY });
}

function windowState(value: unknown): NativeWindowState {
	if (
		!value ||
		typeof value !== "object" ||
		!("maximized" in value) ||
		typeof value.maximized !== "boolean" ||
		!("fullscreen" in value) ||
		typeof value.fullscreen !== "boolean"
	)
		throw new Error("Invalid native window state");
	return { maximized: value.maximized, fullscreen: value.fullscreen };
}

const nativeChrome: NativeWindowChrome = {
	getState: async () => windowState(await windowControl({ action: "state" })),
	onStateChanged: listener => transport.on("window-chrome:state", value => listener(windowState(value))),
	minimize: async () => {
		await windowControl({ action: "minimize" });
	},
	toggleMaximize: async () => {
		await windowControl({ action: "maximize" });
	},
	close: async () => {
		await windowControl({ action: "close" });
	},
	showMenu: async (x, y) => {
		await windowControl({ action: "menu", x, y });
	},
};

function watchMacDrag(): void {
	const blank = (event: MouseEvent) => {
		const target = event.target;
		return (
			event.isTrusted &&
			!event.defaultPrevented &&
			event.button === 0 &&
			!event.ctrlKey &&
			event.clientY >= 0 &&
			event.clientY < 36 &&
			target instanceof Element &&
			target.closest("[data-desktop-titlebar]") &&
			!target.closest(
				".no-drag,button,a,input,select,textarea,[contenteditable=true],[role=button],[role=tab],[role=dialog],[role=menu]",
			)
		);
	};
	let second: { x: number; y: number } | undefined;
	document.addEventListener("mousedown", event => {
		second = undefined;
		if (!blank(event)) return;
		if (event.detail === 2) {
			second = { x: event.clientX, y: event.clientY };
		} else if (event.detail === 1) {
			event.preventDefault();
			void windowControl({ action: "drag", x: event.clientX, y: event.clientY }).catch(error =>
				note("window drag", error),
			);
		}
	});
	document.addEventListener("mouseup", event => {
		const down = second;
		second = undefined;
		if (down && event.detail === 2 && event.clientX === down.x && event.clientY === down.y && blank(event)) {
			void windowControl({ action: "doubleClick", x: event.clientX, y: event.clientY }).catch(error =>
				note("title bar double-click", error),
			);
		}
	});
}

const location = window.location;
const profileBootstrap =
	location?.pathname === "/__profile/migrate" &&
	((location.protocol === "app:" && location.host === "ompdesk") ||
		(location.protocol === "http:" && location.host === "app.localhost"));

// Tauri adds an initialization script to every subframe on Windows (its docs: "scripts are always added to subframes"),
// and Electron's preload ran in the top frame only. A frame inside the page (a document viewer, a sandboxed reply
// frame) gets no `window.omp` or readiness handshake.
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
		const shared = createOmpApi(transport, typeof OMP_WINDOW_KEY === "string" ? nativeChrome : undefined);
		const api: OmpApi = {
			...shared,
			fs: {
				...shared.fs,
				// WKWebView/WebView2 File objects expose bytes, not an authenticated local path.
				pathForFile: () => "",
			},
		};
		nativeWindow.omp = api;
		const platform = navigator.platform?.toLowerCase();
		if (typeof OMP_WINDOW_KEY === "string") {
			const install = platform?.startsWith("win")
				? watchCaptionRegions
				: platform?.startsWith("mac")
					? watchMacDrag
					: undefined;
			if (install && document.readyState === "loading")
				document.addEventListener("DOMContentLoaded", install, { once: true });
			else install?.();
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
