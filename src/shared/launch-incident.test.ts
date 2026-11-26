import { describe, expect, it } from "vitest";
import { launchIncidentOf, parseLaunchIncident } from "./launch-incident";

describe("launchIncidentOf", () => {
	const hang = {
		source: "main-thread-hang",
		message: "Main thread stalled for 12s and never recovered",
		details: { detectedAt: "2026-11-26T01:02:03.000Z", phase: "running", steps: "a > b", unresponsiveMs: 12000 },
	};

	it("offers the watchdog's hang with its steps, before safe mode", () => {
		const incident = launchIncidentOf([{ source: "machine-state", message: "hang during" }, hang], true, 5);
		expect(incident).toMatchObject({ kind: "hang", at: Date.parse("2026-11-26T01:02:03.000Z") });
		expect(incident?.detail).toContain("Main thread stalled for 12s");
		expect(incident?.detail).toContain("steps: a > b");
	});

	it("offers safe mode alone, and nothing after a clean launch", () => {
		expect(launchIncidentOf([], true, 5)).toMatchObject({ kind: "unstable", at: 5 });
		expect(launchIncidentOf([{ source: "machine-state", message: "x" }], false, 5)).toBeNull();
	});

	it("reads back only a well-formed incident", () => {
		const incident = launchIncidentOf([hang], false, 5);
		expect(parseLaunchIncident(JSON.parse(JSON.stringify(incident)))).toEqual(incident);
		expect(parseLaunchIncident(null)).toBeNull();
		expect(parseLaunchIncident({ kind: "crash", at: 1, detail: "x" })).toBeNull();
	});
});
