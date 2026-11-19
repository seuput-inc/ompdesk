import { describe, expect, it } from "vitest";
import { compatEntry, compatPending, followTarget, parseOmpCompat, recordVerdict } from "./omp-compat";

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

	it.each([
		["not JSON", "<html>rate limited</html>"],
		["an array", "[]"],
		["a range", JSON.stringify({ "0.134.1": { verified: ["^19.0.0"], holding: null } })],
		["a dist-tag", JSON.stringify({ "0.134.1": { verified: ["latest"], holding: null } })],
		["a URL", JSON.stringify({ "0.134.1": { verified: ["https://evil.example/omp.tgz"], holding: null } })],
		["a package spec", JSON.stringify({ "0.134.1": { verified: ["@evil/omp@19.0.0"], holding: null } })],
		["a prerelease", JSON.stringify({ "0.134.1": { verified: ["19.0.0-canary.1"], holding: null } })],
		["a leading v", JSON.stringify({ "0.134.1": { verified: ["v19.0.0"], holding: null } })],
		["a leading zero", JSON.stringify({ "0.134.1": { verified: ["19.01.0"], holding: null } })],
		["an extra field", JSON.stringify({ "0.134.1": { verified: [], holding: null, package: "@evil/omp" } })],
		["an app key that is no version", JSON.stringify({ latest: { verified: [], holding: null } })],
		["a __proto__ key", '{"__proto__": {"verified": [], "holding": null}}'],
		[
			"a held range",
			JSON.stringify({
				"0.134.1": { verified: [], holding: { version: "19.x", since: "2026-11-20", issue: null } },
			}),
		],
		[
			"a held version without a time",
			JSON.stringify({ "0.134.1": { verified: [], holding: { version: "19.1.0", since: "soon", issue: null } } }),
		],
		[
			"an issue that is no number",
			JSON.stringify({
				"0.134.1": { verified: [], holding: { version: "19.1.0", since: "2026-11-20", issue: "12" } },
			}),
		],
	])("refuses the whole list for %s, so the reader keeps its last good one", (_name, text) => {
		expect(parseOmpCompat(text)).toBeNull();
	});
});

describe("followTarget: what a pass nobody asked for installs", () => {
	it("is the newest verified or tested omp above the installed one and not above the registry's newest", () => {
		expect(followTarget({ installed: "18.22.0", latest: "19.1.0", tested: "18.22.2", verified: ["19.0.0"] })).toBe(
			"19.0.0",
		);
		expect(followTarget({ installed: "18.22.0", latest: "19.1.0", tested: "18.22.2", verified: [] })).toBe("18.22.2");
		// The registry this omp updates from does not offer it yet.
		expect(followTarget({ installed: "18.22.0", latest: "19.0.0", tested: "18.22.2", verified: ["19.1.0"] })).toBe(
			"18.22.2",
		);
	});

	it("never steps down and never names anything but an exact release", () => {
		expect(
			followTarget({ installed: "19.1.0", latest: "19.1.0", tested: "18.22.2", verified: ["19.0.0"] }),
		).toBeNull();
		expect(
			followTarget({ installed: "18.0.0", latest: "19.1.0", tested: "x", verified: ["19.1.0-rc.1"] }),
		).toBeNull();
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
