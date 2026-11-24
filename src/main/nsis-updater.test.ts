/**
 * Windows' install (nsis-updater.ts): the installer starts off the main thread, and the app quits only once it
 * runs. A quit before that would end the process while the installer was still being started.
 */

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpNsisUpdater } from "./nsis-updater";
import type { InstallerStartReceipt } from "./shell-host/shell-calls";

const mocks = vi.hoisted(() => ({
	order: [] as Array<string | InstallerStartReceipt>,
	start: vi.fn<(command: string, args: readonly string[]) => Promise<number>>(),
	appSession: { partition: "app" },
	requests: [] as Array<{ session?: unknown }>,
}));

vi.mock("electron", () => ({
	installerQuitPending: () => mocks.order.push("pending"),
	installerQuitReceipt: (receipt: InstallerStartReceipt) => mocks.order.push(receipt),
	session: { defaultSession: mocks.appSession },
}));
vi.mock("./installer-spawn", () => ({ spawnDetachedOffThread: mocks.start }));

// electron-updater is loaded by Node, not Vite, so its lazy `require("electron")` gets this stand-in of the shim.
const nodeRequire = createRequire(import.meta.url);
nodeRequire.cache[nodeRequire.resolve("electron")] = {
	exports: {
		app: {
			getVersion: () => "0.134.1",
			getName: () => "OMPdesk",
			isPackaged: true,
			getPath: () => "",
			once: () => {},
		},
		session: {
			defaultSession: mocks.appSession,
			fromPartition: (partition: string) => ({ partition }),
		},
		net: {
			request: (options: { session?: unknown }) => {
				mocks.requests.push(options);
				return new EventEmitter();
			},
		},
	},
} as NodeJS.Module;

const app = {
	version: "0.44.0",
	name: "OMPdesk",
	isPackaged: true,
	appUpdateConfigPath: "",
	userDataPath: "",
	baseCachePath: "",
	whenReady: async () => {},
	relaunch: () => {},
	quit: () => mocks.order.push("app.quit"),
	onQuit: () => {},
};

/** An updater whose installer has been downloaded and verified, as `update-downloaded` leaves it. */
async function downloaded(installer: string): Promise<OmpNsisUpdater> {
	class Downloaded extends OmpNsisUpdater {
		async keep(file: string): Promise<void> {
			this.downloadedUpdateHelper = new DownloadedUpdateHelper("unused");
			await this.downloadedUpdateHelper.setDownloadedFile(
				file,
				null,
				{ version: "0.45.0", files: [], path: "setup.exe", sha512: "x", releaseDate: "2026-10-20" },
				{ url: new URL("https://example.invalid/setup.exe"), info: { url: "setup.exe", sha512: "x" } },
				"setup.exe",
				false,
			);
		}
	}
	const updater = new Downloaded(undefined, app);
	await updater.keep(installer);
	return updater;
}

afterEach(() => {
	mocks.order.length = 0;
	mocks.start.mockReset();
});

describe("OmpNsisUpdater.quitAndInstall", () => {
	it("holds quit until the verified install's first worker reports its PID", async () => {
		const started = Promise.withResolvers<number>();
		mocks.start.mockReturnValue(started.promise);
		const updater = await downloaded("C:\\updates\\ompdesk-windows-setup.exe");

		updater.quitAndInstall();

		expect(mocks.start).toHaveBeenCalledWith(
			"C:\\updates\\ompdesk-windows-setup.exe",
			expect.arrayContaining(["--updated"]),
		);
		expect(mocks.order).toEqual(["pending"]);
		started.resolve(4242);
		await vi.waitFor(() => expect(mocks.order).toEqual(["pending", { kind: "started", pid: 4242 }]));
	});

	it("still quits when the installer could not start, and the updater reports why", async () => {
		mocks.start.mockRejectedValue(Object.assign(new Error("the installer would not start"), { code: "EPERM" }));
		const updater = await downloaded("C:\\updates\\ompdesk-windows-setup.exe");
		const failures: unknown[] = [];
		updater.on("error", error => failures.push(error));

		updater.quitAndInstall();

		await vi.waitFor(() =>
			expect(mocks.order).toEqual([
				"pending",
				{ kind: "failed", message: "the installer would not start", code: "EPERM" },
			]),
		);
		expect(failures).toMatchObject([{ code: "EPERM" }]);
	});

	it("starts nothing and does not quit when there is no downloaded installer", () => {
		const updater = new OmpNsisUpdater(undefined, app);
		const failures: unknown[] = [];
		updater.on("error", error => failures.push(error));

		updater.quitAndInstall();

		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.order).toEqual([]);
		expect(failures).toHaveLength(1);
	});

	it("an install at app quit stays on the calling thread: the process may end right after it", async () => {
		const updater = await downloaded(process.execPath);

		updater.install(true, false);

		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.order).toEqual([]);
	});
});

describe("OmpNsisUpdater's download", () => {
	it("goes out on the app session, never on a partition the shell has to create first", () => {
		const updater = new OmpNsisUpdater();
		// electron-updater's executor is not in its typings: the field this fix sets is what the test pins.
		const internals = updater as unknown as {
			httpExecutor: { createRequest(options: object, callback: () => void): unknown };
		};
		const executor = internals.httpExecutor;

		executor.createRequest({ protocol: "https:", hostname: "api.github.com", path: "/asset" }, () => {});

		expect(mocks.requests.map(request => request.session)).toEqual([mocks.appSession]);
	});
});
