import { describe, expect, it } from "vitest";
import { closeTerminal, NO_PANES, pickTerminal, splitTerminal, unsplit } from "./terminal-panes";

describe("terminal panes", () => {
	it("a pick focuses a terminal already shown and otherwise puts it in the pane in focus", () => {
		const one = pickTerminal(NO_PANES, "a");
		expect(one).toMatchObject({ panes: ["a"], focus: 0 });
		const split = splitTerminal(one, "b", "down");
		expect(split).toEqual({ panes: ["a", "b"], focus: 1, direction: "down" });
		expect(pickTerminal(split, "a")).toMatchObject({ panes: ["a", "b"], focus: 0 });
		expect(pickTerminal(split, "c")).toMatchObject({ panes: ["a", "c"], focus: 1 });
		expect(unsplit(pickTerminal(split, "a"))).toMatchObject({ panes: ["a"], focus: 0 });
	});
	it("a closed pane's terminal gives the panel to the other pane, or to the terminal that took its tab's place", () => {
		const split = splitTerminal(pickTerminal(NO_PANES, "a"), "b", "right");
		expect(closeTerminal(split, "b", ["a", "c"], "c")).toMatchObject({ panes: ["a"], focus: 0 });
		expect(closeTerminal(pickTerminal(NO_PANES, "a"), "a", ["c"], "c")).toMatchObject({ panes: ["c"] });
		expect(closeTerminal(pickTerminal(NO_PANES, "a"), "a", [], null)).toEqual(NO_PANES);
		// A terminal no pane shows leaves the panes as they are.
		expect(closeTerminal(split, "z", ["a", "b"], "a")).toBe(split);
	});
});
