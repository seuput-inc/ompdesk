import { describe, expect, it } from "vitest";
import type { Touchpoint } from "../omp-boundary/touchpoints";
import { type JobSummary, jobResults, planBump, renderReport, summarize, type VitestReport } from "./latest-run";

const base = {
	latest: "18.23.0",
	fileTested: "18.22.0",
	pretendTested: "",
	onMain: true,
	runs: true,
	branchExists: false,
};

describe("planBump", () => {
	it("takes the bump path on main when npm's omp is newer, comparing numbers, not text", () => {
		expect(planBump(base)).toEqual({
			latest: "18.23.0",
			tested: "18.22.0",
			bump: true,
			fresh: true,
			branch: "omp/bump/18.23.0",
		});
		expect(planBump({ ...base, latest: "18.100.0" }).bump).toBe(true);
		expect(planBump({ ...base, latest: "18.3.0" }).bump).toBe(false);
	});

	it("behaves as before when the latest is the tested omp", () => {
		expect(planBump({ ...base, latest: "18.22.0" })).toMatchObject({ bump: false, fresh: false });
	});

	it("tests but pushes nothing new for a version whose branch exists", () => {
		expect(planBump({ ...base, branchExists: true })).toMatchObject({ bump: true, fresh: false });
	});

	it("keeps another ref off the bump path unless a rehearsal names a tested version", () => {
		expect(planBump({ ...base, onMain: false }).bump).toBe(false);
		expect(planBump({ ...base, onMain: false, latest: "18.22.0", pretendTested: "18.21.0" })).toMatchObject({
			tested: "18.21.0",
			bump: true,
			fresh: true,
			branch: "omp/bump/18.22.0",
		});
	});

	it("plans no bump in a run that does not test main, however new npm's omp is", () => {
		expect(planBump({ ...base, runs: false })).toMatchObject({ latest: "18.23.0", bump: false, fresh: false });
	});

	it("refuses a version it cannot order", () => {
		expect(() => planBump({ ...base, latest: "" })).toThrow(/latest/);
		expect(() => planBump({ ...base, pretendTested: "18.21" })).toThrow(/tested/);
	});
});

describe("jobResults", () => {
	const needs = {
		plan: { result: "success", outputs: { latest: "18.23.0" } },
		main: { result: "failure", outputs: { omp: "18.23.0", check: "success", windows: "failure" } },
		strings: { result: "skipped", outputs: {} },
	};

	it("reads the vitest call as the two jobs it ran, so the report can tell which one failed", () => {
		expect(jobResults(needs, "main")).toEqual({
			plan: "success",
			check: "success",
			windows: "failure",
			strings: "skipped",
		});
	});

	it("gives both jobs the call's own result when the call reported none of theirs", () => {
		expect(jobResults({ ...needs, main: { result: "failure", outputs: {} } }, "main")).toMatchObject({
			check: "failure",
			windows: "failure",
		});
		expect(jobResults({ plan: needs.plan, release: { result: "cancelled" } }, "release")).toEqual({
			plan: "success",
			check: "cancelled",
			windows: "cancelled",
		});
	});
});

function report(files: Record<string, { status: string; tests: Record<string, string> }>): VitestReport {
	return {
		testResults: Object.entries(files).map(([name, file]) => ({
			name,
			status: file.status,
			assertionResults: Object.entries(file.tests).map(([fullName, status]) => ({ fullName, status })),
		})),
	};
}

describe("summarize", () => {
	const meta = { group: "windows", job: "windows", outcome: "failure", root: "D:\\a\\ompdesk\\ompdesk" };
	const run = report({
		"D:/a/ompdesk/ompdesk/src/main/a-stock.test.ts": {
			status: "passed",
			tests: { "a b": "passed", "a c": "skipped" },
		},
		"d:/a/ompdesk/ompdesk/src/main/b.test.ts": { status: "failed", tests: { x: "failed", y: "skipped" } },
		"D:/a/ompdesk/ompdesk/src/main/local/git/pr-create-stock.test.ts": {
			status: "passed",
			tests: { "prCreate against stock executePrCreate passes stock's gh pr create flags": "skipped" },
		},
		"D:/a/ompdesk/ompdesk/src/main/bridge-accounts-stock.test.ts": {
			status: "passed",
			tests: { "real stock account/reset adapters preserves account listings": "skipped", "other todo": "todo" },
		},
	});

	it("counts every skipped stock test as a failure, a stand-in Windows cannot start included", () => {
		expect(summarize(run, { ...meta, platform: "win32" })).toEqual({
			group: "windows",
			job: "windows",
			outcome: "failure",
			report: true,
			failed: ["src/main/b.test.ts"],
			skipped: [
				{ file: "src/main/a-stock.test.ts", test: "a c" },
				{
					file: "src/main/local/git/pr-create-stock.test.ts",
					test: "prCreate against stock executePrCreate passes stock's gh pr create flags",
				},
			],
		});
	});

	it("lets an allowed skip pass only on the platforms it names", () => {
		const allowed = [{ file: "src/main/a-stock.test.ts", test: "a", platforms: ["win32"] as const, reason: "r" }];
		expect(summarize(run, { ...meta, platform: "win32", allowed }).skipped).toEqual([
			{
				file: "src/main/local/git/pr-create-stock.test.ts",
				test: "prCreate against stock executePrCreate passes stock's gh pr create flags",
			},
			{
				file: "src/main/bridge-accounts-stock.test.ts",
				test: "real stock account/reset adapters preserves account listings",
			},
		]);
		expect(summarize(run, { ...meta, platform: "linux", allowed }).skipped).toContainEqual({
			file: "src/main/a-stock.test.ts",
			test: "a c",
		});
	});

	it("lets the Windows-only daemon-folder suite skip on a Linux shard and never on the Windows job", () => {
		const daemon = (root: string) =>
			report({
				[`${root}/src/main/omp-daemon-folder-stock.test.ts`]: {
					status: "skipped",
					tests: {
						"a worktree a session's omp ran in is removed once that omp ended, while another session's omp keeps running":
							"skipped",
					},
				},
			});
		const linux = { ...meta, group: "check", job: "node-2", root: "/home/runner/work/ompdesk/ompdesk" };
		expect(summarize(daemon(linux.root), { ...linux, platform: "linux" }).skipped).toEqual([]);
		expect(summarize(daemon("D:/a/ompdesk/ompdesk"), { ...meta, platform: "win32" }).skipped).toHaveLength(1);
	});
});

describe("renderReport", () => {
	const touchpoint = (id: string, tests: string[]): Touchpoint => ({
		id,
		area: "bridge",
		contract: "internal",
		summary: `${id} summary`,
		files: [],
		stock: [],
		tests,
	});
	const touchpoints = [
		touchpoint("B01", ["src/main/a-stock.test.ts"]),
		touchpoint("B02", ["src/main/a-stock.test.ts", "src/main/c.test.ts"]),
		touchpoint("B03", ["src/main/unrelated.test.ts"]),
	];
	const summary = (patch: Partial<JobSummary>): JobSummary => ({
		group: "check",
		job: "node-1",
		outcome: "success",
		report: true,
		failed: [],
		skipped: [],
		...patch,
	});

	it("lists each failed or skipped file under every touchpoint naming it, and the rest apart", () => {
		const text = renderReport({
			version: "18.23.0",
			summaries: [
				summary({ outcome: "failure", failed: ["src/main/c.test.ts", "src/main/new.test.ts"] }),
				summary({
					group: "windows",
					job: "windows",
					outcome: "failure",
					failed: ["src/main/c.test.ts"],
					skipped: [{ file: "src/main/a-stock.test.ts", test: "a c" }],
				}),
			],
			jobs: { plan: "success", check: "failure", windows: "failure", strings: "failure" },
			missingStrings: "omp 18.23.0 has 1 strings OMPdesk's dictionaries lack:\n  KO_SETTINGS: foo.bar\n",
			touchpoints,
		});
		expect(text).toBe(
			[
				"### Against omp 18.23.0, by touchpoint",
				"",
				"- **B01** (bridge) B01 summary",
				'  - `src/main/a-stock.test.ts` skipped "a c" (windows)',
				"- **B02** (bridge) B02 summary",
				'  - `src/main/a-stock.test.ts` skipped "a c" (windows)',
				"  - `src/main/c.test.ts` failed (node-1, windows)",
				"",
				"### Test files no touchpoint lists",
				"",
				"- `src/main/new.test.ts` failed (node-1)",
				"",
				"### Strings OMPdesk's dictionaries lack",
				"",
				"```text",
				"omp 18.23.0 has 1 strings OMPdesk's dictionaries lack:\n  KO_SETTINGS: foo.bar",
				"```",
			].join("\n"),
		);
	});

	it("names a job that failed with no test file to blame", () => {
		const text = renderReport({
			version: "18.23.0",
			summaries: [summary({ job: "node-2", outcome: "failure", report: false })],
			jobs: { check: "failure", windows: "failure", strings: "success", push: "cancelled" },
			missingStrings: null,
			touchpoints,
		});
		expect(text).toBe(
			[
				"### Failed outside any test file (each job's summary names the step)",
				"",
				"- `node-2`: vitest failed and wrote no report",
				"- `windows`: failed before its checks",
				"- `push`: cancelled",
			].join("\n"),
		);
	});

	it("says so when nothing failed", () => {
		expect(
			renderReport({ version: "18.23.0", summaries: [summary({})], jobs: {}, missingStrings: null, touchpoints }),
		).toBe("Nothing failed against omp 18.23.0.");
	});
});
