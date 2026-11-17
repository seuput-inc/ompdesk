/**
 * The rules omp-latest.yml runs by when npm has an omp newer than the tested one (src/shared/omp-tested.json): whether
 * this run takes the bump path, which skipped stock tests fail it, and the report that groups what failed by the
 * touchpoints whose tests name it. The CLI around them is latest.ts.
 */
import { compareVersions } from "../../src/shared/version";
import { STOCK_TEST_FILE, type Touchpoint } from "../omp-boundary/touchpoints";

const VERSION = /^\d+\.\d+\.\d+$/;

export interface BumpPlan {
	/** The omp every job of the run installs. */
	latest: string;
	/** The version the run treats as tested: the file's, or a rehearsal's `pretend_tested`. */
	tested: string;
	/** latest > tested on main (or in a rehearsal): run the stock skip guard and the string check, report by touchpoint. */
	bump: boolean;
	/** `bump`, and no branch for this version yet: a green run pushes it. */
	fresh: boolean;
	branch: string;
}

export interface BumpInput {
	latest: string;
	fileTested: string;
	/** A dispatch's `pretend_tested`; empty on schedule. Lets any ref rehearse the bump path. */
	pretendTested: string;
	onMain: boolean;
	/** Whether `omp/bump/<latest>` already exists on the remote. */
	branchExists: boolean;
}

export function bumpBranch(version: string): string {
	return `omp/bump/${version}`;
}

export function planBump(input: BumpInput): BumpPlan {
	const tested = input.pretendTested || input.fileTested;
	for (const [name, value] of [
		["latest", input.latest],
		["tested", tested],
	]) {
		if (!VERSION.test(value)) throw new Error(`${name} omp version is not X.Y.Z: ${JSON.stringify(value)}`);
	}
	const bump = (input.onMain || input.pretendTested !== "") && (compareVersions(input.latest, tested) ?? 0) > 0;
	return {
		latest: input.latest,
		tested,
		bump,
		fresh: bump && !input.branchExists,
		branch: bumpBranch(input.latest),
	};
}

export interface ExpectedSkip {
	file: string;
	/** A describe title or a test's full name; covers every test whose full name starts with it. */
	test: string;
	/** Only on these platforms; all when absent. */
	platforms?: readonly NodeJS.Platform[];
	reason: string;
}

/**
 * The only stock tests that may skip on a runner with omp installed: each needs what no runner can ever have (the
 * person's accounts or real model, a model they downloaded). A stand-in a platform cannot start is not a reason; the
 * test gets one it can. A new entry needs the same reason.
 */
export const EXPECTED_STOCK_SKIPS: readonly ExpectedSkip[] = [
	{
		file: "src/main/bridge-accounts-stock.test.ts",
		test: "real stock account/reset adapters",
		reason: "reads the person's own accounts, never on a runner",
	},
	{
		file: "src/main/bridge-stt-language-stock.test.ts",
		test: "dictation's model, on stock omp prepares English on the cached default model at once",
		reason: "needs the speech model already downloaded",
	},
	{
		file: "src/main/bridge-todo-compact-stock.test.ts",
		test: "a todo list grown long by appends, on the user's real smol model",
		reason: "runs the person's real model (OMP_GUI_REAL_WORK)",
	},
	{
		file: "src/main/bridge-todo-stale-stock.test.ts",
		test: "a todo list left from earlier work, on the user's real smol model",
		reason: "runs the person's real model (OMP_GUI_REAL_WORK)",
	},
];

/** The part of vitest's JSON reporter output read here. */
export interface VitestReport {
	testResults: {
		name: string;
		status: string;
		assertionResults: { fullName: string; status: string }[];
	}[];
}

export interface StockSkip {
	file: string;
	test: string;
}

/** One vitest job's result, as the job writes it for the report. */
export interface JobSummary {
	/** The workflow job (`check`, `windows`) this ran in. */
	group: string;
	/** This leg of it, e.g. `node-1`. */
	job: string;
	/** vitest's step outcome. */
	outcome: string;
	/** Whether vitest wrote its JSON report. */
	report: boolean;
	failed: string[];
	/** Skipped stock tests EXPECTED_STOCK_SKIPS does not explain. */
	skipped: StockSkip[];
}

/** A test file's path relative to the checkout, with `/`; vitest names files by absolute path. */
export function repoPath(file: string, root: string): string {
	const name = file.replaceAll("\\", "/");
	const prefix = `${root.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
	return name.toLowerCase().startsWith(prefix.toLowerCase()) ? name.slice(prefix.length) : name;
}

export function summarize(
	report: VitestReport,
	meta: {
		group: string;
		job: string;
		outcome: string;
		root: string;
		platform: NodeJS.Platform;
		allowed?: readonly ExpectedSkip[];
	},
): JobSummary {
	const allowed = meta.allowed ?? EXPECTED_STOCK_SKIPS;
	const expected = (skip: StockSkip) =>
		allowed.some(
			entry =>
				entry.file === skip.file &&
				(skip.test === entry.test || skip.test.startsWith(`${entry.test} `)) &&
				(!entry.platforms || entry.platforms.includes(meta.platform)),
		);
	const failed: string[] = [];
	const skipped: StockSkip[] = [];
	for (const result of report.testResults) {
		const file = repoPath(result.name, meta.root);
		if (result.status === "failed") failed.push(file);
		if (!STOCK_TEST_FILE.test(file)) continue;
		for (const test of result.assertionResults) {
			const skip = { file, test: test.fullName };
			if (test.status === "skipped" && !expected(skip)) skipped.push(skip);
		}
	}
	return { group: meta.group, job: meta.job, outcome: meta.outcome, report: true, failed: failed.sort(), skipped };
}

export interface ReportInput {
	version: string;
	summaries: readonly JobSummary[];
	/** `needs.<job>.result` of the run's jobs. */
	jobs: Readonly<Record<string, string>>;
	/** `extract.ts --check` output when it failed. */
	missingStrings: string | null;
	touchpoints: readonly Touchpoint[];
}

/** Markdown: every failed or wrongly skipped test file under each touchpoint whose `tests` name it. */
export function renderReport(input: ReportInput): string {
	// file → what happened to it → the jobs it happened in
	const files = new Map<string, Map<string, string[]>>();
	const note = (file: string, what: string, job: string) => {
		const notes = files.get(file) ?? new Map<string, string[]>();
		files.set(file, notes);
		push(notes, what, job);
	};
	for (const summary of input.summaries) {
		for (const file of summary.failed) note(file, "failed", summary.job);
		for (const skip of summary.skipped) note(skip.file, `skipped "${skip.test}"`, summary.job);
	}
	const out: string[] = [];
	const unknown: string[] = [];
	const byTouchpoint = new Map<Touchpoint, string[]>();
	for (const [file, notes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
		const owners = input.touchpoints.filter(t => t.tests.includes(file));
		const entry = `\`${file}\` ${[...notes].map(([what, jobs]) => `${what} (${jobs.join(", ")})`).join("; ")}`;
		if (owners.length === 0) unknown.push(entry);
		for (const owner of owners) push(byTouchpoint, owner, entry);
	}
	if (byTouchpoint.size > 0) {
		out.push(`### Against omp ${input.version}, by touchpoint`, "");
		for (const t of input.touchpoints) {
			const entries = byTouchpoint.get(t);
			if (!entries) continue;
			out.push(`- **${t.id}** (${t.area}) ${t.summary}`, ...entries.map(e => `  - ${e}`));
		}
		out.push("");
	}
	if (unknown.length > 0) {
		out.push("### Test files no touchpoint lists", "", ...unknown.map(e => `- ${e}`), "");
	}
	if (input.missingStrings !== null) {
		out.push("### Strings OMPdesk's dictionaries lack", "", "```text", input.missingStrings.trim(), "```", "");
	}
	const outside = input.summaries
		.filter(s => s.outcome === "failure" && s.failed.length === 0)
		.map(s => `- \`${s.job}\`: vitest failed ${s.report ? "outside any test file" : "and wrote no report"}`);
	const accounted = new Set(
		input.summaries.filter(s => s.outcome === "failure" || s.skipped.length > 0).map(s => s.group),
	);
	if (input.missingStrings !== null) accounted.add("strings");
	for (const [job, result] of Object.entries(input.jobs)) {
		if (result === "failure" && !accounted.has(job)) outside.push(`- \`${job}\`: failed before its checks`);
	}
	if (outside.length > 0) {
		out.push("### Failed outside any test file (each job's summary names the step)", "", ...outside, "");
	}
	if (out.length === 0) out.push(`Nothing failed against omp ${input.version}.`);
	return out.join("\n").trimEnd();
}

function push<K>(map: Map<K, string[]>, key: K, value: string): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}
