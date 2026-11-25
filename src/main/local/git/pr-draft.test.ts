import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import { withCreditSpendRuns } from "../../omp-launch";
import { RM_TEMP, writeFakeBin } from "../../test-fake-omp";
import type { OmpRuntime } from "../types";
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
		const policyOff = path.join(dir, "policy-off");
		const gh = await writeFakeBin(
			bin,
			"gh",
			`
if (process.argv.slice(2).join(" ") !== "repo view --json nameWithOwner,defaultBranchRef") process.exit(1);
await Bun.write(${JSON.stringify(policyOff)}, "");
process.stdout.write('{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}');`,
		);
		const basePath = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
		vi.stubEnv("PATH", basePath);
		vi.stubEnv("OMP_GUI_TEST_BREW_DIRS", "");
		expect(await resolveBin("gh")).toBe(gh);
		const run = vi.fn<OmpRuntime["run"]>().mockResolvedValue({
			code: 0,
			stdout: 'noise {bad} {"nested":{"title":" T {x} ","body":" B\\nline "}}',
			stderr: "",
		});
		const omp = withCreditSpendRuns(
			{ bin: "fixture-omp", basePath, version: "test", run },
			{
				bridgeDir: bin,
				enabled: () => !existsSync(policyOff),
				commitCheck: async () => {},
			},
		);
		await expect(prDraft(dir, omp, {})).rejects.toMatchObject({ code: "not_a_repo" });
		expect(run).not.toHaveBeenCalled();
		await initRepo(repo);
		await expect(prDraft(repo, omp, {})).rejects.toMatchObject({
			code: "pr_draft_failed",
			message: "No changes between main and main",
		});
		expect(run).not.toHaveBeenCalled();
		gitSync(repo, "checkout", "-qb", "topic");
		await fs.mkdir(sub);
		await fs.writeFile(path.join(sub, "a.txt"), "a\n");
		gitSync(repo, "add", ".");
		const subject = 'Use %PATH% & "$1 {{files}}"';
		gitSync(repo, "commit", "-qm", subject);
		await fs.rm(policyOff);
		expect(await prDraft(sub, omp, {})).toEqual({ title: "T {x}", body: "B\nline" });
		const system = await fs.readFile(path.resolve("native/ompdesk/crates/core/src/gh/pr-draft-system.md"), "utf8");
		const user = `Base: main — Head: topic\n\nCommits (1):\n${subject}\n\nChanged files (1):\nsub/a.txt\n\n\nDiff stat:\n1\t0\tsub/a.txt\n\n\nDraft the PR title and body as the JSON object.\n`;
		expect(run).toHaveBeenCalledWith(
			["-p", "--no-session", "--tools=", "--no-lsp", "-e", path.join(bin, "credit-spend-run.ts")],
			{
				cwd: repo,
				input: `${system.trim()}\n\n---\n\n${user}`,
				timeoutMs: 170_000,
				env: { OMP_GUI_CREDIT_SPEND: "0" },
			},
		);
		run.mockResolvedValueOnce({ code: 9, stderr: "failure: fake-draft-error-token", stdout: "" });
		vi.stubEnv("GH_TOKEN", "fake-draft-error-token");
		await expect(prDraft(sub, omp, {})).rejects.toMatchObject({
			code: "pr_draft_failed",
			message: "The model did not return a draft: failure: <token>",
		});
		const missing = path.join(bin, "missing-omp.exe");
		run.mockRejectedValueOnce(new Error(`spawn ${missing} ENOENT`));
		await expect(prDraft(sub, omp, {})).rejects.toMatchObject({
			code: "pr_draft_failed",
			message: `Draft failed: spawn ${missing} ENOENT`,
		});
	} finally {
		vi.unstubAllEnvs();
		await fs.rm(dir, RM_TEMP);
	}
}, 90_000);
