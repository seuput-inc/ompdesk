/**
 * `bun run dev`: OMPdesk from this checkout on the Tauri host (native-rust › S), the renderer on Vite's dev server
 * (HMR), main and the preload rebuilt on every edit.
 *
 * 1. The native binaries, the Tauri host and the pinned Node, each built only when its staged copy is stale
 *    (`ensureNative`, `checkTauri`, `stageNode`).
 * 2. electron-vite's resolved config: main and the preload build into `out/` and watch; the renderer is served.
 * 3. The staged host starts Node on `out/main/index.js` with `ELECTRON_RENDERER_URL` = the dev server, which main's
 *    window loads (src/main/window.ts) and which only an unpackaged host trusts (crates/tauri-shell registry.rs
 *    `dev_origin`). A rebuilt main or preload restarts the host, which reads the preload once, at its start. Quitting
 *    the app ends the run.
 *
 * The run keeps a profile of its own, `<app data>/ompdesk-dev`, unless the arguments name `--user-data-dir`: on the
 * default profile the host hands the launch to an installed OMPdesk that is running and quits. Arguments after
 * `bun run dev --` go to the host (`--user-data-dir=…`, a folder to open).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import { resolveConfig } from "electron-vite";
import { build, createServer, type InlineConfig, mergeConfig, type Plugin } from "vite";
import { ensureNative } from "./build-native";
import { NODE_ROOT, readPin, stageNode } from "./build-node";
import { buildTauri, checkTauri, REPO_ROOT, stagedDir } from "./build-tauri";

/** How long a restart waits for the old host and its Node to let go of the profile. */
const STOP_GRACE_MS = 10_000;

function log(message: string): void {
	console.log(`[dev] ${message}`);
}

async function stagedHost(): Promise<string> {
	try {
		checkTauri();
	} catch (error) {
		log(`building the Tauri host: ${error instanceof Error ? error.message : String(error)}`);
		await buildTauri();
	}
	return path.join(stagedDir(), process.platform === "win32" ? "ompdesk-shell.exe" : "ompdesk-shell");
}

async function stagedNode(): Promise<string> {
	const key = `${process.platform}-${process.arch}`;
	const pin = readPin();
	await stageNode(key, pin);
	const target = pin.targets[key];
	if (!target) throw new Error(`no pinned Node for ${key}`);
	return path.join(NODE_ROOT, key, target.binary);
}

function devProfile(): string {
	const appData =
		process.platform === "win32"
			? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
			: path.join(os.homedir(), "Library", "Application Support");
	return path.join(appData, "ompdesk-dev");
}

/**
 * Builds `config` in watch mode; resolves after the first build, then calls `rebuilt` after each later one. The hook is
 * `sequential`, so it runs after every other `closeBundle` (the preload config writes `tauri.js` in one).
 */
function watchBuild(config: InlineConfig, rebuilt: () => void): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let first = true;
	const built: Plugin = {
		name: "ompdesk:dev-built",
		closeBundle: {
			order: "post",
			sequential: true,
			handler() {
				if (first) {
					first = false;
					resolve();
				} else rebuilt();
			},
		},
	};
	build(mergeConfig(config, { plugins: [built] })).catch(reject);
	return promise;
}

ensureNative();
const hostExe = await stagedHost();
const nodeExe = await stagedNode();

process.env.NODE_ENV_ELECTRON_VITE = "development";
const { config } = await resolveConfig({ build: { watch: {} } }, "serve", "development");
if (!config?.main || !config.preload || !config.renderer)
	throw new Error("electron.vite.config.ts needs main, preload and renderer");

const server = await createServer(config.renderer);
await server.listen();
const rendererUrl = server.resolvedUrls?.local[0];
if (!rendererUrl) throw new Error("Vite's dev server reported no local URL");
server.printUrls();

const args = process.argv.slice(2);
if (!args.some(arg => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="))) {
	args.unshift(`--user-data-dir=${devProfile()}`);
}
const env: NodeJS.ProcessEnv = {
	...process.env,
	ELECTRON_RENDERER_URL: rendererUrl,
	OMPDESK_APP_DIR: REPO_ROOT,
	OMPDESK_NODE: nodeExe,
};
let host: ChildProcess | undefined;
let restarts = Promise.resolve();

function startHost(): void {
	// Piped, not inherited: Node inherits the host's stdout and stderr, so their end means both have exited.
	const child = spawn(hostExe, args, { env, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout?.pipe(process.stdout);
	child.stderr?.pipe(process.stderr);
	child.once("exit", code => {
		if (host !== child) return;
		log(`the app exited (${code ?? "signal"})`);
		process.exit(code ?? 0);
	});
	host = child;
}

function restartHost(why: string): void {
	restarts = restarts.then(async () => {
		log(`${why}: restarting the app`);
		const old = host;
		host = undefined;
		if (old && old.exitCode === null && old.signalCode === null) {
			const closed = once(old, "close");
			old.kill();
			await Promise.race([closed, Bun.sleep(STOP_GRACE_MS)]);
		}
		startHost();
	});
}

await watchBuild(config.main, () => restartHost("main rebuilt"));
await watchBuild(config.preload, () => restartHost("preload rebuilt"));
log(`starting ${path.relative(REPO_ROOT, hostExe)} ${args.join(" ")}`);
startHost();
