// Static import reachability, not evidence that a request used a module. Run from the checkout root.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withoutGitSelectors } from "../src/shared/git-env";

const entries = {
	node: ["src/main/index.ts"],
	page: [
		"src/preload/tauri.ts",
		"src/renderer/public/pre-paint.js",
		"src/renderer/main.tsx",
		"src/renderer/components/layout/sidebar/Sidebar.tsx",
		"src/renderer/web/web-boot.ts",
		"src/renderer/web/sw.ts",
		"native/ompdesk/crates/tauri-shell/src/ipc_post_message.js",
	],
	stock: [
		"resources/gui-bridge/index.ts",
		"resources/gui-bridge/memory-judge-host.ts",
		"resources/gui-bridge/credit-spend-run.ts",
		"resources/gui-bridge/ponytail.ts",
		// agent-control.ts lazy-loads this module through a nonliteral import.
		"resources/gui-bridge/agent-control-blobs.ts",
	],
	worker: ["resources/gui-bridge/stock-helper/host.ts"],
	stats: ["resources/gui-bridge/stats-host.ts"],
	catalog: ["resources/gui-bridge/boot-model.ts"],
	mcp: ["resources/gui-bridge/mcp-hub.ts"],
};
const sourceDirs = ["src", "resources/gui-bridge", "native/ompdesk/crates/tauri-shell/src"];
const tracked = execFileSync("git", ["ls-files", "-z", "--", ...sourceDirs], {
	env: withoutGitSelectors(process.env),
	encoding: "utf8",
	maxBuffer: 16 << 20,
})
	.split("\0")
	.filter(Boolean);
const remaining = process.argv.includes("--remaining");
const inventory = remaining || process.argv.includes("--check-inventory");
const paths = tracked.filter(path => /\.[cm]?[jt]sx?$/.test(path));
const reach = new Map<string, string[]>(paths.map(path => [path, []]));
for (const [runtime, entrypoints] of Object.entries(entries)) {
	if (inventory && (runtime === "node" || runtime === "page" || runtime === "stock")) continue;
	const result = await Bun.build({
		root: ".",
		entrypoints,
		target: runtime === "node" ? "node" : runtime === "page" ? "browser" : "bun",
		metafile: true,
		packages: "external",
		external: ["*?raw", "*?url", "*?inline", "*.css", "*.svg", "*.png", "*.wasm"],
		plugins: [
			{
				name: "ompdesk-source-aliases",
				setup(builder) {
					builder.onResolve({ filter: /^electron$/ }, () => ({
						path: resolve("src/main/shell-host/electron/index.ts"),
					}));
					builder.onResolve({ filter: /^@(shared|renderer)\// }, ({ path }) => ({
						path: require.resolve(resolve(`src/${path.slice(1)}`)),
					}));
				},
			},
		],
	});
	if (!result.metafile) throw new Error(`No import graph for ${runtime}`);
	for (const path of Object.keys(result.metafile.inputs)) reach.get(path.replaceAll("\\", "/"))?.push(runtime);
	for (const path of entrypoints) {
		if (!reach.get(path)?.includes(runtime)) throw new Error(`Missing entry: ${path} (${runtime})`);
	}
}
if (inventory) {
	const dir = "docs/rust-inventory";
	const expected = new Set(tracked.filter(path => path.startsWith("src/main/") || path.startsWith("src/preload/")));
	for (const [path, runtimes] of reach) {
		if (runtimes.length || path.startsWith("resources/gui-bridge/stock-helper/")) expected.add(path);
	}
	const seen = new Set<string>();
	const issues: string[] = [];
	const statuses = new Set(["port", "mixed", "native-client", "tooling", "exception"]);
	const pending: string[] = [];
	for (const name of readdirSync(dir).filter(name => name.endsWith(".tsv"))) {
		const [header, ...rows] = readFileSync(`${dir}/${name}`, "utf8").trimEnd().split("\n");
		const columns = header.split("\t");
		const statusColumn = columns.indexOf("status");
		const reasons = [
			"reason",
			"remaining_unit_or_reason",
			"replacement_or_dependency",
			"implementer_and_remaining_work",
		];
		const reasonColumn = columns.findIndex(column => reasons.includes(column));
		if (statusColumn < 0 || reasonColumn < 0) throw new Error(`Missing status or reason column in ${name}`);
		for (const row of rows) {
			const fields = row.split("\t");
			const [path] = fields;
			const status = fields[statusColumn];
			if (!statuses.has(status) || !fields[reasonColumn]?.trim())
				issues.push(`missing or invalid classification: ${path} (${name})`);
			if (status === "port" || status === "mixed") pending.push(`${path}\t${status}\t${fields[reasonColumn]}`);
			if (seen.has(path)) issues.push(`duplicate: ${path} (${name})`);
			if (!expected.has(path)) issues.push(`no tracked file: ${path} (${name})`);
			seen.add(path);
		}
	}
	for (const path of expected) if (!seen.has(path)) issues.push(`unclassified: ${path}`);
	if (issues.length) throw new Error(issues.join("\n"));
	if (remaining) console.log(["path\tstatus\treason", ...pending.sort()].join("\n"));
	else console.log(`${seen.size} paths classified exactly once; ${pending.length} paths with host logic to move`);
	process.exit(0);
}
console.log("path\timported_by");
for (const [path, runtimes] of reach) console.log(`${path}\t${runtimes.join(",") || "not-reached"}`);
