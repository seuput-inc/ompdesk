import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
const cmd = (name, ...args) => execFileSync(name, args, { encoding: "utf8" }).trim();
const git = (...args) => cmd("git", ...args);
const api = path => JSON.parse(cmd("gh", "api", `repos/${repo}/${path}`));

// A successful workflow with skipped checks is not a verified batch. A dispatch on the same SHA is not its dev push.
export function admission({ main, dev, tag, run, jobs, liveVersion, publicTag, changes, exceptional = false }) {
	if (
		run.path !== ".github/workflows/ci.yml" ||
		run.head_repository?.full_name !== repo ||
		run.event !== "push" ||
		run.head_branch !== "dev" ||
		run.head_sha !== dev ||
		run.status !== "completed" ||
		run.conclusion !== "success"
	)
		return "no green dev push for this SHA";
	if (!required.every(name => jobs.some(job => job.name === name && job.conclusion === "success")))
		return "missing required job";
	if (`v${liveVersion}` !== publicTag) return "finish the current release first";
	if (main === dev || dev === tag) return "already promoted";
	if (changes === 0 || (changes < 3 && !exceptional)) return "batch too small";
	return "eligible";
}

// Read-only. The sole release session assesses user-visible changes and writes both languages; no commit title can authorize a cut.
function main() {
	const args = process.argv.slice(2);
	const exceptional = args[0] === "--urgent-or-requested";
	const [runId, ...changeIds] = exceptional ? args.slice(1) : args;
	if (!/^\d+$/.test(runId ?? "") || changeIds.some(id => !/^[0-9a-f]{40}$/.test(id)))
		throw Error("usage: node scripts/dev-release.mjs <dev push run id> [distinct user-visible commit SHAs]");
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
	const jobs = JSON.parse(
		cmd("gh", "api", "--paginate", "--slurp", `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`),
	).flatMap(page => page.jobs);
	const liveVersion = JSON.parse(git("show", `${main}:package.json`)).version;
	const verdict = admission({
		main,
		dev,
		tag: tagSha,
		run,
		jobs,
		liveVersion,
		publicTag: latest.tag_name,
		changes: new Set(changeIds).size,
		exceptional,
	});
	console.log(JSON.stringify({ verdict, main, dev, publicTag: latest.tag_name, run: run.id }));
	if (verdict !== "eligible") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
