/**
 * CI results of a session's pushes: the pure rules (engine: ./ci-watch.ts; contracts: ./ci-watch-contracts.ts;
 * control-tools.md › CI results of a session's pushes). What a bash call's output says it pushed, when a watch reads
 * and when it ends, which watches a relaunch arms again, and the text the model reads. No omp imports: the GUI's
 * vitest runs it (src/main/bridge-ci-watch.test.ts). Stock's PR-URL and repo-ref parsers come in as arguments.
 */
import {
	CI_FAILED_SHOWN,
	CI_MESSAGE_TYPE,
	CI_WATCH_END_ENTRY,
	CI_WATCH_ENTRY,
	type CiResultDetails,
	ciTarget,
} from "./ci-watch-contracts";

/** What one push or PR creation named: a branch (and the pushed commit when git printed it) or a PR. */
export interface CiTarget {
	host: string;
	/** `owner/name`. */
	repo: string;
	branch?: string;
	/** As git printed it: often abbreviated. */
	sha?: string;
	pr?: number;
}

/** The `ompdesk-ci-watch` journal entry. */
export interface CiWatchRecord extends CiTarget {
	id: string;
	/** When the push was seen (ms). */
	at: number;
}

export type CiEndReason = "delivered" | "no_ci" | "superseded" | "expired";

export const CI_FIRST_READ_MS = 30_000;
export const CI_POLL_MS = 60_000;
export const CI_BACKOFF_MAX_MS = 15 * 60_000;
export const CI_RATE_LIMIT_WAIT_MS = 5 * 60_000;
/** A commit with no workflow run this long after the push has no CI (a repo without Actions). */
export const CI_NO_RUNS_MS = 10 * 60_000;
/** An older watch of a branch a newer push replaced is still read this long (Orca I8). */
export const CI_SUPERSEDED_MS = 2 * 60 * 60_000;
export const CI_EXPIRE_MS = 24 * 60 * 60_000;

/** A bash command worth remembering until its output comes back. */
export function isPushCommand(command: string): boolean {
	if (/--dry-run/.test(command)) return false;
	return /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*push\b/.test(command) || /\bgh\s+pr\s+create\b/.test(command);
}

/**
 * `https://[user@]host/o/r(.git)`, `[user@]host:o/r(.git)`, `ssh://user@host[:port]/o/r(.git)` → `{host, repo}`; a
 * local path or a remote that is not two segments deep is none.
 */
export function parseGitRemote(url: string): { host: string; repo: string } | undefined {
	const match =
		/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
			url.trim(),
		);
	return match ? { host: match[1].toLowerCase(), repo: `${match[2]}/${match[3]}` } : undefined;
}

// git's ref line: ` <flag> <summary> <from> -> <to> (<reason>)`; a summary like `[new branch]` holds a space.
const REF_LINE = /^ ([ +*!=-]) (\[[^\]]+\]|\S+)\s+(\S+)(?: -> (\S+))?(?: \(([^)]*)\))?\s*$/;

/**
 * Every branch a `git push` output says it updated on a host in `hosts` (gh serves only those): fast-forward, forced
 * and new branches. Deleted, rejected, up-to-date refs and tags are no push of a commit to watch.
 */
export function parseGitPush(output: string, hosts: ReadonlySet<string>): CiTarget[] {
	const targets: CiTarget[] = [];
	let remote: { host: string; repo: string } | undefined;
	for (const line of output.split(/\r?\n|\r/)) {
		if (line.startsWith("To ")) {
			const parsed = parseGitRemote(line.slice(3));
			remote = parsed && hosts.has(parsed.host) ? parsed : undefined;
			continue;
		}
		const ref = remote ? REF_LINE.exec(line) : null;
		if (!remote || !ref) continue;
		const [, flag, summary, , to] = ref;
		if (!to || (flag !== " " && flag !== "+" && flag !== "*") || summary === "[new tag]") continue;
		if (to.startsWith("refs/") && !to.startsWith("refs/heads/")) continue;
		const sha = /^[0-9a-f]{7,40}\.\.\.?([0-9a-f]{7,40})$/.exec(summary)?.[1];
		targets.push({ ...remote, branch: to.replace(/^refs\/heads\//, ""), ...(sha ? { sha } : {}) });
	}
	return targets;
}

/** Stock's `tools/gh-common` parsers (`parsePullRequestUrl`, `parseRepoRef`). */
export interface GhUrlParsers {
	parsePullRequestUrl(value: string | undefined): { repo?: string; prNumber?: number };
	parseRepoRef(repo: string): { host?: string; slug: string };
}

/** The PR a `gh pr create` output names (gh prints its URL on a line of its own). */
export function parsePrCreate(output: string, gh: GhUrlParsers): CiTarget[] {
	const targets: CiTarget[] = [];
	for (const line of output.split(/\r?\n/)) {
		const { repo, prNumber } = gh.parsePullRequestUrl(line.trim());
		if (!repo || !prNumber) continue;
		const ref = gh.parseRepoRef(repo);
		if (ref.host) targets.push({ host: ref.host.toLowerCase(), repo: ref.slug, pr: prNumber });
	}
	return targets;
}

/** When a watch stops being read whatever it finds, and why: 24 h after the push, or 2 h after a newer push replaced it. */
export function ciDeadline(watch: CiWatchRecord, supersededAt?: number): { at: number; reason: CiEndReason } {
	const expires = watch.at + CI_EXPIRE_MS;
	return supersededAt !== undefined && supersededAt + CI_SUPERSEDED_MS < expires
		? { at: supersededAt + CI_SUPERSEDED_MS, reason: "superseded" }
		: { at: expires, reason: "expired" };
}

/** What a successful read means: a final outcome to deliver, no CI at all, or a wait for the next read. */
export function readVerdict(
	watch: CiWatchRecord,
	runCount: number,
	outcome: "success" | "failure" | "pending",
	now: number,
): "deliver" | "no_ci" | "pending" {
	if (runCount === 0) return now - watch.at >= CI_NO_RUNS_MS ? "no_ci" : "pending";
	return outcome === "pending" ? "pending" : "deliver";
}

/** The wait after the `failures`-th failed read in a row: 60 s doubling to 15 min; GitHub's rate limit waits 5 min. */
export function retryDelay(failures: number, rateLimited: boolean): number {
	if (rateLimited) return CI_RATE_LIMIT_WAIT_MS;
	return Math.min(CI_POLL_MS * 2 ** Math.max(0, failures - 1), CI_BACKOFF_MAX_MS);
}

function parseWatch(data: unknown): CiWatchRecord | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	const { id, host, repo, branch, sha, pr, at } = record;
	if (typeof id !== "string" || typeof host !== "string" || typeof repo !== "string" || typeof at !== "number")
		return undefined;
	if (typeof branch !== "string" && typeof pr !== "number") return undefined;
	return {
		id,
		host,
		repo,
		at,
		...(typeof branch === "string" ? { branch } : {}),
		...(typeof sha === "string" ? { sha } : {}),
		...(typeof pr === "number" ? { pr } : {}),
	};
}

function field(entry: unknown, key: string): unknown {
	return typeof entry === "object" && entry !== null && key in entry
		? (entry as Record<string, unknown>)[key]
		: undefined;
}

function isCiMessage(entry: unknown): boolean {
	return field(entry, "type") === "custom_message" && field(entry, "customType") === CI_MESSAGE_TYPE;
}

/** True when the branch already holds a CI line for this watch, or for the same commit (a push and its PR). */
export function isDelivered(entries: readonly unknown[], id: string, repo: string, sha?: string): boolean {
	return entries.some(entry => {
		if (!isCiMessage(entry)) return false;
		const details = field(entry, "details");
		return (
			field(details, "id") === id ||
			(sha !== undefined && field(details, "repo") === repo && field(details, "sha") === sha)
		);
	});
}

/**
 * The watches a session's branch still owes a result for, oldest first: recorded under 24 h before `now`, not ended
 * and not delivered. `supersededAt` is when the next watch of the same repo and branch was recorded.
 */
export function pendingWatches(
	entries: readonly unknown[],
	now: number,
): Array<{ watch: CiWatchRecord; supersededAt?: number }> {
	const watches: CiWatchRecord[] = [];
	const done = new Set<string>();
	for (const entry of entries) {
		if (field(entry, "type") === "custom" && field(entry, "customType") === CI_WATCH_ENTRY) {
			const watch = parseWatch(field(entry, "data"));
			if (watch) watches.push(watch);
		} else if (field(entry, "type") === "custom" && field(entry, "customType") === CI_WATCH_END_ENTRY) {
			const id = field(field(entry, "data"), "id");
			if (typeof id === "string") done.add(id);
		} else if (isCiMessage(entry)) {
			const id = field(field(entry, "details"), "id");
			if (typeof id === "string") done.add(id);
		}
	}
	return watches.flatMap((watch, index) => {
		if (done.has(watch.id) || now - watch.at >= CI_EXPIRE_MS) return [];
		const newer = watch.branch
			? watches
					.slice(index + 1)
					.find(next => next.host === watch.host && next.repo === watch.repo && next.branch === watch.branch)
			: undefined;
		return [{ watch, ...(newer ? { supersededAt: newer.at } : {}) }];
	});
}

/** The slice of stock's `GhRunSnapshot` a failure line reads. */
export interface CiRun {
	url?: string;
	jobs: Array<{ name: string; conclusion?: string }>;
}

/** The failed job names (distinct, at most five) and the run to open: the first failed run, else the first. */
export function ciFailure<R extends CiRun>(
	runs: readonly R[],
	runFailed: (run: R) => boolean,
	jobFailed: (job: R["jobs"][number]) => boolean,
): { failed: string[]; url?: string } {
	const failed = [...new Set(runs.flatMap(run => run.jobs.filter(jobFailed).map(job => job.name)))];
	const url = (runs.find(runFailed) ?? runs[0])?.url;
	return { failed: failed.slice(0, CI_FAILED_SHOWN), ...(url ? { url } : {}) };
}

/** The line the model reads with the next turn. */
export function ciResultText(details: CiResultDetails): string {
	const target = ciTarget(details);
	if (details.outcome === "success") return `CI passed for ${target}.`;
	const jobs = details.failed.length > 0 ? `: ${details.failed.join(", ")}` : "";
	return `CI failed for ${target}${jobs}.${details.url ? ` ${details.url}` : ""}`;
}
