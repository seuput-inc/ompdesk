/**
 * The hub's four cases for taking stock `update.auto` over and giving it back (docs/design/follow-omp.md, review
 * point 6 a): the round trip, a person's change in between, a value that was off already, and no config file at all.
 * Stock is a fake holding one value; the record lives in a temp file so a relaunch reads what the last launch took.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OmpAutoTakeover, takeoverStep } from "./omp-auto-takeover";

/** Stock's settings: `value` undefined stands for no config file (stock's default, off). */
function world(initial: boolean | undefined, enabled = true) {
	const stock = { value: initial, writes: [] as boolean[] };
	const sw = { enabled };
	const logs: string[] = [];
	const file = join(mkdtempSync(join(tmpdir(), "omp-auto-takeover-")), "omp-auto-takeover.json");
	const make = () =>
		new OmpAutoTakeover({
			enabled: () => sw.enabled,
			read: async () => stock.value ?? false,
			write: async value => {
				stock.writes.push(value);
				stock.value = value;
			},
			file,
			app: "0.135.0",
			log: step => logs.push(step),
			onChanged: () => {},
			now: () => Date.parse("2026-11-20T04:00:00.000Z"),
		});
	return { stock, sw, logs, file, make };
}

describe("OmpAutoTakeover", () => {
	it("round trip: takes an on value once, records it, and gives it back when the switch goes off", async () => {
		const w = world(true);
		const takeover = w.make();
		await takeover.sync();
		expect(w.stock).toMatchObject({ value: false, writes: [false] });
		expect(takeover.taken()).toBe(true);
		expect(JSON.parse(readFileSync(w.file, "utf8"))).toEqual({
			record: { state: "taken", before: true, wrote: false, at: "2026-11-20T04:00:00.000Z", by: "OMPdesk 0.135.0" },
		});
		// A relaunch reads the record and takes nothing twice.
		const relaunched = w.make();
		await relaunched.sync();
		expect(w.stock.writes).toEqual([false]);
		w.sw.enabled = false;
		await relaunched.sync();
		expect(w.stock).toMatchObject({ value: true, writes: [false, true] });
		expect(relaunched.taken()).toBe(false);
		expect(w.logs).toEqual(["stock-auto-taken", "stock-auto-given-back"]);
	});

	it("a person's change in between wins: nothing is written over it while the switch stays on, nor when it goes off", async () => {
		const w = world(true);
		const takeover = w.make();
		await takeover.sync();
		// They turned omp's own update back on in its settings while the switch was on.
		w.stock.value = true;
		await takeover.sync();
		expect(w.stock.writes).toEqual([false]);
		expect(takeover.taken()).toBe(false);
		// Taken once only: OMPdesk does not fight them for it, not even after a relaunch.
		await w.make().sync();
		w.sw.enabled = false;
		await takeover.sync();
		expect(w.stock).toMatchObject({ value: true, writes: [false] });
		expect(w.logs).toEqual(["stock-auto-taken", "stock-auto-let-go"]);
		// Turning the switch on again later is a fresh start.
		w.sw.enabled = true;
		await takeover.sync();
		expect(w.stock).toMatchObject({ value: false, writes: [false, false] });
	});

	it("leaves a value that was off already alone, both ways, and records nothing", async () => {
		const w = world(false);
		const takeover = w.make();
		await takeover.sync();
		w.sw.enabled = false;
		await takeover.sync();
		expect(w.stock.writes).toEqual([]);
		expect(takeover.taken()).toBe(false);
		expect(w.logs).toEqual([]);
	});

	it("leaves a computer with no config file alone (stock's default is off)", async () => {
		const w = world(undefined);
		await w.make().sync();
		expect(w.stock).toMatchObject({ value: undefined, writes: [] });
	});

	it("does nothing while stock cannot say its value, and logs a write stock refused", async () => {
		expect(takeoverStep(true, null, null)).toEqual({ kind: "none" });
		const w = world(true);
		const logs: string[] = [];
		const takeover = new OmpAutoTakeover({
			enabled: () => true,
			read: async () => true,
			write: async () => {
				throw new Error("written, but OMP_UPDATE_AUTO overrides it");
			},
			file: w.file,
			app: "0.135.0",
			log: step => logs.push(step),
			onChanged: () => {},
		});
		await takeover.sync();
		expect(takeover.taken()).toBe(false);
		expect(logs).toEqual(["stock-auto-failed"]);
	});
});
