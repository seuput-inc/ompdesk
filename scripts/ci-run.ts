/**
 * Dispatch a workflow on GitHub's runners through the check queue's front door.
 *
 *   bun scripts/ci-run.ts ci --ref omp/agent/foo -f batch=true
 *   bun scripts/ci-run.ts ci --ref omp/agent/foo -f batch=true -f mac=true      the landing gate
 *   bun scripts/ci-run.ts e2e-nightly --ref omp/agent/foo -f specs="e2e/a.e2e.ts"
 *   bun scripts/ci-run.ts flake-probe --ref omp/agent/foo -f spec=e2e/a.e2e.ts -f os=windows
 *   options: --ref <branch> (default: the current branch), -f key=value (any number), --dry-run
 *
 *  - A branch without queue-gate.yml (cut before the gate landed) runs its own old workflow files, which hold nothing:
 *    refused (exit 2); merge main first.
 * Exit 0: dispatched, the exact response run ID printed (watch it once: `bun scripts/watch-run.ts <id>`).
 */
import { spawnSync } from "node:child_process";
import { gh } from "./gh-run";

/**
 * The workflows a session dispatches, and what each asks of the macOS runners from its inputs. The Playwright suite
 * (ci's `e2e`, e2e-nightly, an e2e spec in flake-probe) runs on Windows: Playwright cannot attach to macOS's WKWebView.
 */
const WORKFLOWS: Record<string, (inputs: Record<string, string>) => boolean> = {
	ci: inputs => inputs.mac === "true",
	"e2e-nightly": () => false,
	"flake-probe": inputs => {
		const os = inputs.os ?? "all";
		return os === "macos" || (os === "all" && !(inputs.spec ?? "").endsWith(".e2e.ts"));
	},
	"shell-batch-checks": () => true,
	formal: () => false,
};

export interface CiRunArgs {
	workflow: string;
	ref: string | undefined;
	inputs: Record<string, string>;
	dryRun: boolean;
}

export function parseArgs(argv: string[]): CiRunArgs | string {
	const [first, ...rest] = argv;
	const workflow = first?.replace(/\.yml$/, "") ?? "";
	if (!(workflow in WORKFLOWS)) return `workflow must be one of ${Object.keys(WORKFLOWS).join(", ")}`;
	const args: CiRunArgs = { workflow, ref: undefined, inputs: {}, dryRun: false };
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--ref") args.ref = rest[++i];
		else if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "-f" || arg === "--field" || arg === "--raw-field") {
			const pair = rest[++i] ?? "";
			const eq = pair.indexOf("=");
			if (eq <= 0) return `${arg} needs key=value`;
			args.inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
		} else return `unknown argument ${arg}`;
	}
	return args;
}

/** Whether the dispatch asks for a macOS runner. */
export function asksForMac(workflow: string, inputs: Record<string, string>): boolean {
	return WORKFLOWS[workflow]?.(inputs) ?? false;
}

function fail(message: string, code: number): never {
	console.error(`ci-run: ${message}`);
	process.exit(code);
}

function currentBranch(): string {
	const branch = spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" }).stdout.trim();
	return branch || fail("not on a branch: pass --ref <branch>", 2);
}

/**
 * Standard GitHub-hosted runners, seuput-inc Enterprise, verified 25 Nov 2026 (https://docs.github.com/en/enterprise-cloud@latest/actions/reference/limits).
 * `siblings` names additional repositories to inspect, without claiming the list is complete.
 */
export const RUNNER_LIMITS = {
	owner: "seuput-inc",
	jobs: 500,
	macos: 50,
	siblings: (process.env.OMPDESK_CI_SIBLINGS ?? "").split(",").filter(Boolean),
};

/** Open runs of this repo and its siblings, for the wait to be expected, not a mystery. */
function accountLoad(): string {
	const count = (repo: string, status: string) => {
		const counted = gh(["api", `repos/${repo}/actions/runs?status=${status}&per_page=1`, "--jq", ".total_count"]);
		return counted.ok ? counted.out.trim() : "?";
	};
	const here = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).out.trim();
	const parts = [here, ...RUNNER_LIMITS.siblings]
		.filter(Boolean)
		.map(repo => `${repo} ${count(repo, "in_progress")} running, ${count(repo, "queued")} queued runs`);
	return `${RUNNER_LIMITS.owner} (Enterprise: ${RUNNER_LIMITS.jobs} jobs, ${RUNNER_LIMITS.macos} macOS; listed repositories only): ${parts.join("; ")}`;
}

function main(argv: string[]): number {
	const args = parseArgs(argv);
	if (typeof args === "string")
		fail(`${args}\nusage: bun scripts/ci-run.ts <workflow> [--ref <branch>] [-f key=value]... [--dry-run]`, 2);
	const ref = args.ref ?? currentBranch();
	if (!gh(["api", `repos/{owner}/{repo}/git/ref/heads/${ref}`]).ok) fail(`${ref} is not pushed: push it first`, 2);
	if (
		args.workflow !== "formal" &&
		!gh(["api", `repos/{owner}/{repo}/contents/.github/workflows/queue-gate.yml?ref=${ref}`]).ok
	) {
		fail(
			`${ref} has no .github/workflows/queue-gate.yml: its workflow files predate the check queue and hold nothing. Merge main into it first.`,
			2,
		);
	}
	if (asksForMac(args.workflow, args.inputs)) {
		console.log(accountLoad());
	}
	if (args.dryRun) {
		const fields = Object.entries(args.inputs).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
		console.log(`dry run: gh workflow run ${args.workflow}.yml --ref ${ref} ${fields.join(" ")}`);
		return 0;
	}
	// API 2026-03-10 returns this dispatch's run ID; a recent run on the same ref is never a receipt.
	const fields = Object.entries(args.inputs).flatMap(([key, value]) => ["-f", `inputs[${key}]=${value}`]);
	const dispatched = gh([
		"api",
		"--method",
		"POST",
		`repos/{owner}/{repo}/actions/workflows/${args.workflow}.yml/dispatches`,
		"-H",
		"Accept:application/vnd.github+json",
		"-H",
		"X-GitHub-Api-Version:2026-03-10",
		"-f",
		`ref=${ref}`,
		...fields,
	]);
	let id: number | undefined;
	if (dispatched.ok) {
		try {
			const receipt: unknown = JSON.parse(dispatched.out);
			if (receipt && typeof receipt === "object" && "workflow_run_id" in receipt) {
				const returned = receipt.workflow_run_id;
				if (typeof returned === "number" && Number.isSafeInteger(returned) && returned > 0) id = returned;
			}
		} catch {
			// A lost or malformed response does not prove that GitHub refused the dispatch.
		}
	}
	if (id === undefined) {
		const candidates = gh([
			"run",
			"list",
			"--workflow",
			`${args.workflow}.yml`,
			"--branch",
			ref,
			"--event",
			"workflow_dispatch",
			"--limit",
			"5",
			"--json",
			"databaseId,displayTitle,headSha,url",
		]);
		fail(
			`dispatch outcome is unconfirmed; it may have started. Do not dispatch it again automatically.${dispatched.err ? ` ${dispatched.err}` : ""}\nCandidates (not attributed): ${candidates.ok ? candidates.out.trim() : candidates.err}`,
			1,
		);
	}
	console.log(`dispatched ${args.workflow}.yml on ${ref}: run ${id}\nwatch it once: bun scripts/watch-run.ts ${id}`);
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
