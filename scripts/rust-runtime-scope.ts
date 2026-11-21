// Static import reachability, not evidence that a request used a module. Run from the checkout root.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { withoutGitSelectors } from "../src/shared/git-env";

const entries = {
	node: ["src/main/index.ts", "src/main/hang-watchdog-worker.ts"],
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
const paths = execFileSync("git", ["ls-files", "-z", "--", ...sourceDirs], {
	env: withoutGitSelectors(process.env),
	encoding: "utf8",
	maxBuffer: 16 << 20,
})
	.split("\0")
	.filter(path => /\.[cm]?[jt]sx?$/.test(path));
const reach = new Map<string, string[]>(paths.map(path => [path, []]));
for (const [runtime, entrypoints] of Object.entries(entries)) {
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
console.log("path\timported_by");
for (const [path, runtimes] of reach) console.log(`${path}\t${runtimes.join(",") || "not-reached"}`);
