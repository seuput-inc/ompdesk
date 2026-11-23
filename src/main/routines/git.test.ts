import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { core } from "../core/process";
import type { CoreRunner } from "../local/git/exec";
import { gitSync, initRepo } from "../local/git/test-repos";
import { fixture, gate, testGit, until } from "./test-context";

async function repository(branch = "main", hold = false) {
	let reads = gate<CoreRunner>();
	const f = await fixture({ hold, ports: { git: () => reads.ask() } });
	await initRepo(f.work);
	const tool = await testGit(f.dir);
	const id = await f.add({ source: "git", repo: f.work, branch });
	const head = () => gitSync(f.work, "rev-parse", "HEAD");
	const commit = (message: string) => {
		writeFileSync(join(f.work, "f.txt"), `${message}\n`);
		gitSync(f.work, "add", "f.txt");
		gitSync(f.work, "commit", "--no-gpg-sign", "-q", "-m", message);
		return gitSync(f.work, "rev-parse", "--short", "HEAD");
	};
	return {
		f,
		id,
		tool,
		head,
		commit,
		read: () => reads.allow(tool),
		waiting: () => reads.waiting(),
		at: (head: string | null) => until(() => expect(f.marks()[id]?.mark).toEqual({ head })),
		reopen: async () => {
			await f.close();
			reads = gate<CoreRunner>();
			await f.reopen();
		},
	};
}

describe("the native git source on a local repository", () => {
	it("saves before the separate log lookup, reports commits newest first and does not fire again on the same head", async () => {
		const g = await repository();
		await g.read();
		await g.at(g.head());
		expect(g.f.fired).toEqual([]);
		const a = g.commit("Fix login"),
			b = g.commit("Add tests");
		await g.read();
		await g.waiting();
		await g.at(g.head());
		expect(g.f.fired).toEqual([]);
		await g.read();
		await until(() => expect(g.f.fired).toEqual([`2 new commits on main: ${b} Add tests; ${a} Fix login`]));
		await g.read();
		await g.waiting();
		expect(g.f.fired).toHaveLength(1);
	});

	it("catches up once after relaunch, listing ten commits and counting the rest", async () => {
		const g = await repository();
		await g.read();
		await g.at(g.head());
		await g.f.close();
		for (let i = 0; i < 12; i++) g.commit(`commit ${i}`);
		await g.reopen();
		await g.read();
		await g.read();
		await until(() => expect(g.f.fired).toEqual([expect.stringMatching(/^12 new commits on main: .*; and 2 more$/)]));
		expect(g.f.fired[0]!.split("; ")).toHaveLength(11);
		await g.reopen();
		await g.read();
		await g.waiting();
		expect(g.f.fired).toHaveLength(1);
	}, 30_000);

	it("takes the routine's own commits as baseline even if its run ends inside a pending read", async () => {
		const g = await repository("main", true);
		await g.read();
		await g.at(g.head());
		await g.waiting();
		await g.f.service.command({ action: "runNow", id: g.id });
		g.commit("by the routine");
		g.f.launched[0]!.finish();
		await until(() => expect(g.f.service.latest.runs[0]?.status).toBe("succeeded"));
		await g.read();
		await g.at(g.head());
		await g.read(); // the immediate run-ended rebase
		await g.waiting();
		expect(g.f.fired).toEqual([]);
		const later = g.commit("after the run");
		await g.read();
		await g.read();
		await until(() => expect(g.f.fired).toEqual([`1 new commit on main: ${later} after the run`]));
	});

	it("baselines a newly-created branch; a missing branch with a known head preserves it until it returns", async () => {
		const g = await repository("later");
		await g.read();
		await g.at(null);
		await g.read();
		await g.waiting();
		expect(g.f.log).toHaveLength(1);
		expect(g.f.log[0]).toContain("the branch does not exist");
		gitSync(g.f.work, "branch", "later");
		const base = g.head();
		await g.read();
		await g.at(base);
		gitSync(g.f.work, "branch", "-D", "later");
		await g.read();
		await g.waiting();
		expect(g.f.log).toHaveLength(2);
		expect(g.f.marks()[g.id]?.mark).toEqual({ head: base });
		const next = g.commit("restored change");
		gitSync(g.f.work, "branch", "later");
		await g.read();
		await g.read();
		await until(() => expect(g.f.fired).toEqual([`1 new commit on later: ${next} restored change`]));
		// A branch moved backwards has no new commits.
		await until(() => expect(g.f.service.latest.runs[0]?.status).toBe("succeeded"));
		gitSync(g.f.work, "branch", "-f", "later", base);
		await g.read();
		await g.at(base);
		await g.read();
		await g.waiting();
		await g.f.close();
		expect(g.f.fired).toHaveLength(1);
	});

	it("replaces a malformed persisted head with the first observation", async () => {
		const g = await repository();
		for (const [branch, expected] of [
			["main", { kind: "changed", mark: { head: g.head() }, from: null }],
			["absent", { kind: "missing", mark: { head: null } }],
		] as const) {
			expect(
				(await core().call("git.routineHead", { git: g.tool, repo: g.f.work, branch, mark: { head: 42 } })).result,
			).toEqual(expected);
		}
	});

	it("deduplicates a repository read failure and never reads or marks after the service closes", async () => {
		const reads = gate<CoreRunner>();
		const f = await fixture({ ports: { git: reads.ask } });
		const id = await f.add({ source: "git", repo: f.work, branch: "main" });
		const tool = await testGit(f.dir);
		await reads.allow(tool);
		await reads.allow(tool);
		await reads.waiting();
		expect(f.log).toHaveLength(1);
		expect(f.service.latest.runs).toMatchObject([{ scheduleId: id, trigger: "event", status: "failed" }]);
		await f.close();
		await reads.allow(tool);
		expect(f.fired).toEqual([]);
		expect(f.marks()).toEqual({});
	});
});
