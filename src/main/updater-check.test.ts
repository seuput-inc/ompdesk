/**
 * A Check for Updates the person starts while the background check is still running. The two used to run side by
 * side: the background one settled the shared "checking" state as a quiet idle, and the person's one then found
 * nothing to settle, so the sidebar card said "Checking for updates…" for good (desktop.e2e "Check for Updates…",
 * 2 of 16 runs on a loaded Windows PC).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IPC_COMMANDS, type UpdateStatus } from "../shared/ipc-types";
import { NO_BACKGROUND_WORK } from "./background-work";
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";
import type * as UpdateRelease from "./update-release";
import type { PlatformRelease } from "./update-release";
import { setupUpdater } from "./updater";
import { type IpcCaller, IpcRegistry } from "./web/ipc-registry";

const mocks = vi.hoisted(() => {
	let pending: PromiseWithResolvers<PlatformRelease> | null = null;
	return {
		sent: [] as UpdateStatus[],
		userData: { dir: "" },
		checks: 0,
		// The core's release lookup, answered when the test says.
		lookupRelease: () => {
			mocks.checks++;
			pending = Promise.withResolvers<PlatformRelease>();
			return pending.promise;
		},
		answer: (release: PlatformRelease) => pending?.resolve(release),
	};
});

vi.mock("electron", () => ({
	app: { isPackaged: true, getVersion: () => "0.44.0", getPath: () => mocks.userData.dir, on: () => {} },
	BrowserWindow: {
		getAllWindows: () => [
			{
				isFocused: () => false,
				webContents: { send: (_channel: string, status: UpdateStatus) => mocks.sent.push(status) },
			},
		],
	},
	powerMonitor: { getSystemIdleTimeAsync: async () => 0 },
	shell: {},
}));
vi.mock("./update-release", async importOriginal => ({
	...(await importOriginal<typeof UpdateRelease>()),
	lookupRelease: () => mocks.lookupRelease(),
	setUpdateNetwork: () => {},
}));
vi.mock("./shell-host/shell-calls", () => ({ systemIdleSeconds: async () => 0, updateHost: () => ({}) }));
vi.mock("./app-quit", () => ({
	confirmUpdateRestart: async () => true,
	onQuitForcedExit: () => {},
	logQuitAsked: () => {},
	requestQuit: () => {},
}));
vi.mock("./hang-watchdog", () => ({ markMainStep: () => {} }));
vi.mock("./i18n", () => ({ mainT: (key: MainTextKey) => MAIN_TEXT[key].en }));
vi.mock("./runtime-log", () => ({ writeRuntimeLog: () => {} }));
vi.mock("./update-auth", () => ({
	GITHUB_API_REPO: "https://api.github.com/repos/example/example",
	checkRepoAccess: async () => "ok",
	clearUpdateToken: async () => {},
	resolveUpdateToken: async () => undefined,
	storeUpdateToken: async () => {},
	updateAuthInfo: async () => ({}),
}));

const caller: IpcCaller = { win: null, browserWindow: null, sender: { id: 1, once: () => {} } };
const registry = new IpcRegistry({ handle: () => {}, on: () => {} });
const realPlatform = process.platform;

beforeAll(() => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval"] });
	Object.defineProperty(process, "platform", { value: "win32" });
	mocks.userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-updater-check-"));
	setupUpdater(registry, {
		enabled: () => false,
		resumes: () => true,
		busy: () => false,
		asking: () => false,
		compacting: () => false,
		opening: () => false,
		backgroundWork: async () => NO_BACKGROUND_WORK,
		proxy: async () => undefined,
	});
});

afterAll(() => {
	vi.useRealTimers();
	Object.defineProperty(process, "platform", { value: realPlatform });
	fs.rmSync(mocks.userData.dir, { recursive: true, force: true });
});

describe("Check for Updates while the background check runs", () => {
	it("ends with the check's outcome, never left checking or quietly idle, and asks GitHub once", async () => {
		// The first background check, three seconds after launch, is waiting on the release feed.
		await vi.advanceTimersByTimeAsync(3000);
		expect(mocks.checks).toBe(1);
		const manual = registry.invoke(IPC_COMMANDS.UPDATER_CHECK, caller, []);
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.sent.at(-1)?.state).toBe("checking");
		mocks.answer({
			version: "0.44.0",
			releaseDate: "2026-11-01T00:00:00.000Z",
			releaseName: "v0.44.0",
			notes: "",
			file: { name: "ompdesk-windows-setup.exe", size: 1, sha512: "x" },
			assetUrl: "https://api.github.com/repos/example/example/releases/assets/1",
		});
		const settled = (await manual) as UpdateStatus;
		// GitHub's newest is the running version: the person who asked hears so.
		expect(settled).toEqual({ state: "not-available", version: "0.44.0" });
		expect(mocks.sent.at(-1)).toEqual(settled);
		expect(mocks.checks).toBe(1);
	});
});
