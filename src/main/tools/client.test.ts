import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { stopCore } from "../core/process";
import { ToolsClient } from "./client";

/** Between scheduled checks while all is well (`CHECK_INTERVAL_MS` of `tools/mod.rs`). */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

const userData = mkdtempSync(join(tmpdir(), "ompdesk-tools-client-"));

afterAll(() => {
	stopCore();
	rmSync(userData, { recursive: true, force: true });
});

const asks = {
	env: () => ({}),
	refreshPath: async () => {},
	ompResolution: async () => ({
		ok: false as const,
		error: "omp was not found",
		reason: { kind: "not-found" as const },
	}),
	ompReady: () => {},
	firstTab: async () => {},
	releaseHelpers: async () => {},
	resume: async () => {},
	applyExtensionUpdate: () => {},
	notify: () => {},
	stock: async () => null,
	workspaceDirs: () => [],
};

/** Lets the core's items reach main (the hub's worker pings on a turn of the event loop) until `done` holds. */
async function until(done: () => boolean): Promise<void> {
	for (let turn = 0; turn < 2_000 && !done(); turn += 1) await new Promise<void>(next => setImmediate(next));
	expect(done()).toBe(true);
}

describe("ToolsClient against the real core", () => {
	it("reads the state at once, and main's fake timers drive the core's schedule", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const timers = vi.spyOn(globalThis, "setTimeout");
		const armed = () => timers.mock.calls.map(([, ms]) => ms);
		// The 4 h check timers (setup's first detection also arms its step's bound while it runs).
		const checks = () => armed().filter(ms => ms === CHECK_INTERVAL_MS);
		const client = new ToolsClient({
			opts: {
				platform: "darwin",
				arch: "arm64",
				toolsDir: join(userData, "tools"),
				userData,
				appVersion: "0.0.0",
				testedOmp: "18.22.2",
				automatic: false,
				scheduled: { omp: true, cli: false, ext: false },
				manual: true,
				bunInstall: join(userData, "bun"),
			},
			asks,
			onState: () => {},
		});
		try {
			const state = client.state();
			expect(state.setup).toMatchObject({
				platform: "darwin",
				automatic: false,
				ompReady: false,
				requiredRunning: false,
			});
			expect(state.setup.items.map(item => [item.id, item.phase])).toEqual(
				["bun", "git", "omp", "gh", "node", "agent-desktop", "tailscale"].map(id => [id, "checking"]),
			);
			expect(state.omp).toMatchObject({ enabled: true, scheduled: true, phase: "idle", held: null });
			expect(state.cli).toEqual({ enabled: true, scheduled: false, tools: [] });
			expect(client.start()).toBe(true);
			// Setup's first pass (a detection on this machine), then the launch tick's pass; then the 4 h timer was armed.
			await until(() => checks().length === 1);
			await until(() => vi.getTimerCount() === 1);
			expect(client.state().setup.items.every(item => item.phase !== "checking")).toBe(true);
			// The timer fires in the core: the next tick runs its pass and arms the next 4 h.
			await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
			await until(() => checks().length === 2);
			expect(checks()).toEqual([CHECK_INTERVAL_MS, CHECK_INTERVAL_MS]);
			expect(vi.getTimerCount()).toBe(1);
			client.close();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			client.close();
			timers.mockRestore();
			vi.useRealTimers();
		}
	});
});
