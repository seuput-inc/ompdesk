import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it, onTestFinished } from "vitest";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { OMP_COMMAND, INSTALLED_OMP as omp, runStock, stockFixtureEnv, stockSource } from "./test-bridge-probe";
import { StockRpc } from "./test-stock-rpc";

const sessionManager = stockSource("pi-coding-agent", path.join("session", "session-manager.ts"));

/**
 * Plan mode was removed from OMPdesk (composer.md › Toolbar), but a session saved while it was on still carries stock's
 * `mode_change` plan entry. A tab's omp runs in stock's RPC mode, which never restores plan state from the journal
 * (only its TUI does), so the session opens as a plain one: stock takes a goal there, which it refuses while plan mode
 * is on ("Exit plan mode before starting a goal.").
 */
describe.skipIf(!existsSync(omp) || !sessionManager)("a session saved with plan mode on, on the installed omp", () => {
	it("opens with plan mode off", async () => {
		const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-saved-plan-")));
		onTestFinished(() => fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
		const agent = path.join(scratch, "agent");
		const project = path.join(scratch, "project");
		await fs.mkdir(agent, { recursive: true, mode: 0o700 });
		await fs.mkdir(project);
		// A model that is never answered: rpc mode refuses to start without one, and a CI runner has none.
		await fs.writeFile(
			path.join(agent, "models.yml"),
			"providers:\n  fixture:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    apiKey: unused\n    models:\n      - id: idle\n        name: Idle\n        reasoning: false\n",
		);
		// The journal as stock wrote it while plan mode was on: a message, then the mode change.
		const file = runStock<string>(`
			const { SessionManager } = await import(${JSON.stringify(sessionManager)});
			const session = SessionManager.create(${JSON.stringify(project)}, ${JSON.stringify(path.join(scratch, "sessions"))});
			session.appendMessage({ role: "user", content: [{ type: "text", text: "Plan the rollout" }], timestamp: Date.now() });
			session.appendModeChange("plan", { planFilePath: "local://PLAN.md" });
			await session.ensureOnDisk();
			await session.flush();
			console.log(JSON.stringify(session.getSessionFile()));
			await session.close();`);
		expect(await fs.readFile(file, "utf8")).toContain('"mode":"plan"');

		const child = spawn(
			OMP_COMMAND.file,
			[
				...OMP_COMMAND.args,
				"--mode",
				"rpc-ui",
				"--session",
				file,
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--model",
				"fixture/idle",
			],
			{
				cwd: project,
				env: { ...stockFixtureEnv(scratch), OMP_PROFILE: "", PI_PROFILE: "" },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr += chunk.toString();
		});
		const rpc = new StockRpc(frame => child.stdin.write(`${JSON.stringify(frame)}\n`), { timeout: 30_000 });
		child.once("exit", code => rpc.rejectAll(`omp exited (${code}): ${stderr}`));
		const lines = createInterface({ input: child.stdout });
		lines.on("line", line => {
			try {
				const frame = JSON.parse(line) as RpcResponse;
				if (frame.type === "response") rpc.onResponse(frame);
			} catch {
				/* Stock may print startup diagnostics. */
			}
		});
		try {
			const state = await rpc.stock({ type: "get_state" });
			expect(state.success, stderr).toBe(true);
			expect((state as { data?: { sessionFile?: string } }).data?.sessionFile).toBe(file);
			// Stock's own `goal` command (omp://rpc.md#goal), which OMPdesk's typed command set wraps as `set_goal`.
			const create = { type: "goal", op: "create", objective: "Ship the rollout" } as unknown as RpcCommand;
			const goal = await rpc.stock(create);
			expect(goal, stderr).toMatchObject({ success: true });
		} finally {
			rpc.rejectAll("test teardown");
			lines.close();
			child.stdin.end();
			child.kill("SIGTERM");
			if (child.exitCode === null && child.signalCode === null) {
				const exited = Promise.withResolvers<void>();
				child.once("exit", () => exited.resolve());
				await exited.promise;
			}
		}
	}, 120_000);
});
