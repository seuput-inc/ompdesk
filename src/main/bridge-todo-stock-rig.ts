/**
 * Shared world of the todo rules' stock tests (bridge-todo-stale-stock.test.ts, bridge-todo-compact-stock.test.ts):
 * the installed omp in `--mode rpc-ui` with the bridge, a scripted OpenAI-style provider, and for the opt-in real
 * runs the user's config copied into a private agent dir. Every process and folder it makes is released by the
 * importing file's `afterAll`.
 */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect } from "vitest";
import { CLEANUP_MS } from "./bridge-agent-mail-stock-harness";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { configDirName, OMP_COMMAND, stopOmpDaemon } from "./test-bridge-probe";
import { RM_TEMP } from "./test-fake-omp";

export type Frame = {
	type: string;
	id?: string;
	toolName?: string;
	args?: { op?: string };
	result?: {
		details?: { op?: string; phases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }> };
	};
	isError?: boolean;
	message?: { role?: string; customType?: string };
	[key: string]: unknown;
};

const cleanups: Array<() => Promise<void> | void> = [];
// The same budget as the agent-mail stock suites: each omp gets up to 30 s to exit and each folder waits for omp's
// daemon, past vitest's 10 s hook default (bridge-todo-drift-stock's six omps took longer on a busy Linux runner).
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
}, CLEANUP_MS);

export function onCleanup(cleanup: () => Promise<void> | void): void {
	cleanups.push(cleanup);
}

export function sse(chunks: unknown[], finish: string): string {
	const frame = (delta: unknown, reason: string | null = null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
	return `${frame({ role: "assistant", content: "" })}${chunks.map(chunk => frame(chunk)).join("")}${frame({}, finish)}data: [DONE]\n\n`;
}

export function toolCall(name: string, args: Record<string, unknown>): unknown[] {
	return [
		{
			tool_calls: [
				{
					index: 0,
					id: `call_${name}_${Math.random().toString(36).slice(2)}`,
					type: "function",
					function: { name, arguments: JSON.stringify(args) },
				},
			],
		},
	];
}

/**
 * A scripted provider: `reply(step, body)` answers the main agent's `step`th request (1-based) with an SSE body; it
 * gets the request's JSON text, so a scripted agent can act on what the request carries. Requests without the `todo`
 * tool (side models, compaction) get a plain answer and are not counted.
 */
export async function startProvider(
	reply: (step: number, body: string) => string,
): Promise<{ url: string; bodies: string[] }> {
	const bodies: string[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body || "{}") as { tools?: Array<{ function?: { name?: string } }> };
			const main = (parsed.tools ?? []).some(tool => tool.function?.name === "todo");
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (!main) {
				res.end(sse([{ content: "side" }], "stop"));
				return;
			}
			bodies.push(body);
			res.end(reply(bodies.length, body));
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	cleanups.push(() => {
		server.closeAllConnections();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		return closed.promise;
	});
	return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies };
}

/** A private agent dir whose only model is the scripted provider's `fake/m1`. */
export function fakeAgent(url: string): { agentDir: string; isolated: string } {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-todo-stock-"));
	chmodSync(isolated, 0o700);
	cleanups.push(() => rmSync(isolated, { recursive: true, force: true }));
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  fake:\n    baseUrl: ${url}\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        reasoning: false\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
	);
	return { agentDir, isolated };
}

/** The user's config and credentials copied into a private agent dir (never touched); the main model is `smol`. */
export function realAgent(): { agentDir: string; isolated: string; smol: string } {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-todo-stock-real-"));
	chmodSync(isolated, 0o700);
	cleanups.push(() => rmSync(isolated, { recursive: true, force: true }));
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const config = readFileSync(join(homedir(), ".omp/agent/config.yml"), "utf8");
	const smol = /^ {2}smol:\s*(\S+)\s*$/m.exec(config)?.[1];
	if (!smol) throw new Error("config.yml has no modelRoles.smol");
	writeFileSync(join(agentDir, "config.yml"), config);
	const models = join(homedir(), ".omp/agent/models.yml");
	if (existsSync(models)) writeFileSync(join(agentDir, "models.yml"), readFileSync(models));
	const db = new DatabaseSync(join(homedir(), ".omp/agent/agent.db"), { readOnly: true });
	try {
		db.exec(`VACUUM INTO '${join(agentDir, "agent.db").replaceAll("'", "''")}'`);
	} finally {
		db.close();
	}
	return { agentDir, isolated, smol };
}

/** The bridge as it was at `ref`, extracted beside a copy of `src/shared` its type imports name. */
export function bridgeAt(ref: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-todo-stock-before-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const archive = execFileSync("git", ["archive", ref, "resources/gui-bridge", "src/shared"], { maxBuffer: 1 << 28 });
	execFileSync("tar", ["-x", "-C", dir], { input: archive });
	return join(dir, "resources/gui-bridge/index.ts");
}

export interface Omp {
	frames: Frame[];
	send(command: Record<string, unknown>): Promise<Frame>;
	/**
	 * Sends a prompt and resolves with the frames of its turn once the session settled; one that has not settled
	 * within `timeoutMs` fails with `diagnose()`.
	 */
	turn(message: string, timeoutMs?: number): Promise<Frame[]>;
	/** What a run that stalled left to read: the frames omp wrote, in order with repeats counted, and its stderr. */
	diagnose(): string;
	root: string;
	/** The bridge as main reaches it, connected once omp is ready, and every frame it pushed (`emit`), in order. */
	bridge: GuiBridgeClient;
	bridgeEvents: Array<{ type: string; [key: string]: unknown }>;
	/** OMPdesk's quit of a tab's omp (stdin closes); a second call waits for the same exit. */
	quit(): Promise<void>;
}

export async function startOmp(options: {
	agentDir: string;
	isolated: string;
	model: string;
	bridge: string;
	/** Host tools to register once ready (`set_host_tools`), each answered with its text as it is called. */
	hostTools?: Record<string, { description: string; parameters: Record<string, unknown>; answer: string }>;
	/** An earlier run's folder, to continue its newest session there (`--continue`), as a relaunch does. */
	resume?: string;
	/** Variables set over the test's environment for this omp (after the OMPdesk ones are removed). */
	env?: Record<string, string>;
}): Promise<Omp> {
	const root = options.resume ?? realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-todo-stock-repo-")));
	if (!options.resume) execFileSync("git", ["init", "--quiet"], { cwd: root });
	const address = newBridgeAddress();
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: options.agentDir,
		// Stock joins it to the home folder (pi-utils dirs.ts `getConfigDirName`): an absolute path would land under home.
		PI_CONFIG_DIR: configDirName(options.isolated),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_BRIDGE: address,
	};
	for (const key of ["ELECTRON_RUN_AS_NODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
		Reflect.deleteProperty(env, key);
	for (const key of Object.keys(env))
		if (key.startsWith("OMP_GUI_") && key !== "OMP_GUI_BRIDGE") Reflect.deleteProperty(env, key);
	Object.assign(env, options.env);
	// Windows: a process whose working folder this is keeps it from removal (EBUSY) while it runs: omp 18's service
	// broker, which ended with omp here (vitest.setup.ts `OMP_DAEMON_IDLE_GRACE_MS`), and omp 19's daemon, which does not.
	if (!options.resume)
		cleanups.push(() => {
			stopOmpDaemon(options.isolated);
			rmSync(root, RM_TEMP);
		});
	const child: ChildProcessWithoutNullStreams = spawn(
		OMP_COMMAND.file,
		[
			...OMP_COMMAND.args,
			"--mode",
			"rpc-ui",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			...(options.resume ? ["--continue"] : []),
			"--model",
			options.model,
			"-e",
			options.bridge,
		],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = Promise.withResolvers<void>();
	child.once("exit", () => exited.resolve());
	const bridge = new GuiBridgeClient(address);
	const bridgeEvents: Omp["bridgeEvents"] = [];
	bridge.onEvent(event => bridgeEvents.push(event));
	let exit: Promise<void> | undefined;
	const quit = () => {
		exit ??= (async () => {
			bridge.close();
			child.stdin.end();
			// A real omp exits on stdin EOF; SIGKILL only if it does not.
			const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
			await exited.promise;
			clearTimeout(timer);
			removeBridgeAddress(address);
		})();
		return exit;
	};
	cleanups.push(quit);
	const frames: Frame[] = [];
	const responses = new Map<string, (frame: Frame) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as Frame;
			if (frame.type === "response" && frame.id && responses.has(frame.id)) responses.get(frame.id)?.(frame);
			else {
				frames.push(frame);
				const tool = frame.type === "host_tool_call" ? options.hostTools?.[String(frame.toolName)] : undefined;
				if (tool)
					child.stdin.write(
						`${JSON.stringify({ type: "host_tool_result", id: frame.id, result: { content: [{ type: "text", text: tool.answer }] } })}\n`,
					);
			}
		} catch {
			// not a frame
		}
	});
	await expect
		.poll(() => frames.some(frame => frame.type === "ready"), { timeout: 60_000, message: stderr })
		.toBe(true);
	await expect
		.poll(
			() =>
				bridge.connect(1_000).then(
					() => true,
					() => false,
				),
			{ timeout: 60_000, message: `bridge never came up\n${stderr.slice(-2000)}` },
		)
		.toBe(true);
	let counter = 0;
	const registered = Object.entries(options.hostTools ?? {}).map(([name, tool]) => ({
		name,
		description: tool.description,
		parameters: tool.parameters,
		loadMode: "essential",
	}));
	const send = (command: Record<string, unknown>) => {
		const answered = Promise.withResolvers<Frame>();
		const id = `c${++counter}`;
		responses.set(id, answered.resolve);
		child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		return answered.promise;
	};
	if (registered.length > 0) await send({ type: "set_host_tools", tools: registered });
	const diagnose = () => {
		const seen: string[] = [];
		let last = "";
		let repeats = 0;
		const flush = () => {
			if (last) seen.push(repeats > 1 ? `${last} x${repeats}` : last);
		};
		for (const frame of frames) {
			const name = frame.toolName ? `${frame.type}:${String(frame.toolName)}` : frame.type;
			if (name === last) repeats++;
			else {
				flush();
				last = name;
				repeats = 1;
			}
		}
		flush();
		return `frames: ${seen.join(" > ")}\nomp stderr: ${stderr.slice(-2000)}`;
	};
	const turn = async (message: string, timeoutMs = 300_000) => {
		const from = frames.length;
		await send({ type: "prompt", message });
		try {
			await expect
				.poll(() => frames.slice(from).some(frame => frame.type === "session_settled"), { timeout: timeoutMs })
				.toBe(true);
		} catch (error) {
			throw new Error(`the turn never settled\n${diagnose()}`, { cause: error });
		}
		return frames.slice(from);
	};
	return { frames, send, turn, diagnose, root, bridge, bridgeEvents, quit };
}

export function todoOps(frames: readonly Frame[]): string[] {
	return frames
		.filter(frame => frame.type === "tool_execution_start" && frame.toolName === "todo")
		.map(frame => frame.args?.op ?? "?");
}
