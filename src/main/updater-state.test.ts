import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stopCore } from "./core/process";
import { prepareShellPolicyFixture, type ShellPolicyFixture, shellPolicyFixture } from "./shell-policy-test-rig";
import { checkRepoAccess } from "./update-auth";
import { serveFeed } from "./update-feed-test-rig";
import { lastSwapEntry } from "./update-log-core";
import {
	classifyRepoAccess,
	firstUpdateToken,
	isSwappableBundleLocation,
	macBundlePath,
	SingleTransfer,
	StageBundleError,
	SWAP_SCRIPT,
	settleFailedUpdateCheck,
	settleIncompleteUpdateCheck,
	stageBundleFromDmg,
} from "./updater-state";

vi.mock("electron", () => ({ app: {}, safeStorage: {} }));

let files: ShellPolicyFixture;
beforeAll(async () => {
	if (process.platform === "win32") return;
	await prepareShellPolicyFixture();
	files = await shellPolicyFixture();
}, 120_000);
afterAll(async () => {
	await files?.close();
	await stopCore();
});

function sweepInstallerPartials(directory: string, activePartial?: string): Promise<string[]> {
	const asset = activePartial && path.basename(activePartial, ".partial");
	return files.call("app.sweepUpdateFiles", { directory, area: "downloads", asset });
}

describe("update repository access", () => {
	it("asks the canonical repository through the core, without a token", async () => {
		const feed = await serveFeed({ body: "{}" });
		try {
			expect(await checkRepoAccess(undefined)).toBe("ok");
			expect(feed.requests.map(request => request.url)).toEqual(["https://api.github.com/repos/seuput-inc/ompdesk"]);
			expect(feed.requests[0]?.headers).toMatchObject({
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
			});
			expect(feed.requests[0]?.headers.authorization).toBeUndefined();
		} finally {
			await feed.close();
		}
	});

	it("reads GitHub's hourly limit as a failed request and a refused token as invalid", async () => {
		const limited = await serveFeed({ status: 403, body: "{}" });
		try {
			// The stand-in sends no rate-limit header: a plain 403 is no access.
			expect(await checkRepoAccess("abc")).toBe("denied");
			expect(limited.requests[0]?.headers.authorization).toBe("Bearer abc");
		} finally {
			await limited.close();
		}
		const refused = await serveFeed({ status: 401, body: "{}" });
		try {
			expect(await checkRepoAccess("abc")).toBe("invalid");
		} finally {
			await refused.close();
		}
	});
});

describe("installer transfer concurrency", () => {
	it("never runs a second transfer while one is in flight", async () => {
		const transfers = new SingleTransfer();
		const { promise: gate, resolve: finish } = Promise.withResolvers<void>();
		const transfer = vi.fn(() => gate);

		const first = transfers.start(transfer);
		const second = transfers.start(transfer);
		expect(transfers.running).toBe(true);
		expect(transfer).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);

		finish();
		await first;
		expect(transfers.running).toBe(false);
	});

	it("lets a retry start once the previous transfer failed", async () => {
		const transfers = new SingleTransfer();
		await expect(transfers.start(async () => Promise.reject(new Error("offline")))).rejects.toThrow();
		expect(transfers.running).toBe(false);

		const retry = vi.fn(async () => {});
		await transfers.start(retry);
		expect(retry).toHaveBeenCalledTimes(1);
	});
});

describe("update check terminal state", () => {
	it("does not leave a completed manual check spinning forever", () => {
		expect(settleIncompleteUpdateCheck({ state: "checking" }, true)).toEqual({
			state: "error",
			message: "Couldn't check for updates.",
		});
	});

	it("keeps real updater terminal states intact and makes background misses silent", () => {
		const available = { state: "available", version: "0.7.2", mode: "automatic" } as const;
		expect(settleIncompleteUpdateCheck(available, true)).toBe(available);
		expect(settleIncompleteUpdateCheck({ state: "checking" }, false)).toEqual({ state: "idle" });
	});
});

describe.runIf(process.platform !== "win32")("macOS DMG download partials", () => {
	it("sweeps a superseded partial without touching the current version", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-dmg-name-"));
		try {
			const stale = "ompdesk-0.18.0-arm64.dmg.partial";
			fs.writeFileSync(path.join(dir, stale), "");
			const active = path.join(dir, "ompdesk-0.18.1-arm64.dmg.partial");
			expect(await sweepInstallerPartials(dir, active)).toEqual([stale]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("macOS DMG staging reply", () => {
	const request = {
		dmgPath: "/profile/updates/release.dmg",
		version: "0.18.0",
		ownBundle: "/Applications/OMPdesk.app",
	};

	it("returns the verified path and preserves typed refusals for the localized updater", async () => {
		const staged = "/profile/updates/0.18.0/OMPdesk.app";
		await expect(stageBundleFromDmg(request, async () => ({ staged }))).resolves.toBe(staged);
		for (const reason of ["mount", "missing", "copy", "compatibility", "verify"] as const) {
			const failure = stageBundleFromDmg(request, async () => ({ error: { reason, message: "refused" } }));
			await expect(failure).rejects.toBeInstanceOf(StageBundleError);
			await expect(failure).rejects.toMatchObject({ reason, message: "refused" });
		}
	});

	it.runIf(process.platform !== "win32")("keeps the macOS filesystem error in the failure detail", async () => {
		const failure = stageBundleFromDmg(request, async () => ({
			error: { errno: -2, message: "rmdir '/mount'" },
		}));
		await expect(failure).rejects.toThrow("ENOENT: no such file or directory, rmdir '/mount'");
	});

	it("keeps cleanup and detach failures distinct from a localized staging refusal", async () => {
		const failure = stageBundleFromDmg(request, async () => ({
			error: {
				message: "Could not detach the update disk image",
				errors: [
					{ reason: "compatibility", message: "incompatible" },
					{ reason: "mount", message: "detach failed" },
					{ reason: "mount", message: "forced detach failed" },
				],
			},
		}));
		await expect(failure).rejects.toBeInstanceOf(AggregateError);
		await expect(failure).rejects.toMatchObject({
			errors: [{ reason: "compatibility" }, { reason: "mount" }, { reason: "mount" }],
		});
		await expect(stageBundleFromDmg(request, async () => ({ error: { message: "rmdir refused" } }))).rejects.toThrow(
			"rmdir refused",
		);
	});
});

describe("in-place macOS swap", () => {
	it("finds the bundle only from its own Contents/MacOS executable", () => {
		expect(macBundlePath("/Applications/ompdesk.app/Contents/MacOS/ompdesk")).toBe("/Applications/ompdesk.app");
		expect(macBundlePath("/usr/local/bin/ompdesk")).toBeUndefined();
	});

	it("refuses read-only disk images and translocated copies", () => {
		expect(isSwappableBundleLocation("/Applications/ompdesk.app")).toBe(true);
		expect(isSwappableBundleLocation("/Users/me/Applications/ompdesk.app")).toBe(true);
		expect(isSwappableBundleLocation("/Volumes/ompdesk 0.2.1/ompdesk.app")).toBe(false);
		expect(isSwappableBundleLocation("/private/var/folders/x/AppTranslocation/ABC/d/ompdesk.app")).toBe(false);
	});

	describe.runIf(process.platform !== "win32")("swap script", () => {
		let dir: string;
		const makeApp = (appPath: string, marker: string) => {
			fs.mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true });
			fs.writeFileSync(path.join(appPath, "Contents", "marker"), marker);
		};
		const markerOf = (appPath: string) => fs.readFileSync(path.join(appPath, "Contents", "marker"), "utf8");
		const swapLog = () => fs.readFileSync(path.join(dir, "swap.log"), "utf8");
		const opened = () => fs.readFileSync(path.join(dir, "opened.log"), "utf8").trim().split("\n");
		const markFile = () => path.join(dir, "userData", "app-started.json");
		const writeMark = (version: string) => {
			fs.mkdirSync(path.dirname(markFile()), { recursive: true });
			fs.writeFileSync(markFile(), JSON.stringify({ version, pid: 1, at: 1 }));
		};
		// What `open -n <bundle> --args …` is on the test's PATH: it logs the call, and a bundle holding "new" starts by
		// writing the start mark for STAND_IN_MARK_VERSION (after STAND_IN_MARK_DELAY seconds, when set), as a new app
		// does once its first page loaded. Written by rename, as main does. `ditto` and `xattr` only stand in where
		// the host has none (Linux): they come last on the PATH.
		const writeTools = () => {
			const first = path.join(dir, "bin-first");
			const last = path.join(dir, "bin-last");
			fs.mkdirSync(first);
			fs.mkdirSync(last);
			const tool = (folder: string, name: string, body: string) =>
				fs.writeFileSync(path.join(folder, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
			tool(
				first,
				"open",
				`bundle="$2"
echo "$* [$(cat "$bundle/Contents/marker")]" >> "$STAND_IN_OPENED"
if [ "$(cat "$bundle/Contents/marker")" = "new" ] && [ -n "$STAND_IN_MARK_VERSION" ]; then
  mark() { mkdir -p "$(dirname "$STAND_IN_MARK")"; printf '{"version":"%s","pid":%s,"at":1}' "$STAND_IN_MARK_VERSION" "$$" > "$STAND_IN_MARK.tmp" && mv "$STAND_IN_MARK.tmp" "$STAND_IN_MARK"; }
  if [ -n "$STAND_IN_MARK_DELAY" ]; then ( sleep "$STAND_IN_MARK_DELAY"; mark ) >/dev/null 2>&1 & else mark; fi
fi`,
			);
			tool(last, "ditto", 'cp -R "$1" "$2"');
			tool(last, "xattr", "exit 0");
			return `${first}:${process.env.PATH ?? ""}:${last}`;
		};
		// Async: the test's own event loop must stay free to reap the fake app
		// process, or it lingers as a zombie that still answers `kill -0`.
		const runSwap = (
			pid: number,
			src: string,
			dest: string,
			options: {
				relaunch?: "0" | "1";
				/** What the opener stand-in writes into the mark (none: a new app that never starts). */
				markVersion?: string;
				markDelay?: string;
				expect?: string;
				waitSeconds?: string;
			} = {},
		) => {
			const { promise, resolve } = Promise.withResolvers<number | null>();
			spawn(
				"/bin/bash",
				[
					"-c",
					SWAP_SCRIPT,
					"swap",
					String(pid),
					src,
					dest,
					options.relaunch ?? "0",
					path.join(dir, "swap.log"),
					markFile(),
					options.expect ?? "2.0.0",
					"--flag",
				],
				{
					env: {
						...process.env,
						PATH: writeTools(),
						STAND_IN_OPENED: path.join(dir, "opened.log"),
						STAND_IN_MARK: markFile(),
						STAND_IN_MARK_VERSION: options.markVersion ?? "",
						STAND_IN_MARK_DELAY: options.markDelay ?? "",
						OMPDESK_SWAP_START_WAIT_S: options.waitSeconds ?? "0",
					},
				},
			).on("exit", resolve);
			return promise;
		};
		const staged = () => {
			const dest = path.join(dir, "Applications", "ompdesk.app");
			const src = path.join(dir, "updates", "2.0.0", "ompdesk.app");
			makeApp(src, "new");
			return { dest, src };
		};

		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-swap-"));
		});
		afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

		it("waits for the app to exit, then replaces it and leaves no debris", async () => {
			const dest = path.join(dir, "Applications", "ompdesk.app");
			const src = path.join(dir, "updates", "0.2.2", "ompdesk.app");
			makeApp(dest, "old");
			makeApp(src, "new");
			const app = spawn("/bin/sleep", ["0.6"]);
			const startedAt = Date.now();
			const status = await runSwap(app.pid ?? 0, src, dest);

			expect(status).toBe(0);
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
			expect(markerOf(dest)).toBe("new");
			expect(fs.readdirSync(path.dirname(dest))).toEqual(["ompdesk.app"]);
			expect(fs.existsSync(src)).toBe(false);
			expect(swapLog()).toContain("installed");
		});

		it("without a relaunch removes the old app at once and opens nothing: that path has no start check", async () => {
			const { dest, src } = staged();
			makeApp(dest, "old");
			expect(await runSwap(999_999, src, dest, { relaunch: "0" })).toBe(0);

			expect(fs.readdirSync(path.dirname(dest))).toEqual(["ompdesk.app"]);
			expect(fs.existsSync(path.join(dir, "opened.log"))).toBe(false);
			expect(lastSwapEntry(swapLog())?.outcome).toBe("installed");
		});

		it("keeps the old app until the new one marked its start, then removes it", async () => {
			const { dest, src } = staged();
			makeApp(dest, "old");
			expect(await runSwap(999_999, src, dest, { relaunch: "1", markVersion: "2.0.0" })).toBe(0);

			expect(markerOf(dest)).toBe("new");
			expect(fs.readdirSync(path.dirname(dest))).toEqual(["ompdesk.app"]);
			expect(opened()).toEqual([`-n ${dest} --args --flag [new]`]);
			const log = swapLog();
			expect(log).toMatch(/installed\nwaiting for the new app to start\nstarted\n$/);
			expect(lastSwapEntry(log)?.outcome).toBe("started");
		});

		it("waits for a mark that comes some time after the open", async () => {
			const { dest, src } = staged();
			makeApp(dest, "old");
			const status = await runSwap(999_999, src, dest, {
				relaunch: "1",
				markVersion: "2.0.0",
				markDelay: "0.3",
				waitSeconds: "20",
			});

			expect(status).toBe(0);
			expect(lastSwapEntry(swapLog())?.outcome).toBe("started");
			expect(markerOf(dest)).toBe("new");
			expect(fs.existsSync(`${dest}.previous`)).toBe(false);
		});

		it("puts the previous app back and reopens it when the new one never marks its start", async () => {
			const { dest, src } = staged();
			makeApp(dest, "old");
			fs.writeFileSync(path.join(dest, "Contents", "MacOS", "app-file"), "intact");
			expect(await runSwap(999_999, src, dest, { relaunch: "1" })).toBe(0);

			expect(markerOf(dest)).toBe("old");
			expect(fs.readFileSync(path.join(dest, "Contents", "MacOS", "app-file"), "utf8")).toBe("intact");
			expect(fs.readdirSync(path.dirname(dest))).toEqual(["ompdesk.app"]);
			expect(opened()).toEqual([`-n ${dest} --args --flag [new]`, `-n ${dest} --args --flag [old]`]);
			const log = swapLog();
			expect(log).toMatch(/installed\nwaiting for the new app to start\nstart failed; previous app restored\n$/);
			expect(lastSwapEntry(log)?.outcome).toBe("start failed; previous app restored");
		});

		it("counts a mark for another version as not started", async () => {
			const { dest, src } = staged();
			makeApp(dest, "old");
			expect(await runSwap(999_999, src, dest, { relaunch: "1", markVersion: "1.9.0" })).toBe(0);

			expect(markerOf(dest)).toBe("old");
			expect(lastSwapEntry(swapLog())?.outcome).toBe("start failed; previous app restored");
		});

		it("never reads a mark left by an earlier launch as the new app's", async () => {
			const { dest, src } = staged();
			makeApp(dest, "old");
			writeMark("2.0.0");
			expect(await runSwap(999_999, src, dest, { relaunch: "1" })).toBe(0);

			expect(markerOf(dest)).toBe("old");
			expect(fs.existsSync(markFile())).toBe(false);
			expect(lastSwapEntry(swapLog())?.outcome).toBe("start failed; previous app restored");
		});

		it("ends what the new app left running before it takes the old one back", async () => {
			const { dest, src } = staged();
			makeApp(dest, "old");
			const leftover = spawn("/bin/bash", [
				"-c",
				'exec -a "$0" sleep 60',
				path.join(dest, "Contents", "MacOS", "app"),
			]);
			const exited = new Promise<NodeJS.Signals | null>(resolve =>
				leftover.once("exit", (_code, signal) => resolve(signal)),
			);
			await vi.waitFor(() => {
				const processes = execFileSync("ps", ["-axww", "-o", "pid=", "-o", "command="], { encoding: "utf8" });
				expect(processes).toContain(`${leftover.pid} ${path.join(dest, "Contents", "MacOS", "app")}`);
			});
			expect(await runSwap(999_999, src, dest, { relaunch: "1" })).toBe(0);

			expect(await exited).toBe("SIGTERM");
			expect(markerOf(dest)).toBe("old");
			expect(lastSwapEntry(swapLog())?.outcome).toBe("start failed; previous app restored");
		});

		it("says the previous app is lost when there was none to put back, and leaves what is there", async () => {
			const { dest, src } = staged();
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			expect(await runSwap(999_999, src, dest, { relaunch: "1" })).toBe(0);

			expect(markerOf(dest)).toBe("new");
			expect(opened()).toEqual([`-n ${dest} --args --flag [new]`]);
			expect(lastSwapEntry(swapLog())?.outcome).toBe("start failed; previous app lost");
		});

		it("leaves the installed app untouched when the staged bundle is gone", async () => {
			const dest = path.join(dir, "ompdesk.app");
			makeApp(dest, "old");
			const status = await runSwap(999_999, path.join(dir, "missing", "ompdesk.app"), dest);

			expect(status).toBe(1);
			expect(markerOf(dest)).toBe("old");
			expect(
				fs
					.readdirSync(dir)
					.filter(name => !name.startsWith("bin-"))
					.sort(),
			).toEqual(["ompdesk.app", "swap.log"]);
		});
	});
});

// The transfer itself (resume, hash, stall) is the core's: crates/core/src/update_feed/net_tests.rs.

describe.runIf(process.platform !== "win32")("installer debris sweep", () => {
	const ENTRIES = [
		"ompdesk-0.9.7.dmg.download-4242",
		"ompdesk-0.9.8.dmg.download-99",
		"ompdesk-0.9.8.dmg.partial",
		"ompdesk-0.9.7 (1).dmg.partial",
		"holiday.dmg.partial",
		"notes.partial",
		"install-ompdesk.dmg.download-1",
		"ompdesk-0.9.9-arm64.dmg",
	];
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-downloads-"));
		for (const name of ENTRIES) fs.writeFileSync(path.join(dir, name), "x");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("clears PID-keyed orphans that no restart could ever continue", async () => {
		expect((await sweepInstallerPartials(dir)).sort()).toEqual([
			"ompdesk-0.9.7.dmg.download-4242",
			"ompdesk-0.9.8.dmg.download-99",
		]);
	});

	it("keeps every current-name partial while nothing is downloading", async () => {
		await sweepInstallerPartials(dir);
		expect(fs.existsSync(path.join(dir, "ompdesk-0.9.8.dmg.partial"))).toBe(true);
	});

	it("drops a superseded release's partial once the current download names its own", async () => {
		const active = path.join(dir, "ompdesk-0.9.9-arm64.dmg.partial");
		fs.writeFileSync(active, "x");
		const removed = await sweepInstallerPartials(dir, active);
		expect(removed.sort()).toEqual([
			"ompdesk-0.9.7 (1).dmg.partial",
			"ompdesk-0.9.7.dmg.download-4242",
			"ompdesk-0.9.8.dmg.download-99",
			"ompdesk-0.9.8.dmg.partial",
		]);
		expect(fs.existsSync(active)).toBe(true);
	});

	it("leaves files the updater never wrote where they are", async () => {
		const active = path.join(dir, "ompdesk-0.9.9-arm64.dmg.partial");
		await sweepInstallerPartials(dir, active);
		await sweepInstallerPartials(dir);
		for (const name of [
			"holiday.dmg.partial",
			"notes.partial",
			"install-ompdesk.dmg.download-1",
			"ompdesk-0.9.9-arm64.dmg",
		]) {
			expect(fs.existsSync(path.join(dir, name)), name).toBe(true);
		}
	});

	it("says nothing when the downloads directory doesn't exist yet", async () => {
		expect(await sweepInstallerPartials(path.join(dir, "absent"))).toEqual([]);
	});
});

describe("release access with an optional token", () => {
	it("takes the first token in precedence order and never runs later lookups", async () => {
		const calls: string[] = [];
		const lookup = (name: string, value: string | undefined) => () => {
			calls.push(name);
			return value;
		};
		expect(
			await firstUpdateToken([
				["env", lookup("env", "  ")],
				["gh", lookup("gh", "gho_abc\n")],
				["stored", lookup("stored", "stored-token")],
			]),
		).toEqual({ token: "gho_abc", source: "gh" });
		expect(calls).toEqual(["env", "gh"]);
		expect(await firstUpdateToken([["env", () => undefined]])).toBeUndefined();
	});

	it("treats GitHub's 404 for an invisible private repo as no access", () => {
		expect(classifyRepoAccess(200)).toBe("ok");
		expect(classifyRepoAccess(401)).toBe("invalid");
		expect(classifyRepoAccess(403)).toBe("denied");
		expect(classifyRepoAccess(404)).toBe("denied");
		expect(classifyRepoAccess(502)).toBe("network");
	});

	it("reads GitHub's hourly rate limit as a failed request, not as missing access", () => {
		expect(classifyRepoAccess(403, true)).toBe("network");
		expect(classifyRepoAccess(403, false)).toBe("denied");
		expect(classifyRepoAccess(429)).toBe("network");
	});

	it("asks for a token only when an anonymous request is refused", () => {
		expect(settleFailedUpdateCheck("missing", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "404", "0.1.0", false)).toEqual(
			{
				state: "auth-required",
				reason: "missing",
			},
		);
		expect(settleFailedUpdateCheck("ok", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "404", "0.1.0", false)).toEqual({
			state: "not-available",
			version: "0.1.0",
		});
	});

	it("turns a failed check into sign-in guidance, up to date, or a quiet background error", () => {
		expect(settleFailedUpdateCheck("denied", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "404", "0.1.0", false)).toEqual({
			state: "auth-required",
			reason: "denied",
		});
		expect(settleFailedUpdateCheck("invalid", undefined, "401", "0.1.0", true)).toEqual({
			state: "auth-required",
			reason: "invalid",
		});
		expect(settleFailedUpdateCheck("ok", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "404", "0.1.0", true)).toEqual({
			state: "not-available",
			version: "0.1.0",
		});
		expect(settleFailedUpdateCheck("network", undefined, "offline", "0.1.0", false)).toEqual({
			state: "error",
			message: "offline",
			showInBanner: false,
		});
		expect(settleFailedUpdateCheck("ok", "ERR_X", "boom", "0.1.0", true)).toEqual({
			state: "error",
			message: "boom",
			showInBanner: true,
		});
	});
});
