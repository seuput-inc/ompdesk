import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import {
	configDirName,
	OMP_COMMAND,
	INSTALLED_OMP as omp,
	stopOmpDaemon,
	withoutAwsCredentials,
} from "./test-bridge-probe";

/**
 * On the installed omp, with one AgentSession internal hidden (`OMP_GUI_BRIDGE_PROBE_HIDE`, as a newer omp that
 * dropped it): the bridge refuses only the action that uses it and serves the other actions of what used to be one
 * `composer` feature. omp 19 dropped `abortHandoff`/`isGeneratingHandoff` while every composer method shared one id,
 * and ten composer actions and the relaunch resume went dark at once.
 */

const HIDDEN = "AgentSession.abortCompaction";

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

describe.skipIf(!existsSync(omp))("one missing omp internal, on stock omp", () => {
	it("refuses only the action that uses it and reports that action alone", async () => {
		const isolated = mkdtempSync(join(tmpdir(), "ompdesk-granular-"));
		chmodSync(isolated, 0o700);
		cleanups.push(() => rmSync(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
		const agentDir = join(isolated, "agent");
		mkdirSync(agentDir, { recursive: true });
		// omp does not start without a model; nothing is asked of this one.
		writeFileSync(
			join(agentDir, "models.yml"),
			"providers:\n  fake:\n    baseUrl: http://127.0.0.1:9/v1\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        reasoning: false\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n",
		);
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-granular-cwd-")));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
		const address = newBridgeAddress();
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_CONFIG_DIR: configDirName(isolated),
			OMP_PROFILE: "",
			PI_PROFILE: "",
		};
		for (const key of ["ELECTRON_RUN_AS_NODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
			Reflect.deleteProperty(env, key);
		for (const key of Object.keys(env)) if (key.startsWith("OMP_GUI_")) Reflect.deleteProperty(env, key);
		withoutAwsCredentials(env, isolated);
		env.OMP_GUI_BRIDGE = address;
		env.OMP_GUI_BRIDGE_PROBE_HIDE = HIDDEN;
		const child = spawn(
			OMP_COMMAND.file,
			[
				...OMP_COMMAND.args,
				...["--mode", "rpc-ui", "--no-session", "--no-extensions", "--no-skills", "--no-rules"],
				...["--model", "fake/m1", "-e", resolve("resources/gui-bridge/index.ts")],
			],
			{ cwd, env: env as NodeJS.ProcessEnv },
		);
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr += chunk;
		});
		const exited = Promise.withResolvers<void>();
		child.once("exit", () => exited.resolve());
		cleanups.push(async () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited.promise;
			removeBridgeAddress(address);
			stopOmpDaemon(isolated);
		});
		const ready = Promise.withResolvers<void>();
		createInterface({ input: child.stdout }).on("line", line => {
			if (line.includes('"type":"ready"')) ready.resolve();
		});
		void exited.promise.then(() => ready.reject(new Error(`omp ended before it was ready\n${stderr.slice(-2000)}`)));
		await ready.promise;

		const bridge = new GuiBridgeClient(address);
		cleanups.push(() => bridge.close());
		await bridge.connect(30_000);

		const capabilities = await bridge.request<{ unavailable: Array<{ feature: string; missing: string[] }> }>(
			"capabilities",
		);
		expect(capabilities.unavailable).toEqual([{ feature: "abortCompaction", missing: [HIDDEN] }]);

		await expect(bridge.request("composer.abort_maintenance")).rejects.toThrow(
			/Cancel compaction \(missing AgentSession\.abortCompaction\)/,
		);
		// The other actions of the old composer feature, the relaunch resume's own probe included, still answer.
		await expect(bridge.request("composer.prewalk_armed")).resolves.toEqual({ armed: false });
		await expect(bridge.request("composer.dequeue")).resolves.toBeNull();
		await expect(bridge.request("composer.cancel_job", { id: "none" })).resolves.toEqual({ cancelled: false });
		await expect(bridge.request("composer.state")).resolves.toMatchObject({ cwd: expect.any(String) });
	}, 120_000);
});
