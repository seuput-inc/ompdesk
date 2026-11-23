/**
 * Git's repository selectors (GIT_DIR and its kin) leak into every child git when OMPdesk or a test runs under
 * `git bisect run`, a hook or a shell inside a git operation. Neither the test repositories nor the app's own git
 * runner may follow them: one such run once set a shared checkout's `.git/config` to `core.bare = true` with a test
 * identity. A sacrificial repository stands where the leaked variables point and must come out byte-identical.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_REPO_SELECTOR_ENV } from "../../../shared/git-env";
import { getGitChanges, getGitStatus } from "./changes";
import { stage } from "./scm";
import { gitSync, initRepo } from "./test-repos";

let root: string;
let saved: Record<string, string | undefined>;

/** git in `cwd` with no selector at all, whatever the test set. */
function cleanGit(cwd: string, ...args: string[]): string {
	const env = { ...process.env };
	for (const name of GIT_REPO_SELECTOR_ENV) delete env[name];
	return execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
}

/** What a stray git command would change in a repository: its config, HEAD, refs and index. */
async function fingerprint(repo: string): Promise<string> {
	const git = path.join(repo, ".git");
	return JSON.stringify({
		config: await fs.readFile(path.join(git, "config"), "utf8"),
		head: await fs.readFile(path.join(git, "HEAD"), "utf8"),
		refs: cleanGit(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
		index: (await fs.readFile(path.join(git, "index"))).toString("base64"),
	});
}

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-env-")));
	saved = Object.fromEntries(GIT_REPO_SELECTOR_ENV.map(name => [name, process.env[name]]));
});

afterEach(async () => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await fs.rm(root, { recursive: true, force: true });
});

describe("git under leaked repository selectors", () => {
	it("reads and stages in the requested repository without changing the one the selectors name", async () => {
		const sacrificial = path.join(root, "sacrificial");
		await fs.mkdir(sacrificial);
		cleanGit(sacrificial, "init", "-q", "-b", "main");
		await fs.writeFile(path.join(sacrificial, "kept.txt"), "kept\n");
		cleanGit(sacrificial, "add", ".");
		cleanGit(sacrificial, "-c", "user.email=k@example.com", "-c", "user.name=k", "commit", "-q", "-m", "kept");
		const before = await fingerprint(sacrificial);

		// What `git bisect run` from a linked worktree, or a hook, exports.
		process.env.GIT_DIR = path.join(sacrificial, ".git");
		process.env.GIT_WORK_TREE = sacrificial;
		process.env.GIT_INDEX_FILE = path.join(sacrificial, ".git", "index");

		const repo = path.join(root, "repo");
		await initRepo(repo);
		gitSync(repo, "config", "user.name", "Someone Else");
		await fs.writeFile(path.join(repo, "added.txt"), "added\n");
		const changes = await getGitChanges(repo);
		expect(changes.root).toBe(repo);
		expect(changes.files).toEqual([{ path: "added.txt", status: "??" }]);
		expect(await getGitStatus(repo)).toMatchObject({ isRepo: true, untracked: 1, staged: 0, unstaged: 0 });

		await stage(repo, ["added.txt"]);
		expect(cleanGit(repo, "log", "--format=%s")).toBe("init");
		expect(cleanGit(repo, "diff", "--cached", "--name-only")).toBe("added.txt");
		expect(await fingerprint(sacrificial)).toBe(before);
	});
});
