import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeHangMarker, type HangMarker } from "./hang-watchdog-core";

describe("hang marker", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hang-marker-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const marker: HangMarker = { detectedAt: 1_700_000_000_000, pid: 4242, unresponsiveMs: 6_100, selfRecovered: false };

	it("round-trips and is removed once consumed", () => {
		const file = join(dir, "main-thread-hang.json");
		writeFileSync(file, JSON.stringify(marker));
		expect(consumeHangMarker(file)).toEqual(marker);
		expect(() => readFileSync(file)).toThrow();
		expect(consumeHangMarker(file)).toBeNull();
	});

	it("reads a rewritten marker as recovered", () => {
		const file = join(dir, "m.json");
		writeFileSync(file, JSON.stringify(marker));
		writeFileSync(file, JSON.stringify({ ...marker, unresponsiveMs: 9_000, selfRecovered: true }));
		expect(consumeHangMarker(file)).toMatchObject({ unresponsiveMs: 9_000, selfRecovered: true });
	});

	it("keeps the machine sample, primitives only", () => {
		const file = join(dir, "m.json");
		const machine = { availMB: 512, cpuBusyPct: 99.5 };
		writeFileSync(file, JSON.stringify({ ...marker, machine: { ...machine, nested: { a: 1 }, list: [1] } }));
		expect(consumeHangMarker(file)).toEqual({ ...marker, machine });
	});

	it("drops a corrupt or invalid marker without throwing", () => {
		const file = join(dir, "m.json");
		writeFileSync(file, "{not json");
		expect(consumeHangMarker(file)).toBeNull();
		writeFileSync(file, JSON.stringify({ detectedAt: 1, pid: -3, unresponsiveMs: 5 }));
		expect(consumeHangMarker(file)).toBeNull();
	});
});

describe("hang marker compatibility", () => {
	it("carries phase and steps through the marker, and reads an older marker without them", () => {
		const dir = mkdtempSync(join(tmpdir(), "hang-steps-"));
		try {
			const file = join(dir, "m.json");
			const withSteps: HangMarker = {
				detectedAt: 1,
				pid: 7,
				unresponsiveMs: 5_300,
				selfRecovered: true,
				phase: "quit",
				steps: ["update:quit-and-install", "quit:teardown:sidecars"],
			};
			writeFileSync(file, JSON.stringify(withSteps));
			expect(consumeHangMarker(file)).toEqual(withSteps);
			writeFileSync(file, JSON.stringify({ detectedAt: 1, pid: 7, unresponsiveMs: 5_300, selfRecovered: true }));
			expect(consumeHangMarker(file)).toEqual({ detectedAt: 1, pid: 7, unresponsiveMs: 5_300, selfRecovered: true });
			writeFileSync(file, JSON.stringify({ ...withSteps, phase: "nonsense", steps: [1, 2] }));
			expect(consumeHangMarker(file)).toEqual({ detectedAt: 1, pid: 7, unresponsiveMs: 5_300, selfRecovered: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
