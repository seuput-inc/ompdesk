import { describe, expect, it } from "vitest";
import { headParts, shownHead } from "./session-row-target";

const branch = (name: string) => shownHead(name, { kind: "branch", name });

describe("a row's branch on a short line", () => {
	it("keeps the last segment of two agent branches that differ only at their end", () => {
		const light = headParts(branch("omp/agent/settings-panel-light"));
		const dark = headParts(branch("omp/agent/settings-panel-dark"));
		expect(light).toMatchObject({ body: "…/settings-panel", tail: "-light" });
		expect(dark).toMatchObject({ body: "…/settings-panel", tail: "-dark" });
	});

	it("cuts the end of a name whose last segment is too long to keep", () => {
		expect(headParts(branch("omp/agent/sidebar-branchtruncationworks"))).toMatchObject({ tail: "" });
	});

	it("keeps a name of eight characters or fewer whole, with no floor", () => {
		expect(headParts(branch("release"))).toEqual({ body: "release", tail: "", floorCh: null });
	});

	it("counts Hangul wider in the floor", () => {
		const latin = headParts("Detached 9f3c2a1").floorCh ?? 0;
		const korean = headParts("분리됨 9f3c2a1b").floorCh ?? 0;
		expect(korean).toBeGreaterThan(latin);
	});
});
