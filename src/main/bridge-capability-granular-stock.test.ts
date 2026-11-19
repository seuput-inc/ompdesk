import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
 * On the installed omp, as a newer omp that dropped two internals: an AgentSession member (hidden from the probe,
 * `OMP_GUI_BRIDGE_PROBE_HIDE`) and a stock export (gone from the bridge copy's one-line adapter too, so Bun's linker
 * sees it missing). The bridge refuses only the two actions that use them; the other actions of the same areas answer.
 * omp 19 dropped `abortHandoff`/`isGeneratingHandoff` while every composer method shared one id, and ten composer
 * actions and the relaunch resume went dark at once; an area that linked a vanished export lost all its methods.
 */

const HIDDEN = "AgentSession.abortCompaction";
const COMPLETIONS = "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
const GONE = `${COMPLETIONS}#buildMcpArgumentCompletions`;

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
		env.OMP_GUI_BRIDGE_PROBE_HIDE = `${HIDDEN},${GONE}`;
		// The bridge beside the test's own adapter for the completions module, which no longer has the export.
		const bridgeCopy = join(isolated, "bridge");
		cpSync(resolve("resources/gui-bridge"), bridgeCopy, { recursive: true });
		writeFileSync(
			join(bridgeCopy, "omp", "pi-coding-agent", "slash-commands", "builtin-completions.ts"),
			"export {};\n",
		);
		const child = spawn(
			OMP_COMMAND.file,
			[
				...OMP_COMMAND.args,
				...["--mode", "rpc-ui", "--no-session", "--no-extensions", "--no-skills", "--no-rules"],
				...["--model", "fake/m1", "-e", join(bridgeCopy, "index.ts")],
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
		expect(capabilities.unavailable).toEqual([
			{ feature: "abortCompaction", missing: [HIDDEN] },
			{ feature: "argCompletions", missing: [GONE] },
		]);

		await expect(bridge.request("composer.abort_maintenance")).rejects.toThrow(
			/Cancel compaction \(missing AgentSession\.abortCompaction\)/,
		);
		// The other actions of the old composer feature, the relaunch resume's own probe included, still answer.
		await expect(bridge.request("composer.prewalk_armed")).resolves.toEqual({ armed: false });
		await expect(bridge.request("composer.dequeue")).resolves.toBeNull();
		await expect(bridge.request("composer.cancel_job", { id: "none" })).resolves.toEqual({ cancelled: false });
		await expect(bridge.request("composer.state")).resolves.toMatchObject({ cwd: expect.any(String) });

		// The area that served the vanished export still loaded: its other actions answer, that one is refused.
		await expect(bridge.request("sessions.write_local_paste", { content: "big paste" })).resolves.toMatchObject({
			url: "local://paste-1.md",
		});
		await expect(bridge.request("sessions.arg_completions", { cwd, command: "mcp", prefix: "" })).rejects.toThrow(
			/Slash-command argument completion \(missing @oh-my-pi\/pi-coding-agent\/slash-commands\/builtin-completions#buildMcpArgumentCompletions\)/,
		);
	}, 120_000);
});
