/**
 * CI results of a session's pushes, the pure rules (resources/gui-bridge/modes/ci-watch-core.ts): what a `git push` or
 * `gh pr create` output says was pushed, when a watch reads and ends, which watches a relaunch reads again, the dedupe
 * and the text the model reads. Stock's PR-URL parsers are passed in; the stock-shaped fakes here follow
 * `tools/gh-common`'s `parsePullRequestUrl`/`parseRepoRef`.
 */
import { describe, expect, it } from "vitest";
import {
	CI_MESSAGE_TYPE,
	CI_WATCH_END_ENTRY,
	CI_WATCH_ENTRY,
	parseCiResult,
} from "../../resources/gui-bridge/modes/ci-watch-contracts";
import {
	CI_BACKOFF_MAX_MS,
	CI_EXPIRE_MS,
	CI_NO_RUNS_MS,
	CI_POLL_MS,
	CI_RATE_LIMIT_WAIT_MS,
	CI_SUPERSEDED_MS,
	type CiWatchRecord,
	ciDeadline,
	ciFailure,
	ciResultText,
	type GhUrlParsers,
	isDelivered,
	isPushCommand,
	parseGitPush,
	parseGitRemote,
	parsePrCreate,
	pendingWatches,
	readVerdict,
	retryDelay,
} from "../../resources/gui-bridge/modes/ci-watch-core";

const GITHUB = new Set(["github.com"]);

const gh: GhUrlParsers = {
	parsePullRequestUrl(value) {
		const match = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(value ?? "");
		return match ? { repo: `${match[1]}/${match[2]}`, prNumber: Number(match[3]) } : {};
	},
	parseRepoRef(repo) {
		const [host, ...slug] = repo.split("/");
		return slug.length === 2 ? { host, slug: slug.join("/") } : { slug: repo };
	},
};

describe("push commands", () => {
	it("remembers pushes and PR creations, not other git commands", () => {
		expect(isPushCommand("git push")).toBe(true);
		expect(isPushCommand("git push -u origin feat")).toBe(true);
		expect(isPushCommand("cd app && git -C ../x push origin HEAD")).toBe(true);
		expect(isPushCommand('gh pr create --fill --title "x"')).toBe(true);
		expect(isPushCommand('git commit -m "push it"')).toBe(false);
		expect(isPushCommand("git push --dry-run")).toBe(false);
		expect(isPushCommand("git pull")).toBe(false);
	});
});

describe("git remotes", () => {
	it("reads https, scp-like and ssh remotes", () => {
		expect(parseGitRemote("https://github.com/o/r.git")).toEqual({ host: "github.com", repo: "o/r" });
		expect(parseGitRemote("https://x-access-token:t@GitHub.com/o/r")).toEqual({ host: "github.com", repo: "o/r" });
		expect(parseGitRemote("github.com:o/r.git")).toEqual({ host: "github.com", repo: "o/r" });
		expect(parseGitRemote("git@github.com:o/r.git")).toEqual({ host: "github.com", repo: "o/r" });
		expect(parseGitRemote("ssh://git@ghe.example.com:2222/o/r.git")).toEqual({
			host: "ghe.example.com",
			repo: "o/r",
		});
		expect(parseGitRemote("/tmp/remote.git")).toBeUndefined();
	});
});

describe("git push output", () => {
	it("reads a fast-forward push", () => {
		const output = [
			"Enumerating objects: 5, done.",
			"Writing objects: 100% (3/3), 310 bytes | 310.00 KiB/s, done.",
			"To https://github.com/o/r.git",
			"   1a2b3c4..5d6e7f8  main -> main",
		].join("\n");
		expect(parseGitPush(output, GITHUB)).toEqual([
			{ host: "github.com", repo: "o/r", branch: "main", sha: "5d6e7f8" },
		]);
	});

	it("reads a new branch without a sha and a forced update with one", () => {
		const output = [
			"remote: Create a pull request for 'feat' on GitHub by visiting:",
			"remote:      https://github.com/o/r/pull/new/feat",
			"To github.com:o/r.git",
			" * [new branch]      feat -> feat",
			" + a1b2c3d...e4f5a6b x -> x (forced update)",
			"branch 'feat' set up to track 'origin/feat'.",
		].join("\n");
		expect(parseGitPush(output, GITHUB)).toEqual([
			{ host: "github.com", repo: "o/r", branch: "feat" },
			{ host: "github.com", repo: "o/r", branch: "x", sha: "e4f5a6b" },
		]);
	});

	it("skips rejected, up-to-date, deleted refs and tags", () => {
		const output = [
			"To ssh://git@github.com/o/r.git",
			" ! [rejected]        main -> main (fetch first)",
			" = [up to date]      dev -> dev",
			" - [deleted]         old",
			" * [new tag]         v1.0 -> v1.0",
			"   1111111..2222222  HEAD -> refs/tags/moved",
			"error: failed to push some refs to 'github.com:o/r.git'",
		].join("\n");
		expect(parseGitPush(output, GITHUB)).toEqual([]);
		expect(parseGitPush("Everything up-to-date", GITHUB)).toEqual([]);
	});

	it("reads several refs and remotes, keeping only hosts gh serves", () => {
		const output = [
			"To https://gitlab.com/o/elsewhere.git",
			"   1111111..2222222  main -> main",
			"To https://github.com/o/r.git",
			"   3333333..4444444  main -> main",
			"   5555555..6666666  HEAD -> refs/heads/release",
		].join("\n");
		expect(parseGitPush(output, GITHUB)).toEqual([
			{ host: "github.com", repo: "o/r", branch: "main", sha: "4444444" },
			{ host: "github.com", repo: "o/r", branch: "release", sha: "6666666" },
		]);
	});
});

describe("gh pr create output", () => {
	it("reads the PR URL gh prints", () => {
		const output = ["Creating pull request for feat into main in o/r", "", "https://github.com/o/r/pull/42"].join(
			"\n",
		);
		expect(parsePrCreate(output, gh)).toEqual([{ host: "github.com", repo: "o/r", pr: 42 }]);
		expect(parsePrCreate("a pull request for branch already exists", gh)).toEqual([]);
	});
});

const T0 = 1_000_000_000_000;
const watch = (over: Partial<CiWatchRecord> = {}): CiWatchRecord => ({
	id: "ci-a",
	host: "github.com",
	repo: "o/r",
	branch: "main",
	sha: "5d6e7f8",
	at: T0,
	...over,
});

describe("cadence and end rules", () => {
	it("ends a watch 24 h after the push, or 2 h after a newer push of the branch", () => {
		expect(ciDeadline(watch())).toEqual({ at: T0 + CI_EXPIRE_MS, reason: "expired" });
		expect(ciDeadline(watch(), T0 + 60_000)).toEqual({ at: T0 + 60_000 + CI_SUPERSEDED_MS, reason: "superseded" });
		expect(ciDeadline(watch(), T0 + CI_EXPIRE_MS - 1000).reason).toBe("expired");
	});

	it("waits for runs, calls a commit with none after 10 min no CI, delivers a settled outcome", () => {
		expect(readVerdict(watch(), 0, "pending", T0 + 30_000)).toBe("pending");
		expect(readVerdict(watch(), 0, "pending", T0 + CI_NO_RUNS_MS)).toBe("no_ci");
		expect(readVerdict(watch(), 2, "pending", T0 + CI_NO_RUNS_MS * 3)).toBe("pending");
		expect(readVerdict(watch(), 2, "failure", T0 + 90_000)).toBe("deliver");
		expect(readVerdict(watch(), 1, "success", T0 + 90_000)).toBe("deliver");
	});

	it("backs off failed reads from 60 s to 15 min, and waits 5 min at GitHub's rate limit", () => {
		expect([1, 2, 3, 4, 5, 6].map(failures => retryDelay(failures, false))).toEqual([
			CI_POLL_MS,
			2 * CI_POLL_MS,
			4 * CI_POLL_MS,
			8 * CI_POLL_MS,
			CI_BACKOFF_MAX_MS,
			CI_BACKOFF_MAX_MS,
		]);
		expect(retryDelay(1, true)).toBe(CI_RATE_LIMIT_WAIT_MS);
	});
});

const watchEntry = (data: CiWatchRecord) => ({ type: "custom", customType: CI_WATCH_ENTRY, data });
const ciMessage = (details: Record<string, unknown>) => ({
	type: "custom_message",
	customType: CI_MESSAGE_TYPE,
	details,
});

describe("re-arming after a relaunch", () => {
	it("reads again what is younger than 24 h, not ended and not delivered, with its supersession", () => {
		const entries = [
			watchEntry(watch({ id: "old", at: T0 - CI_EXPIRE_MS - 1 })),
			watchEntry(watch({ id: "ended" })),
			{ type: "custom", customType: CI_WATCH_END_ENTRY, data: { id: "ended", reason: "no_ci" } },
			watchEntry(watch({ id: "told" })),
			ciMessage({ id: "told", repo: "o/r", sha: "x" }),
			watchEntry(watch({ id: "first", at: T0 + 1 })),
			watchEntry(watch({ id: "pr", branch: undefined, pr: 7, at: T0 + 2 })),
			watchEntry(watch({ id: "second", at: T0 + 3 })),
			watchEntry(watch({ id: "other", branch: "dev", at: T0 + 4 })),
			{ type: "custom", customType: CI_WATCH_ENTRY, data: { id: "broken" } },
		];
		expect(pendingWatches(entries, T0 + 10)).toEqual([
			{ watch: watch({ id: "first", at: T0 + 1 }), supersededAt: T0 + 3 },
			{ watch: watch({ id: "pr", branch: undefined, pr: 7, at: T0 + 2 }) },
			{ watch: watch({ id: "second", at: T0 + 3 }) },
			{ watch: watch({ id: "other", branch: "dev", at: T0 + 4 }) },
		]);
	});
});

describe("delivery", () => {
	const SHA = "5d6e7f8a".padEnd(40, "0");

	it("tells a watch once, and a commit once when a push and its PR both watched it", () => {
		const entries = [ciMessage({ id: "ci-a", repo: "o/r", sha: SHA })];
		expect(isDelivered(entries, "ci-a", "o/r")).toBe(true);
		expect(isDelivered(entries, "ci-b", "o/r", SHA)).toBe(true);
		expect(isDelivered(entries, "ci-b", "o/other", SHA)).toBe(false);
		expect(isDelivered([], "ci-a", "o/r", SHA)).toBe(false);
	});

	it("names the failed jobs (five at most) and the failed run", () => {
		const runs = [
			{ url: "https://github.com/o/r/actions/runs/1", ok: true, jobs: [{ name: "lint", conclusion: "success" }] },
			{
				url: "https://github.com/o/r/actions/runs/2",
				ok: false,
				jobs: ["a", "b", "c", "d", "e", "f", "a"].map(name => ({ name, conclusion: "failure" })),
			},
		];
		expect(
			ciFailure(
				runs,
				run => !run.ok,
				job => job.conclusion === "failure",
			),
		).toEqual({ failed: ["a", "b", "c", "d", "e"], url: "https://github.com/o/r/actions/runs/2" });
	});

	it("writes the line the model reads, which the transcript parses back", () => {
		const base = { id: "ci-a", host: "github.com", repo: "o/r", branch: "main", sha: SHA };
		expect(ciResultText({ ...base, outcome: "success", failed: [] })).toBe("CI passed for o/r@5d6e7f8 (main).");
		const failure = {
			...base,
			outcome: "failure" as const,
			failed: ["check", "native"],
			url: "https://github.com/o/r/actions/runs/2",
		};
		expect(ciResultText(failure)).toBe(
			"CI failed for o/r@5d6e7f8 (main): check, native. https://github.com/o/r/actions/runs/2",
		);
		expect(parseCiResult(failure)).toEqual(failure);
		expect(parseCiResult({ ...failure, url: "javascript:alert(1)" })).toEqual({
			...base,
			outcome: "failure",
			failed: ["check", "native"],
		});
	});
});
