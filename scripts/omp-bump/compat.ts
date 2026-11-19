/**
 * The verified-omp list on its branch (`omp-compat`, one file `omp-compat.json`; rules in compat-run.ts).
 *
 *   bun scripts/omp-bump/compat.ts record   env APP, OMP, VERDICT=green|red, WRITE=true|false, ISSUE (red: the hold
 *                                           issue's number, may be empty), AT (red: ISO time, default now)
 *
 * `record` reads the branch, applies the verdict and, with WRITE=true, pushes one commit as github-actions[bot]. A
 * push only ever adds a commit on top of the one that was read (no force), so a writer that lost the race reads again
 * and applies its verdict to the newer list. Without WRITE it prints the list it would have written: the rehearsal.
 * Writes GITHUB_OUTPUT (`pushed`, `released_issue`) and the step summary.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { type CompatVerdict, OMP_COMPAT_BRANCH, OMP_COMPAT_FILE } from "../../src/shared/omp-compat";
import { type Applied, applyVerdict } from "./compat-run";

export interface GitResult {
	status: number | null;
	stdout: string;
	stderr: string;
}
export type Git = (args: string[], input?: string) => GitResult;

export function gitIn(cwd: string): Git {
	return (args, input) => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8", input });
		return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
}

const REF = `refs/heads/${OMP_COMPAT_BRANCH}`;
const TRACKING = `refs/remotes/origin/${OMP_COMPAT_BRANCH}`;
const BOT = [
	"-c",
	"user.name=github-actions[bot]",
	"-c",
	"user.email=41898282+github-actions[bot]@users.noreply.github.com",
];

function ok(result: GitResult, what: string): string {
	if (result.status !== 0) throw new Error(`${what} failed (${result.status}): ${result.stderr.trim()}`);
	return result.stdout;
}

/** The branch's head and the file's text as origin has them now; null for a branch or a file that does not exist. */
export function readCompat(git: Git): { commit: string | null; text: string | null } {
	const remote = git(["ls-remote", "--exit-code", "--heads", "origin", REF]);
	// 2: no such ref. Any other failure must not read as an empty list.
	if (remote.status === 2) return { commit: null, text: null };
	ok(remote, "git ls-remote");
	ok(git(["fetch", "--quiet", "origin", `+${REF}:${TRACKING}`]), "git fetch");
	const commit = ok(git(["rev-parse", "--verify", TRACKING]), "git rev-parse").trim();
	const listed = ok(git(["ls-tree", "--name-only", commit, "--", OMP_COMPAT_FILE]), "git ls-tree").trim();
	if (listed === "") return { commit, text: null };
	return { commit, text: ok(git(["show", `${commit}:${OMP_COMPAT_FILE}`]), "git show") };
}

export interface RecordInput {
	app: string;
	omp: string;
	verdict: CompatVerdict;
	/** false: read and apply only. */
	write: boolean;
	tries?: number;
}

export interface Recorded extends Applied {
	pushed: boolean;
}

/**
 * Applies the verdict to the list origin holds and pushes it. Each try starts from what origin has at that moment, so
 * a run that crashed after its push, a re-run and a writer that pushed in between all end with the same list.
 */
export function recordOnBranch(git: Git, input: RecordInput): Recorded {
	const tries = input.tries ?? 3;
	for (let attempt = 1; ; attempt++) {
		const remote = readCompat(git);
		const applied = applyVerdict(remote.text, input.app, input.omp, input.verdict);
		if (!input.write || !applied.changed) return { ...applied, pushed: false };
		const message = `chore(omp-compat): ${input.app} ${input.verdict.green ? "green" : "red"} omp ${input.omp}`;
		// Built from objects, never a working tree: the branch's tree is this one file whatever the checkout holds.
		const blob = ok(git(["hash-object", "-w", "--stdin"], applied.text), "git hash-object").trim();
		const tree = ok(git(["mktree"], `100644 blob ${blob}\t${OMP_COMPAT_FILE}\n`), "git mktree").trim();
		const parent = remote.commit ? ["-p", remote.commit] : [];
		const commit = ok(git([...BOT, "commit-tree", tree, ...parent, "-m", message]), "git commit-tree").trim();
		const push = git(["push", "--quiet", "origin", `${commit}:${REF}`]);
		if (push.status === 0) return { ...applied, pushed: true };
		if (attempt >= tries) throw new Error(`git push failed ${tries} times: ${push.stderr.trim()}`);
		console.error(`push ${attempt} was rejected; reading ${OMP_COMPAT_BRANCH} again\n${push.stderr.trim()}`);
	}
}

function env(name: string): string {
	const value = process.env[name];
	if (value === undefined) throw new Error(`${name} is not set`);
	return value.trim();
}

function verdictFromEnv(): CompatVerdict {
	const verdict = env("VERDICT");
	if (verdict === "green") return { green: true };
	if (verdict !== "red") throw new Error(`VERDICT must be green or red: ${JSON.stringify(verdict)}`);
	const issue = (process.env.ISSUE ?? "").trim();
	if (issue !== "" && !/^[1-9]\d*$/.test(issue))
		throw new Error(`ISSUE is not an issue number: ${JSON.stringify(issue)}`);
	const at = (process.env.AT ?? "").trim() || new Date().toISOString();
	return { green: false, at, issue: issue === "" ? null : Number(issue) };
}

if (import.meta.main) {
	const [command] = process.argv.slice(2);
	if (command !== "record") {
		console.error("usage: bun scripts/omp-bump/compat.ts record");
		process.exit(2);
	}
	const [app, omp, verdict, write] = [env("APP"), env("OMP"), verdictFromEnv(), env("WRITE") === "true"];
	const recorded = recordOnBranch(gitIn(path.resolve(import.meta.dirname, "../..")), { app, omp, verdict, write });
	const outcome = recorded.pushed
		? `pushed to \`${OMP_COMPAT_BRANCH}\``
		: write
			? `\`${OMP_COMPAT_BRANCH}\` already says so, nothing pushed`
			: "rehearsal, nothing pushed";
	const summary = [
		`### omp ${omp} against OMPdesk ${app}: ${verdict.green ? "green" : "red"} (${outcome})`,
		"",
		`\`${OMP_COMPAT_FILE}\`${recorded.pushed || !recorded.changed ? "" : " as it would be"}:`,
		"",
		"```json",
		recorded.text.trimEnd(),
		"```",
		"",
	].join("\n");
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(
			process.env.GITHUB_OUTPUT,
			`pushed=${recorded.pushed}\nreleased_issue=${recorded.releasedIssue ?? ""}\n`,
		);
	}
}
