/**
 * Which Chromium browsers this computer has, over a temp HOME with fake bundles; the status snapshot and its
 * automatic choice; and the extension install. Every case runs through the core process
 * (`native/ompdesk/crates/core/src/browsers/`): omp is a stand-in executable the core runs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentBrowserStatus, CHROMIUM_BROWSER_IDS, CHROMIUM_BROWSER_NAMES } from "../shared/default-browser";
import { type BrowserPlaces, findChromiumBrowsers, installRelayExtension, resolveEgoBrowser } from "./agent-browsers";
import * as coreProcess from "./core/process";
import type { OmpRuntime } from "./local/types";
import { nativeBinPath } from "./native-bin";
import * as shellEnv from "./shell-env";
import { OMP_COMMAND, stockSource } from "./test-bridge-probe";

const { CoreProcess } = coreProcess;
let root: string;
let home: string;

function place(path: string, content?: string): void {
	if (content === undefined) {
		mkdirSync(path, { recursive: true });
		return;
	}
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

const mac = (): BrowserPlaces => ({
	platform: "darwin",
	home,
	appDirs: [join(root, "Applications"), join(home, "Applications")],
	programDirs: [],
	localAppData: join(home, "AppData", "Local"),
});

const support = (...parts: string[]) => join(home, "Library", "Application Support", ...parts);
/** Where `id`'s own copy lives. */
const relayExtensionDir = (id: string) => join(home, ".omp", "browser-relay", `extension-${id}`);
const NATIVE = ["chrome", "brave", "chromium"] as const;

async function readStatus(host: coreProcess.CoreProcess, places: BrowserPlaces, refresh: boolean) {
	const browsers = CHROMIUM_BROWSER_IDS.map(id => ({ id, name: CHROMIUM_BROWSER_NAMES[id] }));
	return (
		await host.call<{ status: AgentBrowserStatus; changed: boolean }>("browsers.status", {
			nativeHostBrowsers: NATIVE,
			probe: { places, browsers, ego: { pathEnv: root, home: places.home, cwd: root }, refresh },
		})
	).result;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agent-browsers-"));
	home = join(root, "home");
	mkdirSync(home, { recursive: true });
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("ego-browser executable discovery", () => {
	const win = process.platform === "win32";
	const firstName = win ? "ego-browser.exe" : "ego-browser";
	const file = (path: string) => {
		place(path, "");
		chmodSync(path, 0o755);
	};

	it("retries misses, searches each PATH directory before the next and keeps the first hit", async () => {
		const host = new CoreProcess({ binary: () => nativeBinPath("ompdesk-core"), log: () => {} });
		const pathEnv = ["", "first/missing/..", "second"].join(delimiter);
		const lookup = async () => (await host.call("browsers.resolveEgo", { home, cwd: root, pathEnv })).result;
		try {
			file(join(root, firstName)); // An empty PATH entry does not mean cwd.
			if (win) place(join(root, "first", firstName));
			else {
				file(join(root, "first", firstName));
				chmodSync(join(root, "first", firstName), 0o644);
			}
			expect(await lookup()).toBeNull();
			const expected = join("first", win ? "ego-browser.cmd" : firstName);
			file(join(root, expected));
			if (win) file(join(root, "first", "ego-browser"));
			file(join(root, "second", firstName));
			file(join(home, ".local", "bin", firstName));
			expect(await lookup()).toBe(expected);
			rmSync(join(root, expected));
			expect((await host.call("browsers.cachedEgo", {})).result).toBe(expected);
			expect(await lookup()).toBe(expected);
		} finally {
			await host.stop();
		}
	});

	it("shares the pending lookup and asks for the shell PATH only on a cache miss", async () => {
		const host = new CoreProcess({ binary: () => nativeBinPath("ompdesk-core"), log: () => {} });
		const client = vi.spyOn(coreProcess, "core").mockReturnValue(host);
		const path = vi.spyOn(shellEnv, "spawnPath").mockResolvedValue(root);
		try {
			const expected = join(root, firstName);
			file(expected);
			const pending = resolveEgoBrowser();
			expect(resolveEgoBrowser()).toBe(pending);
			expect(await pending).toBe(expected);
			rmSync(expected);
			expect(await resolveEgoBrowser()).toBe(expected);
			expect(path).toHaveBeenCalledTimes(1);
		} finally {
			path.mockRestore();
			client.mockRestore();
			await host.stop();
		}
	});

	it("accepts the bare installer fallback outside PATH", async () => {
		const host = new CoreProcess({ binary: () => nativeBinPath("ompdesk-core"), log: () => {} });
		try {
			const expected = join(home, ".local", "bin", "ego-browser");
			file(expected);
			const answer = await host.call("browsers.resolveEgo", { home, cwd: root, pathEnv: "" });
			expect(answer.result).toBe(expected);
		} finally {
			await host.stop();
		}
	});
});

describe("findChromiumBrowsers", () => {
	it("lists the installed bundles from /Applications-style folders and ~/Applications, in auto order", async () => {
		place(join(home, "Applications", "Brave Browser.app"));
		place(join(root, "Applications", "Microsoft Edge.app"));
		place(join(root, "Applications", "Google Chrome.app"));
		place(join(root, "Applications", "Safari.app"));
		const found = await findChromiumBrowsers(mac());
		expect(found.map(browser => [browser.id, browser.name])).toEqual([
			["chrome", "Google Chrome"],
			["edge", "Microsoft Edge"],
			["brave", "Brave"],
		]);
		expect(found[0]?.app).toBe(join(root, "Applications", "Google Chrome.app"));
		expect(found[0]?.dataDir).toBe(support("Google", "Chrome"));
		expect(found.map(browser => browser.extensionsUrl)).toEqual([
			"chrome://extensions",
			"edge://extensions",
			"brave://extensions",
		]);
	});

	it("knows Arc and Chromium by their own bundles and data folders", async () => {
		place(join(root, "Applications", "Arc.app"));
		place(join(root, "Applications", "Chromium.app"));
		const found = await findChromiumBrowsers(mac());
		expect(found.map(browser => [browser.id, browser.dataDir, browser.extensionsUrl])).toEqual([
			["arc", support("Arc", "User Data"), "arc://extensions"],
			["chromium", support("Chromium"), "chrome://extensions"],
		]);
	});

	it("finds nothing on a machine without them", async () => {
		expect(await findChromiumBrowsers(mac())).toEqual([]);
	});

	it("reads Windows install folders (Program Files, LocalAppData) and skips Arc, which has none", async () => {
		const programFiles = join(root, "Program Files");
		const localAppData = join(root, "Local");
		place(join(programFiles, "Google", "Chrome", "Application", "chrome.exe"), "");
		place(join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"), "");
		place(join(programFiles, "Arc.app"));
		const found = await findChromiumBrowsers({
			platform: "win32",
			home,
			appDirs: [],
			programDirs: [programFiles, localAppData],
			localAppData,
		});
		expect(found.map(browser => [browser.id, browser.dataDir])).toEqual([
			["chrome", join(localAppData, "Google", "Chrome", "User Data")],
			["edge", join(localAppData, "Microsoft", "Edge", "User Data")],
		]);
	});
});

describe("browsers.status", () => {
	it("shares the first probe, lists the installed browsers and reports a change of what is installed", async () => {
		const host = new CoreProcess({ binary: () => nativeBinPath("ompdesk-core"), log: () => {} });
		try {
			const read = (refresh = false) => readStatus(host, mac(), refresh);
			expect((await host.call("browsers.status", { nativeHostBrowsers: NATIVE })).result).toBeNull();
			place(join(root, "Applications", "Google Chrome.app"));
			const first = await Promise.all([read(), read()]);
			expect(first[0]).toEqual(first[1]);
			expect(first[0]).toEqual({
				changed: false,
				status: {
					auto: { kind: "builtin" },
					egoInstalled: false,
					browsers: [{ id: "chrome", name: "Google Chrome" }],
					nativeHostBrowsers: NATIVE,
				},
			});
			expect((await host.call("browsers.status", { nativeHostBrowsers: NATIVE })).result).toEqual(first[0]);
			expect((await read(true)).changed).toBe(false);

			place(join(root, "Applications", "Microsoft Edge.app"));
			const edge = await read(true);
			expect(edge.changed).toBe(true);
			expect(edge.status.browsers.map(browser => browser.id)).toEqual(["chrome", "edge"]);
			expect((await read(true)).changed).toBe(false);
		} finally {
			await host.stop();
		}
	});

	it("invalidates the cache on another native-host list and shares ego discovery with explicit lookup", async () => {
		const host = new CoreProcess({ binary: () => nativeBinPath("ompdesk-core"), log: () => {} });
		try {
			place(join(root, "Applications", "Google Chrome.app"));
			expect((await readStatus(host, mac(), true)).changed).toBe(false);
			expect((await host.call("browsers.status", { nativeHostBrowsers: ["chrome"] })).result).toBeNull();

			const bin = join(home, ".local", "bin", "ego-browser");
			place(bin, "");
			chmodSync(bin, 0o755);
			expect((await readStatus(host, mac(), false)).status.egoInstalled).toBe(false);
			const refreshed = await readStatus(host, mac(), true);
			expect(refreshed.changed).toBe(true);
			expect(refreshed.status.auto).toEqual({ kind: "ego" });
			expect(refreshed.status.egoInstalled).toBe(true);
			expect((await host.call("browsers.cachedEgo", {})).result).toBe(bin);
		} finally {
			await host.stop();
		}
	});
});

describe("installRelayExtension", () => {
	/** What the stand-in omp runs: it records its arguments and, when it succeeds, writes the files to `--dir`. */
	const FAKE_OMP = `const fs = require("node:fs");
const path = require("node:path");
const [spec, ...argv] = process.argv.slice(2);
const { files, code, stderr, calls } = JSON.parse(fs.readFileSync(spec, "utf8"));
fs.appendFileSync(calls, JSON.stringify(argv) + "\\n");
if (code === 0) {
	const dir = argv[argv.indexOf("--dir") + 1];
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
}
process.stderr.write(stderr, () => process.exit(code));
`;

	let made = 0;

	/** A stock omp whose `browser-relay install --dir <dir>` writes `files` there; `calls` reads its argument lists. */
	function runtime(
		files: Record<string, string>,
		result: { code?: number; stderr?: string } = {},
	): { omp: OmpRuntime; calls: () => string[][] } {
		made += 1;
		const dir = join(root, `omp-${made}`);
		mkdirSync(dir, { recursive: true });
		const script = join(dir, "omp.cjs");
		const spec = join(dir, "spec.json");
		const calls = join(dir, "calls.jsonl");
		writeFileSync(script, FAKE_OMP);
		writeFileSync(spec, JSON.stringify({ files, code: result.code ?? 0, stderr: result.stderr ?? "", calls }));
		const node = process.execPath;
		const bin = join(dir, process.platform === "win32" ? "omp.cmd" : "omp");
		if (process.platform === "win32") writeFileSync(bin, `@"${node}" "${script}" "${spec}" %*\r\n`);
		else writeFileSync(bin, `#!/bin/sh\nexec "${node}" "${script}" "${spec}" "$@"\n`, { mode: 0o755 });
		const omp: OmpRuntime = {
			bin,
			version: "19.2.0",
			run: async () => {
				throw new Error("the core process runs omp");
			},
		};
		const read = () =>
			existsSync(calls)
				? readFileSync(calls, "utf8")
						.split("\n")
						.filter(Boolean)
						.map(line => JSON.parse(line) as string[])
				: [];
		return { omp, calls: read };
	}

	it("registers the final extension path on native-host omp without loading it in any Chrome profile", async () => {
		const { omp, calls } = runtime({ "worker.js": "uses native messaging" });
		const dir = await installRelayExtension(omp, "chrome", home);
		expect(dir).toBe(relayExtensionDir("chrome"));
		expect(calls()).toEqual([["browser-relay", "install", "--dir", dir, "--no-chrome"]]);
		expect(readFileSync(join(dir, "worker.js"), "utf8")).toBe("uses native messaging");
	});

	// Windows registration writes HKCU even with a private HOME; exercise its argv above, never the real registry.
	it.skipIf(
		process.platform === "win32" || !stockSource("pi-coding-agent", "tools/browser/relay/native-host-manifest.ts"),
	)(
		"stock registers only the final path's origin and leaves the synthetic Chrome profile alone",
		() => {
			const dir = relayExtensionDir("chrome");
			const config = join(home, ".config");
			const chrome = process.platform === "darwin" ? support("Google", "Chrome") : join(config, "google-chrome");
			const prefs = join(chrome, "Default", "Preferences");
			place(prefs, "{}");
			const result = spawnSync(
				OMP_COMMAND.file,
				[...OMP_COMMAND.args, "browser-relay", "install", "--dir", dir, "--no-chrome"],
				{
					cwd: home,
					env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: config, PI_CONFIG_DIR: ".", TMPDIR: root },
					encoding: "utf8",
					timeout: 30_000,
				},
			);
			expect(result.status, result.stderr || result.error?.message).toBe(0);
			const id = createHash("sha256")
				.update(realpathSync(dir))
				.digest("hex")
				.slice(0, 32)
				.replace(/./g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
			const manifests = join(chrome, "NativeMessagingHosts");
			const files = readdirSync(manifests);
			expect(files).toHaveLength(1);
			expect(JSON.parse(readFileSync(join(manifests, files[0]), "utf8"))).toMatchObject({
				allowed_origins: [`chrome-extension://${id}/`],
				type: "stdio",
			});
			expect(readFileSync(prefs, "utf8")).toBe("{}");
			expect(existsSync(join(chrome, "Default", "Secure Preferences"))).toBe(false);
		},
		40_000,
	);

	it("does not run the installer for a browser the native host cannot register", async () => {
		const { omp, calls } = runtime({});
		await expect(installRelayExtension(omp, "arc", home)).rejects.toThrow("Arc");
		expect(calls()).toEqual([]);
	});

	it("fails with omp's own words", async () => {
		await expect(
			installRelayExtension(runtime({}, { code: 1, stderr: "disk full\n" }).omp, "chrome", home),
		).rejects.toThrow("disk full");
		expect(existsSync(relayExtensionDir("chrome"))).toBe(false);
	});
});

describe.runIf(process.platform === "win32")("openExtensionsPage on Windows", () => {
	it("starts the browser outside the core's job and off its pipes: it outlives the core, and main sees the core end", async () => {
		// The browser's stand-in: node running a script that writes its pid and stays (60 s at most).
		const script = join(root, "browser.cjs");
		const pidFile = join(root, "browser.pid");
		writeFileSync(
			script,
			`require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60_000);`,
		);
		const core = new CoreProcess({ binary: () => nativeBinPath("ompdesk-core"), log: () => {} });
		let browser = 0;
		try {
			await core.call("browsers.openExtensions", { app: process.execPath, url: script });
			browser = await vi.waitFor(() => Number(readFileSync(pidFile, "utf8")), { timeout: 10_000 });
			const first = core.pid as number;
			// Rejected only by the core's `close`: a core whose pipes the browser held would end this in a timeout.
			const waiting = core.call("core.echo", { waitFor: "never" }, { timeoutMs: 5_000 });
			process.kill(first, "SIGKILL");
			await expect(waiting).rejects.toMatchObject({ code: "core_exited" });
			const again = await core.call<{ value: unknown }>("core.echo", { value: 2 }, { timeoutMs: 5_000 });
			expect(again.result.value).toBe(2);
			expect(core.pid).not.toBe(first);
			expect(() => process.kill(browser, 0)).not.toThrow();
		} finally {
			if (browser) process.kill(browser);
			await core.stop();
		}
	});
});
