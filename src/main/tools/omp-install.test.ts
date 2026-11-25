/**
 * omp's update for real, through the core's `tools` instance: a fake registry (127.0.0.1) serves releases of
 * `@oh-my-pi/pi-coding-agent`, the real `bun install -g` puts the older one in two Bun roots under a temp HOME (the
 * default `~/.bun`, whose `bin` comes first on the user's PATH, and a custom BUN_INSTALL whose omp is the one OMPdesk
 * runs), and the omp part's passes check (the stand-in launcher's `update --check`) and update (`bun install -g` of
 * the named release in the Bun root of the omp OMPdesk runs). It must land there and leave the other one alone, and an
 * unasked pass must install the newest release of the tested major by name while the registry's newest is a major
 * above it. Nothing outside the temp root is written: HOME, BUN_INSTALL and Bun's cache all point into it. The rules
 * of setup's own omp install (the package launcher put back over a compiled omp, an omp neither Bun nor npm owns) are
 * the core's tests (`tools/setup/tests.rs`).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stopCore } from "../core/process";
import { MIN_OMP_VERSION, OMP_PACKAGE, resolveOmpAmong, TESTED_OMP_VERSION } from "../omp-runtime";
import { type OmpRegistry, type OmpRelease, ompRegistry, ompRelease } from "../test-omp-registry";
import { ToolsClient, type ToolsState } from "./client";

/** The core's log lines (`omp-update`, `setup`), shown when a case fails. */
const logs = vi.hoisted(() => [] as unknown[]);
vi.mock("../runtime-log", () => ({ writeRuntimeLog: (line: unknown) => logs.push(line) }));

const windows = process.platform === "win32";

/** Stock's `omp update --check` on a Bun install, reduced to what it answers; OMPdesk installs the release itself. */
const CLI = `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
if (args[0] === "--version") {
	console.log("omp/" + pkg.version);
	process.exit(0);
}
if (args[0] !== "update" || !args.includes("--check")) process.exit(2);
console.log("Current version: " + pkg.version);
const registry = (process.env.BUN_CONFIG_REGISTRY ?? "").replace(/\\/+$/, "");
const latest = (await (await fetch(registry + "/" + pkg.name)).json())["dist-tags"].latest;
console.log(latest === pkg.version ? "Already up to date" : "New version available: " + latest);
`;

const bunProbe = spawnSync("bun", ["-e", "console.log(process.execPath + '\\n' + Bun.version)"], { encoding: "utf8" });
const [bun = null, bunVersion = "0.0.0"] = bunProbe.status === 0 ? bunProbe.stdout.trim().split(/\r?\n/) : [];

/** Run to the end without blocking this process (the registry lives here). */
function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
	const { promise, resolve } = Promise.withResolvers<{ code: number; output: string }>();
	const child = spawn(command, args, { env, windowsHide: true });
	let output = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	child.on("error", error => resolve({ code: 127, output: error.message }));
	child.on("close", code => resolve({ code: code ?? 1, output }));
	return promise;
}

/** Lets the core's items reach main until `done` holds, bound by wall time: the pass waits on real `bun` processes. */
async function until(done: () => boolean, ms = 90_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!done() && Date.now() < deadline) await new Promise<void>(next => setTimeout(next, 20));
	expect(done(), JSON.stringify(logs.slice(-12))).toBe(true);
}

afterAll(() => stopCore());

describe.skipIf(bun === null)("omp update through the tools instance with a real bun install -g", () => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ompdesk-omp-update-")));
	const home = join(root, "home");
	const shellBun = join(home, ".bun");
	const ownBun = join(root, "own-bun");
	const ownOmp = join(ownBun, "bin", windows ? "omp.exe" : "omp");
	const shellOmp = join(shellBun, "bin", windows ? "omp.exe" : "omp");
	/** The package version `bun install -g` left in a Bun root. */
	const installedVersion = (bunRoot: string): unknown => {
		const file = join(bunRoot, "install", "global", "node_modules", OMP_PACKAGE, "package.json");
		const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
		return typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : undefined;
	};
	const [major = 0, minor = 0] = MIN_OMP_VERSION.split(".").map(Number);
	const testedMajor = Number(TESTED_OMP_VERSION.split(".")[0]);
	// One release per version. Each names the running Bun as its oldest (stock's `engines.bun`): the core reads it from
	// the registry before an update (real `bun pm view`) and finds nothing to upgrade.
	const releases = new Map<string, OmpRelease>();
	const release = (version: string): OmpRelease => {
		const made = releases.get(version) ?? ompRelease(version, CLI, {}, { bun: `>=${bunVersion}` });
		releases.set(version, made);
		return made;
	};
	const older = release(MIN_OMP_VERSION);
	const newer = release(`${major}.${minor + 1}.0`);
	const tested = release(TESTED_OMP_VERSION);
	/** A major this OMPdesk was never tested with. */
	const beyond = release(`${testedMajor + 1}.0.0`);
	let latest = older.version;
	let registry: OmpRegistry | undefined;
	let env: NodeJS.ProcessEnv;

	/** An instance whose omp is the one in `ownBun`, as main's resolution would find it; `scheduled` runs the launch pass. */
	function instance(name: string, scheduled: boolean): { client: ToolsClient; state: () => ToolsState } {
		const userData = join(root, name);
		mkdirSync(userData, { recursive: true });
		const client = new ToolsClient({
			opts: {
				platform: windows ? "win32" : "darwin",
				arch: process.arch,
				toolsDir: join(root, "tools"),
				userData,
				appVersion: "0.0.0",
				testedOmp: TESTED_OMP_VERSION,
				automatic: false,
				scheduled: { omp: scheduled, cli: false, ext: false },
				systemRoot: process.env.SystemRoot ?? "C:\\Windows",
				// OMPdesk's default Bun root (`bunInstallDir`): the one the user's shell would update.
				bunInstall: shellBun,
				cwd: root,
			},
			asks: {
				env: () => ({ ...env }),
				refreshPath: async () => {},
				ompResolution: async () =>
					(await resolveOmpAmong([ownOmp], env.PATH ?? "")) ?? { ok: false, error: "omp was not found" },
				ompReady: () => {},
				firstTab: () => new Promise<void>(() => {}),
				releaseHelpers: async () => {},
				resume: async () => {},
				applyExtensionUpdate: () => {},
				notify: () => {},
				stock: async () => null,
				workspaceDirs: () => [],
			},
			onState: () => {},
		});
		return { client, state: () => client.state() };
	}

	beforeAll(async () => {
		mkdirSync(home, { recursive: true });
		const served = await ompRegistry([...releases.values()], () => latest);
		registry = served;
		const systemDirs = windows
			? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows"]
			: ["/usr/bin", "/bin"];
		env = {
			...Object.fromEntries(
				Object.entries(process.env).filter(
					([key]) => !/^(BUN_INSTALL|OMP_GUI_OMP|https?_proxy|all_proxy|npm_config_registry)/i.test(key),
				),
			),
			HOME: home,
			USERPROFILE: home,
			BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
			BUN_CONFIG_REGISTRY: served.url,
			NPM_CONFIG_REGISTRY: served.url,
			NO_PROXY: "127.0.0.1,localhost",
			// The user's shell: the default Bun root's bin first, the omp OMPdesk runs further down.
			PATH: [join(shellBun, "bin"), dirname(bun ?? ""), ...systemDirs, join(ownBun, "bin")].join(delimiter),
		};
		for (const bunRoot of [shellBun, ownBun]) {
			const installed = await run(bun ?? "bun", ["install", "-g", "--no-cache", `${OMP_PACKAGE}@${older.version}`], {
				...env,
				BUN_INSTALL: bunRoot,
			});
			expect(installed.code, installed.output).toBe(0);
		}
		latest = newer.version;
	}, 120_000);

	afterAll(async () => {
		await registry?.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	});

	it("Update now checks and updates the omp OMPdesk runs, not the omp first on PATH or the default Bun root", async () => {
		const { client, state } = instance("now", false);
		try {
			client.start();
			await until(() => state().omp.installed === older.version);
			await client.ompNow();
			expect(state().omp, JSON.stringify(logs.slice(-12))).toMatchObject({
				phase: "idle",
				failure: null,
				latest: newer.version,
			});
			expect(installedVersion(ownBun)).toBe(newer.version);
			expect(installedVersion(shellBun)).toBe(older.version);
			expect((await run(shellOmp, ["--version"], env)).output.trim()).toBe(`omp/${older.version}`);
		} finally {
			client.close();
		}
	}, 120_000);

	it("an unasked pass installs the tested major's newest by name while the registry's newest is a major above it", async () => {
		latest = beyond.version;
		const { client, state } = instance("launch", true);
		try {
			client.start();
			await until(() => state().omp.phase === "idle" && state().omp.installed === tested.version);
			expect(state().omp, JSON.stringify(logs.slice(-12))).toMatchObject({
				failure: null,
				latest: beyond.version,
				held: { version: beyond.version, reason: "untested-major" },
			});
			expect(installedVersion(ownBun)).toBe(tested.version);
			expect(installedVersion(shellBun)).toBe(older.version);
		} finally {
			client.close();
		}
	}, 120_000);
});
