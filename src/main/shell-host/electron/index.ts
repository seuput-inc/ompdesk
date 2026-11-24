/**
 * The `electron` module main, electron-store and electron-updater import (the main bundle aliases `electron` to this
 * file). Importing it connects to the shell (`OMPDESK_SHELL_SOCKET`, `OMPDESK_SHELL_TOKEN`), says `hello` and waits
 * for the facts before any main code runs, so Electron's synchronous `app.getPath()` and friends work at module top
 * level, as they do there.
 */
import { shutdownCore } from "../../core/process";
import type { DiagnosticBundleDeps } from "../../diagnostic-bundle";
import type { DiagnosticsDeps } from "../../diagnostics";
import type { WatchdogSignal } from "../../hang-watchdog";
import type { AdmitNotification } from "../../notify-triage";
import { exitReport } from "../../quit-log";
import { appendRuntimeLogAtPath, type RuntimeLogReport, runtimeLogFile } from "../../runtime-log-core";
import type { IpcShell } from "../../web/ipc-registry";
import { ShellClient } from "../client";
import type { HostFacts } from "../facts";
import { decodeBin, encodeBin } from "./binary-json";
import { createElectron } from "./create";

const socketPath = process.env.OMPDESK_SHELL_SOCKET;
const token = process.env.OMPDESK_SHELL_TOKEN;
if (!socketPath || !token) {
	throw new Error("OMPdesk's main runs under ompdesk-shell: OMPDESK_SHELL_SOCKET and OMPDESK_SHELL_TOKEN are not set");
}

const client = await ShellClient.connect(socketPath);
const hello = await client.call<{ protocol: number; facts: HostFacts }>("hello", {
	token,
	pid: process.pid,
	protocol: 1,
});
if (hello.protocol !== 1) throw new Error(`The shell speaks host protocol ${hello.protocol}, this main speaks 1`);

export const appIconPath = hello.facts.appIcon.path;

export function consumeHangReports(): Promise<RuntimeLogReport[]> {
	return client.call<RuntimeLogReport[]>("app.consumeHangReports").catch((error: unknown) => {
		console.warn("[hang-watchdog]", error);
		return [];
	});
}

export function postWatchdog(signal: WatchdogSignal): void {
	void client.call("app.watchdog", signal).catch((error: unknown) => console.warn("[hang-watchdog]", error));
}

export const diagnosticBundleFileName: DiagnosticBundleDeps["fileName"] = params =>
	client.call("app.diagnosticBundleFileName", params);

export const readDiagnosticLog: DiagnosticsDeps["readLog"] = selection => client.call("app.diagnosticLog", selection);

export const admitNotification: AdmitNotification = report => client.call("app.admitNotification", report);

export function openPageExternal(url: string): Promise<void> {
	return electron.shell.openExternal(url, "page");
}

/** The page channels the shell serves itself; main's own callers (paired pages, agents) reach them through `ipc.call`. */
export const shellIpc: IpcShell = {
	channels: hello.facts.nativeIpc,
	routes: main => client.call("ipc.routes", main),
	call: async params =>
		decodeBin((await client.call<{ value: unknown }>("ipc.call", { ...params, args: encodeBin(params.args) })).value),
};

let stopping = false;
/** Main's app once made: its log line names the profile and the version. */
let electronApp: { getPath(name: "userData"): string; getVersion(): string } | null = null;
/** `app.exit` wrote the run's end line: the shell's stdin ending after it is the exit's own. */
let ended = false;
function endMain(reason: string): void {
	if (stopping) return;
	stopping = true;
	console.error(`[shell-host] ${reason}; exiting`);
	if (electronApp && !ended) {
		appendRuntimeLogAtPath(runtimeLogFile(electronApp.getPath("userData")), exitReport(1, reason), {
			appVersion: electronApp.getVersion(),
			platform: process.platform,
			pid: process.pid,
		});
	}
	void shutdownCore(true).then(
		() => process.exit(1),
		(error: unknown) => {
			console.error(`[shell-host] core shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		},
	);
}
client.onClose(reason => endMain(`the shell connection ended${reason ? `: ${reason.message}` : ""}`));
process.stdin.once("end", () => endMain("the shell's stdin ended"));
process.stdin.resume();

const electron = createElectron(client, hello.facts, { patchProcess: true });
electronApp = electron.app;
if (hello.facts.legacyUserDataMigration) {
	appendRuntimeLogAtPath(
		runtimeLogFile(electron.app.getPath("userData")),
		{ source: "user-data-migration", message: hello.facts.legacyUserDataMigration },
		{ appVersion: electron.app.getVersion(), platform: process.platform, pid: process.pid },
	);
}
electron.app.once("quit", () => {
	ended = true;
});

export function readPreviousRunEnd(): Promise<RuntimeLogReport | null> {
	return client
		.call<RuntimeLogReport | null>("app.previousRunEnd", { ownPid: process.pid })
		.catch((error: unknown) => {
			console.warn("[app-quit]", error);
			return null;
		});
}

// The e2e harness (OMP_GUI_TEST_NODE_INSPECT=1: main runs under `--inspect`) evaluates specs' functions against this
// object through the inspector, where Electron's `app.evaluate` handed them the module.
if (process.env.OMP_GUI_TEST_NODE_INSPECT === "1") {
	Object.defineProperty(globalThis, "__ompdeskElectron", { value: electron, configurable: true });
}

export const {
	app,
	BrowserWindow,
	WebContentsView,
	webContents,
	session,
	protocol,
	ipcMain,
	Menu,
	MenuItem,
	Tray,
	dialog,
	clipboard,
	shell,
	Notification,
	screen,
	nativeTheme,
	systemPreferences,
	powerMonitor,
	powerSaveBlocker,
	globalShortcut,
	autoUpdater,
	net,
	nativeImage,
	safeStorage,
} = electron;

export default electron;
