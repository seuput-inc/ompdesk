/**
 * "Restart & install" on Windows (updater.ts). Installing blocks the app for seconds (the installer starts and the
 * app quits), so the window must hear about it first, and a second click while it runs must start nothing: the
 * user clicked twice, 5 s apart, because nothing on screen said the first one had worked.
 *
 * Each test sets up a fresh updater that checked and downloaded 0.45.0 (the core's lookup and download stand in).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_COMMANDS, type UpdateStatus } from "../shared/ipc-types";
import { type BackgroundWork, NO_BACKGROUND_WORK } from "./background-work";
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";
import type * as UpdateRelease from "./update-release";
import type { PlatformRelease } from "./update-release";
import type * as UpdaterModule from "./updater";
import { type IpcCaller, IpcRegistry } from "./web/ipc-registry";

const mocks = vi.hoisted(() => {
	const asked: unknown[] = [];
	const answer = { go: true };
	return {
		appEvents: new Map<string, Array<(...args: unknown[]) => void>>(),
		sent: [] as UpdateStatus[],
		runtimeLog: [] as Array<{ message: string; details: Record<string, unknown> }>,
		userData: { dir: "" },
		windowVisible: true,
		/** `powerMonitor.getSystemIdleTimeAsync()` (the shim's form of `getSystemIdleTime()`): seconds since anyone gave the computer input. */
		idleSeconds: 0,
		/** What the restart confirm is told: it reads the work like the real one, then answers `answer.go`. */
		confirmUpdateRestart: vi.fn(async (readWork: () => Promise<unknown>) => {
			asked.push(await readWork());
			return answer.go;
		}),
		asked,
		answer,
		/** The core's release lookup and installer download. */
		lookupRelease: vi.fn(),
		downloadInstaller: vi.fn(async (_options: Parameters<typeof UpdateRelease.downloadInstaller>[0]) => {}),
		/** The setup's start on a worker thread (a restart) and on this thread (a quit). */
		startOffThread: vi.fn(async (_command: string, _args: string[]) => 4242),
		spawn: vi.fn(),
		quitPending: vi.fn(),
		quitReceipt: vi.fn(),
	};
});

vi.mock("electron", () => ({
	app: {
		isPackaged: true,
		getVersion: () => "0.44.0",
		getPath: () => mocks.userData.dir,
		on: (event: string, listener: (...args: unknown[]) => void) => {
			mocks.appEvents.set(event, [...(mocks.appEvents.get(event) ?? []), listener]);
		},
	},
	BrowserWindow: {
		getAllWindows: () => [
			{
				isDestroyed: () => false,
				isVisible: () => mocks.windowVisible,
				isMinimized: () => false,
				isFocused: () => false,
				webContents: { send: (_channel: string, status: UpdateStatus) => mocks.sent.push(status) },
			},
		],
	},
	powerMonitor: { getSystemIdleTimeAsync: async () => mocks.idleSeconds },
	shell: { openPath: async () => "" },
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("./installer-spawn", () => ({ spawnDetachedOffThread: mocks.startOffThread }));
vi.mock("./shell-host/shell-calls", () => ({
	installerQuitPending: mocks.quitPending,
	installerQuitReceipt: mocks.quitReceipt,
	systemIdleSeconds: async () => mocks.idleSeconds,
	updateHost: () => ({}),
}));
vi.mock("./update-release", async importOriginal => ({
	...(await importOriginal<typeof UpdateRelease>()),
	lookupRelease: mocks.lookupRelease,
	downloadInstaller: mocks.downloadInstaller,
	setUpdateNetwork: () => {},
}));
vi.mock("./app-quit", () => ({
	confirmUpdateRestart: mocks.confirmUpdateRestart,
	onQuitForcedExit: () => {},
	logQuitAsked: () => {},
	requestQuit: () => {},
}));
vi.mock("./hang-watchdog", () => ({ markMainStep: () => {} }));
vi.mock("./i18n", () => ({
	mainT: (key: MainTextKey) => MAIN_TEXT[key].en,
}));
vi.mock("./runtime-log", () => ({
	writeRuntimeLog: (report: { message: string; details: Record<string, unknown> }) => mocks.runtimeLog.push(report),
}));
vi.mock("./update-auth", () => ({
	GITHUB_API_REPO: "https://api.github.com/repos/example/example",
	checkRepoAccess: async () => "ok",
	clearUpdateToken: async () => {},
	resolveUpdateToken: async () => undefined,
	storeUpdateToken: async () => {},
	updateAuthInfo: async () => ({}),
}));

type Updater = typeof UpdaterModule;

const caller: IpcCaller = { win: null, browserWindow: null, sender: { id: 1, once: () => {} } };
const realPlatform = process.platform;
let autoInstallOn = false;
/** What a click on "Restart & install" asks fresh: the running work the confirm names. */
const background = { work: NO_BACKGROUND_WORK as BackgroundWork };
/** The cards the probe reports open on this computer's tabs. */
const holds = { asking: false, planWaiting: false };
let updater: Updater;
let registry: IpcRegistry;

const summary = { ko: "다운로드를 이어받습니다.", en: "Downloads can resume." };
const bilingualNotes = `${summary.ko}\n\n${"추가 설명. ".repeat(90)}\n\n---\n\n${summary.en}`;

/** The release a check finds. */
function releaseOf(version: string, notes = ""): PlatformRelease {
	return {
		version,
		releaseDate: "2026-11-01T00:00:00.000Z",
		releaseName: `v${version}`,
		notes,
		file: { name: "ompdesk-windows-setup.exe", size: 113_241_490, sha512: "x" },
		assetUrl: "https://api.github.com/repos/example/example/releases/assets/1",
	};
}

/** A check (the person's) that finds `version`; the download that follows is done when this settles. */
async function check(found: string | Error | "nothing", notes = ""): Promise<unknown> {
	if (found instanceof Error) mocks.lookupRelease.mockRejectedValueOnce(found);
	else mocks.lookupRelease.mockResolvedValueOnce(releaseOf(found === "nothing" ? "0.44.0" : found, notes));
	const status = await registry.invoke(IPC_COMMANDS.UPDATER_CHECK, caller, []);
	await vi.waitFor(() => expect(mocks.sent.at(-1)?.state).not.toBe("downloading"));
	return status;
}

/** Restart & install from this window. */
function restartAndInstall(): Promise<unknown> {
	return registry.invoke(IPC_COMMANDS.UPDATER_APPLY, caller, []);
}

/** How many times the setup was started for a restart. */
const restarts = () => mocks.startOffThread.mock.calls.length;

beforeAll(() => {
	// Windows' install path (NSIS, `automatic`) on any host that runs the suite.
	Object.defineProperty(process, "platform", { value: "win32" });
	mocks.userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-updater-install-"));
	process.env.LOCALAPPDATA = mocks.userData.dir;
});

afterAll(() => {
	Object.defineProperty(process, "platform", { value: realPlatform });
	fs.rmSync(mocks.userData.dir, { recursive: true, force: true });
});

beforeEach(async () => {
	// The scheduler reads `Date.now` once, at setup; its ticks and the background checks run only when a test asks.
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval"] });
	vi.resetModules();
	mocks.appEvents.clear();
	mocks.sent.length = 0;
	mocks.runtimeLog.length = 0;
	for (const mock of [mocks.lookupRelease, mocks.downloadInstaller, mocks.startOffThread, mocks.spawn])
		mock.mockReset();
	mocks.downloadInstaller.mockImplementation(async () => {});
	mocks.startOffThread.mockImplementation(async () => 4242);
	mocks.quitPending.mockClear();
	mocks.quitReceipt.mockClear();
	background.work = NO_BACKGROUND_WORK;
	mocks.answer.go = true;
	mocks.asked.length = 0;
	mocks.confirmUpdateRestart.mockClear();
	// A fresh module each test (`resetModules`): its state is one updater's, which a test ends by installing.
	updater = await import("./updater");
	registry = new IpcRegistry({ handle: () => {}, on: () => {} });
	updater.setupUpdater(registry, {
		enabled: () => autoInstallOn,
		resumes: () => true,
		busy: () => false,
		asking: () => holds.asking,
		planWaiting: () => holds.planWaiting,
		compacting: () => false,
		opening: () => false,
		backgroundWork: async () => background.work,
		proxy: async () => undefined,
	});
	if (!deliver) return;
	await check("0.45.0", bilingualNotes);
	mocks.sent.length = 0;
	mocks.runtimeLog.length = 0;
});

/** Each test starts with 0.45.0 downloaded, except where a describe turns this off to watch the check itself. */
let deliver = true;

afterEach(() => {
	autoInstallOn = false;
	holds.asking = false;
	holds.planWaiting = false;
	mocks.idleSeconds = 0;
	vi.useRealTimers();
});

const SUBAGENTS: BackgroundWork = {
	subagents: 2,
	jobs: 0,
	subagentLabels: ["LayoutSplit", "StreamFast"],
	jobLabels: [],
};
const schedulerEvents = () =>
	mocks.runtimeLog.flatMap(report =>
		report.message === "scheduler"
			? [`${report.details.event}${report.details.reason ? `:${report.details.reason}` : ""}`]
			: [],
	);

describe("a check that finds a newer release", () => {
	beforeAll(() => {
		deliver = false;
	});
	afterAll(() => {
		deliver = true;
	});

	it("downloads its setup into electron-updater's old cache folder and offers it", async () => {
		await check("0.46.0");
		const file = path.join(mocks.userData.dir, "ompdesk-updater", "pending", "ompdesk-windows-setup.exe");
		expect(mocks.downloadInstaller).toHaveBeenLastCalledWith(
			expect.objectContaining({ file, url: releaseOf("0.46.0").assetUrl, size: 113_241_490, sha512: "x" }),
		);
		expect(mocks.sent.map(sent => sent.state)).toEqual(["checking", "available", "downloading", "downloaded"]);
		expect(mocks.sent.at(-1)).toMatchObject({ version: "0.46.0", mode: "automatic" });
	});

	it("keeps both published sentences with their version through every download status", async () => {
		mocks.downloadInstaller.mockImplementationOnce(async ({ size, onProgress }) => onProgress(size / 2));
		await check("0.46.0", bilingualNotes);
		expect(mocks.sent.slice(1)).toEqual([
			{ state: "available", version: "0.46.0", mode: "automatic", summary },
			{ state: "downloading", version: "0.46.0", mode: "automatic", summary, percent: 0 },
			{ state: "downloading", version: "0.46.0", mode: "automatic", summary, percent: 50 },
			{ state: "downloaded", version: "0.46.0", mode: "automatic", summary },
		]);
	});

	it("drops the partial another release left, which could never pass this one's hash", async () => {
		const file = path.join(mocks.userData.dir, "ompdesk-updater", "pending", "ompdesk-windows-setup.exe");
		fs.writeFileSync(`${file}.partial`, "older bytes");
		fs.writeFileSync(`${file}.version`, "0.45.9");
		await check("0.46.0");
		expect(fs.existsSync(`${file}.partial`)).toBe(false);
		expect(fs.readFileSync(`${file}.version`, "utf8")).toBe("0.46.0");
	});

	it("shows a refused download in the person's words, with the status GitHub answered", async () => {
		// The fresh module graph's class: the updater tells its errors apart with `instanceof`.
		const { CoreError } = await import("./core/process");
		mocks.downloadInstaller.mockRejectedValueOnce(new CoreError("update_status", "503"));
		await check("0.46.0");
		expect(mocks.sent.at(-1)).toEqual({
			state: "error",
			message: `${MAIN_TEXT["updates.downloadFailed"].en} (503)`,
			showInBanner: false,
		});
	});

	it("keeps the core's words for any other failure as the detail", async () => {
		const { CoreError } = await import("./core/process");
		mocks.downloadInstaller.mockRejectedValueOnce(new CoreError("update_stalled", "No data received for 30 s"));
		await check("0.46.0");
		expect(mocks.sent.at(-1)).toEqual({
			state: "error",
			message: MAIN_TEXT["updates.downloadFailed"].en,
			detail: "No data received for 30 s",
			showInBanner: false,
		});
	});
});

describe("Restart & install with background work running", () => {
	it("asks with a fresh reading of the work and starts nothing when cancelled", async () => {
		background.work = SUBAGENTS;
		mocks.answer.go = false;
		await restartAndInstall();
		expect(mocks.asked).toEqual([SUBAGENTS]);
		expect(restarts()).toBe(0);
		mocks.answer.go = true;
		await restartAndInstall();
		expect(restarts()).toBe(1);
	});

	it("the automatic install does not wait for it: countdown at once, install at the deadline, no question", async () => {
		background.work = SUBAGENTS;
		autoInstallOn = true;
		await updater.appAutoUpdatePrefChanged();
		await updater.appAutoUpdatePrefChanged();
		expect(schedulerEvents()).toEqual(["safe", "countdown"]);
		const countdown = mocks.sent.at(-1);
		if (countdown?.state !== "downloaded" || countdown.restartAt === undefined) throw new Error("no countdown");
		vi.setSystemTime(countdown.restartAt);
		await updater.appAutoUpdatePrefChanged();
		expect(schedulerEvents()).toEqual(["safe", "countdown", "install"]);
		expect(restarts()).toBe(1);
		expect(mocks.confirmUpdateRestart).not.toHaveBeenCalled();
	});

	// Settings › Updates checks as it opens: a "checking" status in between made the scheduler drop its notice.
	it("a check while the countdown shows keeps the countdown the scheduler shows", async () => {
		background.work = SUBAGENTS;
		autoInstallOn = true;
		await updater.appAutoUpdatePrefChanged();
		const countdown = { state: "downloaded", restartAt: expect.any(Number) };
		expect(mocks.sent.at(-1)).toMatchObject(countdown);
		await registry.invoke(IPC_COMMANDS.UPDATER_CHECK, caller, []);
		await updater.appAutoUpdatePrefChanged();
		expect(mocks.sent.at(-1)).toMatchObject(countdown);
		expect(schedulerEvents()).toEqual(["safe", "countdown"]);
	});
});

describe("Restart & install on Windows", () => {
	it("starts the setup off this thread with a relaunch, and holds the quit until that start reports", async () => {
		let heardWhenInstallerStarted: UpdateStatus | undefined;
		mocks.startOffThread.mockImplementationOnce(async () => {
			heardWhenInstallerStarted = mocks.sent.at(-1);
			return 4242;
		});
		await restartAndInstall();
		// The window hears it first.
		expect(heardWhenInstallerStarted).toMatchObject({ state: "downloaded", version: "0.45.0", installing: true });
		const file = path.join(mocks.userData.dir, "ompdesk-updater", "pending", "ompdesk-windows-setup.exe");
		expect(mocks.startOffThread).toHaveBeenCalledWith(file, ["--updated", "--force-run"]);
		expect(mocks.quitPending).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(mocks.quitReceipt).toHaveBeenCalledWith({ kind: "started", pid: 4242 }));
	});

	it("a start that fails still lets the quit go on, and says why", async () => {
		mocks.startOffThread.mockRejectedValueOnce(Object.assign(new Error("spawn EPERM"), { code: "EPERM" }));
		await restartAndInstall();
		await vi.waitFor(() =>
			expect(mocks.quitReceipt).toHaveBeenCalledWith({ kind: "failed", message: "spawn EPERM", code: "EPERM" }),
		);
	});

	it("records how the windows sat, so the relaunch comes back the same way", async () => {
		mocks.windowVisible = false;
		try {
			await restartAndInstall();
		} finally {
			mocks.windowVisible = true;
		}
		const helper = mocks.runtimeLog.find(report => report.details.event === "helper");
		expect(helper?.details).toMatchObject({ mode: "nsis", presence: "hidden" });
		expect(updater.readRelaunchPresence()).toBe("hidden");
	});

	it("starts nothing when clicked again while the install is under way, nor at the quit that follows", async () => {
		await restartAndInstall();
		await restartAndInstall();
		expect(restarts()).toBe(1);
		const installs = mocks.runtimeLog.filter(report => report.details.event === "install");
		expect(installs.map(report => report.details.trigger)).toEqual(["user click"]);
		for (const listener of mocks.appEvents.get("will-quit") ?? []) listener();
		for (const listener of mocks.appEvents.get("quit") ?? []) listener({}, 0);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("keeps saying 'installing' when Later is pressed after Now", async () => {
		autoInstallOn = true;
		await updater.appAutoUpdatePrefChanged();
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", restartAt: expect.any(Number), summary });
		await restartAndInstall();
		await registry.invoke(IPC_COMMANDS.UPDATER_POSTPONE, caller, []);
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", installing: true, summary });
	});

	it("an automatic install is not followed by a second countdown when the app stalls after it", async () => {
		autoInstallOn = true;
		await updater.appAutoUpdatePrefChanged();
		const countdown = mocks.sent.at(-1);
		if (countdown?.state !== "downloaded" || countdown.restartAt === undefined) throw new Error("no countdown");
		vi.setSystemTime(countdown.restartAt);
		await updater.appAutoUpdatePrefChanged();
		expect(restarts()).toBe(1);
		// The 5.6 s the installer's start once froze the app for, then the tick that follows.
		vi.setSystemTime(countdown.restartAt + 5600);
		await updater.appAutoUpdatePrefChanged();
		const logged = mocks.runtimeLog.flatMap(report => (report.message === "scheduler" ? [report.details.event] : []));
		expect(logged).toEqual(["safe", "countdown", "install"]);
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", installing: true });
		expect(restarts()).toBe(1);
	});
});

describe("an approved quit with an update downloaded", () => {
	it("installs it silently on this thread, starting nothing after it", () => {
		mocks.spawn.mockReturnValueOnce({ once: () => {}, unref: () => {}, pid: 1 });
		for (const listener of mocks.appEvents.get("will-quit") ?? []) listener();
		for (const listener of mocks.appEvents.get("quit") ?? []) listener({}, 0);
		const file = path.join(mocks.userData.dir, "ompdesk-updater", "pending", "ompdesk-windows-setup.exe");
		expect(mocks.spawn).toHaveBeenCalledWith(file, ["--updated", "/S"], { detached: true, stdio: "ignore" });
		const helper = mocks.runtimeLog.find(report => report.details.event === "helper");
		expect(helper?.details).toMatchObject({ mode: "nsis", trigger: "quit" });
	});

	it("installs nothing when the app quits with a failure", () => {
		for (const listener of mocks.appEvents.get("will-quit") ?? []) listener();
		for (const listener of mocks.appEvents.get("quit") ?? []) listener({}, 1);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});

describe("The automatic install and an open card", () => {
	// 12 Nov 2026: a card held the update from 06:12:58; the owner's click at 08:02:34 installed it, and one second later
	// the scheduler still logged `safe` and `countdown`.
	it("writes nothing and starts no countdown after an install a person started", async () => {
		autoInstallOn = true;
		holds.asking = true;
		await updater.appAutoUpdatePrefChanged();
		await restartAndInstall();
		holds.asking = false;
		vi.setSystemTime(Date.now() + 1000);
		await updater.appAutoUpdatePrefChanged();
		expect(schedulerEvents()).toEqual(["waiting:open ask", "install"]);
		expect(restarts()).toBe(1);
	});

	it("installs over a question nobody at the computer answered for ten minutes", async () => {
		autoInstallOn = true;
		holds.asking = true;
		mocks.idleSeconds = 60 * 60;
		await updater.appAutoUpdatePrefChanged();
		vi.setSystemTime(Date.now() + 10 * 60 * 1000);
		await updater.appAutoUpdatePrefChanged();
		const countdown = mocks.sent.at(-1);
		if (countdown?.state !== "downloaded" || countdown.restartAt === undefined) throw new Error("no countdown");
		vi.setSystemTime(countdown.restartAt);
		await updater.appAutoUpdatePrefChanged();
		expect(schedulerEvents()).toEqual(["waiting:open ask", "unattended", "countdown", "install"]);
		expect(restarts()).toBe(1);
	});

	it("keeps waiting for a plan proposal however long nobody is there: the relaunch would lose it", async () => {
		autoInstallOn = true;
		holds.asking = true;
		holds.planWaiting = true;
		mocks.idleSeconds = 24 * 60 * 60;
		await updater.appAutoUpdatePrefChanged();
		vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
		await updater.appAutoUpdatePrefChanged();
		expect(schedulerEvents()).toEqual(["waiting:open ask"]);
		expect(restarts()).toBe(0);
	});
});

// The macOS swap helper reopens the new app and waits for this mark before it drops the old one (updater-state.ts).
describe("the start mark and a start that failed", () => {
	const markFile = () => path.join(mocks.userData.dir, "app-started.json");
	const installFile = () => path.join(mocks.userData.dir, "update-install.json");
	const failedFile = () => path.join(mocks.userData.dir, "update-start-failed.json");
	const results = () => mocks.runtimeLog.filter(report => report.details.event === "result");

	it("is written once, with the running version, before the previous install is reported; a start failure is remembered", () => {
		fs.rmSync(markFile(), { force: true });
		// The helper rolled 0.45.0 back to this 0.44.0: its log's last outcome says the new app did not start.
		fs.writeFileSync(
			installFile(),
			JSON.stringify({ from: "0.44.0", to: "0.45.0", mode: "relaunch", trigger: "auto", at: Date.now() }),
		);
		fs.mkdirSync(path.join(mocks.userData.dir, "updates"), { recursive: true });
		fs.writeFileSync(
			path.join(mocks.userData.dir, "updates", "swap.log"),
			"swap Mon Oct 19 14:03:22 KST 2026: /s -> /d\ninstalled\nwaiting for the new app to start\nstart failed; previous app restored\n",
		);
		// Set up and running, no page yet: no mark, and the install marker is still unread (a new app that dies here
		// leaves it for the old app the helper restores).
		expect(fs.existsSync(markFile())).toBe(false);
		expect(fs.existsSync(installFile())).toBe(true);
		expect(results()).toEqual([]);
		expect(fs.existsSync(failedFile())).toBe(false);

		updater.noteAppStarted();
		const mark = JSON.parse(fs.readFileSync(markFile(), "utf8"));
		expect(mark).toEqual({ version: "0.44.0", pid: process.pid, at: expect.any(Number) });
		expect(results()).toHaveLength(1);
		expect(results()[0]?.details).toMatchObject({
			outcome: "rolled back",
			previous: "0.44.0",
			expected: "0.45.0",
			current: "0.44.0",
			swapOutcome: "start failed; previous app restored",
		});
		expect(fs.existsSync(installFile())).toBe(false);
		expect(JSON.parse(fs.readFileSync(failedFile(), "utf8"))).toEqual({
			version: "0.45.0",
			count: 1,
			at: expect.any(Number),
		});

		// A second page (another window, a reload) writes nothing more.
		fs.rmSync(markFile());
		updater.noteAppStarted();
		expect(fs.existsSync(markFile())).toBe(false);
		expect(results()).toHaveLength(1);
	});

	// The tests below run after the one above, which recorded 0.45.0 (the version each test downloads) as one that
	// failed to start; each fresh updater reads that record at setup. The last one downloads a newer version, which
	// clears the record.
	it("leaves that version to the person: the automatic install skips it, once", async () => {
		autoInstallOn = true;
		await updater.appAutoUpdatePrefChanged();
		await updater.appAutoUpdatePrefChanged();
		vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
		await updater.appAutoUpdatePrefChanged();
		expect(schedulerEvents()).toEqual(["withdrawn:start failed before"]);
		expect(restarts()).toBe(0);
	});

	it("an ordinary quit installs nothing of it", () => {
		for (const listener of mocks.appEvents.get("will-quit") ?? []) listener();
		for (const listener of mocks.appEvents.get("quit") ?? []) listener({}, 0);
		expect(mocks.runtimeLog.filter(report => report.details.event === "helper")).toEqual([]);
		expect(fs.existsSync(installFile())).toBe(false);
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(restarts()).toBe(0);
	});

	it("a check that finds the held version again keeps it downloaded, fetches nothing and shows no spinner", async () => {
		const downloads = mocks.downloadInstaller.mock.calls.length;
		expect(await check("0.45.0")).toMatchObject({ state: "downloaded", version: "0.45.0", summary });
		expect(mocks.sent.map(sent => sent.state)).toEqual([]);
		expect(mocks.downloadInstaller.mock.calls.length).toBe(downloads);
		// Nothing newer: the held download is still the answer.
		expect(await check("nothing", "다른 버전입니다.\n\n---\n\nAnother version.")).toMatchObject({
			state: "downloaded",
			version: "0.45.0",
			summary,
		});
		// And a failed look keeps it as well.
		expect(await check(new Error("offline"))).toMatchObject({ state: "downloaded", version: "0.45.0" });
	});

	it('"Restart & install" still installs it', async () => {
		await restartAndInstall();
		expect(restarts()).toBe(1);
	});

	it("a newer release found while it is held is downloaded and replaces it: the scheduler counts down for the newer one", async () => {
		autoInstallOn = true;
		await updater.appAutoUpdatePrefChanged();
		mocks.sent.length = 0;
		await check("0.46.0");
		expect(mocks.sent.at(-1)).toEqual({ state: "downloaded", version: "0.46.0", mode: "automatic" });
		expect(mocks.sent.map(sent => sent.state)).toEqual(["available", "downloading", "downloaded"]);
		mocks.runtimeLog.length = 0;
		await updater.appAutoUpdatePrefChanged();
		await updater.appAutoUpdatePrefChanged();
		expect(schedulerEvents()).toEqual(["safe", "countdown"]);
		expect(fs.existsSync(failedFile())).toBe(false);
		// Now an ordinary quit installs it.
		mocks.spawn.mockReturnValueOnce({ once: () => {}, unref: () => {}, pid: 1 });
		for (const listener of mocks.appEvents.get("will-quit") ?? []) listener();
		for (const listener of mocks.appEvents.get("quit") ?? []) listener({}, 0);
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
	});
});
