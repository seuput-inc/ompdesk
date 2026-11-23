import { describe, expect, it } from "vitest";
import type { GithubEventKind } from "../../shared/schedules";
import type { CoreRunner } from "../local/git/exec";
import { fakeGh, fixture, gate, until } from "./test-context";

type Tool = { home: string; runner: CoreRunner | null };
async function github(kinds: GithubEventKind[], initial: Record<string, unknown>, repo = "o/r") {
	let reads = gate<Tool>();
	const f = await fixture({ ports: { github: () => reads.ask() } });
	const gh = fakeGh(f.dir, initial);
	const id = await f.add({ source: "github", repo, events: kinds });
	const poll = async () => {
		for (let i = 0; i < kinds.length; i++) await reads.allow(gh.tool);
		await reads.waiting();
	};
	return {
		f,
		gh,
		id,
		poll,
		reopen: async () => {
			await f.close();
			reads = gate<Tool>();
			await f.reopen();
		},
	};
}

const pull = (number: number, title: string, login: string) => ({
	number,
	title,
	user: { login },
	html_url: `https://github.com/o/r/pull/${number}`,
});

describe("GitHub sources through the real core and fixture gh", () => {
	it("baselines, catches up offline exactly once and publishes new PRs oldest first", async () => {
		const { f, gh, id, poll, reopen } = await github(["pull_request"], {
			"repos/o/r/pulls": [pull(1, "Old", "bob")],
		});
		await poll();
		expect(f.fired).toEqual([]);
		await f.close();
		expect(f.marks()[id]?.mark).toEqual({ seen: { pull_request: [1] } });
		gh.answers["repos/o/r/pulls"] = [pull(3, "Three", "c"), pull(2, "Two", "b"), pull(1, "Old", "bob")];
		await reopen();
		await poll();
		await until(() =>
			expect(f.fired).toEqual([
				'PR #2 "Two" opened by b: https://github.com/o/r/pull/2',
				'PR #3 "Three" opened by c: https://github.com/o/r/pull/3',
			]),
		);
		await reopen();
		await poll();
		expect(gh.calls).toHaveLength(3);
		expect(f.fired).toHaveLength(2);
	});

	it("follows selected kinds in the shared order, ignoring PRs on issues and draft releases", async () => {
		const commit = (sha: string, message: string) => ({ sha, commit: { message: `${message}\n\nbody` } });
		const run = (id: number, branch: string) => ({
			id,
			name: "CI",
			display_title: "Fix login",
			head_branch: branch,
			conclusion: "failure",
			html_url: `https://github.com/o/r/actions/runs/${id}`,
		});
		const { f, gh, poll } = await github(["push", "release", "ci_failure", "issue"], {
			"repos/o/r/issues": [],
			"repos/o/r/actions/runs": { workflow_runs: [run(100, "main")] },
			"repos/o/r/releases": [{ id: 1, tag_name: "v1", html_url: "u1" }],
			"repos/o/r/commits": [commit("aaaaaaa1111", "Start")],
			"repos/o/r": { default_branch: "main" },
		});
		await poll();
		expect(f.fired).toEqual([]);
		expect(gh.calls[0]).toMatch(/^repos\/o\/r\/issues\?/);
		expect(gh.calls[1]).toBe("repos/o/r/actions/runs?status=failure&per_page=20");
		expect(gh.calls).toContain("repos/o/r/commits?sha=main&per_page=20");
		gh.answers["repos/o/r/issues"] = [
			{ ...pull(9, "PR", "p"), pull_request: {} },
			{ number: 8, title: "Crash on start", user: { login: "bob" }, html_url: "https://github.com/o/r/issues/8" },
		];
		gh.answers["repos/o/r/actions/runs"] = { workflow_runs: [run(101, "feature"), run(100, "main")] };
		gh.answers["repos/o/r/releases"] = [
			{ id: 3, tag_name: "v1.2", draft: true },
			{ id: 2, tag_name: "v1.1.0", name: "Spring", author: { login: "alice" }, html_url: "u2" },
		];
		gh.answers["repos/o/r/commits"] = [
			commit("ccccccc3333", "Fix it"),
			commit("bbbbbbb2222", "Add it"),
			commit("aaaaaaa1111", "Start"),
		];
		await poll();
		await until(() =>
			expect(f.fired).toEqual([
				'Issue #8 "Crash on start" opened by bob: https://github.com/o/r/issues/8',
				'CI failure: workflow "CI" on feature ("Fix login"): https://github.com/o/r/actions/runs/101',
				'Release v1.1.0 "Spring" published by alice: u2',
				"2 new commits on main (o/r): ccccccc Fix it; bbbbbbb Add it",
			]),
		);
		await poll();
		expect(f.fired).toHaveLength(4);
	});

	it("baselines on first success, keeps the last good cursor through failures and reports distinct failures once", async () => {
		const { f, gh, id, poll } = await github(["pull_request"], { "repos/o/r/pulls": new Error("offline") });
		await poll();
		gh.answers["repos/o/r/pulls"] = [pull(1, "Old", "a")];
		await poll();
		expect(f.fired).toEqual([]);
		gh.answers["repos/o/r/pulls"] = new Error("offline");
		await poll();
		await poll();
		gh.answers["repos/o/r/pulls"] = new Error("HTTP 404");
		await poll();
		expect(f.log).toEqual([
			"Routine: github o/r: pull_request: offline",
			"Routine: github o/r: pull_request: offline",
			"Routine: github o/r: pull_request: HTTP 404",
		]);
		expect(f.marks()[id]?.mark).toEqual({ seen: { pull_request: [1] } });
		gh.answers["repos/o/r/pulls"] = [pull(2, "Two", "b"), pull(1, "Old", "a")];
		await poll();
		expect(f.fired).toEqual(['PR #2 "Two" opened by b: https://github.com/o/r/pull/2']);
		await f.close();
		expect(f.marks()[id]?.mark).toEqual({ seen: { pull_request: [1, 2] } });
		const calls = gh.calls.length;
		expect(calls).toBe(6);
	});

	it("never starts gh for a dot path", async () => {
		const { f, gh } = await github(["push"], {}, "o/..");
		await until(() => expect(f.log).toEqual(["Routine: github o/..: not an owner/name repository"]));
		expect(gh.calls).toEqual([]);
		expect(f.launched).toEqual([]);
	});
});
