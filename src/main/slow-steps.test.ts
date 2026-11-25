import { describe, expect, it } from "vitest";
import { SLOW_LINES_PER_HOUR, SLOW_REPEAT_MS, SLOW_STEP_MS, SLOW_SYNC_MS, SlowSteps } from "./slow-steps";

function probe() {
	const clock = { now: 0 };
	const lines: Array<{ message: string; details: Record<string, string | number | boolean> }> = [];
	const steps = new SlowSteps({ now: () => clock.now, log: (message, details) => lines.push({ message, details }) });
	return { clock, lines, steps };
}

describe("slow steps", () => {
	it("writes a step at its bound with its name and ms, and nothing for a faster one", () => {
		const { lines, steps } = probe();
		steps.took("stock", "sessions.list", SLOW_STEP_MS.stock - 1);
		steps.took("tab-open", "start", SLOW_STEP_MS["tab-open"] - 1, { lane: "t1" });
		expect(lines).toEqual([]);

		steps.took("stock", "sessions.list", 1_499.6);
		steps.took("tab-open", "start", 7_000, { lane: "t1", stages: "resolved 40ms > spawned 900ms > ready 7000ms" });
		expect(lines).toEqual([
			{
				message: "stock sessions.list took 1500 ms",
				details: { kind: "stock", name: "sessions.list", ms: 1500 },
			},
			{
				message: "tab-open start took 7000 ms",
				details: {
					kind: "tab-open",
					name: "start",
					ms: 7000,
					lane: "t1",
					stages: "resolved 40ms > spawned 900ms > ready 7000ms",
				},
			},
		]);
	});

	it("writes one step once in ten minutes and counts the times between on its next line", () => {
		const { clock, lines, steps } = probe();
		steps.took("stock", "sessions.list", 1_200);
		clock.now += 60_000;
		steps.took("stock", "sessions.list", 4_000);
		steps.took("stock", "sessions.list", 2_000);
		steps.took("stock", "history.read", 1_100);
		expect(lines.map(line => line.details.name)).toEqual(["sessions.list", "history.read"]);

		clock.now += SLOW_REPEAT_MS;
		steps.took("stock", "sessions.list", 1_300);
		expect(lines.at(-1)?.details).toEqual({
			kind: "stock",
			name: "sessions.list",
			ms: 1300,
			again: 2,
			worstMs: 4000,
		});
	});

	it("takes a handler that held main's thread for slow whatever its answer took", () => {
		const { lines, steps } = probe();
		steps.ipc("sessions:list", 50, SLOW_SYNC_MS - 1);
		expect(lines).toEqual([]);
		steps.ipc("git:status", 150, 120);
		steps.ipc("sessions:dump-bundle", 2_500, 3);
		expect(lines.map(line => line.details)).toEqual([
			{ kind: "ipc", name: "git:status", ms: 150, syncMs: 120 },
			{ kind: "ipc", name: "sessions:dump-bundle", ms: 2500, syncMs: 3 },
		]);
	});

	it("names what held the thread when main's loop was blocked, once", () => {
		const { lines, steps } = probe();
		steps.hub("resumeFacts", 340);
		steps.ipc("tabs:acquire", 30, 25);
		steps.ipc("prefs:get", 4, 3);
		steps.loop(410, 12.4);
		expect(lines.map(line => line.details)).toEqual([
			{ kind: "hub", name: "resumeFacts", ms: 340 },
			{
				kind: "loop",
				name: "hub resumeFacts",
				ms: 410,
				cpuMs: 12,
				during: "hub resumeFacts 340ms, ipc tabs:acquire 25ms",
			},
		]);

		steps.loop(650, 600);
		expect(lines.at(-1)?.details).toEqual({ kind: "loop", name: "unknown", ms: 650, cpuMs: 600 });
	});

	it("writes nothing for a loop that kept up, nor for a gap the size of a sleep", () => {
		const { lines, steps } = probe();
		steps.loop(SLOW_STEP_MS.loop - 1, 0);
		steps.loop(8 * 60 * 60_000, 0);
		expect(lines).toEqual([]);
	});

	it("keeps to the hour's lines and says how many it left out", () => {
		const { clock, lines, steps } = probe();
		for (let index = 0; index < SLOW_LINES_PER_HOUR + 3; index++) steps.took("stock", `method-${index}`, 2_000);
		expect(lines).toHaveLength(SLOW_LINES_PER_HOUR);

		clock.now += 60 * 60_000;
		steps.took("stock", "method-0", 2_000);
		expect(lines).toHaveLength(SLOW_LINES_PER_HOUR + 1);
		expect(lines.at(-1)?.details.dropped).toBe(3);
	});
});
