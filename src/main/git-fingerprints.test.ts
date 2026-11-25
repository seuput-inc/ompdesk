import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopCore } from "./core/process";
import { gitFingerprints } from "./git-fingerprints";
import { getGitFingerprint } from "./local/git/changes";
import { gitSync, initRepo } from "./local/git/test-repos";

const trusted = process.platform === "darwin" || process.platform === "win32";

describe("the Changes panel's watched fingerprint", () => {
	let dir: string;
	let root: string;
	let trace: string;
	beforeEach(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-fp-")));
		root = path.join(dir, "repo");
		await initRepo(root);
		trace = path.join(dir, "git-trace.jsonl");
		await fs.writeFile(trace, "");
		vi.stubEnv("GIT_TRACE2_EVENT", trace);
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await stopCore();
		await fs.rm(dir, { recursive: true, force: true });
	});

	const traceSize = async () => (await fs.stat(trace)).size;
	const fingerprint = async (cwd: string) => (await gitFingerprints.read(cwd)).fingerprint;
	const moves = async (cwd: string, change: () => void | Promise<void>) => {
		const before = await fingerprint(cwd);
		await change();
		await expect.poll(() => fingerprint(cwd), { timeout: 5_000 }).not.toBe(before);
	};

	it.runIf(trusted)("runs no git while untouched and sees edits, staging and a stash", async () => {
		const clean = await fingerprint(root);
		const git = await fs.readFile(trace, "utf8");
		expect(git).toContain("--git-common-dir");
		// The watch lookup found the root: the first status needs no separate root lookup.
		expect(git).not.toMatch(/"rev-parse","--show-toplevel"\]/);
		await expect
			.poll(
				async () => {
					const before = await traceSize();
					await fingerprint(root);
					return (await traceSize()) === before;
				},
				{ timeout: 5_000 },
			)
			.toBe(true);
		const settled = await traceSize();
		for (let i = 0; i < 5; i++) expect(await fingerprint(root)).toBe(clean);
		expect(await traceSize()).toBe(settled);
		await moves(root, () => fs.writeFile(path.join(root, "README.md"), "edited\n"));
		await moves(root, () => fs.writeFile(path.join(root, "README.md"), "edited again, same status letters\n"));
		await moves(root, () => {
			gitSync(root, "add", "README.md");
		});
		await moves(root, () => {
			gitSync(root, "stash", "push", "-q");
		});
		expect(await gitFingerprints.read(root, root)).toEqual(await getGitFingerprint(root));
	});

	it.runIf(trusted)("sees a linked worktree edit and a stash made in its separate common git directory", async () => {
		const linked = path.join(dir, "linked");
		gitSync(root, "worktree", "add", "-q", "-b", "linked", linked);
		await moves(linked, () => fs.writeFile(path.join(linked, "README.md"), "worktree edit\n"));
		await moves(linked, async () => {
			await fs.writeFile(path.join(root, "README.md"), "primary edit\n");
			gitSync(root, "stash", "push", "-q");
		});
		expect(await gitFingerprints.read(linked)).toEqual(await getGitFingerprint(linked));
	});

	it("reads git every time outside a repository", async () => {
		await fingerprint(dir);
		const before = await traceSize();
		expect(before).toBeGreaterThan(0);
		await fingerprint(dir);
		expect(await traceSize()).toBeGreaterThan(before);
	});

	it.runIf(!trusted)("reads git on each ask where recursive watches are not trusted", async () => {
		await fingerprint(root);
		const before = await traceSize();
		await fingerprint(root);
		expect(await traceSize()).toBeGreaterThan(before);
	});
});
