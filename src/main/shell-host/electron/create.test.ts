/**
 * The `electron` shim against a fake shell: Electron's semantics (events, synchronous getters, the quit sequence,
 * `ipcMain` feeding main's `IpcRegistry`, protocol and net streaming, menus) over the host protocol's frames.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { NsisUpdater } from "electron-updater";
import { ElectronAppAdapter } from "electron-updater/out/ElectronAppAdapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcRegistry } from "../../web/ipc-registry";
import { InputMapper } from "../../web/preview-input";
import { Answered, HostError, ShellClient } from "../client";
import { duplexPair } from "../duplex-pair";
import type { HostFacts } from "../facts";
import { createElectron, type ElectronShim } from "./create";

const holder = vi.hoisted(() => ({ electron: null as Record<string, unknown> | null }));
// `IpcRegistry` imports `BrowserWindow` from "electron": it gets the shim under test.
vi.mock("electron", () => ({
	get BrowserWindow() {
		return holder.electron?.BrowserWindow;
	},
}));

const RECT = { x: 10, y: 20, width: 800, height: 600 };
const FACTS: HostFacts = {
	paths: {
		userData: "C:/data/ompdesk",
		appData: "C:/data",
		sessionData: "C:/data/ompdesk",
		home: "C:/home",
		temp: "C:/tmp",
		exe: "C:/app/OMPdesk.exe",
		module: "C:/app/OMPdesk.exe",
		desktop: "C:/home/Desktop",
		documents: "C:/home/Documents",
		downloads: "C:/home/Downloads",
		music: "C:/home/Music",
		pictures: "C:/home/Pictures",
		videos: "C:/home/Videos",
		logs: "C:/data/ompdesk/logs",
		crashDumps: "C:/data/ompdesk/Crashpad",
	},
	exe: "C:/app/OMPdesk.exe",
	resourcesPath: "C:/app/resources",
	appIcon: { path: "C:/app/resources/app-icon.png", notifications: "appIcon" },
	// A path of the machine the test runs on: loadFile resolves against it, as against a real app folder.
	appPath: join(tmpdir(), "ompdesk-app", "resources", "app"),
	isPackaged: true,
	argv: ["C:/app/OMPdesk.exe", "--user-data-dir=C:/data/ompdesk", "--blink-settings=foo=1", "C:/work"],
	locale: { appLocale: "ko", systemLocale: "ko-KR", preferredLanguages: ["ko-KR", "en-US"] },
	displays: [
		{
			id: 1,
			label: "main",
			bounds: { x: 0, y: 0, width: 1920, height: 1080 },
			workArea: { x: 0, y: 0, width: 1920, height: 1040 },
			scaleFactor: 1.5,
			rotation: 0,
			internal: true,
			colorDepth: 24,
		},
		{
			id: 2,
			label: "side",
			bounds: { x: 1920, y: 0, width: 1280, height: 1024 },
			workArea: { x: 1920, y: 0, width: 1280, height: 984 },
			scaleFactor: 1,
			rotation: 0,
			internal: false,
			colorDepth: 24,
		},
	],
	primaryDisplayId: 1,
	theme: { dark: true, highContrast: false, inverted: false },
	system: { reducedMotion: false, onBattery: false, online: true },
	versions: { chrome: "156.0.1", cef: "156.0.26", shell: "0.1.0" },
	safeStorage: { unavailable: "test" },
	nativeIpc: [],
	coreOwner: "",
};

interface Call {
	method: string;
	params: Record<string, unknown>;
	bin?: Buffer;
}

/** The shell's end: records the requests and events Node sends and answers the ones a test teaches it. */
function fakeShell(shell: ShellClient) {
	const calls: Call[] = [];
	const events: Array<{ name: string; data: Record<string, unknown>; bin?: Buffer }> = [];
	const answers = new Map<
		string,
		(params: Record<string, unknown>, bin: Buffer | undefined, signal: AbortSignal) => unknown
	>();
	const methods = [
		"app.init",
		"app.startLaunchProtection",
		"app.launchEvent",
		"app.exit",
		"app.quit",
		"app.getGPUInfo",
		"win.create",
		"win.op",
		"view.create",
		"view.op",
		"wc.op",
		"wc.cdp.send",
		"session.create",
		"session.op",
		"menu.popup",
		"dialog.messageBox",
		"clipboard.readText",
		"clipboard.writeText",
		"clipboard.writePassword",
		"net.fetch",
		"shell.openPath",
		"theme.setSource",
		"power.idleTime",
		"power.desktopAway",
		"notification.show",
		"notification.close",
		"power.blockerStart",
		"power.blockerStop",
	];
	for (const method of methods) {
		shell.handle(method, (params: Record<string, unknown>, { bin, signal }) => {
			calls.push({ method, params, bin });
			const answer = answers.get(method)?.(params, bin, signal);
			return answer instanceof Answered ? answer : (answer ?? {});
		});
	}
	for (const name of ["app.relaunch", "wc.send", "protocol.chunk", "protocol.end", "net.cancel"]) {
		shell.on(name, (data: Record<string, unknown>, bin) => events.push({ name, data, bin }));
	}
	return {
		calls,
		events,
		answers,
		callsOf: (method: string) => calls.filter(call => call.method === method),
		eventsOf: (name: string) => events.filter(event => event.name === name),
	};
}

let node: ShellClient;
let shell: ShellClient;
let fake: ReturnType<typeof fakeShell>;
let electron: ElectronShim;
let exited: number[];

/** Lets the frames written so far reach the other end and be handled. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 5; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
}

async function boot(facts: HostFacts = FACTS): Promise<void> {
	const [a, b] = duplexPair();
	node = new ShellClient(a);
	shell = new ShellClient(b);
	fake = fakeShell(shell);
	exited = [];
	electron = createElectron(node, facts, { exitProcess: code => exited.push(code) });
	holder.electron = electron as unknown as Record<string, unknown>;
}

async function ready(): Promise<void> {
	await settle();
	await shell.event("app.ready");
	await electron.app.whenReady();
	await settle();
}

afterEach(() => {
	node.close();
	shell.close();
	holder.electron = null;
});

describe("app", () => {
	beforeEach(() => boot());

	it("answers the synchronous getters from the facts, at module top level", () => {
		const { app } = electron;
		expect(app.getPath("userData")).toBe("C:/data/ompdesk");
		expect(() => app.getPath("nothing")).toThrow("Failed to get 'nothing' path");
		expect(app.getAppPath()).toBe(FACTS.appPath);
		expect(app.isPackaged).toBe(true);
		expect(app.getLocale()).toBe("ko");
		expect(app.getPreferredSystemLanguages()).toEqual(["ko-KR", "en-US"]);
		expect(app.requestSingleInstanceLock()).toBe(true);
		app.setPath("userData", "C:/other");
		expect(app.getPath("userData")).toBe("C:/other");
	});

	it("reads the shell's own switches and keeps the ones main appends", () => {
		const { commandLine } = electron.app;
		expect(commandLine.getSwitchValue("user-data-dir")).toBe("C:/data/ompdesk");
		expect(commandLine.hasSwitch("blink-settings")).toBe(true);
		expect(commandLine.getSwitchValue("missing")).toBe("");
		commandLine.appendSwitch("blink-settings", "foo=1,dnsPrefetchingEnabled=false");
		commandLine.appendSwitch("disable-renderer-backgrounding");
		expect(commandLine.getSwitchValue("blink-settings")).toBe("foo=1,dnsPrefetchingEnabled=false");
	});

	it("waits for launch history and the GPU decision before sending the pre-ready flags", async () => {
		const { app } = electron;
		const saved = Promise.withResolvers<{ software: boolean }>();
		fake.answers.set("app.startLaunchProtection", () => saved.promise);
		app.commandLine.appendSwitch("enable-gpu");
		const start = app.startLaunchProtection(true);
		await settle();
		expect(fake.callsOf("app.startLaunchProtection")[0]?.params).toEqual({
			primary: true,
			enableGpu: true,
			disableGpu: false,
		});
		expect(fake.callsOf("app.init")).toHaveLength(0);
		saved.resolve({ software: true });
		await start;
		await settle();
		expect(fake.callsOf("app.init")[0]?.params.disableHardwareAcceleration).toBe(true);
	});

	it("sends one app.init after main's top level, with its switches, schemes and flags; ready follows the shell's event", async () => {
		const { app, protocol } = electron;
		app.setAppUserModelId("com.example.app");
		app.disableHardwareAcceleration();
		app.commandLine.appendSwitch("disable-renderer-backgrounding");
		protocol.registerSchemesAsPrivileged([
			{ scheme: "omp-media", privileges: { standard: true, secure: true, stream: true } },
		]);
		let whenReady = false;
		void app.whenReady().then(() => {
			whenReady = true;
		});
		await settle();
		const init = fake.callsOf("app.init");
		expect(init).toHaveLength(1);
		expect(init[0].params).toMatchObject({
			disableHardwareAcceleration: true,
			appUserModelId: "com.example.app",
			schemes: [{ scheme: "omp-media", privileges: { standard: true, secure: true, stream: true } }],
		});
		expect(init[0].params.switches).toContainEqual(["disable-renderer-backgrounding", null]);
		expect(whenReady).toBe(false);
		expect(app.isReady()).toBe(false);
		await shell.event("app.ready");
		await app.whenReady();
		expect(app.isReady()).toBe(true);
		expect(() => protocol.registerSchemesAsPrivileged([])).toThrow(/before app is ready/);
	});

	it("holds requests that need CEF until app.ready, in order, and sends app.* at once", async () => {
		const win = new electron.BrowserWindow({ width: 100, height: 100 });
		void electron.app.getGPUInfo("basic");
		await settle();
		expect(fake.callsOf("app.getGPUInfo")).toHaveLength(1);
		expect(fake.callsOf("win.create")).toHaveLength(0);
		win.show();
		await shell.event("app.ready");
		await settle();
		expect(fake.calls.map(call => call.method).filter(method => method.startsWith("win."))).toEqual([
			"win.create",
			"win.op",
		]);
	});

	it("delivers a child process's end as Electron's child-process-gone", async () => {
		const seen: unknown[] = [];
		electron.app.on("child-process-gone", (_event, details) => seen.push(details));
		await shell.event("app.childProcessGone", { type: "GPU", reason: "crashed" });
		await settle();
		expect(seen).toEqual([{ type: "GPU", reason: "crashed" }]);
	});

	it("keeps Node alive until the shell accepts the requested relaunch and exit", async () => {
		const accepted = Promise.withResolvers<void>();
		fake.answers.set("app.exit", () => accepted.promise);
		try {
			electron.app.relaunch({ args: ["--retained-profile"] });
			electron.app.exit(3);
			await settle();
			expect(fake.eventsOf("app.relaunch").map(event => event.data)).toEqual([{ args: ["--retained-profile"] }]);
			expect(exited).toEqual([]);
		} finally {
			accepted.resolve();
			await settle();
		}
		expect(exited).toEqual([3]);
	});

	it("relaunches with the shell's own arguments unless given others", async () => {
		electron.app.relaunch();
		electron.app.relaunch({ args: ["--x"] });
		await settle();
		expect(fake.eventsOf("app.relaunch").map(event => event.data)).toEqual([{ args: null }, { args: ["--x"] }]);
	});

	it("serves the GPU feature status from the last info", async () => {
		fake.answers.set("app.getGPUInfo", () => ({
			info: { gpuDevice: [{ active: true }] },
			features: { gpu_compositing: "enabled" },
		}));
		await ready();
		expect(electron.app.getGPUFeatureStatus()).toEqual({});
		expect(await electron.app.getGPUInfo("complete")).toEqual({ gpuDevice: [{ active: true }] });
		expect(electron.app.getGPUFeatureStatus()).toEqual({ gpu_compositing: "enabled" });
	});
});

describe("the quit hooks the shell calls", () => {
	beforeEach(async () => {
		await boot();
		await ready();
	});

	const hook = (step: string, extra: Record<string, unknown> = {}) =>
		shell.call("app.quitHook", { step, update: false, ...extra });

	it("sends each quit intent, the installer's pending before its receipt", async () => {
		const { app } = electron;
		app.quit();
		app.quit("approved");
		app.installerQuitPending();
		app.installerQuitReceipt({ kind: "started", pid: 42 });
		app.installerQuitReceipt({ kind: "failed", message: "denied", code: "EACCES" });
		await settle();
		expect(fake.callsOf("app.quit").map(call => call.params)).toEqual([
			{ intent: "ask" },
			{ intent: "approved" },
			{ intent: "installerPending" },
			{ intent: "installerReceipt", receipt: { kind: "started", pid: 42 } },
			{ intent: "installerReceipt", receipt: { kind: "failed", message: "denied", code: "EACCES" } },
		]);
		expect(exited).toEqual([]);
	});

	it("before answers whether before-quit was let through, and may be asked again", async () => {
		let prevent = true;
		electron.app.on("before-quit", event => {
			if (prevent) event.preventDefault();
		});
		expect(await hook("before")).toBe(false);
		prevent = false;
		expect(await hook("before")).toBe(true);
	});

	it("runs main's effects: confirm, finalize, teardown (named for an update) and settle's code", async () => {
		expect(await hook("confirm")).toBe(true);
		expect(await hook("settle")).toBe(0);
		const order: string[] = [];
		const finalized = Promise.withResolvers<void>();
		electron.app.setQuitEffects({
			confirm: async () => false,
			finalize: () => {
				order.push("finalize");
				return finalized.promise;
			},
			teardown: update => order.push(`teardown:${String(update)}`),
			settle: async () => 1,
		});
		expect(await hook("confirm")).toBe(false);
		let finalizeAnswered = false;
		const finalizing = hook("finalize").then(() => {
			finalizeAnswered = true;
		});
		await settle();
		expect(finalizeAnswered).toBe(false);
		finalized.resolve();
		await finalizing;
		expect(await hook("teardown", { update: true })).toBeNull();
		expect(await hook("settle")).toBe(1);
		expect(order).toEqual(["finalize", "teardown:true"]);
		expect(exited).toEqual([]);
	});

	it("close asks the shell to close every window, without window-all-closed", async () => {
		const { app, BrowserWindow } = electron;
		const win = new BrowserWindow({});
		const order: string[] = [];
		win.on("closed", () => order.push("closed"));
		app.on("window-all-closed", () => order.push("window-all-closed"));
		const answer = hook("close");
		await settle();
		expect(fake.callsOf("win.op").filter(call => call.params.op === "close")).toHaveLength(1);
		await shell.event("win.event", { winId: win.id, name: "closed" });
		expect(await answer).toBe(true);
		expect(order).toEqual(["closed"]);
	});

	it("will finishes the stable write between the will-quit listeners on either side of it", async () => {
		const { app } = electron;
		const saved = Promise.withResolvers<void>();
		const order: string[] = [];
		fake.answers.set("app.launchEvent", ({ op }) => {
			order.push(String(op));
			return saved.promise;
		});
		app.once("will-quit", () => order.push("earlier"));
		app.stabilizeOnCleanQuit();
		app.once("will-quit", () => order.push("later"));
		const answer = hook("will");
		await settle();
		expect(order).toEqual(["earlier", "stable"]);
		saved.resolve();
		expect(await answer).toBe(true);
		expect(order).toEqual(["earlier", "stable", "later"]);
	});

	it("will answers false when a listener prevents it", async () => {
		electron.app.on("will-quit", event => event.preventDefault());
		expect(await hook("will")).toBe(false);
	});

	it("exit ends through app.exit with the shell's code", async () => {
		const codes: number[] = [];
		electron.app.on("quit", (_event, code) => codes.push(code));
		expect(await hook("exit", { code: 1 })).toBeNull();
		await settle();
		expect(codes).toEqual([1]);
		expect(exited).toEqual([1]);
	});

	it("exit() emits quit once with its code, without before-quit or will-quit, then ends the process", async () => {
		const { app } = electron;
		const order: string[] = [];
		app.on("before-quit", () => order.push("before-quit"));
		app.on("will-quit", () => order.push("will-quit"));
		app.on("quit", (_event, code) => {
			order.push(`quit:${String(code)}`);
			expect(exited).toEqual([]);
		});
		app.exit(5);
		app.exit(5);
		await settle();
		expect(order).toEqual(["quit:5"]);
		expect(exited).toEqual([5]);
	});

	it("keeps the first exit code when a quit listener calls exit again", async () => {
		electron.app.on("quit", () => electron.app.exit(7));
		electron.app.exit(3);
		await settle();
		expect(exited).toEqual([3]);
	});

	it("exit() still ends the process when a quit listener throws", async () => {
		electron.app.on("quit", () => {
			throw new Error("listener");
		});
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		electron.app.exit(0);
		await settle();
		expect(exited).toEqual([0]);
	});

	// electron-updater installs a downloaded update on the app's `quit`, code 0 only (BaseUpdater.addQuitHandler).
	it.each([
		["a settled quit's exit", () => hook("exit", { code: 0 }), 1],
		["a forced exit(0)", async () => electron.app.exit(0), 1],
		["an exit with a failure code", () => hook("exit", { code: 1 }), 0],
	])("a downloaded update installs on %s (installs: %j)", async (_name, end, installs) => {
		const updater = new NsisUpdater(
			{ provider: "generic", url: "https://updates.invalid/" },
			new ElectronAppAdapter(electron.app as never),
		);
		const doInstall = vi.fn(() => true);
		Object.assign(updater, {
			doInstall,
			autoInstallOnAppQuit: true,
			downloadedUpdateHelper: {
				file: "C:/tmp/OMPdesk-Setup.exe",
				downloadedFileInfo: { isAdminRightsRequired: false },
			},
		});
		(updater as unknown as { addQuitHandler(): void }).addQuitHandler();
		await end();
		await settle();
		expect(doInstall).toHaveBeenCalledTimes(installs);
		if (installs) expect(doInstall).toHaveBeenCalledWith(expect.objectContaining({ isSilent: true }));
	});
});

describe("BrowserWindow", () => {
	beforeEach(async () => {
		await boot();
		await ready();
	});

	it("creates with ids of its own and the options the shell needs: the session as its partition, no preload", async () => {
		const { BrowserWindow, app } = electron;
		const created: number[] = [];
		app.on("browser-window-created", (_event, win: { id: number }) => created.push(win.id));
		const win = new BrowserWindow({
			...RECT,
			show: false,
			webPreferences: { sandbox: true, preload: "C:/x/preload.js" },
		});
		const second = new BrowserWindow({});
		expect([win.id, win.webContents.id, second.id, second.webContents.id]).toEqual([1, 1, 2, 2]);
		expect(created).toEqual([1, 2]);
		await settle();
		const [first] = fake.callsOf("win.create");
		expect(first.params).toMatchObject({
			winId: 1,
			wcId: 1,
			options: { x: 10, show: false, webPreferences: { sandbox: true, session: "app" } },
		});
		expect(
			(first.params.options as { webPreferences: Record<string, unknown> }).webPreferences.preload,
		).toBeUndefined();
		expect(BrowserWindow.getAllWindows()).toHaveLength(2);
		expect(BrowserWindow.fromWebContents(win.webContents)).toBe(win);
		expect(win.getBounds()).toEqual(RECT);
	});

	it("answers getBounds, isMaximized, … from the shell's pushes, and its own calls show at once", async () => {
		const win = new electron.BrowserWindow(RECT);
		expect(win.isVisible()).toBe(false);
		win.show();
		expect(win.isVisible()).toBe(true);
		win.minimize();
		expect(win.isMinimized()).toBe(true);
		expect(win.isVisible()).toBe(false);
		await shell.event("win.state", {
			winId: win.id,
			bounds: { x: 0, y: 0, width: 300, height: 200 },
			maximized: true,
			minimized: false,
			focused: true,
		});
		await settle();
		expect(win.getBounds()).toEqual({ x: 0, y: 0, width: 300, height: 200 });
		expect(win.isMaximized()).toBe(true);
		expect(win.isMinimized()).toBe(false);
		expect(win.isFocused()).toBe(true);
		await settle();
		expect(fake.callsOf("win.op").map(call => call.params.op)).toEqual(["show", "minimize"]);
	});

	it("answers getContentBounds at once after setBounds, setSize, setContentSize and setPosition", async () => {
		const win = new electron.BrowserWindow(RECT);
		// A frame: 16 px of border across, 39 px of caption down; the content starts 8 px in and 31 px down.
		await shell.event("win.state", {
			winId: win.id,
			bounds: RECT,
			contentBounds: { x: 18, y: 51, width: 784, height: 561 },
		});
		await settle();
		win.setBounds({ x: 0, y: 0, width: 500, height: 400 });
		expect(win.getContentBounds()).toEqual({ x: 8, y: 31, width: 484, height: 361 });
		win.setSize(300, 200);
		expect(win.getContentBounds()).toEqual({ x: 8, y: 31, width: 284, height: 161 });
		win.setPosition(50, 60);
		expect(win.getContentBounds()).toEqual({ x: 58, y: 91, width: 284, height: 161 });
		win.setContentSize(100, 100);
		expect(win.getContentSize()).toEqual([100, 100]);
		expect(win.getBounds()).toEqual({ x: 50, y: 60, width: 116, height: 139 });
	});

	it("tracks focus: browser-window-focus, getFocusedWindow, blur", async () => {
		const { BrowserWindow, app } = electron;
		const win = new BrowserWindow({});
		const seen: string[] = [];
		app.on("browser-window-focus", () => seen.push("focus"));
		app.on("browser-window-blur", () => seen.push("blur"));
		await shell.event("win.event", { winId: win.id, name: "focus" });
		await settle();
		expect(BrowserWindow.getFocusedWindow()).toBe(win);
		await shell.event("win.event", { winId: win.id, name: "blur" });
		await settle();
		expect(BrowserWindow.getFocusedWindow()).toBeNull();
		expect(seen).toEqual(["focus", "blur"]);
	});

	it("finishes the window on closed", async () => {
		const { BrowserWindow, app } = electron;
		const win = new BrowserWindow({});
		const order: string[] = [];
		win.on("closed", () => order.push("closed"));
		app.on("window-all-closed", () => order.push("window-all-closed"));
		await shell.event("win.event", { winId: win.id, name: "closed" });
		await settle();
		expect(order).toEqual(["closed", "window-all-closed"]);
		expect(win.isDestroyed()).toBe(true);
		expect(BrowserWindow.getAllWindows()).toEqual([]);
	});

	it("close() asks the shell, which decides what closing the window does", async () => {
		const win = new electron.BrowserWindow({});
		win.close();
		await settle();
		expect(fake.callsOf("win.op").at(-1)?.params).toMatchObject({ op: "close", winId: win.id });
	});

	it("adds and removes view children as view ops", async () => {
		const { BrowserWindow, WebContentsView } = electron;
		const win = new BrowserWindow({});
		const view = new WebContentsView({ webPreferences: { sandbox: true } });
		win.contentView.addChildView(view);
		view.setBounds({ x: 1, y: 2, width: 3, height: 4 });
		expect(win.contentView.children.at(-1)).toBe(view);
		expect(view.getVisible()).toBe(true);
		view.setVisible(false);
		expect(view.getVisible()).toBe(false);
		view.setVisible(true);
		win.contentView.removeChildView(view);
		await settle();
		expect(fake.callsOf("view.create")[0].params).toMatchObject({ viewId: 1, wcId: view.webContents.id });
		expect(fake.callsOf("view.op").map(call => [call.params.op, call.params.args])).toEqual([
			["attach", { winId: win.id }],
			["setBounds", { bounds: { x: 1, y: 2, width: 3, height: 4 } }],
			["setVisible", { visible: false }],
			["setVisible", { visible: true }],
			["detach", { winId: win.id }],
		]);
	});
});

describe("webContents", () => {
	beforeEach(async () => {
		await boot();
		await ready();
	});

	it("mirrors the page's state and events", async () => {
		const win = new electron.BrowserWindow({});
		const { webContents } = win;
		const seen: unknown[][] = [];
		webContents.on("did-fail-load", (_event, ...args) => seen.push(args));
		webContents.on("render-process-gone", (_event, details) => seen.push([details]));
		await shell.event("wc.state", {
			wcId: webContents.id,
			url: "app://ompdesk/index.html",
			title: "T",
			loading: true,
			canGoBack: true,
			zoomFactor: 1.25,
		});
		await shell.event("wc.event", {
			wcId: webContents.id,
			name: "did-fail-load",
			args: [-105, "NAME_NOT_RESOLVED", "https://x", true, 1, 2],
		});
		await shell.event("wc.event", {
			wcId: webContents.id,
			name: "render-process-gone",
			args: [{ reason: "crashed", exitCode: 9 }],
		});
		await settle();
		expect([
			webContents.getURL(),
			webContents.getTitle(),
			webContents.isLoading(),
			webContents.getZoomFactor(),
		]).toEqual(["app://ompdesk/index.html", "T", true, 1.25]);
		expect(webContents.navigationHistory.canGoBack()).toBe(true);
		expect(seen).toEqual([
			[-105, "NAME_NOT_RESOLVED", "https://x", true, 1, 2],
			[{ reason: "crashed", exitCode: 9 }],
		]);
	});

	it("gives console-message and did-start-navigation their details as the event, and switches the optional events on", async () => {
		const { webContents } = new electron.BrowserWindow({});
		const levels: string[] = [];
		webContents.on("console-message", details => levels.push(`${details.level}:${details.message}`));
		await settle();
		expect(fake.callsOf("wc.op").at(-1)?.params).toMatchObject({
			op: "watchEvents",
			args: { names: ["console-message"] },
		});
		await shell.event("wc.event", {
			wcId: webContents.id,
			name: "console-message",
			args: [{ level: "error", message: "boom", lineNumber: 3, sourceId: "x" }],
		});
		await settle();
		expect(levels).toEqual(["error:boom"]);
	});

	it("loadURL settles on the load; loadFile maps the renderer to app://ompdesk/ with query and hash", async () => {
		const { webContents } = new electron.BrowserWindow({});
		const loaded = webContents.loadFile(join(FACTS.appPath, "out", "renderer", "index.html"), {
			query: { slot: "0", mica: "1" },
			hash: "/x",
		});
		await settle();
		expect(fake.callsOf("wc.op").at(-1)?.params).toMatchObject({
			op: "loadURL",
			args: { url: "app://ompdesk/index.html?slot=0&mica=1#/x" },
		});
		await shell.event("wc.event", { wcId: webContents.id, name: "did-finish-load", args: [] });
		await loaded;
		const failed = webContents.loadURL("https://nope.invalid/");
		await shell.event("wc.event", {
			wcId: webContents.id,
			name: "did-fail-load",
			args: [-105, "NAME_NOT_RESOLVED", "https://nope.invalid/", true, 0, 0],
		});
		await expect(failed).rejects.toThrow(/ERR_FAILED \(-105\)/);
		const elsewhere = join(tmpdir(), "elsewhere", "page.html");
		const outside = webContents.loadFile(elsewhere);
		void outside.catch(() => undefined);
		await settle();
		const last = fake.callsOf("wc.op").at(-1);
		expect((last?.params.args as { url: string } | undefined)?.url).toBe(pathToFileURL(elsewhere).href);
	});

	it("maps loadFile through the renderer root the shell serves, when it names one", async () => {
		node.close();
		shell.close();
		const root = join(tmpdir(), "repo", "out-abc", "renderer");
		await boot({ ...FACTS, rendererRoot: root });
		await ready();
		const { webContents } = new electron.BrowserWindow({});
		void webContents.loadFile(join(root, "index.html"), { query: { slot: "0" } });
		await settle();
		expect(fake.callsOf("wc.op").at(-1)?.params).toMatchObject({ args: { url: "app://ompdesk/index.html?slot=0" } });
	});

	it("sends wc.send as an event, in order, and not after the page is gone", async () => {
		const { webContents } = new electron.BrowserWindow({});
		webContents.send("a", 1, { b: 2 });
		webContents.send("c");
		await shell.event("wc.event", { wcId: webContents.id, name: "destroyed", args: [] });
		await settle();
		webContents.send("late");
		await settle();
		expect(fake.eventsOf("wc.send").map(event => [event.data.channel, event.data.args])).toEqual([
			["a", [1, { b: 2 }]],
			["c", []],
		]);
		expect(webContents.isDestroyed()).toBe(true);
	});

	it("denies a window-open request unless the handler decides otherwise, and asks navigation listeners", async () => {
		const { webContents } = new electron.BrowserWindow({});
		expect(await shell.call("wc.windowOpen", { wcId: webContents.id, url: "https://a/" })).toEqual({
			action: "deny",
		});
		const urls: string[] = [];
		webContents.setWindowOpenHandler(({ url }) => {
			urls.push(url);
			return { action: "deny" };
		});
		await shell.call("wc.windowOpen", { wcId: webContents.id, url: "https://b/" });
		expect(urls).toEqual(["https://b/"]);
		webContents.on("will-frame-navigate", details => {
			if (details.url.startsWith("https://bad")) details.preventDefault();
		});
		expect(
			await shell.call("wc.navigate", {
				wcId: webContents.id,
				kind: "will-frame-navigate",
				url: "https://bad/x",
				isMainFrame: true,
			}),
		).toEqual({ prevent: true });
		expect(
			await shell.call("wc.navigate", {
				wcId: webContents.id,
				kind: "will-frame-navigate",
				url: "https://ok/x",
				isMainFrame: true,
			}),
		).toEqual({ prevent: false });
		expect(await shell.call("wc.navigate", { wcId: 999, kind: "will-navigate", url: "https://ok/x" })).toEqual({
			prevent: true,
		});
	});

	it("asks a page's login listener for a server's sign-in, and cancels when none takes it", async () => {
		const { webContents } = new electron.BrowserWindow({});
		const challenge = {
			wcId: webContents.id,
			url: "https://intranet.example/a",
			origin: "https://intranet.example",
			scheme: "basic",
			realm: "Staff",
		};
		// Electron's default: nobody prevented the event, so the challenge is cancelled.
		expect(await shell.call("wc.login", challenge)).toBeNull();
		const asked: unknown[] = [];
		webContents.on("login", (event, details, authInfo, callback) => {
			event.preventDefault();
			asked.push([details.url, authInfo]);
			callback("ada", "s3cret");
		});
		expect(await shell.call("wc.login", challenge)).toEqual({ username: "ada", password: "s3cret" });
		expect(asked).toEqual([
			[
				"https://intranet.example/a",
				{ isProxy: false, scheme: "basic", host: "intranet.example", port: 443, realm: "Staff" },
			],
		]);
		expect(await shell.call("wc.login", { ...challenge, wcId: 999 })).toBeNull();
	});

	it("executes JavaScript and builds the DevTools-protocol calls", async () => {
		const { webContents } = new electron.BrowserWindow({});
		fake.answers.set("wc.op", params => (params.op === "executeJavaScript" ? { result: 42 } : {}));
		expect(await webContents.executeJavaScript("6*7")).toBe(42);
		fake.answers.set("wc.cdp.send", params => {
			if (params.method === "Page.getFrameTree") return { result: { frameTree: { frame: { id: "F" } } } };
			if (params.method === "Page.createIsolatedWorld") return { result: { executionContextId: 7 } };
			if (params.method === "Runtime.evaluate") return { result: { result: { value: "iso" } } };
			if (params.method === "Page.captureScreenshot") return { result: { data: PNG_1X1.toString("base64") } };
			return { result: {} };
		});
		expect(await webContents.executeJavaScriptInIsolatedWorld(3, [{ code: "1" }])).toBe("iso");
		const image = await webContents.capturePage({ x: 0, y: 0, width: 10, height: 10 });
		expect(image.getSize()).toEqual({ width: 1, height: 1 });
		expect(image.toPNG().equals(PNG_1X1)).toBe(true);
		webContents.sendInputEvent({ type: "mouseWheel", x: 5, y: 6, deltaX: 0, deltaY: 40 });
		webContents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
		await webContents.insertText("한");
		await settle();
		const cdp = fake.callsOf("wc.cdp.send").map(call => call.params);
		expect(cdp.find(call => call.method === "Runtime.evaluate")?.params).toMatchObject({
			contextId: 7,
			expression: "1",
		});
		expect(cdp.find(call => call.method === "Input.dispatchMouseEvent")?.params).toMatchObject({
			type: "mouseWheel",
			deltaY: -60,
		});
		expect(cdp.find(call => call.method === "Input.dispatchKeyEvent")?.params).toMatchObject({
			type: "rawKeyDown",
			key: "ArrowLeft",
			windowsVirtualKeyCode: 37,
		});
		expect(cdp.at(-1)).toMatchObject({ method: "Input.insertText", params: { text: "한" } });
	});

	it("delivers a click's move, press and release, then typed text, in the order they were sent however late the shell answers", async () => {
		const { webContents } = new electron.BrowserWindow({});
		const lateFirstAnswer = Promise.withResolvers<void>();
		let arrived = 0;
		fake.answers.set("wc.cdp.send", () => {
			arrived += 1;
			return arrived === 1 ? lateFirstAnswer.promise.then(() => ({ result: {} })) : { result: {} };
		});
		webContents.sendInputEvent({ type: "mouseMove", x: 40, y: 12 });
		webContents.sendInputEvent({ type: "mouseDown", x: 40, y: 12, button: "left", clickCount: 1 });
		webContents.sendInputEvent({ type: "mouseUp", x: 40, y: 12, button: "left", clickCount: 1 });
		const typed = webContents.insertText("한");
		await settle();
		lateFirstAnswer.resolve();
		await typed;
		expect(fake.callsOf("wc.cdp.send").map(call => call.params)).toMatchObject([
			{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 40, y: 12 } },
			{
				method: "Input.dispatchMouseEvent",
				params: { type: "mousePressed", x: 40, y: 12, button: "left", clickCount: 1 },
			},
			{
				method: "Input.dispatchMouseEvent",
				params: { type: "mouseReleased", x: 40, y: 12, button: "left", clickCount: 1 },
			},
			{ method: "Input.insertText", params: { text: "한" } },
		]);
	});

	it("converts positions by page zoom and wheel magnitudes by actual native scale independently", async () => {
		const { webContents } = new electron.BrowserWindow({});
		fake.answers.set("wc.cdp.send", () => ({ result: {} }));
		const sentAt = async (factor: number, nativeScaleFactor: number) => {
			await shell.event("wc.state", { wcId: webContents.id, nativeScaleFactor });
			await settle();
			webContents.setZoomFactor(factor);
			const before = fake.callsOf("wc.cdp.send").length;
			webContents.sendInputEvent({ type: "mouseMove", x: 200, y: 116 });
			webContents.sendInputEvent({ type: "mouseDown", x: 200, y: 116, button: "left", clickCount: 1 });
			webContents.sendInputEvent({ type: "mouseUp", x: 200, y: 116, button: "left", clickCount: 1 });
			webContents.sendInputEvent({ type: "mouseWheel", x: 200, y: 116, deltaX: -60, deltaY: -480 });
			webContents.sendInputEvent({ type: "keyDown", keyCode: "a" });
			await settle();
			return fake
				.callsOf("wc.cdp.send")
				.slice(before)
				.map(call => call.params);
		};
		// A 1× host screen shows a phone frame at 2×: the window is twice the frame and the page is zoomed by 2.
		expect(await sentAt(2, 1)).toMatchObject([
			{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 100, y: 58 } },
			{ method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 100, y: 58, button: "left" } },
			{ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 100, y: 58, button: "left" } },
			{ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 100, y: 58, deltaX: 60, deltaY: 480 } },
			{ method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "a" } },
		]);
		expect(await sentAt(0.5, 2)).toMatchObject([
			{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 400, y: 232 } },
			{ method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 400, y: 232, button: "left" } },
			{ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 400, y: 232, button: "left" } },
			{
				method: "Input.dispatchMouseEvent",
				params: { type: "mouseWheel", x: 400, y: 232, deltaX: 120, deltaY: 960 },
			},
			{ method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "a" } },
		]);
	});

	it("preserves a phone wheel gesture across 1x and 2x hosts through the actual mapper and shim", async () => {
		const { webContents } = new electron.BrowserWindow({});
		fake.answers.set("wc.cdp.send", () => ({ result: {} }));
		for (const nativeScaleFactor of [1, 2]) {
			const scale = 2 / nativeScaleFactor;
			await shell.event("wc.state", { wcId: webContents.id, nativeScaleFactor });
			await settle();
			webContents.setZoomFactor(scale);
			const mapper = new InputMapper();
			for (const op of mapper.map(
				{ t: "wheel", x: 0.5, y: 0.8, dx: 30, dy: 240 },
				{
					width: 390 * scale,
					height: 700 * scale,
					scale,
				},
			)) {
				if (op.op === "event") webContents.sendInputEvent(op.event);
			}
			await settle();
			expect(fake.callsOf("wc.cdp.send").at(-1)?.params).toMatchObject({
				method: "Input.dispatchMouseEvent",
				params: { type: "mouseWheel", deltaX: 60, deltaY: 480 },
			});
		}
	});

	it("refuses mouse and wheel input at a zoom factor that is not a finite number above 0, and still takes keys", async () => {
		const { webContents } = new electron.BrowserWindow({});
		fake.answers.set("wc.cdp.send", () => ({ result: {} }));
		for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			webContents.setZoomFactor(factor);
			expect(() => webContents.sendInputEvent({ type: "mouseDown", x: 1, y: 2, button: "left" })).toThrow(
				RangeError,
			);
			expect(() => webContents.sendInputEvent({ type: "mouseWheel", x: 1, y: 2, deltaY: 3 })).toThrow(RangeError);
		}
		webContents.sendInputEvent({ type: "keyDown", keyCode: "a" });
		await settle();
		expect(fake.callsOf("wc.cdp.send").map(call => call.params.method)).toEqual(["Input.dispatchKeyEvent"]);
	});

	it("logs an input event the page refused and still delivers the ones after it", async () => {
		const { webContents } = new electron.BrowserWindow({});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			fake.answers.set("wc.cdp.send", ({ params: command }) => {
				if (typeof command === "object" && command !== null && "type" in command && command.type === "mousePressed")
					throw new HostError("cdp", "Target closed");
				return { result: {} };
			});
			webContents.sendInputEvent({ type: "mouseDown", x: 1, y: 2, button: "left", clickCount: 1 });
			webContents.sendInputEvent({ type: "mouseUp", x: 1, y: 2, button: "left", clickCount: 1 });
			await webContents.insertText("a");
			await settle();
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sendInputEvent: .*Target closed/));
			expect(fake.callsOf("wc.cdp.send").map(call => call.params.method)).toEqual([
				"Input.dispatchMouseEvent",
				"Input.dispatchMouseEvent",
				"Input.insertText",
			]);
		} finally {
			warn.mockRestore();
		}
	});

	it("BrowserWindow.capturePage is the page's capture", async () => {
		const win = new electron.BrowserWindow({});
		fake.answers.set("wc.cdp.send", () => ({ result: { data: PNG_1X1.toString("base64") } }));
		const image = await win.capturePage({ x: 0, y: 0, width: 5, height: 5 });
		expect(image.getSize()).toEqual({ width: 1, height: 1 });
	});

	it("takes a capture again at a smaller scale instead of resizing a bitmap", async () => {
		const { webContents } = new electron.BrowserWindow({});
		fake.answers.set("wc.cdp.send", params => {
			if (params.method === "Page.getLayoutMetrics")
				return { result: { cssVisualViewport: { clientWidth: 100, clientHeight: 50 } } };
			const scale = (params.params as { clip?: { scale: number } } | undefined)?.clip?.scale ?? 1;
			return { result: { data: pngOfWidth(Math.round(100 * scale)).toString("base64") } };
		});
		const wide = await webContents.capturePage();
		expect(wide.getSize().width).toBe(100);
		const fitted = await wide.fitted(40);
		expect(fitted.getSize().width).toBe(40);
		expect(await wide.fitted(200)).toBe(wide);
	});

	it("keeps the debugger apart from the shim's own DevTools use, and forwards its messages", async () => {
		const { webContents } = new electron.BrowserWindow({});
		fake.answers.set("wc.cdp.send", () => ({ result: { ok: 1 } }));
		await webContents.cdp("Page.enable");
		expect(webContents.debugger.isAttached()).toBe(false);
		webContents.debugger.attach("1.3");
		expect(webContents.debugger.isAttached()).toBe(true);
		const messages: unknown[][] = [];
		webContents.debugger.on("message", (_event, ...args) => messages.push(args));
		webContents.debugger.on("detach", (_event, reason) => messages.push([`detach:${reason}`]));
		await shell.event("wc.cdp.message", {
			wcId: webContents.id,
			method: "Page.loadEventFired",
			params: { t: 1 },
			sessionId: "S",
		});
		expect(await webContents.debugger.sendCommand("Runtime.evaluate", { expression: "1" }, "S")).toEqual({ ok: 1 });
		// The debugger's commands go to its own session in the shell; the shim's own stay on the page's.
		const sent = fake.callsOf("wc.cdp.send").map(call => call.params);
		expect(sent[0]).not.toHaveProperty("debugger");
		expect(sent.at(-1)).toMatchObject({ method: "Runtime.evaluate", sessionId: "S", debugger: true });
		await shell.event("wc.cdp.detached", { wcId: webContents.id, reason: "target closed" });
		await settle();
		expect(messages).toEqual([["Page.loadEventFired", { t: 1 }, "S"], ["detach:target closed"]]);
		expect(webContents.debugger.isAttached()).toBe(false);
		await expect(webContents.debugger.sendCommand("X")).rejects.toThrow(/not attached/);
	});

	it("gives an offscreen paint as an image that is encoded by the shell when something is sent", async () => {
		const win = new electron.BrowserWindow({ webPreferences: { offscreen: true } });
		const images: Array<{ getSize(): { width: number; height: number }; encode(options: unknown): Promise<Buffer> }> =
			[];
		win.webContents.on("paint", (_event, _dirty, image) => images.push(image));
		await shell.event("wc.paint", { wcId: win.webContents.id, width: 780, height: 1688, scale: 2 });
		await settle();
		fake.answers.set("wc.frame", () => new Answered({ width: 390, height: 844 }, Buffer.from("jpeg")));
		const frameCalls: Array<Record<string, unknown>> = [];
		shell.handle("wc.frame", params => {
			frameCalls.push(params as Record<string, unknown>);
			return new Answered({ width: 390, height: 844 }, Buffer.from("jpeg"));
		});
		expect(images[0].getSize()).toEqual({ width: 780, height: 1688 });
		expect((await images[0].encode({ format: "jpeg", quality: 60, width: 390 })).toString()).toBe("jpeg");
		expect(frameCalls).toEqual([{ wcId: win.webContents.id, format: "jpeg", quality: 60, width: 390 }]);
		expect(win.webContents.offscreen).toBe(true);
		expect(win.webContents.windowId).toBeUndefined();
	});
});

/** A 1×1 PNG. */
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
	"base64",
);

/** The header of a PNG that says `width` × 1: enough for the sizes the shim reads. */
function pngOfWidth(width: number): Buffer {
	const png = Buffer.from(PNG_1X1);
	png.writeUInt32BE(width, 16);
	return png;
}

describe("ipcMain with main's IpcRegistry", () => {
	beforeEach(async () => {
		await boot();
		await ready();
	});

	it("dispatches invoke and send from an app window with the page as event.sender, and refuses a view", async () => {
		const { BrowserWindow, WebContentsView, ipcMain } = electron;
		const win = new BrowserWindow({});
		const registry = new IpcRegistry(ipcMain as never);
		const seen: Array<[string, number | undefined, number | undefined, unknown[]]> = [];
		registry.handle("sum", (caller, a: number, b: number) => {
			seen.push(["sum", caller.sender.id, caller.win?.webContents.id, [a, b]]);
			return a + b;
		});
		registry.on("ping", (caller, ...args) => seen.push(["ping", caller.sender.id, caller.browserWindow?.id, args]));
		registry.handle("boom", () => {
			throw new Error("handler failed");
		});
		const from = { wcId: win.webContents.id, frameUrl: "app://ompdesk/index.html" };
		expect(await shell.call("ipc.invoke", { ...from, channel: "sum", args: [2, 3] })).toEqual({ value: 5 });
		await shell.event("ipc.send", { ...from, channel: "ping", args: ["x"] });
		await settle();
		expect(seen).toEqual([
			["sum", 1, 1, [2, 3]],
			["ping", 1, 1, ["x"]],
		]);
		await expect(shell.call("ipc.invoke", { ...from, channel: "boom", args: [] })).rejects.toMatchObject({
			message: "handler failed",
		});
		await expect(shell.call("ipc.invoke", { ...from, channel: "nobody", args: [] })).rejects.toThrow(
			"No handler registered for 'nobody'",
		);
		const view = new WebContentsView({});
		await expect(
			shell.call("ipc.invoke", { wcId: view.webContents.id, frameUrl: "https://x/", channel: "sum", args: [1, 1] }),
		).rejects.toThrow(/not an app window/);
		expect(() => registry.handle("sum", () => 0)).toThrow("second handler");
	});

	it("routes a core channel through IpcRegistry.routeCore as under Electron", async () => {
		const { BrowserWindow, ipcMain } = electron;
		const win = new BrowserWindow({});
		const registry = new IpcRegistry(ipcMain as never);
		const calls: Array<{ method: string; params: unknown }> = [];
		const core = {
			pid: 7,
			call: vi.fn(async (method: string, params?: unknown) => {
				calls.push({ method, params });
				if (method === "ipc.start") return { result: { channels: [{ channel: "core:echo", dir: "invoke" }] } };
				return { result: { value: { echoed: true } } };
			}),
		};
		await registry.routeCore(core as never, { "core:echo": {} });
		const answer = await shell.call("ipc.invoke", {
			wcId: win.webContents.id,
			frameUrl: "app://ompdesk/",
			channel: "core:echo",
			args: [1],
		});
		expect(answer).toEqual({ value: { echoed: true } });
		expect(calls.at(-1)).toMatchObject({
			method: "ipc.call",
			params: {
				caller: { key: `w${win.webContents.id}`, window: win.webContents.id },
				channel: "core:echo",
				dir: "invoke",
				args: [1],
			},
		});
	});

	it("answers ipc.sendSync when a handler sets returnValue, even much later, and with null when none listens", async () => {
		const { BrowserWindow, WebContentsView, ipcMain } = electron;
		new BrowserWindow({});
		const view = new WebContentsView({});
		ipcMain.on("dialog", (event: { returnValue?: unknown }, kind: string) => {
			setTimeout(() => {
				event.returnValue = `answered ${kind}`;
			}, 0);
		});
		const params = { wcId: view.webContents.id, frameUrl: "https://page/", args: ["confirm"] };
		expect(await shell.call("ipc.sendSync", { ...params, channel: "dialog" })).toEqual({ value: "answered confirm" });
		expect(await shell.call("ipc.sendSync", { ...params, channel: "silent" })).toEqual({ value: null });
	});
});

describe("session and protocol", () => {
	beforeEach(async () => {
		await boot();
		await ready();
	});

	it("serves a scheme through the partition's handler: head as the answer, the body as chunks, then the end", async () => {
		const { session } = electron;
		const visual = session.fromPartition("preview-visual-1");
		visual.protocol.handle("omp-visual", request => {
			expect(request.url).toBe("omp-visual://v/1");
			return new Response(new Blob(["ab", "cd"]).stream(), {
				status: 206,
				headers: { "content-range": "bytes 0-3/10" },
			});
		});
		await settle();
		expect(fake.callsOf("session.op").map(call => [call.params.partition, call.params.op])).toContainEqual([
			"preview-visual-1",
			"handleScheme",
		]);
		const ended = Promise.withResolvers<void>();
		shell.on("protocol.end", () => ended.resolve());
		const head = await shell.call<{ status: number; headers: Array<[string, string]>; streamId: number }>(
			"protocol.request",
			{
				scheme: "omp-visual",
				partition: "preview-visual-1",
				url: "omp-visual://v/1",
				method: "GET",
				headers: [["range", "bytes=0-3"]],
				window: { bytes: 4, chunks: 2, chunkBytes: 2 },
			},
		);
		expect(head.status).toBe(206);
		expect(head.headers).toContainEqual(["content-range", "bytes 0-3/10"]);
		await ended.promise;
		expect(Buffer.concat(fake.eventsOf("protocol.chunk").map(event => event.bin ?? Buffer.alloc(0))).toString()).toBe(
			"abcd",
		);
		expect(fake.eventsOf("protocol.end")[0].data).toEqual({ streamId: head.streamId });
		await expect(
			shell.call("protocol.request", {
				scheme: "omp-visual",
				partition: "app",
				url: "omp-visual://v/1",
				method: "GET",
				headers: [],
				window: { bytes: 4, chunks: 2, chunkBytes: 2 },
			}),
		).rejects.toThrow(/No handler/);
	});

	it("waits for actual consumption credit, including partial native reads, before sending beyond the window", async () => {
		const chunks: Buffer[] = [];
		const full = Promise.withResolvers<void>();
		const resumed = Promise.withResolvers<void>();
		const ended = Promise.withResolvers<void>();
		electron.session.fromPartition("credit").protocol.handle("omp-media", request => {
			expect(request.headers.get("range")).toBe("bytes=2-7");
			return new Response(Uint8Array.from([2, 3, 4, 5, 6, 7]), {
				status: 206,
				headers: { "content-range": "bytes 2-7/10" },
			});
		});
		shell.on("protocol.chunk", (_data, bin) => {
			if (bin) chunks.push(bin);
			if (chunks.length === 2) full.resolve();
			if (chunks.length === 3) resumed.resolve();
		});
		shell.on("protocol.end", () => ended.resolve());
		const head = await shell.call<{ streamId: number; status: number }>("protocol.request", {
			partition: "credit",
			scheme: "omp-media",
			url: "omp-media://stream/range",
			method: "GET",
			headers: [["Range", "bytes=2-7"]],
			window: { bytes: 4, chunks: 2, chunkBytes: 2 },
		});
		await full.promise;
		await nextTurn();
		expect(chunks.map(chunk => [...chunk])).toEqual([
			[2, 3],
			[4, 5],
		]);
		await shell.event("protocol.ack", { streamId: head.streamId, bytes: 1, chunks: 0 });
		await nextTurn();
		expect(chunks).toHaveLength(2);
		await shell.event("protocol.ack", { streamId: head.streamId, bytes: 1, chunks: 1 });
		await resumed.promise;
		await ended.promise;
		expect(head.status).toBe(206);
		expect([...Buffer.concat(chunks)]).toEqual([2, 3, 4, 5, 6, 7]);
	});

	it.each(["cancel", "disconnect"] as const)("releases a producer waiting for credit on %s", async how => {
		const full = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		let chunks = 0;
		let ends = 0;
		electron.session.fromPartition("blocked").protocol.handle(
			"omp-media",
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(8));
						},
						cancel() {
							cancelled.resolve();
						},
					}),
				),
		);
		shell.on("protocol.chunk", () => {
			if (++chunks === 2) full.resolve();
		});
		shell.on("protocol.end", () => {
			ends += 1;
		});
		const head = await shell.call<{ streamId: number }>("protocol.request", {
			partition: "blocked",
			scheme: "omp-media",
			url: "omp-media://stream/blocked",
			method: "GET",
			headers: [],
			window: { bytes: 4, chunks: 2, chunkBytes: 2 },
		});
		await full.promise;
		if (how === "cancel") await shell.event("protocol.cancel", { streamId: head.streamId });
		else node.close();
		await cancelled.promise;
		await nextTurn();
		expect(chunks).toBe(2);
		expect(ends).toBe(0);
	});

	it("fails rather than silently ending when a consumer acknowledges bytes never sent", async () => {
		const full = Promise.withResolvers<void>();
		const ended = Promise.withResolvers<{ error?: string }>();
		let chunks = 0;
		electron.session
			.fromPartition("invalid-credit")
			.protocol.handle("omp-media", () => new Response(new Uint8Array(8)));
		shell.on("protocol.chunk", () => {
			if (++chunks === 2) full.resolve();
		});
		shell.on("protocol.end", (data: { error?: string }) => ended.resolve(data));
		const head = await shell.call<{ streamId: number }>("protocol.request", {
			partition: "invalid-credit",
			scheme: "omp-media",
			url: "omp-media://stream/invalid",
			method: "GET",
			headers: [],
			window: { bytes: 4, chunks: 2, chunkBytes: 2 },
		});
		await full.promise;
		await shell.event("protocol.ack", { streamId: head.streamId, bytes: 5, chunks: 1 });
		expect((await ended.promise).error).toBe("invalid protocol consumption credit");
	});

	it("probes a permission handler: deny-all is a policy, anything that grants is refused", async () => {
		const ses = electron.session.fromPartition("preview-1");
		ses.setPermissionRequestHandler(((
			_contents: unknown,
			_permission: unknown,
			callback: (granted: boolean) => void,
		) => callback(false)) as never);
		ses.setPermissionCheckHandler((() => false) as never);
		await settle();
		expect(
			fake
				.callsOf("session.op")
				.filter(call => call.params.op === "setPermissions")
				.map(call => call.params.args),
		).toEqual([{ mode: "deny-all" }, { mode: "deny-all" }]);
		expect(() =>
			ses.setPermissionRequestHandler(((_c: unknown, _p: unknown, callback: (granted: boolean) => void) =>
				callback(true)) as never),
		).toThrow(/denies everything/);
		expect(() => ses.setPermissionCheckHandler((() => true) as never)).toThrow(/denies everything/);
	});

	it("mirrors what session.create returned, and cancels downloads when someone listens", async () => {
		fake.answers.set("session.create", () => ({
			userAgent: "UA",
			acceptLanguages: "ko",
			spellCheckerLanguages: ["en-US"],
			availableSpellCheckerLanguages: ["en-US", "ko"],
			cachePath: "C:/data/ompdesk/shell-webview/Default/Cache",
		}));
		const ses = electron.session.fromPartition("preview-2");
		await ses.ready;
		expect(ses.getUserAgent()).toBe("UA");
		expect(ses.getCachePath()).toBe("C:/data/ompdesk/shell-webview/Default/Cache");
		expect(ses.availableSpellCheckerLanguages).toEqual(["en-US", "ko"]);
		const downloads: string[] = [];
		ses.on("will-download", (_event, item: { getURL(): string; getFilename(): string }) =>
			downloads.push(`${item.getURL()} ${item.getFilename()}`),
		);
		await settle();
		expect(fake.callsOf("session.op").map(call => call.params.op)).toContain("setDownloads");
		await shell.event("session.download", {
			partition: ses.partition,
			wcId: 0,
			url: "https://x/f.zip",
			filename: "f.zip",
			mimeType: "application/zip",
			totalBytes: 1,
		});
		await settle();
		expect(downloads).toEqual(["https://x/f.zip f.zip"]);
		expect(electron.session.defaultSession.partition).toBe("app");
	});
});

describe("net", () => {
	beforeEach(async () => {
		await boot();
		await ready();
	});

	it("fetches through the shell: the head answers, the body streams, request bin goes along", async () => {
		fake.answers.set("net.fetch", (params, bin) => {
			setImmediate(() => {
				void shell.event("net.chunk", { reqId: params.reqId }, Buffer.from(`echo:${bin?.toString() ?? ""}:`));
				void shell.event("net.chunk", { reqId: params.reqId }, Buffer.from("tail"));
				void shell.event("net.end", { reqId: params.reqId });
			});
			return {
				status: 201,
				statusText: "Created",
				url: "https://api.example/x",
				redirected: false,
				headers: [["content-type", "text/plain"]],
			};
		});
		const response = await electron.net.fetch("https://api.example/x", {
			method: "POST",
			body: "hello",
			headers: { a: "b" },
		});
		expect(response.status).toBe(201);
		expect(response.url).toBe("https://api.example/x");
		expect(await response.text()).toBe("echo:hello:tail");
		const call = fake.callsOf("net.fetch")[0];
		expect(call.params).toMatchObject({
			url: "https://api.example/x",
			method: "POST",
			hasBody: true,
			redirect: "follow",
		});
		expect(call.params.headers).toContainEqual(["a", "b"]);
	});

	it("rejects with a TypeError for a network failure and cancels a stream the caller aborts", async () => {
		fake.answers.set("net.fetch", params => {
			if (params.url === "https://down/") throw new Error("net::ERR_CONNECTION_REFUSED");
			return { status: 200, statusText: "OK", url: String(params.url), redirected: false, headers: [] };
		});
		await expect(electron.net.fetch("https://down/")).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
		const controller = new AbortController();
		const response = await electron.net.fetch("https://slow/", { signal: controller.signal });
		const reading = response.text();
		controller.abort();
		await expect(reading).rejects.toBeDefined();
		await settle();
		expect(fake.eventsOf("net.cancel")).toHaveLength(1);
	});

	it("net.request gives the response as a stream, and reports a manual redirect", async () => {
		fake.answers.set("net.fetch", params => {
			if (params.url === "https://cdn/start")
				return {
					status: 302,
					statusText: "Found",
					url: String(params.url),
					redirected: false,
					headers: [["location", "https://cdn/final"]],
				};
			setImmediate(() => {
				void shell.event("net.chunk", { reqId: params.reqId }, Buffer.from("file"));
				void shell.event("net.end", { reqId: params.reqId });
			});
			return {
				status: 200,
				statusText: "OK",
				url: String(params.url),
				redirected: false,
				headers: [["Content-Length", "4"]],
			};
		});
		const redirected = await new Promise<string>(resolve => {
			const request = electron.net.request({ url: "https://cdn/start", redirect: "manual" });
			request.on("redirect", (_status: number, _method: string, url: string) => resolve(url));
			request.end();
		});
		expect(redirected).toBe("https://cdn/final");
		const body = await new Promise<{ status: number; headers: Record<string, unknown>; text: string }>(
			(resolve, reject) => {
				const request = electron.net.request({
					protocol: "https:",
					hostname: "cdn",
					path: "/f",
					method: "GET",
					headers: { Accept: "*/*" },
				});
				request.on(
					"response",
					(response: NodeJS.ReadableStream & { statusCode: number; headers: Record<string, unknown> }) => {
						const chunks: Buffer[] = [];
						response.on("data", (chunk: Buffer) => chunks.push(chunk));
						response.on("end", () =>
							resolve({
								status: response.statusCode,
								headers: response.headers,
								text: Buffer.concat(chunks).toString(),
							}),
						);
					},
				);
				request.on("error", reject);
				request.end();
			},
		);
		expect(body).toEqual({ status: 200, headers: { "content-length": "4" }, text: "file" });
		expect(fake.callsOf("net.fetch").at(-1)?.params.url).toBe("https://cdn/f");
	});

	it("net.request carries the session's partition and answers a challenge through its login listener", async () => {
		const challenge = { isProxy: true, scheme: "basic", host: "proxy.corp", port: 3128, realm: "corp" };
		const answers: unknown[] = [];
		fake.answers.set("net.fetch", async params => {
			answers.push(await shell.call("net.login", { reqId: params.reqId, ...challenge }));
			setImmediate(() => void shell.event("net.end", { reqId: params.reqId }));
			return { status: 200, statusText: "OK", url: String(params.url), redirected: false, headers: [] };
		});
		const run = (options: Record<string, unknown>, onLogin?: (...args: unknown[]) => void) =>
			new Promise<void>((resolve, reject) => {
				const request = electron.net.request({ url: "https://cdn/f", ...options });
				if (onLogin) request.on("login", onLogin);
				request.on("response", (response: NodeJS.ReadableStream) => {
					response.on("data", () => undefined);
					response.on("end", resolve);
				});
				request.on("error", reject);
				request.end();
			});
		const updaterSession = electron.session.fromPartition("electron-updater", { cache: false });
		await run({ session: updaterSession }, (info, callback) => {
			expect(info).toEqual(challenge);
			(callback as (username?: string, password?: string) => void)("user", "secret");
		});
		await run({}, (_info, callback) => (callback as () => void)());
		await run({});
		expect(answers).toEqual([{ username: "user", password: "secret" }, { cancel: true }, { cancel: true }]);
		expect(fake.callsOf("net.fetch").map(call => call.params.partition)).toEqual([
			"electron-updater",
			undefined,
			undefined,
		]);
	});

	it("answers isOnline from the facts and net.online, and resolves hosts through the shell", async () => {
		expect(electron.net.isOnline()).toBe(true);
		await shell.event("net.online", { online: false });
		await settle();
		expect(electron.net.isOnline()).toBe(false);
	});
});

describe("menus, dialogs and the small modules", () => {
	beforeEach(async () => {
		await boot();
		await ready();
	});

	it("sends a popup's description and runs the chosen item's handler or edit role", async () => {
		const { Menu, BrowserWindow } = electron;
		const win = new BrowserWindow({});
		await shell.event("win.event", { winId: win.id, name: "focus" });
		let clicked = 0;
		const menu = Menu.buildFromTemplate([
			{ label: "New", accelerator: "CommandOrControl+N", click: () => (clicked += 1) },
			{ type: "separator" },
			{ role: "undo", label: "Undo!" },
		]);
		let pick = 0;
		fake.answers.set("menu.popup", params => ({ itemId: (params.template as Array<{ id: string }>)[pick].id }));
		menu.popup({ window: win });
		await vi.waitUntil(() => clicked === 1);
		const template = fake.callsOf("menu.popup")[0].params.template as Array<{
			label: string;
			accelerator?: string;
			type: string;
		}>;
		expect(template.map(item => [item.label, item.accelerator, item.type])).toEqual([
			["New", "CommandOrControl+N", "normal"],
			["", undefined, "separator"],
			["Undo!", "CommandOrControl+Z", "normal"],
		]);
		if (process.platform === "darwin") return;
		pick = 2;
		menu.popup({ window: win });
		await vi.waitUntil(() => fake.callsOf("wc.op").some(call => call.params.op === "undo"));
	});

	it.runIf(process.platform === "darwin")(
		"gives Copy and Paste to the Mac responder without swallowing custom Copy actions",
		async () => {
			const custom = vi.fn();
			const { Menu } = electron;
			fake.answers.set("menu.popup", params => ({ itemId: (params.template as Array<{ id: string }>)[2].id }));
			Menu.buildFromTemplate([{ role: "copy" }, { role: "paste" }, { role: "copy", click: custom }]).popup();
			await vi.waitUntil(() => custom.mock.calls.length === 1);
			const items = fake.callsOf("menu.popup")[0].params.template as Array<{ role?: string; accelerator: string }>;
			expect(items.map(item => [item.role, item.accelerator])).toEqual([
				["copy", "CommandOrControl+C"],
				["paste", "CommandOrControl+V"],
				[undefined, "CommandOrControl+C"],
			]);
		},
	);

	it("pops a menu up and runs the item the shell reports", async () => {
		const { Menu, BrowserWindow } = electron;
		const win = new BrowserWindow({});
		const labels: string[] = [];
		const menu = Menu.buildFromTemplate([{ label: "Copy", click: () => labels.push("copy") }]);
		fake.answers.set("menu.popup", params => ({ itemId: (params.template as Array<{ id: string }>)[0].id }));
		menu.popup({ window: win });
		await vi.waitUntil(() => labels.length === 1);
		expect(fake.callsOf("menu.popup")[0].params).toMatchObject({ winId: win.id });
	});

	it("dialogs pass the owner's id and the options; clipboard.readText is asynchronous only", async () => {
		const { dialog, clipboard, BrowserWindow, shell: shellModule } = electron;
		const win = new BrowserWindow({});
		fake.answers.set("dialog.messageBox", () => ({ response: 1, checkboxChecked: false }));
		expect(await dialog.showMessageBox(win, { message: "Quit?", buttons: ["Yes", "No"] })).toEqual({
			response: 1,
			checkboxChecked: false,
		});
		await dialog.showMessageBox({ message: "No owner" });
		expect(fake.callsOf("dialog.messageBox").map(call => call.params)).toEqual([
			{ winId: win.id, options: { message: "Quit?", buttons: ["Yes", "No"] } },
			{ options: { message: "No owner" } },
		]);
		expect(() => clipboard.readText()).toThrow(/readTextAsync/);
		fake.answers.set("clipboard.readText", () => ({ text: "pasted" }));
		expect(await clipboard.readTextAsync()).toBe("pasted");
		fake.answers.set("shell.openPath", () => ({ error: "" }));
		expect(await shellModule.openPath("C:/x")).toBe("");
	});

	it("waits for the password clipboard write and reports a refused write", async () => {
		fake.answers.set("clipboard.writePassword", () => {
			throw new Error("clipboard unavailable");
		});
		await expect(electron.clipboard.writePassword("fixture-password")).rejects.toThrow("clipboard unavailable");
		expect(fake.callsOf("clipboard.writePassword").map(call => call.params)).toEqual([{ text: "fixture-password" }]);
	});

	it("a message box whose signal aborts is closed by the shell and resolves to the shell's cancelled answer", async () => {
		const { dialog, BrowserWindow } = electron;
		const win = new BrowserWindow({});
		const closed: unknown[] = [];
		// The shell's side: the box stays up until Node cancels it, then answers as the Esc key would (cancelId 1).
		fake.answers.set("dialog.messageBox", (params, _bin, signal) => {
			const { promise, resolve } = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>();
			signal.addEventListener("abort", () => {
				const { options } = params;
				closed.push(options && typeof options === "object" && "message" in options ? options.message : null);
				resolve({ response: 1, checkboxChecked: false });
			});
			return promise;
		});
		// The control socket's confirm card (ipc.ts `confirmOutside`): its timeout is this signal.
		const timeout = new AbortController();
		const card = dialog.showMessageBox(win, {
			type: "question",
			message: "Allow?",
			buttons: ["Allow", "Don't allow"],
			defaultId: 1,
			cancelId: 1,
			signal: timeout.signal,
		});
		await settle();
		expect(closed).toEqual([]);
		timeout.abort();
		expect(await card).toEqual({ response: 1, checkboxChecked: false });
		expect(closed).toEqual(["Allow?"]);
		// The signal is Node's own: the shell gets the options without it.
		expect(fake.callsOf("dialog.messageBox")[0]?.params.options).not.toHaveProperty("signal");

		// A signal that has already fired still reaches the shell, which answers the cancelled box at once.
		const late = dialog.showMessageBox(win, { message: "Again?", buttons: ["OK"], signal: AbortSignal.abort() });
		expect(await late).toEqual({ response: 1, checkboxChecked: false });
		expect(closed).toEqual(["Allow?", "Again?"]);
	});

	it("mirrors screen, theme and power state from the facts and the shell's pushes", async () => {
		const { screen, nativeTheme, powerMonitor, systemPreferences, powerSaveBlocker } = electron;
		expect(screen.getPrimaryDisplay()).toMatchObject({
			id: 1,
			scaleFactor: 1.5,
			workArea: { width: 1920, height: 1040 },
		});
		expect(screen.getAllDisplays()).toHaveLength(2);
		expect(screen.getDisplayNearestPoint({ x: 3000, y: 10 }).id).toBe(2);
		expect(screen.getDisplayMatching({ x: 1900, y: 0, width: 400, height: 100 }).id).toBe(2);
		const added: number[] = [];
		screen.on("display-added", (_event, display: { id: number }) => added.push(display.id));
		await shell.event("screen.changed", {
			displays: [...FACTS.displays, { ...FACTS.displays[1], id: 3 }],
			primaryDisplayId: 1,
		});
		await settle();
		expect(added).toEqual([3]);
		expect(nativeTheme.shouldUseDarkColors).toBe(true);
		const updated: boolean[] = [];
		nativeTheme.on("updated", () => updated.push(nativeTheme.shouldUseDarkColors));
		await shell.event("theme.changed", { dark: false, highContrast: false, inverted: false, reducedMotion: true });
		await settle();
		expect(updated).toEqual([false]);
		expect(systemPreferences.getAnimationSettings().prefersReducedMotion).toBe(true);
		fake.answers.set("theme.setSource", () => ({ dark: true, highContrast: false, inverted: false }));
		nativeTheme.themeSource = "dark";
		expect(nativeTheme.themeSource).toBe("dark");
		await settle();
		expect(fake.callsOf("theme.setSource")[0].params).toEqual({ source: "dark" });
		expect(powerMonitor.isOnBatteryPower()).toBe(false);
		const power: string[] = [];
		powerMonitor.on("on-battery", () => power.push("on-battery"));
		await shell.event("power.event", { name: "on-battery" });
		await settle();
		expect(powerMonitor.isOnBatteryPower()).toBe(true);
		expect(power).toEqual(["on-battery"]);
		expect(() => powerMonitor.getSystemIdleTime()).toThrow(/getSystemIdleTimeAsync/);
		fake.answers.set("power.idleTime", () => ({ seconds: 12 }));
		expect(
			await (powerMonitor as unknown as { getSystemIdleTimeAsync(): Promise<number> }).getSystemIdleTimeAsync(),
		).toBe(12);
		// Whether the person is away is the shell's read: unknown until it says, then each change it tells.
		const presence = powerMonitor as unknown as { desktopAway(): boolean | undefined };
		expect(presence.desktopAway()).toBeUndefined();
		const changes: (boolean | undefined)[] = [];
		powerMonitor.on("desktop-away" as never, (away: boolean | undefined) => changes.push(away));
		await shell.event("power.desktopAway", { away: false });
		await settle();
		expect(presence.desktopAway()).toBe(false);
		await shell.event("power.desktopAway", { away: true });
		await settle();
		expect(presence.desktopAway()).toBe(true);
		// The shell could not read the idle time: unknown again, which never silences a phone.
		await shell.event("power.desktopAway", { away: null });
		await settle();
		expect(presence.desktopAway()).toBeUndefined();
		expect(changes).toEqual([false, true, undefined]);
		const id = powerSaveBlocker.start("prevent-app-suspension");
		expect(powerSaveBlocker.isStarted(id)).toBe(true);
		powerSaveBlocker.stop(id);
	});

	it("answers shouldUseDarkColors from the OS's own scheme the moment the source goes back to system", async () => {
		const { nativeTheme } = electron;
		const os = { dark: true, highContrast: false, inverted: false };
		const answerWith = (effective: boolean, system?: typeof os) =>
			fake.answers.set("theme.setSource", () => ({ ...os, dark: effective, ...(system ? { system } : {}) }));
		const updated: boolean[] = [];
		nativeTheme.on("updated", () => updated.push(nativeTheme.shouldUseDarkColors));
		expect(nativeTheme.shouldUseDarkColors).toBe(true);

		answerWith(false, os);
		nativeTheme.themeSource = "light";
		expect(nativeTheme.shouldUseDarkColors).toBe(false);
		await settle();
		nativeTheme.themeSource = "system";
		expect(nativeTheme.shouldUseDarkColors).toBe(true);
		expect(updated).toEqual([false, true]);

		// The OS moves while a source forces light: the shell names it in `system`, the effective facts do not move.
		answerWith(false, os);
		nativeTheme.themeSource = "light";
		await settle();
		await shell.event("theme.changed", { ...os, dark: false, system: { ...os, dark: false } });
		await settle();
		nativeTheme.themeSource = "system";
		expect(nativeTheme.shouldUseDarkColors).toBe(false);
	});

	it("shows a notification and routes its click back", async () => {
		const { Notification } = electron;
		const notification = new Notification({ title: "T", body: "B" });
		const clicks: number[] = [];
		notification.on("click", () => clicks.push(1));
		notification.show();
		await settle();
		expect(fake.callsOf("notification.show")[0].params).toMatchObject({ id: 1, title: "T", body: "B" });
		await shell.event("notification.event", { id: 1, name: "click" });
		expect(clicks).toEqual([1]);
	});

	it("keeps a closed notification until its close event, once, whoever sends it", async () => {
		const { Notification } = electron;
		const closes: Array<string | undefined> = [];
		const silent = new Notification({ title: "S" });
		silent.on("close", (_event, reason) => closes.push(`silent:${String(reason)}`));
		silent.show();
		silent.close();
		await settle();
		// The shell answered and sent no event (macOS): the shim ends it.
		expect(closes).toEqual(["silent:undefined"]);
		await shell.event("notification.event", { id: 1, name: "close", reason: "late" });
		expect(closes).toEqual(["silent:undefined"]);

		const toast = new Notification({ title: "T" });
		toast.on("close", (_event, reason) => closes.push(`toast:${String(reason)}`));
		toast.show();
		fake.answers.set("notification.close", () => new Promise(() => undefined));
		toast.close();
		await settle();
		// Windows: the shell's dismissal arrives while the close call is still open; it is the one close.
		expect(closes).toHaveLength(1);
		await shell.event("notification.event", { id: 2, name: "close", reason: "applicationHidden" });
		expect(closes).toEqual(["silent:undefined", "toast:applicationHidden"]);
	});

	it("builds images from a data URL and refuses a conversion it cannot make", () => {
		const { nativeImage } = electron;
		const image = nativeImage.createFromDataURL(`data:image/png;base64,${PNG_1X1.toString("base64")}`);
		expect(image.getSize()).toEqual({ width: 1, height: 1 });
		expect(image.toPNG().equals(PNG_1X1)).toBe(true);
		expect(() => image.toJPEG(80)).toThrow(/encodeImage/);
		expect(nativeImage.createFromPath("C:/no/such.png").isEmpty()).toBe(true);
		expect(nativeImage.createFromDataURL("data:text/plain,hi").isEmpty()).toBe(true);
	});
});

describe("notification defaults from the shell", () => {
	it.each(["off", "systemIcon", "appIcon"] as const)("shows notifications with policy %s", async notifications => {
		await boot({ ...FACTS, appIcon: { ...FACTS.appIcon, notifications } });
		await ready();
		const { Notification } = electron;
		const show = vi.spyOn(Notification.prototype, "show");
		new Notification({ title: "From PC-B" }).show();
		new Notification({ title: "Autopilot ended", icon: "custom.png" }).show();
		await settle();
		expect(show).toHaveBeenCalledTimes(2);
		const shown = fake.callsOf("notification.show").map(call => call.params);
		expect(shown).toEqual(
			notifications === "off"
				? []
				: [
						{
							id: 1,
							title: "From PC-B",
							body: "",
							...(notifications === "appIcon" ? { icon: FACTS.appIcon.path } : {}),
						},
						{ id: 2, title: "Autopilot ended", body: "", icon: "custom.png" },
					],
		);
	});
});

describe("bytes in ipc JSON", () => {
	beforeEach(async () => {
		await boot();
		await ready();
	});

	it("decodes {$bin} arguments to Buffers, encodes returned and pushed bytes", async () => {
		const win = new electron.BrowserWindow({});
		const seen: unknown[] = [];
		electron.ipcMain.handle("upload", (_event, ...args: unknown[]) => {
			seen.push(Buffer.from((args[0] as { data: Uint8Array }).data).toString());
			return { echo: Buffer.from("out"), n: 1 };
		});
		const answer = await shell.call("ipc.invoke", {
			wcId: win.webContents.id,
			frameUrl: "app://ompdesk/",
			channel: "upload",
			args: [{ name: "f", data: { $bin: Buffer.from("bytes").toString("base64") } }],
		});
		expect(seen).toEqual(["bytes"]);
		expect(answer).toEqual({ value: { echo: { $bin: Buffer.from("out").toString("base64") }, n: 1 } });
		win.webContents.send("chunk", new Uint8Array([1, 2, 3]));
		await settle();
		expect(fake.eventsOf("wc.send")[0].data.args).toEqual([{ $bin: "AQID" }]);
	});
});
