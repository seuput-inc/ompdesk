/**
 * omp-latest.yml and omp-vitest.yml, held to what the scripts beside this file assume: the names the plan step
 * writes, the schedule entry the daily slot is told by, which job may write, and what counts as a verdict.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DAILY_CRON, planTargets } from "./compat-run";
import { planBump } from "./latest-run";

const WORKFLOWS = path.resolve(__dirname, "../../.github/workflows");

interface Job {
	needs?: string | string[];
	if?: string;
	uses?: string;
	with?: Record<string, unknown>;
	permissions?: Record<string, string>;
	outputs?: Record<string, string>;
	env?: Record<string, string>;
	steps?: { if?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }[];
}

interface Workflow {
	on: {
		schedule?: { cron: string }[];
		workflow_dispatch?: { inputs?: Record<string, unknown> };
		workflow_call?: { inputs?: Record<string, unknown>; outputs?: Record<string, { value: string }> };
	};
	jobs: Record<string, Job>;
}

const text = fs.readFileSync(path.join(WORKFLOWS, "omp-latest.yml"), "utf8");
const latest = parse(text) as Workflow;
const vitest = parse(fs.readFileSync(path.join(WORKFLOWS, "omp-vitest.yml"), "utf8")) as Workflow;
const VITEST = "./.github/workflows/omp-vitest.yml";
/** A GitHub Actions expression as the YAML holds it. */
const expr = (inner: string) => `\${{ ${inner} }}`;

/** The hours a `M H * * *` entry fires at; H is a list of hours and ranges. */
function hours(cron: string): number[] {
	const [minute, hour, ...rest] = cron.split(" ");
	expect(rest, cron).toEqual(["*", "*", "*"]);
	expect(Number(minute), cron).toBeGreaterThan(0);
	return (hour ?? "").split(",").flatMap(part => {
		const [from, to = from] = part.split("-").map(Number);
		return Array.from({ length: (to ?? 0) - (from ?? 0) + 1 }, (_, i) => (from ?? 0) + i);
	});
}

describe("omp-latest.yml", () => {
	it("starts once every hour, off the hour, and one entry is the daily slot the plan knows", () => {
		const crons = (latest.on.schedule ?? []).map(entry => entry.cron);
		expect(crons.filter(cron => cron === DAILY_CRON)).toHaveLength(1);
		expect(crons.flatMap(hours).sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, hour) => hour));
	});

	it("hands the plan every dispatch input and the schedule entry", () => {
		const plan = latest.jobs.plan?.steps?.find(step => step.run?.includes("latest.ts plan"));
		expect(plan?.env).toMatchObject({
			PRETEND_TESTED: expr("inputs.pretend_tested"),
			RECHECK: expr("inputs.recheck"),
			REHEARSE_APP: expr("inputs.rehearse_app"),
			SCHEDULE: expr("github.event.schedule"),
		});
		expect(Object.keys(latest.on.workflow_dispatch?.inputs ?? {}).sort()).toEqual([
			"pretend_tested",
			"recheck",
			"rehearse_app",
		]);
	});

	it("reads only plan outputs the plan step writes and the plan job passes on", () => {
		const written = Object.keys({
			...planBump({
				latest: "19.1.0",
				fileTested: "19.0.0",
				pretendTested: "",
				onMain: true,
				runs: true,
				branchExists: false,
			}),
			...planTargets({
				dispatch: false,
				daily: false,
				recheck: false,
				rehearseApp: "",
				onMain: true,
				latest: "19.1.0",
				releases: ["v0.134.1"],
				list: {},
			}),
		});
		const passed = Object.keys(latest.jobs.plan?.outputs ?? {});
		expect(written).toEqual(expect.arrayContaining(passed));
		const read = [...text.matchAll(/needs\.plan\.outputs\.([\w-]+)/g)].map(match => match[1]);
		expect(read.length).toBeGreaterThan(0);
		expect(passed).toEqual(expect.arrayContaining([...new Set(read)]));
	});

	it("reads no job's result or outputs it does not wait for", () => {
		for (const [id, job] of Object.entries(latest.jobs)) {
			const needs = typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
			for (const need of needs) expect(Object.keys(latest.jobs), `${id} needs ${need}`).toContain(need);
			const read = [...JSON.stringify(job).matchAll(/needs\.([\w-]+)\./g)].map(match => match[1]);
			for (const name of new Set(read)) expect(needs, `${id} reads needs.${name}`).toContain(name);
		}
	});

	it("runs both targets as omp-vitest.yml with the same omp, read-only, the release one on the release's tag", () => {
		const { main, release } = latest.jobs;
		for (const job of [main, release]) {
			expect(job?.uses).toBe(VITEST);
			expect(job?.permissions).toEqual({ contents: "read", actions: "read" });
			expect(Object.keys(vitest.on.workflow_call?.inputs ?? {})).toEqual(
				expect.arrayContaining(Object.keys(job?.with ?? {})),
			);
		}
		expect(main?.if).toBe("needs.plan.outputs.main == 'true'");
		expect(main?.with?.ref).toBeUndefined();
		expect(release?.if).toBe("needs.plan.outputs.release == 'true'");
		expect(release?.with).toMatchObject({ ref: `v${expr("needs.plan.outputs.app")}`, report: true });
		// Two calls in one run upload under different names, and main's are the ones the failure report downloads.
		expect(main?.with?.["artifact-prefix"]).toBeUndefined();
		expect(release?.with?.["artifact-prefix"]).toBe("release-");
	});

	it("takes only a finished release target as a verdict, apart from what main did", () => {
		const { compat } = latest.jobs;
		expect(compat?.needs).toEqual(["plan", "release"]);
		expect(compat?.if).toContain("!cancelled()");
		expect(compat?.if).toContain("needs.plan.outputs.release == 'true'");
		expect(compat?.if).toContain("(needs.release.result == 'success' || needs.release.result == 'failure')");
		expect(compat?.env).toMatchObject({
			VERDICT: expr("needs.release.result == 'success' && 'green' || 'red'"),
			WRITE: expr("needs.plan.outputs.write"),
		});
	});

	it("lets only the two pushing jobs write contents, and neither runs a tested ref's code", () => {
		const writers = Object.entries(latest.jobs)
			.filter(([, job]) => job.permissions?.contents === "write")
			.map(([id]) => id);
		expect(writers.sort()).toEqual(["compat", "push"]);
		for (const id of writers) {
			expect(JSON.stringify(latest.jobs[id]?.steps), id).not.toMatch(/"ref":|bun install|bunx vitest/);
		}
		// Every step of compat that changes something outside the run is off in a rehearsal.
		for (const step of latest.jobs.compat?.steps ?? []) {
			if (step.uses?.startsWith("actions/github-script@")) expect(step.if).toContain("env.WRITE == 'true'");
		}
	});
});

describe("omp-vitest.yml", () => {
	it("is only ever called, and tells its caller the omp it installed and how each of its jobs ended", () => {
		expect(Object.keys(vitest.on)).toEqual(["workflow_call"]);
		expect(vitest.on.workflow_call?.outputs).toMatchObject({
			omp: { value: expr("jobs.check.outputs.omp") },
			check: { value: expr("jobs.check.result") },
			windows: { value: expr("jobs.windows.result") },
		});
		expect(Object.keys(vitest.jobs).sort()).toEqual(["check", "windows"]);
	});

	it("checks out the asked ref before anything of the repository runs, with a read-only token", () => {
		for (const [id, job] of Object.entries(vitest.jobs)) {
			const [checkout] = job.steps ?? [];
			expect(checkout?.uses, id).toMatch(/^actions\/checkout@/);
			expect(checkout?.with?.ref, id).toBe(expr("inputs.ref"));
			expect(job.permissions, id).toEqual({ contents: "read", actions: "read" });
		}
	});
});
