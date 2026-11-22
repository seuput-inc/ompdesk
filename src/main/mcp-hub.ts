/**
 * One `ompdesk-core --mcp-hub` process per app serves ompdesk-memory over loopback HTTP.
 *
 * - The secret is minted once per launch and the port is kept across restarts (a crashed hub comes back on it), so
 *   every omp's env (`ompEnv`, expanded by stock when it reads the `.mcp.json`) stays valid for the app's lifetime and
 *   an omp's http MCP client reconnects to the restarted hub by itself.
 * - The hub exits when stdin closes, including when main crashes.
 * - It runs at the agents' scheduling priority (agent-priority.ts): what it does is agent work.
 * - Started before the first omp; an omp's spawn waits for its first listening line (tens of ms), at most
 *   `READY_WAIT_MS`, then goes on without it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { MCP_AUTH_ENV, MCP_HUB_ENV } from "../../resources/gui-bridge/mcp-hub-contracts";
import type { LowerAgentPriority } from "./agent-priority";
import { nativeBinPath } from "./native-bin";
import { RestartBudget } from "./restart-policy";

const READY_WAIT_MS = 10_000;
const STOP_WAIT_MS = 5_000;

export interface McpHubLaunch {
	/** Memory's state file (`recall.json`, written by the core's memory service, `crates/core/src/aimemory/service`). */
	memoryStateFile: string;
	lowerPriority?: LowerAgentPriority;
	/** One line per start, exit and restart (`gui-runtime.jsonl`). */
	log?: (message: string, details?: Record<string, unknown>) => void;
}

export class McpHub {
	readonly #launch: McpHubLaunch;
	readonly #secret = randomBytes(32).toString("hex");
	readonly #budget = new RestartBudget();
	#child: ChildProcess | null = null;
	#port = 0;
	#ready = Promise.withResolvers<void>();
	#restartTimer: NodeJS.Timeout | null = null;
	#started = false;
	#disposed = false;

	constructor(launch: McpHubLaunch) {
		this.#launch = launch;
	}

	get port(): number {
		return this.#port;
	}

	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		this.#spawn();
	}

	/** Connection settings for a spawned omp, empty if the hub never listened. */
	async ompEnv(): Promise<Record<string, string>> {
		this.start();
		this.#revive();
		if (this.#port === 0) {
			const timer = Promise.withResolvers<void>();
			const handle = setTimeout(timer.resolve, READY_WAIT_MS);
			await Promise.race([this.#ready.promise, timer.promise]);
			clearTimeout(handle);
		}
		if (this.#port === 0) return {};
		return {
			[MCP_HUB_ENV]: `http://127.0.0.1:${this.#port}`,
			[MCP_AUTH_ENV]: `Bearer ${this.#secret}`,
		};
	}

	#spawn(): void {
		if (this.#disposed) return;
		let child: ChildProcess;
		try {
			child = spawn(nativeBinPath("ompdesk-core"), ["--mcp-hub"], {
				stdio: ["pipe", "pipe", "ignore"],
				env: {
					...process.env,
					OMP_GUI_MCP_HUB_SECRET: this.#secret,
					OMP_GUI_MCP_HUB_PORT: String(this.#port),
					OMP_GUI_MEMORY: this.#launch.memoryStateFile,
				},
				windowsHide: true,
			});
		} catch (error) {
			this.#restart(error instanceof Error ? error.message : String(error));
			return;
		}
		this.#child = child;
		this.#launch.lowerPriority?.(child.pid);
		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = (stdout + chunk.toString("utf8")).slice(-512);
			const match = /mcp-hub listening http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
			if (!match) return;
			stdout = "";
			this.#port = Number(match[1]);
			this.#budget.noteReady();
			this.#launch.log?.("listening", { port: this.#port, pid: child.pid });
			this.#ready.resolve();
		});
		child.on("error", error => {
			if (this.#child !== child) return;
			this.#child = null;
			this.#restart(error.message);
		});
		child.on("exit", (code, signal) => {
			if (this.#child !== child) return;
			this.#child = null;
			this.#restart(`exit code ${code}${signal ? ` (${signal})` : ""}`);
		});
	}

	#restart(reason: string): void {
		if (this.#disposed) return;
		const delay = this.#budget.nextDelay();
		this.#launch.log?.("exited", { reason, restartInMs: delay });
		if (delay === null) return;
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = null;
			this.#spawn();
		}, delay);
	}

	/** A spawn wants the hub after its restarts were spent: bring it up again (bounded by the budget's rounds). */
	#revive(): void {
		if (!this.#started || this.#disposed || this.#child || this.#restartTimer) return;
		if (this.#budget.revive(Date.now()) === "scheduled") this.#spawn();
	}

	/** Stops the hub for good; resolves once it is gone. */
	kill(): Promise<void> {
		this.#disposed = true;
		clearTimeout(this.#restartTimer ?? undefined);
		this.#restartTimer = null;
		const child = this.#child;
		this.#child = null;
		if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
		const exited = new Promise<void>(done => child.once("exit", () => done()));
		child.stdin?.end();
		return Promise.race([exited, new Promise<void>(done => setTimeout(done, STOP_WAIT_MS).unref())]);
	}
}
