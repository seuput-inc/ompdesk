/**
 * What the quit confirmation is built from: the guard must count live runs, the
 * tabs they sit on, and the distinct windows to name in the message, and it
 * must stay silent when nothing would stop: nothing in flight (otherwise ⌘Q
 * becomes a two-step quit for every idle window), or running work that the next
 * launch continues (Continue interrupted work on; ⌘Q and the update restart alike).
 */

import { describe, expect, it } from "vitest";
import { assessQuitRisk, quitNeedsConfirmation, updateRestartConfirmation, type WindowTabFact } from "./quit-guard";

function fact(windowId: number, tabId: string, inFlight: boolean): WindowTabFact {
	return { windowId, tabId, inFlight };
}

describe("quit guard risk assessment", () => {
	it("counts only the in-flight tabs and the windows that hold them", () => {
		expect(
			assessQuitRisk([fact(1, "a", true), fact(1, "b", false), fact(2, "c", true), fact(3, "d", false)]),
		).toEqual({ workingTabs: 2, totalTabs: 4, workingWindows: 2 });
	});

	it("names one window once even when several of its tabs are working", () => {
		expect(assessQuitRisk([fact(7, "a", true), fact(7, "b", true), fact(7, "c", true)]).workingWindows).toBe(1);
	});

	it("asks only while work is in flight and quitting would stop it", () => {
		const working = assessQuitRisk([fact(1, "a", true)]);
		// Continue interrupted work off: the quit really stops the run.
		expect(quitNeedsConfirmation(assessQuitRisk([]), false)).toBe(false);
		expect(quitNeedsConfirmation(assessQuitRisk([fact(1, "a", false)]), false)).toBe(false);
		expect(quitNeedsConfirmation(working, false)).toBe(true);
		// On (the default): the marker stays and the next launch continues the run, so nothing asks.
		expect(quitNeedsConfirmation(working, true)).toBe(false);
		expect(quitNeedsConfirmation(assessQuitRisk([]), true)).toBe(false);
	});
});

describe("an update restart a person starts", () => {
	const idle = assessQuitRisk([]);
	const working = assessQuitRisk([fact(1, "a", true)]);
	const none = { subagents: 0, jobs: 0, subagentLabels: [], jobLabels: [] };
	const subagents = { subagents: 2, jobs: 0, subagentLabels: ["LayoutSplit", "StreamFast"], jobLabels: [] };

	it("with Continue interrupted work on asks only when background subagents or jobs would start over", () => {
		expect(updateRestartConfirmation(working, true, none)).toBeNull();
		expect(updateRestartConfirmation(idle, true, none)).toBeNull();
		expect(updateRestartConfirmation(working, true, subagents)).toBe("background work");
		expect(updateRestartConfirmation(working, true, { ...none, jobs: 1, jobLabels: ["dev server"] })).toBe(
			"background work",
		);
	});

	it("with it off keeps the quit confirm for running turns, background work included", () => {
		expect(updateRestartConfirmation(working, false, subagents)).toBe("running work");
		expect(updateRestartConfirmation(working, false, none)).toBe("running work");
		expect(updateRestartConfirmation(idle, false, none)).toBeNull();
	});
});
