/**
 * Background bash jobs survive a relaunch (rules: `.omp/rules/interrupted-work.md` › Background jobs survive a
 * relaunch). Stock runs a background job (`bash` with `async: true`) in omp's own embedded shell, so an app relaunch,
 * which ends every omp, ended the job, and the agent was told to start it again. Here the job's command runs in stock's
 * shell process (`omp __omp_worker_shell_process`, seeded with the session shell's exports, functions and aliases as
 * stock seeds a service) under `ompdesk keep` (`native/ompdesk/crates/checks/src/keep.rs`), outside omp and OMPdesk:
 * output to a file the job reads, exit code to a file. A stop leaves it running; the relaunch's restore registers the
 * job again under its own id (`reattachKeptJobs`), so `wait`, `jobs` and the delivered result work as before.
 *
 * Only the main agent's background calls whose command names no session URL path (`keepable`) are kept; subagents'
 * jobs, `pty` and named services stay stock's. Without the CLI (`KEEP_CLI_ENV` unset, tests) everything is stock's.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ShellRunOptions, ShellRunResult } from "@oh-my-pi/pi-natives";
import { guard } from "./health";
import { KEEP_CLI_ENV, keepable, keptExit, keptJobDir, keptResult } from "./kept-jobs-core";
import { shellProcessCommand } from "./omp/pi-coding-agent/exec/shell-process";
import { Shell } from "./omp/pi-natives";
import { type JournalEntry, unsettledJobs } from "./restart-core";

/** How often a kept job's files are read. */
const FOLLOW_MS = 200;

/** Calls that start a kept job, by tool call id: the folder it runs in. Taken by the job's shell run. */
const starting = new Map<string, string>();
/** Set when the main session's omp ends: a job cancelled then is left running for the relaunch. */
let quitting = false;

type Run = (
	this: Shell,
	options: ShellRunOptions,
	onChunk?: ((error: Error | null, chunk: string) => void) | null,
) => Promise<ShellRunResult>;

function cli(): string | undefined {
	return process.env[KEEP_CLI_ENV] || undefined;
}

async function readText(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return undefined;
	}
}

interface Followed {
	code?: number;
	/** Cancelled (by its job's signal, outside a quit) or timed out. */
	cancelled: boolean;
	timedOut: boolean;
	/** The quit ended the job's wait; the command still runs. */
	left: boolean;
	output: string;
}

/**
 * Reads a kept job's output as it grows until it ends. A cancel (`signal`) outside a quit, or `timeoutMs`, asks the
 * runner to end the command; a cancel during the quit leaves it running.
 */
async function follow(
	dir: string,
	{ signal, timeoutMs, onText }: { signal?: AbortSignal; timeoutMs?: number; onText?: (text: string) => void },
): Promise<Followed> {
	const log = path.join(dir, "output.log");
	const decoder = new TextDecoder();
	const deadline = timeoutMs ? Date.now() + timeoutMs : undefined;
	let offset = 0;
	let output = "";
	let stop: "cancel" | "timeout" | "leave" | undefined;
	let asked = false;
	const onAbort = (): void => {
		stop ??= quitting ? "leave" : "cancel";
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const drain = async (): Promise<void> => {
		const handle = await fs.open(log, "r").catch(() => undefined);
		if (!handle) return;
		try {
			for (;;) {
				const buffer = Buffer.alloc(64 * 1024);
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
				if (bytesRead === 0) break;
				offset += bytesRead;
				const text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
				if (text) {
					output += text;
					onText?.(text);
				}
			}
		} finally {
			await handle.close();
		}
	};
	try {
		for (;;) {
			await drain();
			const exit = await readText(path.join(dir, "exit"));
			if (exit !== undefined) {
				await drain();
				const code = keptExit(exit);
				return {
					code,
					cancelled: stop === "cancel" || stop === "timeout",
					timedOut: stop === "timeout",
					left: false,
					output,
				};
			}
			if (stop === "leave") return { cancelled: true, timedOut: false, left: true, output };
			if (!stop && deadline !== undefined && Date.now() >= deadline) stop = "timeout";
			if ((stop === "cancel" || stop === "timeout") && !asked) {
				asked = true;
				await fs.writeFile(path.join(dir, "cancel"), "");
			}
			await Bun.sleep(FOLLOW_MS);
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * The session shell's exports, functions and aliases for a process started from it: stock's `#sessionSeed`
 * (tools/bash.ts), run on the job's own copy of the session's shell.
 */
async function sessionSeed(
	shell: Shell,
	run: Run,
	options: ShellRunOptions,
	dir: string,
): Promise<Record<string, string>> {
	const envFile = path.join(dir, "seed.env");
	const quote = (file: string): string => `'${file.replaceAll("'", `'\\''`)}'`;
	const dump = `env -0 > ${quote(envFile)} && { shopt -p expand_aliases; declare -f; alias -p; } > ${quote(path.join(dir, "seed.sh"))} 2>/dev/null`;
	const result = await run.call(shell, { command: dump, cwd: options.cwd, env: options.env, timeoutMs: 10_000 });
	if (result.exitCode !== 0) throw new Error(`could not read the session shell's state (exit ${result.exitCode})`);
	const env: Record<string, string> = {};
	for (const entry of ((await readText(envFile)) ?? "").split("\0")) {
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		const key = entry.slice(0, eq);
		if (key === "PWD" || key === "OLDPWD" || key === "SHLVL" || key === "_") continue;
		env[key] = entry.slice(eq + 1);
	}
	await fs.rm(envFile, { force: true });
	return env;
}

/** Runs a background job's command under `ompdesk keep` and follows it as the job's shell run. */
async function keptRun(
	shell: Shell,
	run: Run,
	binary: string,
	dir: string,
	options: ShellRunOptions,
	onChunk?: ((error: Error | null, chunk: string) => void) | null,
): Promise<ShellRunResult> {
	await fs.mkdir(dir, { recursive: true });
	const seedEnv = await sessionSeed(shell, run, options, dir);
	const { application, args } = shellProcessCommand({ command: options.command, source: path.join(dir, "seed.sh") });
	await fs.writeFile(path.join(dir, "spec.json"), JSON.stringify({ argv: [application, ...args], cwd: options.cwd }));
	const start = Bun.spawn([binary, "keep", "start", dir], {
		env: { ...process.env, ...seedEnv, ...options.env },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([start.exited, new Response(start.stderr).text()]);
	if (code !== 0) {
		// A runner that started late must not run the command after this call reported it failed.
		await fs.writeFile(path.join(dir, "cancel"), "");
		onChunk?.(null, `OMPdesk could not start the background job outside omp: ${stderr.trim() || `exit ${code}`}\n`);
		return { exitCode: 1, cancelled: false, timedOut: false };
	}
	const followed = await follow(dir, {
		signal: options.signal as AbortSignal | undefined,
		timeoutMs: options.timeoutMs,
		onText: text => onChunk?.(null, text),
	});
	if (!followed.left) await fs.rm(dir, { recursive: true, force: true });
	return followed.code === undefined || followed.cancelled
		? { cancelled: followed.cancelled || followed.code === undefined, timedOut: followed.timedOut }
		: { exitCode: followed.code, cancelled: false, timedOut: false };
}

// Once per process: every extension instance shares the shell class and `starting`.
const stockRun = Shell.prototype.run as Run;
Shell.prototype.run = function (this: Shell, options, onChunk) {
	const id = options.env?.PI_TOOL_CALL_ID;
	const dir = id ? starting.get(id) : undefined;
	const binary = cli();
	if (!id || !dir || !binary) return stockRun.call(this, options, onChunk);
	starting.delete(id);
	return keptRun(this, stockRun, binary, dir, options, onChunk);
} satisfies Run;

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	const main = pi.pi.MAIN_AGENT_ID;
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash" || ctx.agent.id !== main || !cli()) return undefined;
		const { command, async, pty, name } = event.input;
		if (async !== true || pty === true || name !== undefined) return undefined;
		if (typeof command !== "string" || !keepable(command)) return undefined;
		const artifacts = ctx.sessionManager.getArtifactsDir?.();
		if (artifacts) starting.set(event.toolCallId, keptJobDir(artifacts, event.toolCallId, path.join));
		return undefined;
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.id === main) quitting = true;
	});
}

/** The job manager the session's bash tool registers background jobs with, as stock's bash tool reaches it. */
interface BashToolSession {
	asyncJobManager?: {
		register(
			type: "bash",
			label: string,
			run: (ctx: {
				jobId: string;
				signal: AbortSignal;
				reportProgress: (text: string) => Promise<void>;
			}) => Promise<string>,
			options?: { id?: string; ownerId?: string; intent?: string },
		): string;
	};
	getAgentId?(): string | undefined;
}

/**
 * After a relaunch: registers again every background job of `branch` whose kept runner exists, under the job's own id,
 * following the same files. Returns the ids reattached; the restart's follow-up leaves them out.
 */
export async function reattachKeptJobs(
	session: {
		sessionManager: { getArtifactsDir?(): string | null };
		getToolByName(name: string): unknown;
	},
	branch: readonly JournalEntry[],
): Promise<string[]> {
	const artifacts = session.sessionManager.getArtifactsDir?.();
	// BashTool keeps its ToolSession in a TypeScript-private `session` field.
	const bash = session.getToolByName("bash") as { session?: BashToolSession } | undefined;
	const tool = bash?.session;
	const manager = tool?.asyncJobManager;
	if (!artifacts || !manager) return [];
	const reattached: string[] = [];
	for (const job of unsettledJobs(branch)) {
		const dir = keptJobDir(artifacts, job.toolCallId, path.join);
		if ((await readText(path.join(dir, "spec.json"))) === undefined) continue;
		manager.register(
			"bash",
			job.command,
			async ({ signal, reportProgress }) => {
				let shown = "";
				const followed = await follow(dir, {
					signal,
					onText: text => {
						shown = (shown + text).slice(-4_000);
						void reportProgress(shown);
					},
				});
				if (followed.left) return "";
				await fs.rm(dir, { recursive: true, force: true });
				const text = keptResult(followed.output, followed.code ?? -1);
				if (followed.code !== 0) throw new Error(text);
				return text;
			},
			{ id: job.id, ownerId: tool.getAgentId?.(), ...(job.intent ? { intent: job.intent } : {}) },
		);
		reattached.push(job.id);
	}
	return reattached;
}

export const methods = guard("keptJobs", {});
