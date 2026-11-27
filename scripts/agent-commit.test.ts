import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitSync, initRepo, initRepoWithRemote } from "../src/main/local/git/test-repos";
import { withoutGitSelectors } from "../src/shared/git-env";

const SCRIPT = path.join(import.meta.dirname, "agent-commit.sh");

// POSIX only: `bash` on a Windows PATH may be WSL's (System32), which sees neither this checkout's paths nor bun.
describe.skipIf(process.platform === "win32")("agent-commit.sh", () => {
	let repo: string;
	let temp: string;
	beforeEach(async () => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-commit-repo-"));
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-commit-temp-"));
		await initRepo(repo);
	});
	afterEach(() => {
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(temp, { recursive: true, force: true });
	});

	const commit = (...args: string[]) =>
		spawnSync("bash", [SCRIPT, ...args], {
			cwd: repo,
			encoding: "utf8",
			env: { ...withoutGitSelectors(process.env), TMPDIR: temp },
		});

	it("commits TypeScript files and leaves nothing in the temp folder", () => {
		fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
		fs.writeFileSync(path.join(repo, "b.tsx"), "export const b = <i />;\n");

		const done = commit("-m", "feat: two files", "a.ts", "b.tsx");

		expect(done.status, done.stderr).toBe(0);
		expect(gitSync(repo, "log", "-1", "--format=%s")).toBe("feat: two files");
		expect(fs.readdirSync(temp)).toEqual([]);
	});

	it("refuses a file that does not parse, and still leaves nothing in the temp folder", () => {
		fs.writeFileSync(path.join(repo, "broken.ts"), "export const = ;\n");

		const refused = commit("-m", "feat: broken", "broken.ts");

		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain("broken.ts does not parse");
		expect(gitSync(repo, "log", "-1", "--format=%s")).toBe("init");
		expect(fs.readdirSync(temp)).toEqual([]);
	});

	describe("a finished work branch on a bare origin", () => {
		const branch = "omp/agent/finished";
		let origin: string;
		let accepted: string;
		let tree: string;
		const remoteTip = (name: string) =>
			gitSync(origin, "for-each-ref", "--format=%(objectname)", `refs/heads/${name}`);
		const retire = (name: string, sha: string) =>
			spawnSync("bun", [path.join(import.meta.dirname, "publish-work.ts"), "--published", name, sha], {
				cwd: repo,
				encoding: "utf8",
				env: withoutGitSelectors(process.env),
				timeout: 30_000,
			});

		beforeEach(async () => {
			origin = path.join(temp, "origin.git");
			fs.rmSync(repo, { recursive: true });
			await initRepoWithRemote(repo, origin);
			tree = path.join(temp, "worker");
			gitSync(repo, "worktree", "add", "-b", branch, tree);
			fs.writeFileSync(path.join(tree, "work"), "accepted");
			gitSync(tree, "add", "work");
			gitSync(tree, "commit", "-m", "worker result");
			gitSync(tree, "push", "origin", branch);
			accepted = remoteTip(branch);
		});

		it("retires only the published remote copy; a second call preserves the checkout and local ref", () => {
			gitSync(repo, "merge", "--ff-only", branch);
			fs.writeFileSync(path.join(repo, "receipt"), "land");
			const done = commit("--push", "--retire-work", branch, accepted, "-m", "land", "receipt");
			expect(done.status, done.stderr).toBe(0);
			expect(remoteTip(branch)).toBe("");
			expect(remoteTip("main")).toBe(gitSync(repo, "rev-parse", "HEAD"));
			const again = retire(branch, accepted);
			expect(again.status, again.stderr).toBe(0);
			expect(gitSync(tree, "rev-parse", branch)).toBe(accepted);
			expect(fs.readFileSync(path.join(tree, "work"), "utf8")).toBe("accepted");
		});

		it("keeps unpublished work, a moved accepted ref even when landed, and main", () => {
			expect(retire(branch, accepted).stdout).toContain("not in origin/main");
			expect(remoteTip(branch)).toBe(accepted);
			gitSync(tree, "commit", "--allow-empty", "-m", "new work");
			const moved = gitSync(tree, "rev-parse", "HEAD");
			gitSync(tree, "push", "origin", branch, "HEAD:main");
			expect(retire(branch, accepted).stdout).toContain("no longer holds the accepted work tip");
			expect(remoteTip(branch)).toBe(moved);
			expect(retire("main", moved).stdout).toContain("stays");
			expect(remoteTip("main")).toBe(moved);
		});

		it("a rejected main publication never retires even an already-merged branch", () => {
			gitSync(tree, "push", "origin", "HEAD:main");
			gitSync(repo, "merge", "--ff-only", branch);
			const main = remoteTip("main");
			fs.writeFileSync(path.join(origin, "hooks", "pre-receive"), "#!/bin/sh\n! grep -q ' refs/heads/main$'\n", {
				mode: 0o755,
			});
			fs.writeFileSync(path.join(repo, "receipt"), "not published");
			const refused = commit("--push", "--retire-work", branch, accepted, "-m", "land", "receipt");
			expect(refused.status).not.toBe(0);
			expect(remoteTip("main")).toBe(main);
			expect(remoteTip(branch)).toBe(accepted);
		});
	});
});
