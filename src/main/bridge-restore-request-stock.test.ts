import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it, onTestFinished } from "vitest";
import { KEEP_CLI_ENV } from "../../resources/gui-bridge/kept-jobs-core";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { nativeBinPath } from "./native-bin";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp, stopOmpDaemon } from "./test-bridge-probe";
import { RM_TEMP } from "./test-fake-omp";

/**
 * A relaunch continues a turn that OMPdesk's quit cut while omp was preparing its next model request (bridge
 * `composer.restore_interrupted` → stock `restoreSession`), on the installed omp with a scripted OpenAI-compatible
 * provider on loopback (no model spend).
 *
 * Reported on v0.41.0 (19 Oct 2026): "Restart to update" ended a session ~140 ms after its bash result came back,
 * while stock was still building the next request over a 600k-token context. Stock disposed the session and journaled
 * `session_exit` with kind `normal` and no pending tool call; the abort landed before the model call, where stock's
 * agent loop stops without an assistant message (pi-agent-core `agent-loop.ts`, the `beforeModelCall` gate), so no
 * aborted reply reached the journal. Stock's `findUnfinishedTurn` reads a normal exit with nothing pending as a turn
 * that ended, and `/retry` finds no failed reply: the relaunch logged `restored: nothing, retried: false` and the turn
 * was dropped. A prompt cut the same way in a session that already had a reply is dropped alike.
 *
 * The test widens that window with a second extension whose `context` handler (awaited before every model request)
 * waits until the abort, then quits the way OMPdesk does: stdin closes.
 */
const FIRST = "FIRST-MARK say hello";
const SECOND = "SECOND-MARK go on";

type Step = { text: string } | { tool: string; args: Record<string, unknown> };

function sse(chunks: unknown[]): string {
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function completion(step: Step, tools: string[], callId: string): string {
	const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m1" };
	const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
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

interface Provider {
	url: string;
	/** Second-turn requests past `secondTurn`'s steps, answered `CONTINUED`: the continued turn. */
	continued: number;
	/** Every request body, in order. */
	requests: string[];
}

/** The first prompt is answered in text; the second runs `secondTurn` (one step per tool result since it), then `CONTINUED`. */
async function startProvider(secondTurn: readonly Step[]): Promise<Provider> {
	const provider: Provider = { url: "", continued: 0, requests: [] };
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			provider.requests.push(body);
			if (!req.url?.endsWith("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			const parsed = JSON.parse(body) as {
				messages: Array<{ role: string; content: unknown }>;
				tools?: Array<{ function?: { name?: string } }>;
			};
			const tools = (parsed.tools ?? []).map(tool => tool.function?.name ?? "");
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			// Side requests (the next-prompt suggestion, a title) offer no bash tool: a plain answer.
			if (!tools.some(tool => tool.endsWith("bash"))) {
				res.end(completion({ text: "side" }, tools, "side"));
				return;
			}
			const second = parsed.messages.findIndex(
				message => message.role === "user" && textOf(message.content).includes(SECOND),
			);
			if (second === -1) {
				res.end(completion({ text: "FIRST-DONE" }, tools, "first"));
				return;
			}
			const step = parsed.messages.slice(second).filter(message => message.role === "tool").length;
			const scripted = secondTurn[step];
			if (scripted) {
				res.end(completion(scripted, tools, `call_${step}`));
				return;
			}
			provider.continued++;
			res.end(completion({ text: "CONTINUED" }, tools, "continued"));
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	provider.url = `http://127.0.0.1:${port}/v1`;
	onTestFinished(() => {
		const closed = server[Symbol.asyncDispose]();
		server.closeAllConnections();
		return closed;
	});
	return provider;
}

/**
 * While `hold` exists, the request after `holdAfter` (the second prompt, or its bash result) waits in a `context`
 * handler until the session aborts, after writing `held`: the slow request preparation of the report.
 */
function writeHoldExtension(dir: string, holdAfter: "user" | "toolResult"): { hold: string; held: string } {
	const hold = join(dir, "hold");
	const held = join(dir, "held");
	writeFileSync(hold, "");
	writeFileSync(
		join(dir, "hold-extension.ts"),
		`import { existsSync, writeFileSync } from "node:fs";
export default function (pi: { on(event: string, handler: (event: { messages: Array<{ role: string; content: unknown }> }, ctx: unknown, signal?: AbortSignal) => unknown): void }) {
	pi.on("context", async (event, _ctx, signal) => {
		if (!existsSync(${JSON.stringify(hold)})) return undefined;
		const text = JSON.stringify(event.messages);
		const last = event.messages.findLast(message => message.role === "user" || message.role === "toolResult" || message.role === "assistant");
		if (!text.includes(${JSON.stringify(SECOND)}) || last?.role !== ${JSON.stringify(holdAfter)}) return undefined;
		writeFileSync(${JSON.stringify(held)}, "");
		await new Promise<void>(done => {
			if (signal?.aborted) done();
			signal?.addEventListener("abort", () => done());
		});
		return undefined;
	});
}
`,
	);
	return { hold, held };
}

interface Omp {
	bridge: GuiBridgeClient;
	frames: Array<{ type: string; [key: string]: unknown }>;
	send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
	/** OMPdesk's quit of a tab's omp (sidecar.ts): stdin closes and stock disposes the session. */
	quit(): Promise<void>;
	/** A crash, or a computer that went off: the process ends with nothing journaled. */
	kill(): Promise<void>;
}

function testFolders(prefix: string) {
	const isolated = mkdtempSync(join(tmpdir(), `ompdesk-${prefix}-`));
	chmodSync(isolated, 0o700);
	const root = realpathSync(mkdtempSync(join(tmpdir(), `ompdesk-${prefix}-repo-`)));
	onTestFinished(() => {
		// omp 19's daemon for this config folder keeps it and the repository busy on Windows.
		stopOmpDaemon(isolated);
		rmSync(isolated, RM_TEMP);
		rmSync(root, RM_TEMP);
	});
	return { isolated, root };
}

async function startOmp(
	provider: Provider,
	isolated: string,
	root: string,
	resume: boolean,
	extraEnv: Record<string, string> = {},
): Promise<Omp> {
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		[
			"providers:",
			"  fake:",
			`    baseUrl: ${provider.url}`,
			"    apiKey: x",
			"    api: openai-completions",
			"    models:",
			"      - id: m1",
			"        name: m1",
			"        reasoning: false",
			"        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }",
			"",
		].join("\n"),
	);
	const address = newBridgeAddress();
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: configDirName(isolated),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_BRIDGE: address,
		...extraEnv,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]) Reflect.deleteProperty(env, key);
	const child: ChildProcessWithoutNullStreams = spawn(
		OMP_COMMAND.file,
		[
			...OMP_COMMAND.args,
			...["--mode", "rpc-ui", "--no-extensions", "--no-skills", "--no-rules"],
			...(resume ? ["--continue"] : []),
			...["--model", "fake/m1", "-e", resolve("resources/gui-bridge/index.ts")],
			...["-e", join(isolated, "hold-extension.ts")],
		],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	const frames: Omp["frames"] = [];
	const responses = new Map<string, (value: Record<string, unknown>) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as { type: string; id?: string; [key: string]: unknown };
			if (frame.type === "response" && frame.id && responses.has(frame.id)) responses.get(frame.id)?.(frame);
			else frames.push(frame);
		} catch {
			// not a frame
		}
	});
	const bridge = new GuiBridgeClient(address);
	let counter = 0;
	// A killed omp can close its stdin while a write is pending.
	child.stdin.on("error", () => undefined);
	const quit = async () => {
		bridge.close();
		if (child.exitCode === null && child.signalCode === null) {
			child.stdin.end();
			// A guard, not a wait: an omp that ignores its closed stdin is killed so the test ends.
			const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
			await exited;
			clearTimeout(timer);
		}
		removeBridgeAddress(address);
	};
	const kill = async () => {
		bridge.close();
		child.kill("SIGKILL");
		await exited;
		removeBridgeAddress(address);
	};
	onTestFinished(quit);
	await expect.poll(() => frames.some(frame => frame.type === "ready"), { timeout: 60_000 }).toBe(true);
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
	return {
		bridge,
		frames,
		quit,
		kill,
		send: command => {
			const id = `c${++counter}`;
			const { promise, resolve: done, reject: fail } = Promise.withResolvers<Record<string, unknown>>();
			// A guard, not a wait: an omp that never answers fails the test with its stderr.
			const timer = setTimeout(() => fail(new Error(`no response\n${stderr.slice(-1500)}`)), 60_000);
			responses.set(id, value => {
				clearTimeout(timer);
				done(value);
			});
			child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			return promise;
		},
	};
}

interface Entry {
	type?: string;
	customType?: string;
	data?: { kind?: string; pendingToolCalls?: unknown[] };
	message?: { role?: string; content?: unknown; stopReason?: string };
}

function journalFile(isolated: string): string {
	const sessions = join(isolated, "agent", "sessions");
	const [project] = readdirSync(sessions);
	const [file] = readdirSync(join(sessions, project ?? "")).filter(name => name.endsWith(".jsonl"));
	return join(sessions, project ?? "", file ?? "");
}

function journal(isolated: string): Entry[] {
	return readFileSync(journalFile(isolated), "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Entry);
}

const messagesOf = (entries: readonly Entry[]) => entries.filter(entry => entry.type === "message");

/**
 * One omp life that answers a first prompt, then quits while the second turn prepares its next model request.
 * `lostAfterExit`: the tail message (`holdAfter`) is journaled before the quit, and stock's own abort record, written
 * after its `session_exit`, never reaches the journal (the report: omp's stdout write failed EPIPE as the app went and
 * stock's graceful quit ended the process first; a race this test cannot time, so it removes what followed the exit).
 */
async function quitBeforeRequest(
	secondTurn: readonly Step[],
	holdAfter: "user" | "toolResult",
	options: { lostAfterExit?: boolean } = {},
) {
	const { isolated, root } = testFolders("request");
	const provider = await startProvider(secondTurn);
	const { hold, held } = writeHoldExtension(isolated, holdAfter);
	const first = await startOmp(provider, isolated, root, false);
	await first.send({ type: "prompt", message: FIRST });
	await expect.poll(() => first.frames.some(frame => frame.type === "agent_end"), { timeout: 60_000 }).toBe(true);
	await first.send({ type: "prompt", message: SECOND });
	await expect.poll(() => existsSync(held), { timeout: 60_000 }).toBe(true);
	if (options.lostAfterExit) {
		await expect.poll(() => messagesOf(journal(isolated)).at(-1)?.message?.role, { timeout: 30_000 }).toBe(holdAfter);
	}
	await first.quit();
	const lines = readFileSync(journalFile(isolated), "utf8").split("\n").filter(Boolean);
	const exitAt = lines.findLastIndex(line => (JSON.parse(line) as Entry).customType === "session_exit");
	if (options.lostAfterExit) {
		writeFileSync(journalFile(isolated), `${lines.slice(0, exitAt + 1).join("\n")}\n`);
		// What the relaunch finds: a clean exit with nothing pending after the cut-off tail, and no reply after it.
		const before = journal(isolated);
		expect(before.at(-1)).toMatchObject({ customType: "session_exit", data: { kind: "normal" } });
		expect(before.at(-1)?.data?.pendingToolCalls).toBeUndefined();
		expect(messagesOf(before).at(-1)?.message?.role).toBe(holdAfter);
	}
	const before = journal(isolated);
	rmSync(hold);
	const second = await startOmp(provider, isolated, root, true);
	const outcome = await second.bridge.request<{ turn: boolean }>("composer.restore_interrupted", {});
	return { provider, isolated, outcome, before };
}

describe.skipIf(!existsSync(omp))("a quit while omp prepares the next model request, on stock omp", () => {
	it("continues the turn whose bash result the model had not answered yet, without running bash again", async () => {
		const { provider, isolated, outcome } = await quitBeforeRequest(
			[{ tool: "bash", args: { command: "echo probe", i: "probing" } }],
			"toolResult",
			{ lostAfterExit: true },
		);
		expect(outcome).toMatchObject({ turn: true });
		await expect.poll(() => provider.continued, { timeout: 60_000 }).toBe(1);
		await expect
			.poll(() => messagesOf(journal(isolated)).at(-1)?.message?.content, { timeout: 30_000 })
			.toEqual([expect.objectContaining({ text: "CONTINUED" })]);
		expect(messagesOf(journal(isolated)).filter(entry => entry.message?.role === "toolResult")).toHaveLength(1);
	}, 240_000);

	it("answers a prompt whose first request was being prepared, with the prompt in the journal once", async () => {
		const { provider, isolated, outcome, before } = await quitBeforeRequest([], "user");
		// Stock journals an unanswered prompt only as its process ends, after the exit record: its own restore sees it.
		// From omp 18.18.2 it also writes the aborted reply there ("Request was aborted"), the record this relaunch would
		// otherwise make itself (`requestCutAtExit` then declines: a message follows the exit); older omps write the prompt alone.
		const exitAt = before.findLastIndex(entry => entry.customType === "session_exit");
		const afterExit = messagesOf(before.slice(exitAt)).map(entry => [entry.message?.role, entry.message?.stopReason]);
		expect([
			[["user", undefined]],
			[
				["user", undefined],
				["assistant", "aborted"],
			],
		]).toContainEqual(afterExit);
		expect(outcome).toMatchObject({ turn: true });
		await expect.poll(() => provider.continued, { timeout: 60_000 }).toBe(1);
		await expect
			.poll(() => messagesOf(journal(isolated)).at(-1)?.message?.content, { timeout: 30_000 })
			.toEqual([expect.objectContaining({ text: "CONTINUED" })]);
		const prompts = messagesOf(journal(isolated)).filter(entry => textOf(entry.message?.content).includes(SECOND));
		expect(prompts).toHaveLength(1);
	}, 240_000);
});

/**
 * The v0.48.0 → v0.49.0 update restart (21 Oct 2026): the quit aborted two turns mid-tool (a `wait`, a long bash), stock
 * journaled the aborted tool result and the aborted reply, and then a custom message landed after them: in the parent
 * a report the bridge handed the session once the abort left it idle (`ompdesk.mail`), in a child a follow-up stock had
 * queued since an earlier relaunch. Stock's `retry` reads the conversation's end past its eval snapshots only, so the
 * custom message hid the aborted reply: the relaunch logged `restored: nothing, retried: false` and both sat idle.
 */
describe.skipIf(!existsSync(omp))(
	"a quit that aborted a tool, with a note journaled after the abort, on stock omp",
	() => {
		it("goes on with the turn after the relaunch", async () => {
			const { isolated, root } = testFolders("noted");
			const provider = await startProvider([{ tool: "bash", args: { command: "sleep 120", i: "long check" } }]);
			const { hold } = writeHoldExtension(isolated, "user");
			rmSync(hold);
			const first = await startOmp(provider, isolated, root, false);
			await first.send({ type: "prompt", message: FIRST });
			await expect
				.poll(() => first.frames.some(frame => frame.type === "agent_end"), { timeout: 60_000 })
				.toBe(true);
			await first.send({ type: "prompt", message: SECOND });
			await expect
				.poll(() => first.frames.some(frame => frame.type === "tool_execution_start"), { timeout: 60_000 })
				.toBe(true);
			await first.quit();
			const lines = readFileSync(journalFile(isolated), "utf8").split("\n").filter(Boolean);
			const last = JSON.parse(lines.at(-1) ?? "{}") as { id?: string };
			// Stock journals the aborted reply after the aborted tool result, unless its graceful exit ends the process first
			// (1 run in about 8 here): then the tool result is last and stock's own restore takes the turn up.
			const end = messagesOf(journal(isolated)).at(-1)?.message;
			const replyJournaled = end?.role === "assistant";
			if (replyJournaled) expect(end?.stopReason).toBe("aborted");
			else expect(end?.role).toBe("toolResult");
			// What v0.49.0's bridge journaled after the abort: a session report, displayed, in the model's context.
			const note = {
				type: "custom_message",
				id: "n0te0001",
				parentId: last.id,
				timestamp: new Date().toISOString(),
				customType: "ompdesk.mail",
				content: '<ompdesk-mail from="child" kind="progress">still working</ompdesk-mail>',
				display: true,
				details: { id: "m1", from: "child", kind: "progress", text: "still working" },
			};
			writeFileSync(journalFile(isolated), `${[...lines, JSON.stringify(note)].join("\n")}\n`);
			const second = await startOmp(provider, isolated, root, true);
			const outcome = await second.bridge.request<{ turn: boolean; followUp: boolean }>(
				"composer.restore_interrupted",
				{},
			);
			expect(outcome).toMatchObject(replyJournaled ? { turn: false, followUp: true } : { turn: true });
			await expect.poll(() => provider.continued, { timeout: 60_000 }).toBe(1);
			await expect
				.poll(() => messagesOf(journal(isolated)).at(-1)?.message?.content, { timeout: 30_000 })
				.toEqual([expect.objectContaining({ text: "CONTINUED" })]);
		}, 240_000);
	},
);

/**
 * A relaunch never cuts a short command nor runs one a second time (quit-journal.ts). Stock aborts a running command
 * when its stdin closes, and its restore then replays a batch whose every result is an error with the same call id and
 * arguments: a cut `git commit` was made twice after an update restart (19 Nov 2026). Each command appends a line to
 * a counter file, so the counter says how often it ran.
 */
describe.skipIf(!existsSync(omp))("a command a stop or a crash cuts, on stock omp", () => {
	async function cutCommand(script: (counter: string) => string, end: "quit" | "kill") {
		const { isolated, root } = testFolders("once");
		const counter = join(root, "counter").replaceAll("\\", "/");
		const provider = await startProvider([{ tool: "bash", args: { command: script(counter), i: "counted" } }]);
		const { hold } = writeHoldExtension(isolated, "user");
		rmSync(hold);
		const first = await startOmp(provider, isolated, root, false);
		await first.send({ type: "prompt", message: FIRST });
		await expect.poll(() => first.frames.some(frame => frame.type === "agent_end"), { timeout: 60_000 }).toBe(true);
		await first.send({ type: "prompt", message: SECOND });
		await expect.poll(() => existsSync(counter), { timeout: 60_000 }).toBe(true);
		await (end === "quit" ? first.quit() : first.kill());
		const runs = () => readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
		const results = () => messagesOf(journal(isolated)).filter(entry => entry.message?.role === "toolResult");
		const cut = results();
		const second = await startOmp(provider, isolated, root, true);
		const outcome = await second.bridge.request<{ turn: boolean }>("composer.restore_interrupted", {});
		expect(outcome).toMatchObject({ turn: true });
		await expect.poll(() => provider.continued, { timeout: 60_000 }).toBe(1);
		return { cut, results, runs };
	}

	it("lets the stop finish a running command, and the relaunch goes on from its whole output", async () => {
		const { cut, results, runs } = await cutCommand(
			counter => `echo ran >> "${counter}"; sleep 3; echo WHOLE-OUTPUT`,
			"quit",
		);
		expect(cut).toHaveLength(1);
		expect(textOf(cut[0]?.message?.content)).toContain("WHOLE-OUTPUT");
		expect(results()).toHaveLength(1);
		expect(runs()).toBe(1);
	}, 240_000);

	it("never runs a command again that failed while the stop waited for it", async () => {
		const { results, runs } = await cutCommand(counter => `echo ran >> "${counter}"; sleep 2; exit 3`, "quit");
		expect(textOf(results().at(-1)?.message?.content)).toContain("Not run again");
		expect(runs()).toBe(1);
	}, 240_000);

	it("never runs a command again that a crash cut", async () => {
		// The killed omp leaves its command running on Windows: a short one, so it lets the test's folders go.
		const { results, runs } = await cutCommand(counter => `echo ran >> "${counter}"; sleep 8`, "kill");
		expect(textOf(results().at(-1)?.message?.content)).toContain("Not run again");
		expect(runs()).toBe(1);
	}, 240_000);
});

/**
 * A background job runs on through a relaunch (kept-jobs.ts, `ompdesk keep`): stock ran it in omp's own shell, so the
 * relaunch ended it and the agent was told to start it again. The command logs its start and its end to a counter
 * file; the relaunch comes while it sleeps.
 */
describe.skipIf(!existsSync(omp) || !existsSync(nativeBinPath("ompdesk")))("a background job on stock omp", () => {
	it("keeps running through a relaunch, once, and its result reaches the agent after it", async () => {
		const { isolated, root } = testFolders("kept");
		const counter = join(root, "counter").replaceAll("\\", "/");
		// The output is computed, so it reaches a request only from the job's result, never from the call's command.
		const command = `echo started >> "${counter}"; sleep 8; echo KEPT-$((40 + 2)); echo finished >> "${counter}"`;
		const provider = await startProvider([{ tool: "bash", args: { command, async: true, i: "kept" } }]);
		const { hold } = writeHoldExtension(isolated, "user");
		rmSync(hold);
		const keep = { [KEEP_CLI_ENV]: nativeBinPath("ompdesk") };
		const first = await startOmp(provider, isolated, root, false, keep);
		await first.send({ type: "prompt", message: FIRST });
		await expect
			.poll(() => first.frames.filter(frame => frame.type === "agent_end").length, { timeout: 60_000 })
			.toBe(1);
		await first.send({ type: "prompt", message: SECOND });
		await expect.poll(() => existsSync(counter), { timeout: 60_000 }).toBe(true);
		await expect.poll(() => provider.continued, { timeout: 60_000 }).toBe(1);
		await first.quit();
		const lines = () => readFileSync(counter, "utf8").split("\n").filter(Boolean);
		expect(lines()).toEqual(["started"]);
		const second = await startOmp(provider, isolated, root, true, keep);
		const outcome = await second.bridge.request<{ jobs: string[]; followUp: boolean }>(
			"composer.restore_interrupted",
			{},
		);
		expect(outcome).toMatchObject({ jobs: [], followUp: false });
		await expect.poll(() => provider.requests.some(body => body.includes("KEPT-42")), { timeout: 60_000 }).toBe(true);
		expect(lines()).toEqual(["started", "finished"]);
		expect(journal(isolated).some(entry => entry.customType === "ompdesk-restart-jobs")).toBe(false);
	}, 240_000);
});
