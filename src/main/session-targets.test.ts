import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitSync, initRepo } from "./local/git/test-repos";
import { sessionArtwork, sessionTargets } from "./session-targets";

const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

let root: string;
let repo: string;

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-targets-")));
	repo = path.join(root, "acme-web");
	await initRepo(repo);
	await fs.writeFile(path.join(repo, "logo.png"), PIXEL);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("session targets", () => {
	it("names a worktree session's own branch, its repository and that repository's image once looked up", async () => {
		const linked = path.join(root, "gui-feature-1ccaba4");
		gitSync(repo, "worktree", "add", "-q", "-b", "feature", linked);
		const main = gitSync(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
		const rows = [
			{ sessionPath: path.join(root, "main.jsonl"), cwd: repo },
			{ sessionPath: path.join(root, "linked.jsonl"), cwd: linked },
			{ sessionPath: "tab:unsaved", cwd: path.join(repo, "missing") },
			{ sessionPath: path.join(root, "relative.jsonl"), cwd: "relative" },
		];

		const first = await sessionTargets({ sessions: rows });
		expect(first[rows[0].sessionPath]).toEqual({
			path: repo,
			repository: { root: repo, name: "acme-web" },
			head: { kind: "branch", name: main },
		});
		expect(first[rows[1].sessionPath]).toEqual({
			path: linked,
			repository: { root: repo, name: "acme-web" },
			head: { kind: "branch", name: "feature" },
		});
		expect(first[rows[2].sessionPath]).toBeNull();
		expect(first[rows[3].sessionPath]).toBeNull();

		const images = await sessionArtwork({ roots: [repo, linked] });
		expect(images[repo]?.source).toBe("repository");
		expect(images[repo]?.src).toMatch(/^data:image\/png;base64,/);
		// Only a repository's main checkout is a root to read pictures from.
		expect(images[linked]).toBeNull();

		gitSync(linked, "checkout", "-q", "--detach");
		const second = await sessionTargets({ sessions: rows.slice(0, 2) });
		expect(second[rows[0].sessionPath]?.artwork).toEqual(images[repo]);
		expect(second[rows[1].sessionPath]?.head).toEqual({
			kind: "detached",
			commit: gitSync(linked, "rev-parse", "HEAD").trim(),
		});
	});
});
