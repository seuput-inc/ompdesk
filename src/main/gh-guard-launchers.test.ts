import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const GUARD_DIR = resolve(__dirname, "../../resources/gui-bridge/gh-bin");

describe("the gh guard's launchers on Windows", () => {
	const made: string[] = [];
	afterEach(() => {
		for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	// A bun program resolves `gh` through PATHEXT; a `gh.cmd` in the guard's folder made bun refuse every argument
	// holding a cmd.exe special character (`&` in a query string) before anything ran, with no stderr (0.136.0: every
	// `scripts/ci-run.ts` lane listing failed with an empty error). The real gh after the guard's folder answers instead.
	it.runIf(process.platform === "win32")("let a bun program's gh take an argument with &", () => {
		const fake = mkdtempSync(join(tmpdir(), "omp-gh-launcher-"));
		made.push(fake);
		// A stand-in gh.exe that prints its last argument: node under gh's name.
		copyFileSync(process.execPath, join(fake, "gh.exe"));
		const bun = spawnSync("bun", ["--print", "process.execPath"], { encoding: "utf8" }).stdout.trim();
		expect(bun).not.toBe("");
		const path = [GUARD_DIR, fake, dirname(bun), join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(
			delimiter,
		);
		const env: NodeJS.ProcessEnv = { ...process.env, PATH: path };
		delete env.Path;
		const program =
			"const r = require('node:child_process').spawnSync('gh', ['-e', 'process.stdout.write(process.argv[1])', 'a&b'], { encoding: 'utf8' });" +
			"process.stdout.write(JSON.stringify({ status: r.status, error: r.error?.message ?? null, out: r.stdout }));";
		const run = spawnSync(bun, ["-e", program], { encoding: "utf8", env });
		expect(JSON.parse(run.stdout)).toEqual({ status: 0, error: null, out: "a&b" });
	});
});
