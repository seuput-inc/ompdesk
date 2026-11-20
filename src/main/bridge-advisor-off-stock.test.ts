import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { withoutSessionEnv } from "./omp-launch";
import { ompPackageRoot } from "./omp-runtime";
import { INSTALLED_OMP } from "./test-bridge-probe";
import { removeWhenFree } from "./test-folders";

/**
 * A session opened without its advisor keeps it off (control-tools › Tools, `ompdesk_session_open` `advisor`). C17,
 * 20 Nov 2026: a review session another project opened had its advisor interject and the reviewer turned "needs fix"
 * into "ok". On the installed omp with the gui bridge, the advisor role on a model with a key (no request is made):
 * `agent_control.advisor_off` stops the advisor for this session only, a later change of `advisor.enabled` (which
 * stock re-applies to every session) leaves it off, and nothing is written to config.yml.
 */

const CREDENTIAL_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "ELECTRON_RUN_AS_NODE"];

interface Home {
	home: string;
	agentDir: string;
	repo: string;
}

function makeHome(): Home {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-advisor-off-")));
	chmodSync(home, 0o700);
	const agentDir = join(home, ".omp", "agent");
	const repo = join(home, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(repo);
	// Port 9 on loopback: nothing listens, and no test step sends a prompt.
	writeFileSync(
		join(agentDir, "models.yml"),
		[
			"providers:",
			"  fake:",
			"    baseUrl: http://127.0.0.1:9/v1",
			"    apiKey: not-a-real-key",
			"    api: openai-completions",
			"    models:",
			"      - id: m1",
			"        name: M1",
			"        reasoning: false",
			"        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(agentDir, "config.yml"),
		["modelRoles:", "  default: fake/m1", "  advisor: fake/m1", ""].join("\n"),
	);
	return { home, agentDir, repo };
}

interface Omp {
	bridge: GuiBridgeClient;
	stop(): Promise<void>;
}

const stops: Array<() => Promise<void>> = [];
const homes: string[] = [];
afterAll(async () => {
	for (const stop of stops) await stop();
	for (const home of homes) await removeWhenFree(home);
});

async function startOmp(at: Home): Promise<Omp> {
	const root = ompPackageRoot(INSTALLED_OMP);
	if (!root) throw new Error(`no omp package behind ${INSTALLED_OMP}`);
	const address = newBridgeAddress();
	const env: NodeJS.ProcessEnv = {
		...withoutSessionEnv(process.env),
		HOME: at.home,
		USERPROFILE: at.home,
		PI_CODING_AGENT_DIR: at.agentDir,
		PI_CONFIG_DIR: ".omp",
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_BRIDGE: address,
	};
	for (const key of CREDENTIAL_ENV) delete env[key];
	const child: ChildProcessWithoutNullStreams = spawn(
		"bun",
		[
			join(root, "dist", "cli.js"),
			...["--mode", "rpc-ui"],
			...["--config", resolve("resources/gui-bridge/fresh-launch.yml")],
			...["-e", resolve("resources/gui-bridge/index.ts")],
		],
		{ cwd: at.repo, env },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	let ready = false;
	createInterface({ input: child.stdout }).on("line", line => {
		if (line.includes('"type":"ready"')) ready = true;
	});
	const bridge = new GuiBridgeClient(address);
	let stopped: Promise<void> | undefined;
	const stop = () => {
		stopped ??= (async () => {
			bridge.close();
			child.stdin.end();
			const kill = setTimeout(() => child.kill("SIGKILL"), 30_000);
			await exited;
			clearTimeout(kill);
			removeBridgeAddress(address);
		})();
		return stopped;
	};
	stops.push(stop);
	await expect.poll(() => ready, { timeout: 60_000, message: `omp's ready frame\n${stderr.slice(-2000)}` }).toBe(true);
	await expect
		.poll(
			() =>
				bridge.connect(1_000).then(
					() => true,
					() => false,
				),
			{ timeout: 60_000, message: `the bridge\n${stderr.slice(-2000)}` },
		)
		.toBe(true);
	return { bridge, stop };
}

/** Whether the session's advisor runs now (bridge `advisor_stats`, stock `getAdvisorStats().active`). */
async function advisorActive(omp: Omp): Promise<boolean> {
	const usage = await omp.bridge.request<{ active?: unknown }>("advisor_stats", {});
	return usage.active === true;
}

describe.skipIf(!existsSync(INSTALLED_OMP))("a session opened without its advisor on the installed omp", () => {
	it("stops the advisor for this session only, and keeps it off across a settings change", async () => {
		const at = makeHome();
		homes.push(at.home);
		const configYml = readFileSync(join(at.agentDir, "config.yml"), "utf8");
		const omp = await startOmp(at);
		expect(await advisorActive(omp), "OMPdesk holds the advisor on, and its role has a model").toBe(true);

		await omp.bridge.request("agent_control.advisor_off", {});
		expect(await advisorActive(omp)).toBe(false);
		expect(readFileSync(join(at.agentDir, "config.yml"), "utf8"), "session-only").toBe(configYml);

		// Stock re-applies a changed `advisor.enabled` to every session; this one stays off.
		await omp.bridge.request("settings_set", { path: "advisor.enabled", value: false });
		await omp.bridge.request("settings_set", { path: "advisor.enabled", value: true });
		expect(await advisorActive(omp)).toBe(false);
	}, 120_000);
});
