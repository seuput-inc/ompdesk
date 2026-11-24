import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { stopCore } from "../core/process";
import { CHECK_INTERVAL_MS } from "../update-scheduler";
import { ToolsClient } from "./client";

const userData = mkdtempSync(join(tmpdir(), "ompdesk-tools-client-"));

afterAll(() => {
	stopCore();
	rmSync(userData, { recursive: true, force: true });
});

const asks = {
	env: () => ({}),
	refreshPath: async () => {},
	refreshOmp: async () => null,
	ompReady: () => {},
	firstTab: async () => {},
	releaseHelpers: async () => {},
	resume: async () => {},
	applyExtensionUpdate: () => {},
	restartWaiting: () => {},
	notify: () => {},
	stock: async () => null,
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
			},
			asks,
			onState: () => {},
		});
		try {
			const state = client.state();
			expect(state.setup).toEqual({
				platform: "darwin",
				automatic: false,
				ompReady: false,
				requiredRunning: false,
				items: [],
			});
			expect(state.omp).toMatchObject({ enabled: true, scheduled: true, phase: "idle", held: null });
			expect(state.cli).toEqual({ enabled: true, scheduled: false, tools: [] });
			expect(client.start()).toBe(true);
			// The launch tick's pass ran on the queue (ending at once, it armed no bound); then the 4 h timer was armed.
			await until(() => armed().length === 1);
			expect(armed()).toEqual([CHECK_INTERVAL_MS]);
			expect(vi.getTimerCount()).toBe(1);
			// The timer fires in the core: the next tick runs its pass and arms the next 4 h.
			await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
			await until(() => armed().length === 2);
			expect(armed()).toEqual([CHECK_INTERVAL_MS, CHECK_INTERVAL_MS]);
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
