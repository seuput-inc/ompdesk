/**
 * The installer's start off the main thread (installer-spawn.ts), run for real: the process is started with its
 * arguments, and a start that fails rejects with the code electron-updater branches on.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installerSpawnEnv, spawnDetachedOffThread } from "./installer-spawn";

let dir: string;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-installer-spawn-"));
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("spawnDetachedOffThread", () => {
	it("starts the process with its arguments and resolves with its pid", async () => {
		const marker = path.join(dir, "ran.txt");
		const pid = await spawnDetachedOffThread(process.execPath, [
			"-e",
			"require('node:fs').writeFileSync(process.argv[1], process.argv.slice(2).join(' '))",
			marker,
			"--updated",
			"/S",
		]);
		expect(pid).toBeGreaterThan(0);
		await vi.waitFor(() => expect(fs.readFileSync(marker, "utf8")).toBe("--updated /S"));
	});

	it("rejects with the spawn error's code when the file is not there", async () => {
		await expect(spawnDetachedOffThread(path.join(dir, "missing-setup.exe"), [])).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("strips inherited PSModulePath so Windows PowerShell 5.1 inside NSIS loads its own modules", async () => {
		expect(installerSpawnEnv({ PATH: "/bin" })).toBeUndefined();
		expect(installerSpawnEnv({ PATH: "/bin", PSModulePath: "C:\\pwsh\\Modules", OTHER: "1" })).toEqual({
			PATH: "/bin",
			OTHER: "1",
		});
		expect(installerSpawnEnv({ psmodulepath: "C:\\pwsh\\Modules", KEEP: "yes" })).toEqual({ KEEP: "yes" });

		const marker = path.join(dir, "env.txt");
		const previous = process.env.PSModulePath;
		process.env.PSModulePath = "C:\\Program Files\\PowerShell\\7\\Modules";
		try {
			await spawnDetachedOffThread(process.execPath, [
				"-e",
				"require('node:fs').writeFileSync(process.argv[1], String(process.env.PSModulePath ?? 'ABSENT'))",
				marker,
			]);
			await vi.waitFor(() => expect(fs.readFileSync(marker, "utf8")).toBe("ABSENT"));
		} finally {
			if (previous === undefined) delete process.env.PSModulePath;
			else process.env.PSModulePath = previous;
		}
	});
});
