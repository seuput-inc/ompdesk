/**
 * Registers omp:// protocol and handles deep links.
 * Supports omp://session/<id> and omp://new.
 */
import { isAbsolute, resolve } from "node:path";
import type { BrowserWindow } from "electron";
import { type DeepLinkPayload, IPC_EVENTS } from "../shared/ipc-types";
import { app } from "./shell-host/electron/index";
import type { SpawnWindow, WindowManager } from "./window";

const PROTOCOL = "omp";

/**
 * macOS delivers the launch URL while the app is still starting, and `setupDeepLinks`
 * only runs once the first window exists — so a listener registered there would miss
 * the link that opened the app. Recorded here at import time, replayed on setup.
 */
const beforeSetup: string[] = [];
let handler: ((url: string) => void) | undefined;

app.on("open-url", (event, url) => {
	event.preventDefault();
	if (handler) handler(url);
	else beforeSetup.push(url);
});

/** Same replay story for `open -a omp ~/code/x`, which arrives as an open-file. */
const filesBeforeSetup: string[] = [];
let fileHandler: ((path: string) => void) | undefined;

app.on("open-file", (event, path) => {
	event.preventDefault();
	if (fileHandler) fileHandler(path);
	else filesBeforeSetup.push(path);
});

export function setupDeepLinks(windowManager: WindowManager, spawnWindow: SpawnWindow): void {
	// Register as the default omp:// handler, except in test runs (OMP_GUI_HEADLESS):
	// that LaunchServices entry belongs to the user's installed OMPdesk. Links
	// still arrive through open-url / second-instance below either way.
	if (process.env.OMP_GUI_HEADLESS !== "1") app.setAsDefaultProtocolClient(PROTOCOL);

	// The next open must see the window the preceding path or link asked the core to prepare.
	let pending = Promise.resolve();
	const enqueue = (open: () => Promise<void>) => {
		pending = pending.then(open).catch(error => console.error("Failed to open launch request", error));
	};
	handler = url => enqueue(() => handleDeepLink(url, windowManager, spawnWindow));
	for (const url of beforeSetup.splice(0)) handler(url);
	fileHandler = path => enqueue(() => handleOpenPath(path, windowManager, spawnWindow));
	for (const path of filesBeforeSetup.splice(0)) fileHandler(path);

	app.onSecondInstance(request => {
		if (request.kind === "url") handler?.(request.url);
		else if (request.kind === "path") fileHandler?.(request.path);
		else enqueue(async () => showWindow(windowManager.getTargetWindow()));
	});
}

/**
 * Bring a window forward the way a launch from the Start menu or Dock expects. A window hidden to
 * the tray (Settings › General › Window) stays hidden under `focus()` alone: Electron's focus is a
 * no-op on a hidden window on Windows, so the launch would hand over and show nothing.
 */
function showWindow(win: BrowserWindow | null | undefined): void {
	if (!win) return;
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
}

/**
 * Bring the window already showing this workspace forward, or open it in a new
 * one. Relative paths resolve against the launcher's cwd, which is never the
 * workspace the user pointed at, so they are refused rather than guessed.
 */
async function handleOpenPath(path: string, windowManager: WindowManager, spawnWindow: SpawnWindow): Promise<void> {
	if (!isAbsolute(path)) return;
	const target = resolve(path);
	for (const win of windowManager.getAllWindows()) {
		if (windowManager.recordFor(win)?.cwd !== target) continue;
		showWindow(win);
		return;
	}
	await spawnWindow(target);
}

async function handleDeepLink(url: string, windowManager: WindowManager, spawnWindow: SpawnWindow): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return;
	}

	const win = windowManager.getMainWindow() ?? (await spawnWindow());
	if (!win) return;
	win.show();
	win.focus();

	// new URL puts the first segment of a scheme:// URL into hostname, not
	// pathname: omp://new → host "new", omp://session/<id> → host "session" +
	// path "/<id>". (Hostname case is preserved for non-special schemes.)
	let payload: DeepLinkPayload | null = null;
	const host = parsed.hostname.toLowerCase();
	if (host === "new") {
		payload = { action: "new-session" };
	} else if (host === "session") {
		const sessionId = parsed.pathname.replace(/^\/+|\/+$/g, "");
		if (sessionId) {
			payload = { action: "switch-session", sessionId };
		}
	}
	if (!payload) return;

	// Cold start: the renderer only subscribes after load — hold the link until
	// then, otherwise it is silently dropped.
	const link = payload;
	if (win.webContents.isLoading()) {
		win.webContents.once("did-finish-load", () => {
			if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.DEEP_LINK, link);
		});
	} else {
		win.webContents.send(IPC_EVENTS.DEEP_LINK, link);
	}
}
