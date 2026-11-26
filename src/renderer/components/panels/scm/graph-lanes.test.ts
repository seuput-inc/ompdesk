import { describe, expect, it } from "vitest";
import { graphLanes } from "./graph-lanes";

const c = (sha: string, ...parents: string[]) => ({ sha, parents });

describe("graphLanes", () => {
	it("keeps a linear history in one lane", () => {
		const rows = graphLanes([c("c", "b"), c("b", "a"), c("a")]);
		expect(rows.map(row => row.lane)).toEqual([0, 0, 0]);
		expect(rows[0]).toMatchObject({ into: [], through: [], out: [0], width: 1, merge: false });
		expect(rows[1]).toMatchObject({ into: [0], out: [0] });
		expect(rows[2]).toMatchObject({ into: [0], out: [] });
	});

	it("opens a lane for a merge's second parent and closes it where that parent is", () => {
		// m merges side s into main b; both come from a.
		const rows = graphLanes([c("m", "b", "s"), c("s", "a"), c("b", "a"), c("a")]);
		expect(rows[0]).toMatchObject({ lane: 0, out: [0, 1], width: 2, merge: true });
		expect(rows[1]).toMatchObject({ lane: 1, into: [1], through: [[0, 0]], out: [1] });
		expect(rows[2]).toMatchObject({ lane: 0, into: [0], through: [[1, 1]], out: [0] });
		// Both lanes waited for a: they meet in its dot.
		expect(rows[3]).toMatchObject({ lane: 0, into: [0, 1], through: [], out: [], width: 2 });
	});

	it("starts a second branch's tip in a new lane and joins the branches at their common parent", () => {
		const rows = graphLanes([c("x", "base"), c("y", "base"), c("base", "root")]);
		expect(rows[0]).toMatchObject({ lane: 0, into: [], out: [0] });
		expect(rows[1]).toMatchObject({ lane: 1, into: [], through: [[0, 0]], out: [1], width: 2 });
		expect(rows[2]).toMatchObject({ lane: 0, into: [0, 1], out: [0], width: 2 });
	});

	it("keeps a lane open to the page's end for a parent past the page", () => {
		const rows = graphLanes([c("b", "a"), c("side", "older")]);
		expect(rows[1]).toMatchObject({ lane: 1, through: [[0, 0]], out: [1], width: 2 });
		// The next page continues where this one stopped.
		const whole = graphLanes([c("b", "a"), c("side", "older"), c("a", "older"), c("older")]);
		expect(whole.slice(0, 2)).toEqual(rows);
		expect(whole[3]).toMatchObject({ lane: 0, into: [0, 1] });
	});
});
