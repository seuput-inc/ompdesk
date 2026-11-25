import { describe, expect, it } from "vitest";
import { headParts, shownHead } from "./session-row-target";

const branch = (name: string) => shownHead(name, { kind: "branch", name });

describe("a row's branch on a short line", () => {
	it("keeps the last segment of two agent branches that differ only at their end", () => {
		expect(headParts(branch("omp/agent/settings-panel-light"))).toEqual({
			body: "…/settings-panel",
			tail: "-light",
			floor: "…/s…-light",
		});
		expect(headParts(branch("omp/agent/settings-panel-dark"))).toMatchObject({ tail: "-dark", floor: "…/s…-dark" });
	});

	it("cuts the end of a name whose last segment is a date stamp or too long to keep", () => {
		expect(headParts(branch("omp/agent/session-rows-ui-20261119"))).toEqual({
			body: "…/session-rows-ui-20261119",
			tail: "",
			floor: "…/sessio…",
		});
	});

	it("keeps a name of eight characters or fewer whole, with no floor", () => {
		expect(headParts(branch("release"))).toEqual({ body: "release", tail: "", floor: null });
	});
});
