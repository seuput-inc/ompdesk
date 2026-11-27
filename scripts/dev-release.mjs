import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withoutGitSelectors } from "../src/shared/git-env.ts";

const repo = "seuput-inc/ompdesk";
const required = [
	"static",
	"build",
	"win-native-bin",
	"native (linux)",
	"native (windows)",
	"check (node 1/2)",
	"check (node 2/2)",
	"check (renderer 1/2)",
	"check (renderer 2/2)",
	"win-platform (1/3)",
	"win-platform (2/3)",
	"win-platform (3/3)",
];
const cmd = (name, ...args) =>
	execFileSync(name, args, { env: withoutGitSelectors(process.env), encoding: "utf8" }).trim();
export const git = (...args) => cmd("git", ...args);
const api = path => JSON.parse(cmd("gh", "api", `repos/${repo}/${path}`));
const pages = path => JSON.parse(cmd("gh", "api", "--paginate", "--slurp", `repos/${repo}/${path}`));
const runJobs = id => pages(`actions/runs/${id}/jobs?filter=latest&per_page=100`).flatMap(page => page.jobs);
const title = sha => `ci [release-windows=${sha}]`;

// GitHub dispatch has no idempotency key. The sole publisher keeps its claim across checkouts and lost replies.
export function requestOnce(dir, sha, dispatch) {
	mkdirSync(dir, { recursive: true });
	try {
		mkdirSync(join(dir, sha));
	} catch (error) {
		if (error.code === "EEXIST") return;
		throw error;
	}
	dispatch(sha);
}

// A successful workflow with skipped checks is not a verified batch. A dispatch on the same SHA is not its dev push.
export function admission(
	{ main, dev, tag, run, jobs, liveVersion, publicTag, changes, exceptional = false },
	windows,
) {
	if (
		run.path !== ".github/workflows/ci.yml" ||
		run.head_repository?.full_name !== repo ||
		run.event !== "push" ||
		run.head_branch !== "dev" ||
		run.head_sha !== dev ||
		run.status !== "completed"
	)
		return "no green dev push for this SHA";
	if (run.conclusion !== "success") return "no green dev push for this SHA";
	if (!required.every(name => jobs.some(job => job.name === name && job.conclusion === "success")))
		return "missing required job";
	if (`v${liveVersion}` !== publicTag) return "finish the current release first";
	if (main === dev || dev === tag) return "already promoted";
	if (changes === 0 || (changes < 3 && !exceptional)) return "batch too small";
	const receipt = windows.find(dev);
	if (!receipt) {
		if (!windows.request) return `no Windows receipt for ${dev}`;
		windows.request(dev);
		return `waiting for the Windows receipt for ${dev}`;
	}
	const scope = `win-e2e run ${receipt.id} (@smoke including bot-rename reopen and bots-remote paired child)`;
	if (
		receipt.path !== run.path ||
		receipt.head_repository?.full_name !== repo ||
		receipt.event !== "workflow_dispatch" ||
		receipt.head_branch !== "dev" ||
		receipt.head_sha !== dev ||
		receipt.display_title !== title(dev)
	)
		return `${scope}: not the requested dev candidate`;
	if (receipt.status !== "completed") return `waiting for the Windows receipt: ${scope} ${receipt.status}`;
	const job = windows.jobs(receipt.id).find(j => j.name === "win-e2e");
	const proof = job?.steps?.find(step => step.name === "Required Windows app set");
	for (const status of [receipt.conclusion, job?.conclusion, proof?.conclusion]) {
		if (status !== "success") return `${scope}: ${status ?? "missing"}`;
	}
	return "eligible";
}

// The release owner supplies the distinct user-visible changes. --status never requests a workflow.
function main() {
	const args = process.argv.slice(2);
	const statusOnly = args[0] === "--status";
	if (statusOnly) args.shift();
	const exceptional = args[0] === "--urgent-or-requested";
	const [runId, ...changeIds] = exceptional ? args.slice(1) : args;
	if (!/^\d+$/.test(runId ?? "") || changeIds.some(id => !/^[0-9a-f]{40}$/.test(id)))
		throw Error(
			"usage: node scripts/dev-release.mjs [--status] [--urgent-or-requested] <dev push run id> [distinct user-visible commit SHAs]",
		);
	const remote = `https://github.com/${repo}.git`;
	const refs = Object.fromEntries(
		git("ls-remote", remote, "refs/heads/dev", "refs/heads/main")
			.split("\n")
			.map(line => line.split("\t").reverse()),
	);
	const dev = refs["refs/heads/dev"],
		main = refs["refs/heads/main"];
	if (!dev || !main) throw Error("missing integration or release branch");
	const latest = api("releases/latest");
	if (!/^v\d+\.\d+\.\d+$/.test(latest.tag_name)) throw Error("unexpected latest tag");
	git("fetch", "--no-tags", remote, dev, main, `refs/tags/${latest.tag_name}`);
	const tagSha = cmd("gh", "api", `repos/${repo}/commits/${latest.tag_name}`, "--jq", ".sha");
	git("merge-base", "--is-ancestor", tagSha, main);
	git("merge-base", "--is-ancestor", main, dev);
	const range = new Set(git("rev-list", "--no-merges", `${tagSha}..${dev}`).split("\n"));
	if (
		changeIds.some(
			id => !range.has(id) || !/^(feat|fix|perf)(\([^)]*\))?!?:/.test(git("show", "-s", "--format=%s", id)),
		)
	)
		throw Error("change outside unreleased feature/fix/perf commits");
	const run = api(`actions/runs/${runId}`);
	const jobs = runJobs(run.id);
	const liveVersion = JSON.parse(git("show", `${main}:package.json`)).version;
	let receiptJobs = [];
	const verdict = admission(
		{
			main,
			dev,
			tag: tagSha,
			run,
			jobs,
			liveVersion,
			publicTag: latest.tag_name,
			changes: new Set(changeIds).size,
			exceptional,
		},
		{
			find: sha =>
				pages(`actions/workflows/ci.yml/runs?head_sha=${sha}&event=workflow_dispatch&branch=dev&per_page=100`)
					.flatMap(page => page.workflow_runs)
					.find(candidate => candidate.display_title === title(sha)),
			jobs: id => (receiptJobs = runJobs(id)),
			request: statusOnly
				? undefined
				: sha =>
						requestOnce(join(homedir(), ".ompdesk", "dev-release", "windows"), sha, candidate =>
							cmd(
								"gh",
								"workflow",
								"run",
								"ci.yml",
								"--repo",
								repo,
								"--ref",
								"dev",
								"-f",
								`windows_candidate=${candidate}`,
							),
						),
		},
	);
	console.log(JSON.stringify({ verdict, main, dev, publicTag: latest.tag_name, run: run.id }));
	if (verdict !== "eligible") process.exitCode = 2;
	if (verdict.startsWith("win-e2e run ")) {
		const job = receiptJobs.find(job => job.name === "win-e2e");
		if (job?.id && job.conclusion === "failure") {
			for (const note of pages(`check-runs/${job.id}/annotations?per_page=100`).flat()) {
				if (note.title === "Required Windows app set") console.error(note.message);
			}
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
