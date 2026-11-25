/**
 * omp-latest.yml's steps: what a run tests (rules in compat-run.ts) and its bump path (rules in latest-run.ts).
 *
 *   bun scripts/omp-bump/latest.ts plan                        env LATEST, RELEASES (JSON array of release tags),
 *                                                              PRETEND_TESTED, RECHECK, REHEARSE_APP, SCHEDULE,
 *                                                              GITHUB_REF, GITHUB_EVENT_NAME; writes GITHUB_OUTPUT
 *   bun scripts/omp-bump/latest.ts summary <vitest.json> <out> env GROUP, JOB, OUTCOME; exit 1 on an unexplained stock skip
 *   bun scripts/omp-bump/latest.ts report <dir>                env VERSION, NEEDS (toJSON(needs)), TARGET (the job in
 *                                                              it that calls omp-vitest.yml); markdown on stdout
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OMP_COMPAT_BRANCH, OMP_COMPAT_FILE, type OmpCompatList, parseOmpCompat } from "../../src/shared/omp-compat";
import { TOUCHPOINTS } from "../omp-boundary/touchpoints";
import { gitIn, readCompat } from "./compat";
import { DAILY_CRON, planTargets } from "./compat-run";
import {
	bumpBranch,
	type JobSummary,
	jobResults,
	type Need,
	planBump,
	renderReport,
	summarize,
	type VitestReport,
} from "./latest-run";

const ROOT = path.resolve(import.meta.dirname, "../..");
const [command, ...args] = process.argv.slice(2);

function env(name: string): string {
	const value = process.env[name];
	if (value === undefined) throw new Error(`${name} is not set`);
	return value;
}

if (command === "plan") {
	const latest = env("LATEST").trim();
	const file: unknown = JSON.parse(readFileSync(path.join(ROOT, "src/shared/omp-tested.json"), "utf8"));
	const fileTested = file && typeof file === "object" && "version" in file ? String(file.version) : "";
	const remote = spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", bumpBranch(latest)], {
		cwd: ROOT,
		encoding: "utf8",
	});
	// 2: no such ref; anything else but 0 is a git failure, which must not read as "not handled yet".
	if (remote.status !== 0 && remote.status !== 2) throw new Error(`git ls-remote failed: ${remote.stderr}`);
	const releases: unknown = JSON.parse(env("RELEASES"));
	if (!Array.isArray(releases) || !releases.every(tag => typeof tag === "string")) {
		throw new Error(`RELEASES is not a JSON array of tags: ${env("RELEASES")}`);
	}
	const compat = readCompat(gitIn(ROOT)).text;
	const list: OmpCompatList | null = compat === null ? {} : parseOmpCompat(compat);
	// A list the apps refuse too: nothing can be verified into it until someone repairs the file.
	if (!list) throw new Error(`${OMP_COMPAT_FILE} on ${OMP_COMPAT_BRANCH} is not a verified-omp list:\n${compat}`);
	const onMain = process.env.GITHUB_REF === "refs/heads/main";
	const targets = planTargets({
		dispatch: process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
		daily: process.env.SCHEDULE === DAILY_CRON,
		recheck: process.env.RECHECK === "true",
		rehearseApp: (process.env.REHEARSE_APP ?? "").trim(),
		onMain,
		latest,
		releases,
		list,
	});
	const plan = planBump({
		latest,
		fileTested,
		pretendTested: (process.env.PRETEND_TESTED ?? "").trim(),
		onMain,
		runs: targets.main,
		branchExists: remote.status === 0,
	});
	const lines = Object.entries({ ...plan, ...targets }).map(([key, value]) => `${key}=${value}`);
	console.log(lines.join("\n"));
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
	if (process.env.GITHUB_STEP_SUMMARY) {
		const tests = [targets.release && `release v${targets.app}`, targets.main && "this ref"].filter(Boolean);
		appendFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			`omp ${latest}: ${tests.length > 0 ? `testing ${tests.join(" and ")}` : "nothing to test"} (${targets.why})\n`,
		);
	}
} else if (command === "summary" && args.length === 2) {
	const [input, output] = args;
	const meta = { group: env("GROUP"), job: env("JOB"), outcome: env("OUTCOME") };
	const summary: JobSummary = existsSync(input)
		? summarize(JSON.parse(readFileSync(input, "utf8")) as VitestReport, {
				...meta,
				root: process.cwd(),
				platform: process.platform,
			})
		: { ...meta, report: false, failed: [], skipped: [] };
	mkdirSync(path.dirname(output), { recursive: true });
	writeFileSync(output, JSON.stringify(summary, null, "\t"));
	for (const skip of summary.skipped) {
		console.log(`::error file=${skip.file}::skipped with omp installed: ${skip.test}`);
	}
	if (summary.skipped.length > 0) {
		console.log(
			`${summary.skipped.length} stock tests skipped; a stock test skips only for a reason EXPECTED_STOCK_SKIPS (scripts/omp-bump/latest-run.ts) names`,
		);
		process.exit(1);
	}
} else if (command === "report" && args.length === 1) {
	const dir = args[0];
	const jobs = jobResults(JSON.parse(env("NEEDS")) as Record<string, Need>, env("TARGET"));
	const summaries = readdirSync(dir)
		.filter(name => name.endsWith(".summary.json"))
		.sort()
		.map(name => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as JobSummary);
	const strings = path.join(dir, "strings-check.txt");
	const missingStrings = jobs.strings === "failure" && existsSync(strings) ? readFileSync(strings, "utf8") : null;
	console.log(renderReport({ version: env("VERSION"), summaries, jobs, missingStrings, touchpoints: TOUCHPOINTS }));
} else {
	console.error("usage: bun scripts/omp-bump/latest.ts plan | summary <vitest.json> <out> | report <dir>");
	process.exit(2);
}
