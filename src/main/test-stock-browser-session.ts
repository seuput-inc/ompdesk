import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { OMP_COMMAND, stopOmpDaemon } from "./test-bridge-probe";
import { removeWhenFree } from "./test-folders";

export interface StockPreviewRelay {
	url: string;
	extensionUrl?: string;
	token: string;
}

/** Load the production bridge through the installed CLI's own bundled extension loader, not npm's raw TS tree. */
export async function startStockBrowserSession() {
	const profile = await mkdtemp(join(tmpdir(), "omp-browser-relay-"));
	const agent = join(profile, "agent");
	await mkdir(agent, { mode: 0o700 });
	await writeFile(
		join(agent, "models.yml"),
		"providers:\n  fixture:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    apiKey: unused\n    models:\n      - id: idle\n",
	);
	const address = newBridgeAddress();
	const env = {
		...process.env,
		HOME: profile,
		USERPROFILE: profile,
		XDG_CONFIG_HOME: join(profile, ".config"),
		LOCALAPPDATA: join(profile, "AppData", "Local"),
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: ".",
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_DAEMON_DIR: join(profile, "run", "daemon"),
		OMP_DAEMON_TCP: "",
		PI_BROWSER_RELAY_KEEP_FRONT: "0",
		OMP_GUI_BRIDGE: address,
	};
	const child = spawn(
		OMP_COMMAND.file,
		[
			...OMP_COMMAND.args,
			"--mode",
			"rpc-ui",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--model",
			"fixture/idle",
			"-e",
			resolve("resources/gui-bridge/index.ts"),
		],
		{ cwd: profile, env, stdio: "pipe" },
	);
	const client = new GuiBridgeClient(address);
	const ready = Promise.withResolvers<void>();
	const exited = Promise.withResolvers<void>();
	let errors = "";
	child.stderr.on("data", chunk => {
		errors = (errors + String(chunk)).slice(-4000);
	});
	child.once("error", ready.reject);
	child.once("close", code => {
		exited.resolve();
		ready.reject(new Error("omp exited " + code + ": " + errors));
	});
	let output = "";
	child.stdout.on("data", chunk => {
		output = (output + String(chunk)).slice(-65536);
		if (/"type"\s*:\s*"ready"/.test(output)) ready.resolve();
	});
	const close = async () => {
		client.close();
		child.stdin.end();
		child.kill();
		await exited.promise;
		removeBridgeAddress(address);
		stopOmpDaemon(profile, env);
		await removeWhenFree(profile);
	};
	try {
		const timer = setTimeout(() => ready.reject(new Error("omp did not become ready: " + errors)), 40_000);
		await ready.promise.finally(() => clearTimeout(timer));
		await client.connect();
		return { client, address, close };
	} catch (error) {
		await close();
		throw error;
	}
}
