/**
 * The handler table: an Electron call and a caller from outside Electron reach the same handler, the Electron
 * one with the window `BrowserWindow.fromWebContents` finds for its sender, as the handlers looked it up before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProcess } from "../core/process";
import { nativeBinPath } from "../native-bin";
import type { ClientWindow } from "./client-window";
import { type IpcCaller, IpcRegistry, type IpcShell } from "./ipc-registry";
import { WebClientWindow } from "./web-client-window";

const electron = vi.hoisted(() => ({ windows: new Map<object, unknown>() }));
vi.mock("electron", () => ({
	BrowserWindow: { fromWebContents: (sender: object) => electron.windows.get(sender) ?? null },
}));

type Listener = (event: { sender: object }, ...args: unknown[]) => unknown;

function registry() {
	const invokes = new Map<string, Listener>();
	const sends = new Map<string, Listener>();
	const ipc = new IpcRegistry({
		handle: (channel, listener) => {
			// Electron refuses a second handler for a channel.
			if (invokes.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
			invokes.set(channel, listener as Listener);
		},
		on: (channel, listener) => sends.set(channel, listener as Listener),
	});
	return { ipc, invokes, sends };
}

function fakeWindow(id: number): ClientWindow {
	return { webContents: { id, send: () => {} }, isDestroyed: () => false, once: () => {}, removeListener: () => {} };
}

const webCaller: IpcCaller = {
	win: fakeWindow(-1),
	browserWindow: null,
	sender: { id: -1, once: () => {} },
};

describe("IpcRegistry", () => {
	afterEach(() => electron.windows.clear());

	it("registers on ipcMain at once and hands an Electron call its sender's window", async () => {
		const { ipc, invokes } = registry();
		const seen: Array<{ win: ClientWindow | null; native: unknown; senderId: number; args: unknown[] }> = [];
		ipc.handle("demo:echo", (caller, ...args: unknown[]) => {
			seen.push({ win: caller.win, native: caller.browserWindow, senderId: caller.sender.id, args });
			return "answer";
		});
		expect([...invokes.keys()]).toEqual(["demo:echo"]);
		const sender = { id: 7 };
		const win = fakeWindow(7);
		electron.windows.set(sender, win);
		expect(await invokes.get("demo:echo")?.({ sender }, "a", 2)).toBe("answer");
		expect(seen).toEqual([{ win, native: win, senderId: 7, args: ["a", 2] }]);
	});

	it("looks the window up again on every read, like the call it replaces", () => {
		const { ipc, invokes } = registry();
		const reads: Array<ClientWindow | null> = [];
		ipc.handle("demo:twice", caller => {
			reads.push(caller.win);
			electron.windows.clear();
			reads.push(caller.win);
		});
		const sender = { id: 3 };
		const win = fakeWindow(3);
		electron.windows.set(sender, win);
		invokes.get("demo:twice")?.({ sender });
		expect(reads).toEqual([win, null]);
	});

	it("runs the same handler for a caller outside Electron", async () => {
		const { ipc } = registry();
		const handler = vi.fn((caller: IpcCaller, value: unknown) => ({ id: caller.win?.webContents.id, value }));
		ipc.handle("demo:echo", handler);
		await expect(ipc.invoke("demo:echo", webCaller, ["x"])).resolves.toEqual({ id: -1, value: "x" });
		expect(handler).toHaveBeenCalledWith(webCaller, "x");
	});

	it("rejects a web invoke the way Electron does: a handler's throw, or a channel nobody handles", async () => {
		const { ipc } = registry();
		ipc.handle("demo:fail", () => {
			throw new Error("refused");
		});
		await expect(ipc.invoke("demo:fail", webCaller, [])).rejects.toThrow("refused");
		await expect(ipc.invoke("demo:missing", webCaller, [])).rejects.toThrow(
			"No handler registered for 'demo:missing'",
		);
	});

	it("keeps Electron's one handler per invoke channel", () => {
		const { ipc } = registry();
		ipc.handle("demo:once", () => 1);
		expect(() => ipc.handle("demo:once", () => 2)).toThrow("second handler");
	});

	it("dispatches fire-and-forget sends from both callers to one listener per channel", () => {
		const { ipc, sends } = registry();
		const listener = vi.fn();
		ipc.on("demo:report", listener);
		expect(() => ipc.on("demo:report", () => {})).toThrow("second listener");
		const sender = { id: 9 };
		sends.get("demo:report")?.({ sender }, true);
		ipc.send("demo:report", webCaller, [false]);
		ipc.send("demo:nobody", webCaller, []);
		expect(listener.mock.calls.map(([caller, value]) => [caller.sender.id, value])).toEqual([
			[9, true],
			[-1, false],
		]);
	});
});

/** The core's plumbing channels (`crates/core/src/ipc`), classified as `IPC_POLICY` classifies a channel. */
const TEST_POLICY = {
	"test:ipc.record": { dir: "send", permission: "workspace", mode: "pass" },
	"test:ipc.recorded": { dir: "invoke", permission: "workspace", mode: "pass" },
};

describe("IpcRegistry: the channels the shell serves", () => {
	function shell() {
		const calls: unknown[] = [];
		const routes: unknown[] = [];
		const fake: IpcShell = {
			channels: [
				{ channel: "demo:native", dir: "invoke" },
				{ channel: "demo:native-send", dir: "send" },
			],
			routes: async main => void routes.push(main),
			call: async params => {
				calls.push(params);
				return "from the shell";
			},
		};
		return { fake, calls, routes };
	}
	const policy = {
		"demo:native": { dir: "invoke" },
		"demo:native-send": { dir: "send" },
		"demo:main": { dir: "invoke" },
		"demo:report": { dir: "send" },
		"demo:pushed": { dir: "push" },
	};

	it("hands the shell main's channels and policy, and reaches the shell's handler with the caller's identity", async () => {
		const { ipc, invokes, sends } = registry();
		const { fake, calls, routes } = shell();
		await ipc.routeShell(fake, policy);
		expect(routes).toEqual([{ invoke: ["demo:main"], send: ["demo:report"], policy }]);
		// An app page's call never comes to main: nothing is registered on ipcMain.
		expect([...invokes.keys(), ...sends.keys()]).toEqual([]);
		const pageWin = new WebClientWindow("phone-1", -1, () => {});
		const paired: IpcCaller = { win: pageWin, browserWindow: null, sender: pageWin.webContents, connId: "k1" };
		await expect(ipc.invoke("demo:native", paired, [5])).resolves.toBe("from the shell");
		ipc.send("demo:native-send", webCaller, ["x"]);
		expect(calls).toEqual([
			{
				channel: "demo:native",
				dir: "invoke",
				caller: { key: "ck1", window: -1, connId: "k1", deviceId: "phone-1" },
				args: [5],
			},
			{
				channel: "demo:native-send",
				dir: "send",
				caller: { key: "w-1", window: -1, connId: null, deviceId: null },
				args: ["x"],
			},
		]);
	});

	it("refuses a second owner for a channel the shell serves, in either order", async () => {
		const first = registry();
		await first.ipc.routeShell(shell().fake, policy);
		expect(() => first.ipc.handle("demo:native", () => 1)).toThrow("is the shell's");
		expect(() => first.ipc.on("demo:native-send", () => {})).toThrow("is the shell's");
		const second = registry();
		second.ipc.handle("demo:native", () => 1);
		const { fake, routes } = shell();
		await expect(second.ipc.routeShell(fake, policy)).rejects.toThrow("served by both main and the shell");
		expect(routes).toEqual([]);
	});
});

describe("ompdesk-core IPC lanes", () => {
	const cores: CoreProcess[] = [];
	afterEach(async () => {
		await Promise.all(cores.splice(0).map(core => core.stop()));
	});

	function startCore(): CoreProcess {
		const core = new CoreProcess({ binary: () => nativeBinPath("ompdesk-core"), log: () => {} });
		cores.push(core);
		return core;
	}

	it("runs a page's sends to a core channel in the order the page made them", async () => {
		const core = startCore();
		await core.call("ipc.start", { policy: TEST_POLICY, testChannels: true });
		const pageCaller = { key: "w7", window: 7, connId: null, deviceId: null };
		const web = { key: "cconn-1", window: -1, connId: "conn-1", deviceId: "phone-1" };
		// The first send holds 50 ms in the core before it records: a later send that overtook it would record first.
		const first = core.call("ipc.call", {
			caller: pageCaller,
			channel: "test:ipc.record",
			dir: "send",
			args: ["first", 50],
		});
		const second = core.call("ipc.call", {
			caller: pageCaller,
			channel: "test:ipc.record",
			dir: "send",
			args: ["second", 0],
		});
		const pageRecorded = core.call<{ value: unknown }>("ipc.call", {
			caller: pageCaller,
			channel: "test:ipc.recorded",
			dir: "invoke",
			args: [],
		});
		await Promise.all([first, second]);
		expect((await pageRecorded).result.value).toEqual(["first", "second"]);
		await core.call("ipc.call", { caller: web, channel: "test:ipc.record", dir: "send", args: ["web", 0] });
		expect(
			(
				await core.call<{ value: unknown }>("ipc.call", {
					caller: web,
					channel: "test:ipc.recorded",
					dir: "invoke",
					args: [],
				})
			).result.value,
		).toEqual(["web"]);
		expect(
			(
				await core.call<{ value: unknown }>("ipc.call", {
					caller: pageCaller,
					channel: "test:ipc.recorded",
					dir: "invoke",
					args: [],
				})
			).result.value,
		).toEqual(["first", "second"]);
	});

	it("refuses ipc.start when IPC_POLICY omits a core-served channel", async () => {
		const core = startCore();
		await expect(core.call("ipc.start", { policy: {}, testChannels: true })).rejects.toThrow(/IPC_POLICY/);
	});
});
