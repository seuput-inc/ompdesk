/**
 * OMPdesk reads and writes stock's `update.auto` through `omp config get|set … --json` (omp-auto-takeover.ts,
 * touchpoint L13). This runs those helpers against the installed omp in a temp HOME and config folder, so a stock
 * change to the command or its JSON reply (`value`, `overriddenBy`) shows here, not on a person's computer.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OmpAutoTakeover, type OmpCliRun, readStockAuto, writeStockAuto } from "./omp-auto-takeover";
import { INSTALLED_OMP } from "./test-bridge-probe";

function cli(env: Record<string, string>): OmpCliRun {
	return args => {
		const { promise, resolve, reject } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
		const child = spawn(INSTALLED_OMP, args, { env: { ...process.env, ...env, NO_COLOR: "1" } });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => {
			stdout += chunk;
		});
		child.stderr.on("data", chunk => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
		return promise;
	};
}

describe.skipIf(!existsSync(INSTALLED_OMP))("stock update.auto through omp config", () => {
	it("reads stock's default, writes both values, and reads back what it wrote", async () => {
		const home = mkdtempSync(join(tmpdir(), "omp-config-stock-"));
		const run = cli({ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".omp", "agent") });
		expect(await readStockAuto(run)).toBe(false);
		await writeStockAuto(run, true);
		expect(await readStockAuto(run)).toBe(true);
		await writeStockAuto(run, false);
		expect(await readStockAuto(run)).toBe(false);
	}, 60_000);

	it("an OMPdesk that does not follow the verified list leaves stock's config file byte for byte as it was", async () => {
		const home = mkdtempSync(join(tmpdir(), "omp-config-stock-"));
		const agentDir = join(home, ".omp", "agent");
		const run = cli({ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir });
		await writeStockAuto(run, true);
		// Every file stock keeps in its agent folder (the config omp writes, whatever stock calls it).
		const snapshot = () =>
			Object.fromEntries(
				readdirSync(agentDir, { withFileTypes: true })
					.filter(entry => entry.isFile())
					.map(entry => [entry.name, readFileSync(join(agentDir, entry.name)).toString("base64")]),
			);
		const before = snapshot();
		expect(Object.keys(before)).not.toEqual([]);
		const takeover = new OmpAutoTakeover({
			enabled: () => false,
			read: () => readStockAuto(run),
			write: value => writeStockAuto(run, value),
			file: join(home, "omp-auto-takeover.json"),
			app: "0.136.0",
			log: () => {},
			onChanged: () => {},
		});
		await takeover.sync();
		expect(snapshot()).toEqual(before);
		expect(await readStockAuto(run)).toBe(true);
	}, 60_000);
});
