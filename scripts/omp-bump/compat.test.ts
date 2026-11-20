import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseOmpCompat } from "../../src/shared/omp-compat";
import { type Git, gitIn, readCompat, recordOnBranch } from "./compat";

const APP = "0.134.1";
const green = { green: true } as const;

let root: string;
let origin: string;
let n = 0;

function run(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

/** A checkout of its own with `origin` as its remote, like one job's. */
function clone(): string {
	const dir = path.join(root, `work-${n++}`);
	fs.mkdirSync(dir);
	run(dir, "init", "--quiet");
	run(dir, "remote", "add", "origin", origin);
	return dir;
}

/** What origin's branch holds, read without the code under test. */
const branch = {
	exists: () => spawnSync("git", ["rev-parse", "--verify", "--quiet", "omp-compat"], { cwd: origin }).status === 0,
	commits: () => run(origin, "log", "--format=%an <%ae>|%s", "omp-compat").split("\n"),
	files: () => run(origin, "ls-tree", "-r", "--name-only", "omp-compat").split("\n"),
	list: () => parseOmpCompat(`${run(origin, "show", "omp-compat:omp-compat.json")}\n`),
};

/** Puts `files` on origin's branch as someone else's commit. */
function seed(files: Record<string, string>): void {
	const dir = clone();
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
	run(dir, "add", "-A");
	run(dir, "-c", "user.name=someone", "-c", "user.email=someone@example.com", "commit", "--quiet", "-m", "by hand");
	run(dir, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/omp-compat");
}

/** A git that lets `rival` push first, each time this one is about to push: the race a writer can lose. */
function racing(dir: string, rival: (attempt: number) => void): Git {
	const git = gitIn(dir);
	let pushes = 0;
	return (args, input) => {
		if (args[0] === "push") rival(++pushes);
		return git(args, input);
	};
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-compat-"));
	// The person's own git settings (signing, hooks, templates) are not the runner's.
	const config = path.join(root, "gitconfig");
	fs.writeFileSync(config, "");
	vi.stubEnv("GIT_CONFIG_GLOBAL", config);
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	// A lost race is reported on stderr, with git's own words; the tests read the branch instead.
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

beforeEach(() => {
	origin = path.join(root, `origin-${n++}.git`);
	fs.mkdirSync(origin);
	run(origin, "init", "--quiet", "--bare");
});

describe("readCompat", () => {
	it("reads a missing branch and a branch without the file as no list, and the file as it is", () => {
		const git = gitIn(clone());
		expect(readCompat(git)).toEqual({ commit: null, text: null });
		seed({ "README.md": "not the list\n" });
		expect(readCompat(git)).toEqual({ commit: run(origin, "rev-parse", "omp-compat"), text: null });
		seed({ "omp-compat.json": "{}\n" });
		expect(readCompat(git).text).toBe("{}\n");
	});

	it("fails rather than read an unreachable origin as an empty list", () => {
		const dir = clone();
		run(dir, "remote", "set-url", "origin", path.join(root, "nowhere.git"));
		expect(() => readCompat(gitIn(dir))).toThrow(/git ls-remote failed/);
	});
});

describe("recordOnBranch", () => {
	it("creates the branch as one bot commit that holds only the list", () => {
		const recorded = recordOnBranch(gitIn(clone()), { app: APP, omp: "19.1.0", verdict: green, write: true });
		expect(recorded.pushed).toBe(true);
		expect(branch.commits()).toEqual([
			"github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|chore(omp-compat): 0.134.1 green omp 19.1.0",
		]);
		expect(branch.files()).toEqual(["omp-compat.json"]);
		expect(branch.list()).toEqual({ [APP]: { verified: ["19.1.0"], holding: null } });
		expect(run(origin, "show", "omp-compat:omp-compat.json")).toBe(recorded.text.trimEnd());
	});

	it("adds each new verdict on top, and pushes nothing for a verdict the list already holds", () => {
		const git = gitIn(clone());
		recordOnBranch(git, { app: APP, omp: "19.1.0", verdict: green, write: true });
		const red = { green: false, at: "2026-11-20T05:00:00.000Z", issue: 7 } as const;
		expect(recordOnBranch(git, { app: APP, omp: "19.2.0", verdict: red, write: true }).pushed).toBe(true);
		// The same verdict again, from a job with a fresh checkout: a re-run, or a run that died after its push.
		const again = recordOnBranch(gitIn(clone()), { app: APP, omp: "19.2.0", verdict: red, write: true });
		expect(again).toMatchObject({ pushed: false, changed: false });
		expect(branch.commits().map(line => line.split("|")[1])).toEqual([
			"chore(omp-compat): 0.134.1 red omp 19.2.0",
			"chore(omp-compat): 0.134.1 green omp 19.1.0",
		]);
		expect(branch.list()).toEqual({
			[APP]: { verified: ["19.1.0"], holding: { version: "19.2.0", since: red.at, issue: 7 } },
		});
	});

	it("drops whatever else a hand-made commit put on the branch, keeping its history", () => {
		seed({ "omp-compat.json": "{}\n", "notes.txt": "x\n" });
		recordOnBranch(gitIn(clone()), { app: APP, omp: "19.1.0", verdict: green, write: true });
		expect(branch.files()).toEqual(["omp-compat.json"]);
		expect(branch.commits()).toHaveLength(2);
	});

	it("reads the branch again after losing a race, so both writers' verdicts are in the list", () => {
		const rival = gitIn(clone());
		const git = racing(clone(), attempt => {
			if (attempt === 1) recordOnBranch(rival, { app: "0.134.0", omp: "19.0.1", verdict: green, write: true });
		});
		expect(recordOnBranch(git, { app: APP, omp: "19.1.0", verdict: green, write: true }).pushed).toBe(true);
		expect(branch.list()).toEqual({
			"0.134.0": { verified: ["19.0.1"], holding: null },
			[APP]: { verified: ["19.1.0"], holding: null },
		});
		expect(branch.commits()).toHaveLength(2);
	});

	it("loses the race to create the branch without writing over the winner", () => {
		const rival = gitIn(clone());
		const git = racing(clone(), attempt => {
			if (attempt === 1) recordOnBranch(rival, { app: APP, omp: "19.0.1", verdict: green, write: true });
		});
		recordOnBranch(git, { app: APP, omp: "19.1.0", verdict: green, write: true });
		expect(branch.list()).toEqual({ [APP]: { verified: ["19.0.1", "19.1.0"], holding: null } });
	});

	it("gives up after three rejected pushes and leaves the branch to the writers that won", () => {
		const rival = gitIn(clone());
		const git = racing(clone(), attempt => {
			recordOnBranch(rival, { app: APP, omp: `19.0.${attempt}`, verdict: green, write: true });
		});
		expect(() => recordOnBranch(git, { app: APP, omp: "19.1.0", verdict: green, write: true })).toThrow(
			/git push failed 3 times/,
		);
		expect(branch.list()).toEqual({ [APP]: { verified: ["19.0.1", "19.0.2", "19.0.3"], holding: null } });
	});

	it("only says what it would write in a rehearsal", () => {
		const recorded = recordOnBranch(gitIn(clone()), { app: APP, omp: "19.1.0", verdict: green, write: false });
		expect(recorded).toMatchObject({ pushed: false, changed: true });
		expect(parseOmpCompat(recorded.text)).toEqual({ [APP]: { verified: ["19.1.0"], holding: null } });
		expect(branch.exists()).toBe(false);
	});

	it("refuses to write over a file that is not the list", () => {
		seed({ "omp-compat.json": '{"0.134.1": {"verified": ["latest"]}}\n' });
		const before = run(origin, "rev-parse", "omp-compat");
		expect(() => recordOnBranch(gitIn(clone()), { app: APP, omp: "19.1.0", verdict: green, write: true })).toThrow(
			/not a verified-omp list/,
		);
		expect(run(origin, "rev-parse", "omp-compat")).toBe(before);
	});

	it("writes a rehearsal to its probe branch and leaves the list apps read alone", () => {
		const git = gitIn(clone());
		recordOnBranch(git, { app: APP, omp: "19.1.0", verdict: green, write: true });
		const before = run(origin, "rev-parse", "omp-compat");
		const probe = "probe/omp-compat-rehearsal";
		const recorded = recordOnBranch(git, { app: APP, omp: "19.2.0", verdict: green, write: true, branch: probe });
		expect(recorded.pushed).toBe(true);
		expect(parseOmpCompat(`${run(origin, "show", `${probe}:omp-compat.json`)}\n`)).toEqual({
			[APP]: { verified: ["19.2.0"], holding: null },
		});
		expect(run(origin, "rev-parse", "omp-compat")).toBe(before);
		for (const elsewhere of ["main", "probe/other", "omp-compat-x", "probe/omp-compat-../main"]) {
			expect(() =>
				recordOnBranch(git, { app: APP, omp: "19.2.0", verdict: green, write: true, branch: elsewhere }),
			).toThrow(/not a branch the verified list may be written to/);
		}
	});
});
