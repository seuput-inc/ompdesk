import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { withoutSessionEnv } from "./omp-launch";
import { ompPackageRoot } from "./omp-runtime";
import { INSTALLED_OMP } from "./test-bridge-probe";
import { removeWhenFree } from "./test-folders";
import { StockRpc } from "./test-stock-rpc";

/**
 * A subagent never moves to another model behind its parent's back (models-accounts.md › Subagent models). Reported
 * 20 Nov 2026: `reviewer` subagents on the review role (openai-codex) hit a usage limit on their first
 * answer, stock's `retry.fallbackChains` (`openai-codex/*` → Claude) ran the rest on Claude, and the parent counted
 * them as a cross-family review. The owner's setup in miniature on the installed omp with the gui bridge: the parent
 * runs on B, the review role is A, `retry.fallbackChains` `fakea/*` → B on usage limits. A fake A on 127.0.0.1 answers
 * every request with a usage limit, a fake B answers, and a `--preload` guard refuses every request that would leave
 * loopback.
 *
 * - A subagent on the review role fails on A's limit and never asks B; the parent's task result names A and its limit.
 * - A subagent on another role still falls back to B as stock does, and the `wait` result that carries its task result
 *   says it ran on B, not on A, and quotes A's failure.
 */

const A = "fakea/a1";
const B = "fakeb/b1";
/** A's retry-after. Above `retry.maxDelayMs` (1 s), so stock gives up on A at once, as for a real multi-hour limit. */
const WAIT_S = 3;
const CHILD_MARK = "CHILD-ASSIGNMENT: look at the change";
const CREDENTIAL_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ELECTRON_RUN_AS_NODE",
];

/** Replaces `fetch` before any omp module loads: only loopback is reachable. */
const GUARD = `
const LOOPBACK = { "127.0.0.1": true, localhost: true, "[::1]": true };
const realFetch = globalThis.fetch;
const target = input => { try { return new URL(input instanceof Request ? input.url : String(input)); } catch { return undefined; } };
const allowed = url => url && (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK[url.hostname] === true;
async function guarded(input, init) {
 if (!allowed(target(input))) throw new TypeError("ompdesk test guard: non-loopback request refused");
 return realFetch(input, init);
}
guarded.preconnect = (input, options) => { if (allowed(target(input))) realFetch.preconnect(input, options); };
globalThis.fetch = guarded;
`;

type Step = { text: string } | { tool: string; args: Record<string, unknown> };

function sse(chunks: unknown[]): string {
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function completion(step: Step, tools: string[], callId: string): string {
	const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "fake" };
	const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
	if ("text" in step) {
		return sse([
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
		]);
	}
	const name = tools.find(tool => tool === step.tool || tool.endsWith(`_${step.tool}`)) ?? step.tool;
	const call = { index: 0, id: callId, type: "function", function: { name, arguments: JSON.stringify(step.args) } };
	return sse([
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
	]);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(part => textOf((part as { text?: unknown }).text ?? "")).join("");
	return "";
}

interface Fake {
	url: string;
	/** Every child request, `A:429` or `B:200`, in order. */
	child: string[];
	/** The text of each parent request's conversation after its first tool result, in order. */
	parentReads: string[];
	close(): Promise<void>;
}

/** The parent spawns `agent`, waits for it and then answers; the child gets A's usage limit or B's answer. */
async function startFake(agent: string): Promise<Fake> {
	const script: Step[] = [
		{
			tool: "task",
			args: { context: "probe", tasks: [{ name: "Probe", agent, task: CHILD_MARK, solutionSpace: "one look" }] },
		},
		{ tool: "wait", args: { i: "waiting for Probe" } },
	];
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", chunk => {
			body += chunk;
		});
		request.on("end", () => {
			const route = /^\/(a|b)\/v1\/chat\/completions$/.exec(request.url ?? "");
			if (!route) {
				response.writeHead(404).end();
				return;
			}
			const parsed = JSON.parse(body) as {
				messages: Array<{ role: string; content: unknown }>;
				tools?: Array<{ function?: { name?: string } }>;
			};
			const tools = (parsed.tools ?? []).map(tool => tool.function?.name ?? "");
			const parent = tools.some(tool => tool.endsWith("task"));
			const child =
				!parent &&
				parsed.messages.some(message => message.role === "user" && textOf(message.content).includes(CHILD_MARK));
			if (child && route[1] === "a") {
				fake.child.push("A:429");
				// `x-should-retry: false` keeps the provider client from retrying by itself, as for a hard limit.
				response.writeHead(429, {
					"content-type": "application/json",
					"retry-after": String(WAIT_S),
					"x-should-retry": "false",
				});
				response.end(
					JSON.stringify({
						error: {
							message: `You have reached your usage limit. Try again in ${WAIT_S} seconds.`,
							type: "usage_limit_reached",
						},
					}),
				);
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (child) {
				fake.child.push("B:200");
				response.end(completion({ text: "REVIEWED" }, tools, "child"));
				return;
			}
			if (!parent) {
				response.end(completion({ text: "side" }, tools, "side"));
				return;
			}
			const results = parsed.messages.filter(message => message.role === "tool").length;
			if (results > 0)
				fake.parentReads.push(
					parsed.messages
						.slice(1)
						.map(message => textOf(message.content))
						.join("\n"),
				);
			response.end(completion(script[results] ?? { text: "PARENT-DONE" }, tools, `call_${results}`));
		});
	});
	const fake: Fake = {
		url: "",
		child: [],
		parentReads: [],
		close: () => {
			server.closeAllConnections();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return fake;
}

interface Home {
	home: string;
	agentDir: string;
	repo: string;
	guard: string;
	configYml: string;
}

/** A private home whose omp knows only the two fake models, the probe agent on `model`, and the owner's chains. */
function makeHome(fake: Fake, model: string): Home {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-subagent-model-")));
	chmodSync(home, 0o700);
	const agentDir = join(home, ".omp", "agent");
	const repo = join(home, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(repo, ".omp", "agents"), { recursive: true });
	const guard = join(home, "net-guard.js");
	writeFileSync(guard, GUARD);
	const provider = (id: string, path: string, name: string) => [
		`  ${id}:`,
		`    baseUrl: ${fake.url}/${path}/v1`,
		`    apiKey: not-a-real-key-${path}`,
		"    api: openai-completions",
		"    models:",
		`      - id: ${name}`,
		`        name: Model ${path.toUpperCase()}`,
		"        reasoning: false",
		"        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }",
	];
	writeFileSync(
		join(agentDir, "models.yml"),
		["providers:", ...provider("fakea", "a", "a1"), ...provider("fakeb", "b", "b1"), ""].join("\n"),
	);
	writeFileSync(
		join(repo, ".omp", "agents", "probe.md"),
		[
			"---",
			"name: probe",
			'description: "Probe"',
			"tools: read",
			`model: "${model}"`,
			"---",
			"Look and report.",
		].join("\n"),
	);
	const configYml = [
		"modelRoles:",
		`  default: ${B}`,
		`  review: ${A}`,
		"retry:",
		"  fallbackOn: usage-limit",
		"  maxDelayMs: 1000",
		"  fallbackChains:",
		"    fakea/*:",
		`      - ${B}`,
		"",
	].join("\n");
	writeFileSync(join(agentDir, "config.yml"), configYml);
	return { home, agentDir, repo, guard, configYml };
}

type Frame = { type: string; willRetry?: boolean };

const stops: Array<() => Promise<void>> = [];
const homes: string[] = [];
afterAll(async () => {
	for (const stop of stops) await stop();
	for (const home of homes) await removeWhenFree(home);
});

/** The installed omp as a tab starts it, with the bridge; resolves once one prompt's run has ended. */
async function runOnce(at: Home, message: string): Promise<void> {
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
			"--preload",
			at.guard,
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
	const frames: Frame[] = [];
	const rpc = new StockRpc(frame => child.stdin.write(`${JSON.stringify(frame)}\n`), { timeout: 60_000 });
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as Frame | RpcResponse;
			if (frame.type === "response") rpc.onResponse(frame as RpcResponse);
			else frames.push(frame as Frame);
		} catch {
			// Stock may print startup diagnostics.
		}
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
	try {
		await expect
			.poll(() => frames.some(frame => frame.type === "ready"), {
				timeout: 60_000,
				message: `omp's ready frame\n${stderr.slice(-2000)}`,
			})
			.toBe(true);
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
		const sent = await rpc.stock({ type: "prompt", message } as RpcCommand);
		expect(sent.success, JSON.stringify(sent)).toBe(true);
		await expect
			.poll(() => frames.some(frame => frame.type === "agent_end" && frame.willRetry !== true), {
				timeout: 90_000,
				message: `the end of "${message}"\n${stderr.slice(-1500)}`,
			})
			.toBe(true);
	} finally {
		await stop();
	}
}

describe.skipIf(!existsSync(INSTALLED_OMP))("a subagent's model on the installed omp", () => {
	it("on the review role: A's limit fails the child, B is never asked, and the parent reads why", async () => {
		const fake = await startFake("probe");
		const at = makeHome(fake, "@review");
		homes.push(at.home);
		try {
			await runOnce(at, "review the change");
			expect(fake.child).not.toContain("B:200");
			expect(fake.child[0]).toBe("A:429");
			const read = fake.parentReads.join("\n");
			// Stock's own failure names the model and its limit; nothing in it reads as a review that ran.
			expect(read).toContain('status="failed');
			expect(read).toContain(`[${A}] 429 You have reached your usage limit`);
			expect(read).not.toContain("REVIEWED");
			expect(readFileSync(join(at.agentDir, "config.yml"), "utf8")).toBe(at.configYml);
		} finally {
			await fake.close();
		}
	}, 150_000);

	it("on another role: the child falls back to B as stock does, and the parent reads that it ran on B", async () => {
		const fake = await startFake("probe");
		const at = makeHome(fake, A);
		homes.push(at.home);
		try {
			await runOnce(at, "look at the change");
			expect(fake.child).toEqual(["A:429", "B:200"]);
			const read = fake.parentReads.join("\n");
			expect(read).toContain("REVIEWED");
			expect(read).toContain(`ran on ${B} for 1 of its 1 answers, not on its chosen model ${A}, which failed:`);
			expect(read).toMatch(/which failed: [^\n]*usage limit/);
		} finally {
			await fake.close();
		}
	}, 150_000);
});
