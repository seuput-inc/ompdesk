import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LaunchDecision } from "./gpu-fallback";
import { prepareShellPolicyFixture, type ShellPolicyFixture, shellPolicyFixture } from "./shell-policy-test-rig";

let profile: string;
let fixture: ShellPolicyFixture;
beforeAll(prepareShellPolicyFixture, 180_000);
beforeEach(async () => {
	profile = mkdtempSync(join(tmpdir(), "gpu-marker-"));
	fixture = await shellPolicyFixture();
});
afterEach(async () => {
	await fixture.close();
	rmSync(profile, { recursive: true, force: true });
});

function start(): Promise<unknown> {
	return fixture.call("launch.start", { profile, now: 1, guard: false, enableGpu: false, disableGpu: false });
}

describe("GPU fallback", () => {
	it.each([
		["GPU", "crashed", true],
		["GPU", "oom", true],
		["GPU", "launch-failed", true],
		["GPU", "clean-exit", false],
		["GPU", "killed", false],
		["Tab", "crashed", false],
		["Utility", "crashed", false],
	] as const)("handles %s %s as a crash: %s", async (type, reason, handled) => {
		await start();
		const decision = await fixture.call<LaunchDecision>("launch.event", {
			op: "crash",
			args: { type, reason, now: 2 },
		});
		expect(decision !== null).toBe(handled);
	});

	it.each([
		['{"reason":"crashed","exitCode":-1}', true],
		['{"reason":"killed","exitCode":1073807364}', false],
		["not json", true],
	] as const)("retains marker %s: %s", async (text, retained) => {
		const marker = join(profile, "gpu-fallback.json");
		writeFileSync(marker, text);
		await start();
		expect(existsSync(marker)).toBe(retained);
	});
});
