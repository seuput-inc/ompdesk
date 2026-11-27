// Publish an accepted work tip, then retire its remote copy. --published is for a publisher that already succeeded.
import { execFileSync } from "node:child_process";
import { core, shutdownCore } from "../src/main/core/process";
import { withoutGitSelectors } from "../src/shared/git-env";

const args = process.argv.slice(2);
const published = args[0] === "--published";
const [branch, accepted, ...extra] = published ? args.slice(1) : args;
if (!branch || !accepted || extra.length || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(accepted)) {
	throw new Error("usage: bun scripts/publish-work.ts [--published] <finished work branch> <accepted full SHA>");
}
const bin = Bun.which("git");
if (!bin) throw new Error("git not found");
const env = withoutGitSelectors(process.env);
if (!published) {
	const tip = execFileSync(bin, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { env, encoding: "utf8" });
	if (!branch.startsWith("omp/agent/") || tip.trim() !== accepted) throw new Error("Not the accepted work branch tip");
	execFileSync(bin, ["push", "origin", `${accepted}:refs/heads/dev`], { env, stdio: "inherit" });
}
try {
	const { result } = await core().call<{ message: string } | null>(
		"git.dropPublishedWork",
		{
			cwd: process.cwd(),
			branch,
			accepted,
			git: { bin, args: [], env, timeoutMs: 60_000, maxBytes: 8 * 1024 * 1024 },
		},
		{ timeoutMs: 300_000 },
	);
	console.log(result?.message ?? `No copy of ${branch} on origin to retire.`);
} catch (error) {
	console.error(`Could not confirm remote cleanup for ${branch}; do not repeat the dev push.`, error);
	process.exitCode = 1;
} finally {
	await shutdownCore();
}
