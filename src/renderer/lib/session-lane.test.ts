import { describe, expect, it } from "vitest";
import { type LaneFacts, laneState } from "./session-lane";

const quiet: LaneFacts = {
	run: { ask: undefined, failed: false, done: false, down: false, signal: null },
	attention: undefined,
	live: null,
	stopped: false,
	pullRequest: false,
	open: false,
};

const facts = (patch: Partial<LaneFacts>, run: Partial<LaneFacts["run"]> = {}): LaneFacts => ({
	...quiet,
	...patch,
	run: { ...quiet.run, ...run },
});

describe("the status lane's one rank", () => {
	it("puts what needs the person first, then a failure, then work, and keeps a stop apart from a finish", () => {
		const everything = facts(
			{ attention: "childWaiting", live: "turn", stopped: true, pullRequest: true, open: true },
			{ ask: "approval", failed: true, done: true, down: true },
		);
		expect(laneState(everything)).toBe("approval");
		expect(laneState(facts({ ...everything, attention: "childWaiting" }, { failed: true, done: true }))).toBe(
			"childWaiting",
		);
		expect(laneState(facts({ live: "turn" }, { failed: true }))).toBe("failed");
		expect(laneState(facts({ live: "background", stopped: true }, { done: true }))).toBe("background");
		expect(laneState(facts({ stopped: true }, { done: true, down: true }))).toBe("pending");
		expect(laneState(facts({ stopped: true, pullRequest: true }, { done: true }))).toBe("interrupted");
		expect(laneState(facts({ pullRequest: true, open: true }, { done: true }))).toBe("done");
		expect(laneState(facts({ pullRequest: true, open: true }))).toBe("pr");
		expect(laneState(facts({ open: true }))).toBe("open");
		expect(laneState(quiet)).toBe("none");
	});

	it("reads a turn waiting for the network as not up yet", () => {
		const signal = { active: true, color: "", labelKey: "titlebar.status.connectionWait", running: false };
		expect(laneState(facts({}, { signal }))).toBe("pending");
	});
});
