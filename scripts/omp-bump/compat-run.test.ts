import { describe, expect, it } from "vitest";
import { type OmpCompatList, parseOmpCompat } from "../../src/shared/omp-compat";
import { applyVerdict, planTargets, releaseVersions, serializeCompat, type TargetsInput } from "./compat-run";

const APP = "0.134.1";
const OMP = "19.1.0";

/** An hourly scheduled run on main that finds `OMP` on npm and `APP` as the newest release. */
function hourly(list: OmpCompatList, patch: Partial<TargetsInput> = {}): TargetsInput {
	return {
		dispatch: false,
		daily: false,
		recheck: false,
		rehearseApp: "",
		onMain: true,
		latest: OMP,
		releases: ["v0.134.1", "v0.134.0", "v0.99.0"],
		list,
		...patch,
	};
}

const verified: OmpCompatList = { [APP]: { verified: [OMP], holding: null } };
const held: OmpCompatList = {
	[APP]: { verified: ["19.0.0"], holding: { version: OMP, since: "2026-11-20T05:00:00.000Z", issue: 7 } },
};

describe("releaseVersions", () => {
	it("orders release tags by version, not by text or by the order given, and drops every other tag", () => {
		expect(
			releaseVersions(["v0.99.0", "v0.134.1", "nightly", "v0.134.0", "v1.0.0-rc.1", "0.200.0", "v01.2.3"]),
		).toEqual(["0.99.0", "0.134.0", "0.134.1"]);
	});
});

describe("planTargets", () => {
	it("tests the newest release and main the hour an omp has no verdict for that release", () => {
		expect(planTargets(hourly({}))).toMatchObject({ app: APP, release: true, main: true, write: true });
		// Verified for an older release only: computers on the newest one have no verdict yet.
		expect(planTargets(hourly({ "0.134.0": { verified: [OMP], holding: null } }))).toMatchObject({
			app: APP,
			release: true,
			main: true,
		});
	});

	it("tests nothing in an hourly run once the omp is verified or held", () => {
		expect(planTargets(hourly(verified))).toMatchObject({ app: APP, release: false, main: false });
		expect(planTargets(hourly(held))).toMatchObject({ app: APP, release: false, main: false });
	});

	it("tests main on the daily slot, and a held omp again with it, but never a verified one", () => {
		expect(planTargets(hourly(verified, { daily: true }))).toMatchObject({ release: false, main: true });
		expect(planTargets(hourly(held, { daily: true }))).toMatchObject({ release: true, main: true });
		// Another omp is held, the newest one is verified: the daily slot has nothing to try again.
		const olderHeld: OmpCompatList = {
			[APP]: { verified: [OMP], holding: { version: "19.0.5", since: "2026-11-19T05:00:00.000Z", issue: null } },
		};
		expect(planTargets(hourly(olderHeld, { daily: true }))).toMatchObject({ release: false, main: true });
	});

	it("always tests main on a dispatch, and the release only when pending or asked to recheck", () => {
		expect(planTargets(hourly(verified, { dispatch: true }))).toMatchObject({ release: false, main: true });
		expect(planTargets(hourly(held, { dispatch: true }))).toMatchObject({ release: false, main: true });
		expect(planTargets(hourly({}, { dispatch: true }))).toMatchObject({ release: true, main: true });
		expect(planTargets(hourly(verified, { dispatch: true, recheck: true }))).toMatchObject({
			release: true,
			main: true,
			write: true,
		});
	});

	it("writes only from main", () => {
		expect(planTargets(hourly({}, { dispatch: true, onMain: false }))).toMatchObject({
			release: true,
			main: true,
			write: false,
		});
	});

	it("rehearses against the named release whatever the list says, and writes nothing even on main", () => {
		const input = hourly(verified, { dispatch: true, rehearseApp: "0.134.0" });
		expect(planTargets(input)).toMatchObject({ app: "0.134.0", release: true, main: true, write: false });
		expect(planTargets({ ...input, rehearseApp: APP })).toMatchObject({ app: APP, release: true, write: false });
	});

	it("refuses a rehearsal of a version that was never released, and an omp version it cannot name exactly", () => {
		expect(() => planTargets(hourly({}, { dispatch: true, rehearseApp: "0.1.0" }))).toThrow(/rehearse_app/);
		expect(() => planTargets(hourly({}, { dispatch: true, rehearseApp: "v0.134.1" }))).toThrow(/rehearse_app/);
		expect(() => planTargets(hourly({}, { latest: "" }))).toThrow(/latest/);
		expect(() => planTargets(hourly({}, { latest: "19.1.0-beta.1" }))).toThrow(/latest/);
	});

	it("has no release target while nothing is released", () => {
		expect(planTargets(hourly({}, { releases: [] }))).toMatchObject({ app: "", release: false, main: false });
		expect(planTargets(hourly({}, { releases: [], daily: true }))).toMatchObject({ release: false, main: true });
	});
});

describe("applyVerdict", () => {
	const green = { green: true } as const;
	const red = { green: false, at: "2026-11-20T05:00:00.000Z", issue: 7 } as const;

	it("starts the list when the branch has no file, as tab-indented JSON the app's reader takes", () => {
		const applied = applyVerdict(null, APP, OMP, green);
		expect(applied.text).toBe(
			'{\n\t"0.134.1": {\n\t\t"verified": [\n\t\t\t"19.1.0"\n\t\t],\n\t\t"holding": null\n\t}\n}\n',
		);
		expect(applied.changed).toBe(true);
		expect(parseOmpCompat(applied.text)).toEqual(verified);
	});

	it("changes nothing when the list already holds the verdict", () => {
		const first = applyVerdict(null, APP, OMP, red);
		expect(first.changed).toBe(true);
		// The daily retry failed again, hours later and without an issue of its own: the first failure's stays.
		const again = applyVerdict(first.text, APP, OMP, { green: false, at: "2026-11-21T04:47:00.000Z", issue: null });
		expect(again.changed).toBe(false);
		expect(again.text).toBe(first.text);
	});

	it("names the issue of the hold a green verdict lifts, for the same omp or a newer one", () => {
		const holding = applyVerdict(null, APP, OMP, red);
		expect(holding.releasedIssue).toBeNull();
		expect(parseOmpCompat(holding.text)?.[APP]?.holding).toEqual({ version: OMP, since: red.at, issue: 7 });
		expect(applyVerdict(holding.text, APP, OMP, green)).toMatchObject({ changed: true, releasedIssue: 7 });
		expect(applyVerdict(holding.text, APP, "19.1.1", green)).toMatchObject({ changed: true, releasedIssue: 7 });
		// Verifying an older omp leaves the newer one held, and its issue open.
		const older = applyVerdict(holding.text, APP, "19.0.9", green);
		expect(older.releasedIssue).toBeNull();
		expect(older.list[APP]?.holding?.version).toBe(OMP);
	});

	it("keeps every other release's entry", () => {
		const other = applyVerdict(null, "0.134.0", "19.0.0", green);
		const both = applyVerdict(other.text, APP, OMP, green);
		expect(parseOmpCompat(both.text)).toEqual({
			"0.134.0": { verified: ["19.0.0"], holding: null },
			[APP]: { verified: [OMP], holding: null },
		});
	});

	it("refuses a file that is not the list instead of writing over it", () => {
		expect(() => applyVerdict('{"0.134.1": {"verified": ["^19.0.0"]}}', APP, OMP, green)).toThrow(
			/not a verified-omp list/,
		);
		expect(() => applyVerdict("", APP, OMP, green)).toThrow(/not a verified-omp list/);
	});
});

describe("serializeCompat", () => {
	it("refuses a list the app's strict reader would not read back as written", () => {
		expect(() => serializeCompat({ [APP]: { verified: ["19.x"], holding: null } })).toThrow(/refusing to write/);
		expect(() =>
			serializeCompat({ [APP]: { verified: [OMP], holding: { version: OMP, since: "yesterday", issue: 7 } } }),
		).toThrow(/refusing to write/);
		expect(() => serializeCompat({ latest: { verified: [OMP], holding: null } })).toThrow(/refusing to write/);
	});
});
