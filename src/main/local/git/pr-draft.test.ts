import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import { RM_TEMP, writeFakeBin, writeFakeOmp } from "../../test-fake-omp";
import { resolveBin } from "./exec";
import { prDraft } from "./pr";
import { gitSync, initRepo } from "./test-repos";

it("drafts from the checkout root with stock's print flags and literal stdin", async () => {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ompdesk-pr-draft-")));
	try {
		const repo = path.join(dir, "repo");
		const sub = path.join(repo, "sub");
		const bin = path.join(dir, "bin");
		await fs.mkdir(bin);
		const gh = await writeFakeBin(
			bin,
			"gh",
			`
if (process.argv.slice(2).join(" ") !== "repo view --json nameWithOwner,defaultBranchRef") process.exit(1);
process.stdout.write('{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}');`,
		);
		const basePath = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
		vi.stubEnv("PATH", basePath);
		vi.stubEnv("OMP_GUI_TEST_BREW_DIRS", "");
		vi.stubEnv("FORCE_COLOR", "2");
		expect(await resolveBin("gh")).toBe(gh);
		const seen = path.join(dir, "seen.json");
		const fail = path.join(dir, "fail");
		const omp = {
			bin: await writeFakeOmp(
				dir,
				`
const input = await Bun.stdin.text();
await Bun.write(${JSON.stringify(seen)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),input,color:process.env.FORCE_COLOR}));
if (await Bun.file(${JSON.stringify(fail)}).exists()) {
	process.stderr.write("failure: " + process.env.GH_TOKEN);
	process.exitCode = 9;
}
process.stdout.write('noise {bad} '+JSON.stringify({nested:{title:' T {x} ',body:' B\\nline '}}));`,
			),
			basePath,
		};
		await expect(prDraft(dir, omp, {})).rejects.toMatchObject({ code: "not_a_repo" });
		await expect(fs.stat(seen)).rejects.toMatchObject({ code: "ENOENT" });
		await initRepo(repo);
		await expect(prDraft(repo, omp, {})).rejects.toMatchObject({
			code: "pr_draft_failed",
			message: "No changes between main and main",
		});
		await expect(fs.stat(seen)).rejects.toMatchObject({ code: "ENOENT" });
		gitSync(repo, "checkout", "-qb", "topic");
		await fs.mkdir(sub);
		await fs.writeFile(path.join(sub, "a.txt"), "a\n");
		gitSync(repo, "add", ".");
		const subject = 'Use %PATH% & "$1 {{files}}"';
		gitSync(repo, "commit", "-qm", subject);
		expect(await prDraft(sub, omp, {})).toEqual({ title: "T {x}", body: "B\nline" });
		const system = await fs.readFile(path.resolve("native/ompdesk/crates/core/src/gh/pr-draft-system.md"), "utf8");
		const user = `Base: main — Head: topic\n\nCommits (1):\n${subject}\n\nChanged files (1):\nsub/a.txt\n\n\nDiff stat:\n1\t0\tsub/a.txt\n\n\nDraft the PR title and body as the JSON object.\n`;
		expect(JSON.parse(await fs.readFile(seen, "utf8"))).toEqual({
			args: ["-p", "--no-session", "--no-tools", "--no-lsp"],
			cwd: repo,
			input: `${system.trim()}\n\n---\n\n${user}`,
			color: "2",
		});
		await fs.writeFile(fail, "");
		vi.stubEnv("GH_TOKEN", "fake-draft-error-token");
		await expect(prDraft(sub, omp, {})).rejects.toMatchObject({
			code: "pr_draft_failed",
			message: "The model did not return a draft: failure: ***",
		});
		const missing = path.join(bin, "missing-omp.exe");
		await expect(prDraft(sub, { bin: missing, basePath }, {})).rejects.toMatchObject({
			code: "pr_draft_failed",
			message: `Draft failed: spawn ${missing} ENOENT`,
		});
	} finally {
		vi.unstubAllEnvs();
		await fs.rm(dir, RM_TEMP);
	}
}, 90_000);
