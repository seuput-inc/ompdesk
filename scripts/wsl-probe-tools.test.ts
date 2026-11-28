import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const script = readFileSync(join(__dirname, "../resources/gui-bridge/wsl/probe-tools.sh"), "utf8");

it.skipIf(process.platform !== "linux")("refuses root without reporting tool readiness", () => {
	const child = spawnSync("/bin/sh", ["-s"], { input: `id() { echo 0; }\n${script}`, encoding: "utf8" });
	expect(child.status).toBe(1);
	expect(child.stdout).toBe("");
});

it.skipIf(process.platform !== "linux")("reads the guest's global tools without running project hooks", () => {
	const home = mkdtempSync(join(existsSync("/dev/shm") ? "/dev/shm" : tmpdir(), "wsl-tools-"));
	try {
		const project = join(home, "project");
		mkdirSync(project);
		const marker = join(home, "unexpected-execution");
		const hook = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); throw Error('unexpected execution')`;
		writeFileSync(join(project, "hook.js"), hook);
		writeFileSync(join(project, "bunfig.toml"), 'preload = ["./hook.js"]');
		writeFileSync(join(home, ".bunfig.toml"), `preload = [${JSON.stringify(join(project, "hook.js"))}]`);
		const probe = () => {
			// Supply a synthetic passwd entry without changing a Linux account or accepting a probe path argument.
			const input = `id() { echo 1000; }\ngetent() { printf 'test:x:1000:1000::%s:/bin/sh\\n' "$FIXTURE_HOME"; }\n${script}`;
			const child = spawnSync("/bin/sh", ["-s"], {
				input,
				cwd: project,
				encoding: "utf8",
				timeout: 5000,
				env: {
					FIXTURE_HOME: home,
					HOME: project,
					PATH: project,
					WSLENV: "HOME/p",
					BUN_OPTIONS: "--preload ./hook.js",
				},
			});
			expect(child.status, child.stderr).toBe(0);
			expect(existsSync(marker)).toBe(false);
			return JSON.parse(child.stdout);
		};
		const git = execFileSync("/usr/bin/git", ["--version"], { encoding: "utf8" })
			.trim()
			.replace(/^git version /, "");
		expect(probe()).toEqual({ git, bun: null, omp: null, enginesBun: null, launchable: false });
		const bun = execFileSync("bun", ["--print", "process.execPath"], { encoding: "utf8" }).trim();
		const version = execFileSync(bun, ["--version"], { encoding: "utf8" }).trim();
		mkdirSync(join(home, ".bun/bin"), { recursive: true });
		symlinkSync(bun, join(home, ".bun/bin/bun"));
		const pkg = join(home, ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
		mkdirSync(join(pkg, "dist"), { recursive: true });
		const manifest = join(pkg, "package.json");
		const data = { name: "@oh-my-pi/pi-coding-agent", version: "11.2.3", engines: { bun: ">=999.0.0" } };
		writeFileSync(manifest, JSON.stringify(data));
		const absent = { git, bun: version, omp: null, enginesBun: null, launchable: false };
		const installed = { ...absent, omp: "11.2.3", enginesBun: ">=999.0.0" };
		expect(probe()).toEqual(installed);
		const cli = join(pkg, "dist/cli.js");
		writeFileSync(cli, hook);
		expect(probe()).toEqual({ ...installed, launchable: process.getuid?.() !== 0 });
		writeFileSync(manifest, JSON.stringify({ ...data, engines: { bun: "*" } }));
		expect(probe().enginesBun).toBeNull();
		chmodSync(cli, 0o666);
		writeFileSync(manifest, JSON.stringify(data));
		expect(probe()).toEqual(installed);
		writeFileSync(manifest, "not JSON");
		chmodSync(cli, 0o600);
		expect(probe()).toEqual(absent);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
