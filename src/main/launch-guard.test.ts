import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LaunchStart } from "./gpu-fallback";
import { prepareShellPolicyFixture, type ShellPolicyFixture, shellPolicyFixture } from "./shell-policy-test-rig";

let dir: string;
let fixture: ShellPolicyFixture;

function start(profile: string, now: number): Promise<LaunchStart> {
	return fixture.call("launch.start", { profile, now, guard: true, enableGpu: false, disableGpu: false });
}

beforeAll(prepareShellPolicyFixture, 180_000);
beforeEach(async () => {
	fixture = await shellPolicyFixture();
	dir = mkdtempSync(join(tmpdir(), "launch-guard-"));
});

afterEach(async () => {
	await fixture.close();
	rmSync(dir, { recursive: true, force: true });
});

const SECOND = 1000;

describe("crash-loop guard", () => {
	it("starts in safe mode after three launches in a row ended before they became stable", async () => {
		const t0 = 1_800_000_000_000;
		expect((await start(dir, t0)).safeMode).toBe(false);
		expect((await start(dir, t0 + 5 * SECOND)).safeMode).toBe(false);
		expect((await start(dir, t0 + 10 * SECOND)).safeMode).toBe(false);
		expect((await start(dir, t0 + 15 * SECOND)).safeMode).toBe(true);
	});

	it("a safe-mode launch that stays up ends safe mode for the next one", async () => {
		const t0 = 1_800_000_000_000;
		for (let i = 0; i < 3; i++) await start(dir, t0 + i * SECOND);
		expect((await start(dir, t0 + 3 * SECOND)).safeMode).toBe(true);
		await fixture.call("launch.event", { op: "stable", args: {} });
		expect((await start(dir, t0 + 60 * SECOND)).safeMode).toBe(false);
	});

	it("a stable or cleanly quit launch among them is no loop", async () => {
		const t0 = 1_800_000_000_000;
		await start(dir, t0);
		await start(dir, t0 + SECOND);
		await fixture.call("launch.event", { op: "stable", args: {} });
		await start(dir, t0 + 2 * SECOND);
		expect((await start(dir, t0 + 3 * SECOND)).safeMode).toBe(false);
	});

	it("launches that ended long ago are no loop", async () => {
		const t0 = 1_800_000_000_000;
		for (let i = 0; i < 3; i++) await start(dir, t0 + i * SECOND);
		expect((await start(dir, t0 + 2 * SECOND + 600_000 + SECOND)).safeMode).toBe(false);
	});

	it("an unreadable history never blocks a start", async () => {
		writeFileSync(join(dir, "launch-history.json"), "{not json");
		expect((await start(dir, 1_800_000_000_000)).safeMode).toBe(false);
		expect((await start(join(dir, "missing", "deeper"), 1_800_000_000_000)).safeMode).toBe(false);
	});
});
