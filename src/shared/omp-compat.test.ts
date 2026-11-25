import { describe, expect, it } from "vitest";
import { compatEntry, compatPending, followTarget, parseOmpCompat, recordVerdict } from "./omp-compat";
// The cases the core's reader (native/ompdesk/crates/core/src/tools/omp/compat.rs) is pinned to as well.
import vectors from "./omp-compat-vectors.json";

const GOOD = {
	"0.134.1": {
		verified: ["18.22.2", "19.0.0"],
		holding: { version: "19.1.0", since: "2026-11-20T01:00:00.000Z", issue: 12 },
	},
	"0.135.0": { verified: [], holding: null },
};

describe("parseOmpCompat: the app reads the list strictly", () => {
	it("reads the workflow's own file", () => {
		const list = parseOmpCompat(JSON.stringify(GOOD));
		expect(list && compatEntry(list, "0.134.1")).toEqual(GOOD["0.134.1"]);
		expect(list && compatEntry(list, "0.136.0")).toEqual({ verified: [], holding: null });
	});

	it.each(vectors.read)("reads $app's entry of a good list", ({ text, app, entry }) => {
		const list = parseOmpCompat(text);
		if (!list) throw new Error("refused");
		const { verified, holding } = compatEntry(list, app);
		expect({ verified, holding: holding && { version: holding.version, since: holding.since } }).toEqual(entry);
	});

	it.each(vectors.refused)("refuses the whole list for %s, so the reader keeps its last good one", (_name, text) => {
		expect(parseOmpCompat(text)).toBeNull();
	});
});

describe("followTarget: what a pass nobody asked for installs", () => {
	// The newest verified or tested omp above the installed one and not above the registry's newest; never a step
	// down, never anything but an exact release.
	it.each(vectors.follow)("$installed → $target (latest $latest, verified $verified)", ({ target, ...input }) => {
		expect(followTarget(input)).toBe(target);
	});
});

describe("recordVerdict: what a run writes", () => {
	it("a green run verifies the version and lets go of a hold on it or anything older", () => {
		const list = parseOmpCompat(JSON.stringify(GOOD));
		if (!list) throw new Error("unreadable");
		const after = recordVerdict(list, "0.134.1", "19.1.0", { green: true });
		expect(after["0.134.1"]).toEqual({ verified: ["18.22.2", "19.0.0", "19.1.0"], holding: null });
		// A newer hold stays when an older version turns green.
		const older = recordVerdict(list, "0.134.1", "19.0.1", { green: true });
		expect(older["0.134.1"].holding?.version).toBe("19.1.0");
		expect(parseOmpCompat(JSON.stringify(after))).toEqual(after);
	});

	it("a red run holds the version, keeps the first failure's time and issue, and takes it off the verified list", () => {
		const first = recordVerdict(Object.create(null), "0.135.0", "19.1.0", {
			green: false,
			at: "2026-11-20T02:00:00.000Z",
			issue: 7,
		});
		expect(first["0.135.0"]).toEqual({
			verified: [],
			holding: { version: "19.1.0", since: "2026-11-20T02:00:00.000Z", issue: 7 },
		});
		expect(compatPending(first, "0.135.0", "19.1.0")).toBe(false);
		const again = recordVerdict(first, "0.135.0", "19.1.0", {
			green: false,
			at: "2026-11-21T02:00:00.000Z",
			issue: null,
		});
		expect(again["0.135.0"].holding).toEqual({ version: "19.1.0", since: "2026-11-20T02:00:00.000Z", issue: 7 });
		const flipped = recordVerdict(recordVerdict(first, "0.135.0", "19.1.0", { green: true }), "0.135.0", "19.1.0", {
			green: false,
			at: "2026-11-22T00:00:00.000Z",
			issue: 9,
		});
		expect(flipped["0.135.0"].verified).toEqual([]);
	});

	it("refuses to write anything but exact versions", () => {
		expect(() => recordVerdict(Object.create(null), "0.135.0", "latest", { green: true })).toThrow();
	});
});
