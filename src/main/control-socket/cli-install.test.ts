import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCliLaunchers } from "./cli-install";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cli-install-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(packaged: boolean, platform: "darwin" | "win32" | "other" = "darwin") {
	const home = join(root, "home");
	const bunBin = join(home, ".bun", "bin");
	mkdirSync(bunBin, { recursive: true });
	const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
	const options = {
		binary: join(root, "res", "ompdesk-bin", platform === "win32" ? "ompdesk.exe" : "ompdesk"),
		userData: join(root, "userData"),
		platform,
		packaged,
		env,
		home,
	};
	return { options, env, bunBin, appBin: join(root, "userData", "bin") };
}

describe("installCliLaunchers", () => {
	it("writes an executable launcher naming the app's CLI and appends PATH once", async () => {
		const { options, env, appBin } = setup(false);
		const written = await installCliLaunchers(options);
		await installCliLaunchers(options);
		const launcher = readFileSync(join(appBin, "ompdesk"), "utf8");
		expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
		expect(launcher).toContain("ompdesk CLI launcher, written by OMPdesk");
		expect(launcher).toContain(options.binary);
		if (process.platform !== "win32") expect(statSync(join(appBin, "ompdesk")).mode & 0o111).not.toBe(0);
		expect(written).toEqual([appBin]);
		expect(env.PATH).toBe(`/usr/bin:${appBin}`);
	});

	it.skipIf(process.platform === "win32")(
		"runs the CLI with the caller's arguments, from a folder whose name needs quoting",
		async () => {
			const { options, appBin } = setup(false);
			const folder = join(root, "Application Support's", "ompdesk-bin");
			mkdirSync(folder, { recursive: true });
			const binary = join(folder, "ompdesk");
			writeFileSync(binary, '#!/bin/sh\nfor arg in "$@"; do printf "[%s]" "$arg"; done\n', { mode: 0o755 });
			await installCliLaunchers({ ...options, binary });
			const out = execFileSync(join(appBin, "ompdesk"), ["send", "s 1", 'say "hi" $HOME', "-"], {
				encoding: "utf8",
			});
			expect(out).toBe('[send][s 1][say "hi" $HOME][-]');
		},
	);

	it("skips Bun's bin folder when not packaged", async () => {
		const { options, bunBin } = setup(false);
		await installCliLaunchers(options);
		expect(existsSync(join(bunBin, "ompdesk"))).toBe(false);
	});

	it("puts a launcher in Bun's bin folder when packaged, and rewrites its own when the app moves", async () => {
		const { options, bunBin, appBin } = setup(true);
		expect(await installCliLaunchers(options)).toEqual([appBin, bunBin]);
		const moved = { ...options, binary: join(root, "elsewhere", "ompdesk-bin", "ompdesk") };
		await installCliLaunchers(moved);
		expect(readFileSync(join(bunBin, "ompdesk"), "utf8")).toContain(moved.binary);
		expect(readFileSync(join(bunBin, "ompdesk"), "utf8")).not.toContain(options.binary);
	});

	it("never overwrites a foreign file in Bun's bin folder", async () => {
		const { options, bunBin, appBin } = setup(true);
		writeFileSync(join(bunBin, "ompdesk"), "#!/bin/sh\necho mine\n");
		expect(await installCliLaunchers(options)).toEqual([appBin]);
		expect(readFileSync(join(bunBin, "ompdesk"), "utf8")).toBe("#!/bin/sh\necho mine\n");
	});

	it.skipIf(process.platform === "win32")("leaves a dangling foreign launcher in place", async () => {
		const { options, bunBin, appBin } = setup(true);
		const launcher = join(bunBin, "ompdesk");
		symlinkSync("absent", launcher);
		expect(await installCliLaunchers(options)).toEqual([appBin]);
		expect(readlinkSync(launcher)).toBe("absent");
	});

	it.each(["ompdesk", "ompdesk.cmd"])("preserves a foreign %s but still installs its Windows sibling", async name => {
		const { options, appBin, bunBin } = setup(true, "win32");
		writeFileSync(join(bunBin, name), "mine");
		expect(await installCliLaunchers(options)).toEqual([appBin]);
		expect(readFileSync(join(bunBin, name), "utf8")).toBe("mine");
		const sibling = name === "ompdesk" ? "ompdesk.cmd" : "ompdesk";
		expect(readFileSync(join(bunBin, sibling))).toEqual(readFileSync(join(appBin, sibling)));
	});

	it("does not touch Bun's bin folder in a headless launch or when it is absent", async () => {
		const headless = setup(true);
		headless.env.OMP_GUI_HEADLESS = "1";
		await installCliLaunchers(headless.options);
		expect(existsSync(join(headless.bunBin, "ompdesk"))).toBe(false);
		rmSync(headless.bunBin, { recursive: true });
		headless.env.OMP_GUI_HEADLESS = "0";
		expect(await installCliLaunchers(headless.options)).toEqual([headless.appBin]);
		expect(existsSync(headless.bunBin)).toBe(false);
	});

	it("writes a .cmd next to it on Windows that runs the CLI by its absolute path", async () => {
		const { options, appBin } = setup(false, "win32");
		await installCliLaunchers(options);
		const cmd = readFileSync(join(appBin, "ompdesk.cmd"), "utf8");
		expect(cmd.startsWith("@echo off\r\nrem ")).toBe(true);
		expect(cmd).toContain(`"${options.binary}" %*`);
	});

	it("names the CLI with forward slashes in the sh launcher on Windows, which every Windows bash resolves", async () => {
		const { options, appBin } = setup(false, "win32");
		// A Windows path whatever the test's host: omp's own bash answered `not found` for `exec 'C:\…\ompdesk.exe'`.
		await installCliLaunchers({ ...options, binary: String.raw`C:\Program Files\O'MP\ompdesk-bin\ompdesk.exe` });
		const sh = readFileSync(join(appBin, "ompdesk"), "utf8");
		expect(sh).toContain(`exe='C:/Program Files/O'\\''MP/ompdesk-bin/ompdesk.exe'`);
		expect(sh).toContain(`exec "$exe" "$@"`);
		const cmd = readFileSync(join(appBin, "ompdesk.cmd"), "utf8");
		expect(cmd).toContain(String.raw`"C:\Program Files\O'MP\ompdesk-bin\ompdesk.exe" %*`);
	});

	/**
	 * WSL on a POSIX host: `WSL_DISTRO_NAME` set, a `wslpath` that records what it maps, and a stand-in for the Windows
	 * CLI that logs its arguments and, for `heavy hold`, answers as the real one does (with Windows' CR): `held 1 pid
	 * 4242`, or `held reused` under a holder named by `OMPDESK_HEAVY_HELD`, then holds until its stdin closes.
	 */
	async function underWsl() {
		const { options, appBin } = setup(false, "win32");
		const bin = join(root, "wsl-bin");
		mkdirSync(bin, { recursive: true });
		const log = join(root, "cli.log");
		const cli = join(bin, "ompdesk.exe");
		writeFileSync(
			cli,
			`#!/bin/sh
echo "$*" >> '${log}'
[ "$1 $2" = "heavy hold" ] || exit 0
if [ "$TEST_UNLIMITED" = yes ]; then printf 'unlimited\\r\\n'; exit 0; fi
if [ -n "$OMPDESK_HEAVY_HELD" ]; then echo "reused under $OMPDESK_HEAVY_HELD" >> '${log}'; printf 'held reused\\r\\n'
else printf 'held 1 pid 4242\\r\\n'; fi
cat >/dev/null
echo released >> '${log}'
`,
			{ mode: 0o755 },
		);
		writeFileSync(join(bin, "wslpath"), `#!/bin/sh\necho "wslpath $*" >> '${log}'\necho "$2"\n`, { mode: 0o755 });
		await installCliLaunchers({ ...options, binary: cli });
		const env: NodeJS.ProcessEnv = { ...process.env, WSL_DISTRO_NAME: "Ubuntu", PATH: `${bin}:${process.env.PATH}` };
		delete env.WSLENV;
		delete env.OMPDESK_HEAVY_HELD;
		const calls = () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.filter(line => !line.startsWith("wslpath "))
				: [];
		return { launcher: join(appBin, "ompdesk"), env, calls, log, cli };
	}

	it.skipIf(process.platform === "win32")("under WSL runs the Windows CLI by its mapped path", async () => {
		const { launcher, env, log, cli } = await underWsl();
		execFileSync(launcher, ["heavy", "status"], { env });
		expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([`wslpath -u ${cli}`, "heavy status"]);
	});

	it.skipIf(process.platform === "win32")(
		"under WSL runs without exporting a holder when admission is off",
		async () => {
			const { launcher, env } = await underWsl();
			const run = spawnSync(
				launcher,
				["run", "--heavy", "--", "sh", "-c", 'test -z "$OMPDESK_HEAVY_HELD" && exit 7'],
				{
					env: { ...env, TEST_UNLIMITED: "yes", OMPDESK_HEAVY_HELD: "999" },
				},
			);
			expect(run.status).toBe(7);
		},
	);

	it.skipIf(process.platform === "win32")(
		"under WSL runs a heavy command as a Linux process while it holds a slot, and returns its exit code",
		async () => {
			const { launcher, env, calls, log } = await underWsl();
			const seen = join(root, "seen");
			// What the command saw: the hold taken and not yet released, its holder's pid, and no handle of the hold's stdin.
			const command = `grep -v wslpath '${log}' > '${seen}'; echo "$OMPDESK_HEAVY_HELD $WSLENV" >> '${seen}'; if (: >&3) 2>/dev/null; then echo inherited >> '${seen}'; fi; exit 3`;
			const run = spawnSync(launcher, ["run", "--heavy", "--", "sh", "-c", command], { env });
			expect(run.status).toBe(3);
			expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual(["heavy hold", "4242 OMPDESK_HEAVY_HELD"]);
			expect(calls()).toEqual(["heavy hold", "released"]);
		},
	);

	it.skipIf(process.platform === "win32")(
		"under WSL a heavy run nested in another reuses the outer slot instead of waiting for a second",
		async () => {
			const { launcher, env, calls } = await underWsl();
			const run = spawnSync(launcher, ["run", "--heavy", "--", launcher, "run", "--heavy", "--", "true"], { env });
			expect(run.status).toBe(0);
			expect(calls()).toEqual(["heavy hold", "heavy hold", "reused under 4242", "released", "released"]);
		},
	);

	it.skipIf(process.platform === "win32")("under WSL frees the slot when the heavy run is killed", async () => {
		const { launcher, env, calls } = await underWsl();
		const pidFile = join(root, "child.pid");
		const run = spawn(launcher, ["run", "--heavy", "sh", "-c", `echo $$ > '${pidFile}'; exec sleep 30`], { env });
		await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
		expect(calls()).toEqual(["heavy hold"]);
		run.kill("SIGKILL");
		try {
			await vi.waitFor(() => expect(calls()).toEqual(["heavy hold", "released"]));
		} finally {
			process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
		}
	});

	it("leaves the command out, and the app starting, when its folder cannot be written", async () => {
		const { options, env, appBin } = setup(false);
		mkdirSync(join(root, "userData"), { recursive: true });
		writeFileSync(appBin, "a file where the folder goes");
		expect(await installCliLaunchers(options)).toEqual([]);
		expect(env.PATH).toBe(`/usr/bin:${appBin}`);
	});
});
