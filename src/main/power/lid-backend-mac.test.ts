import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacLidBackend, RESPAWN_MS } from "./lid-backend-mac";

describe("caffeinate that ends while the lid is held", () => {
	let exits: Array<() => void>;
	let stopped: number;
	let backend: MacLidBackend;
	beforeEach(() => {
		vi.useFakeTimers();
		exits = [];
		stopped = 0;
		backend = new MacLidBackend({
			caffeinate: onExit => {
				exits.push(onExit);
				return {
					stop: () => {
						stopped++;
						onExit();
					},
				};
			},
			batteryReport: async () => "",
		});
	});
	afterEach(() => vi.useRealTimers());

	it("starts again on a doubling delay and stops for good once released", async () => {
		await backend.hold();
		exits[0]?.();
		await vi.advanceTimersByTimeAsync(RESPAWN_MS - 1);
		expect(exits).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(exits).toHaveLength(2);

		exits[1]?.();
		await vi.advanceTimersByTimeAsync(RESPAWN_MS);
		expect(exits).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(RESPAWN_MS);
		expect(exits).toHaveLength(3);

		await backend.hold();
		expect(exits).toHaveLength(3);
		await backend.release();
		expect(stopped).toBe(1);
		await vi.advanceTimersByTimeAsync(16 * RESPAWN_MS);
		expect(exits).toHaveLength(3);
	});

	it("a release while a restart waits starts nothing", async () => {
		await backend.hold();
		exits[0]?.();
		await backend.release();
		await vi.advanceTimersByTimeAsync(16 * RESPAWN_MS);
		expect(exits).toHaveLength(1);
	});
});
