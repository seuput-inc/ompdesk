/**
 * The core's omp part reads and writes stock's `update.auto` through `omp config get|set update.auto … --json`
 * (`crates/core/src/tools/omp/takeover.rs`, touchpoint L13): it reads the reply's boolean `value`, and a `set` reply
 * with `overriddenBy` is a write that did not take. This runs those commands against the installed omp in a temp HOME
 * and config folder, so a stock change to the command or its JSON reply shows here, not on a person's computer. The
 * takeover's rules are the core's tests (`omp/tests.rs`).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLED_OMP } from "./test-bridge-probe";

/** `omp config <args> --json`'s object, as the core parses it. */
function config(env: Record<string, string>, args: string[]): Promise<Record<string, unknown>> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	const child = spawn(INSTALLED_OMP, ["config", ...args, "--json"], {
		env: { ...process.env, ...env, NO_COLOR: "1" },
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", chunk => {
		stdout += chunk;
	});
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	child.on("error", reject);
	child.on("close", code => {
		if (code === 0) resolve(JSON.parse(stdout));
		else reject(new Error(`omp config ${args.join(" ")} exited ${code}: ${stderr || stdout}`));
	});
	return promise;
}

describe.skipIf(!existsSync(INSTALLED_OMP))("stock update.auto through omp config", () => {
	it("reads stock's default, writes both values, and reads back what it wrote", async () => {
		const home = mkdtempSync(join(tmpdir(), "omp-config-stock-"));
		const env = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".omp", "agent") };
		expect((await config(env, ["get", "update.auto"])).value).toBe(false);
		for (const value of [true, false]) {
			const reply = await config(env, ["set", "update.auto", String(value)]);
			expect(reply.overriddenBy).toBeUndefined();
			expect((await config(env, ["get", "update.auto"])).value).toBe(value);
		}
	}, 60_000);
});
