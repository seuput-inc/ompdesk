import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * A plan the automatic mode choice entered for one request (bridge `modes.set_plan_mode {auto: true}`) is approved
 * by the bridge itself the moment the agent proposes it: no `plan_proposal` frame (so no card in any window), plan
 * mode ends, and the execution turn starts in the same session with the plan inlined in stock's approved-plan prompt.
 * A plan mode the user turned on still waits for the person's answer, and the card's answers (`modes.plan_approval`)
 * do what the card says: approve and execute runs the plan in a new session, a rejection with feedback sends the
 * feedback as the next turn with plan mode still on, a bare rejection sends nothing. Installed omp, scripted
 * loopback provider, no spend.
 */

type Frame = { type: string; [key: string]: unknown };

const PROMPT = "add a greeting file and run the checks";
const PLAN = "# Demo\n\n1. Add the greeting file.\n2. Run the checks.\n";

function sse(delta: unknown, finish: string): string {
	const frame = (value: unknown, reason: string | null = null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
	return `${frame({ role: "assistant", content: "" })}${frame(delta)}${frame({}, finish)}data: [DONE]\n\n`;
}

function write(path: string, content: string): string {
	const call = {
		tool_calls: [
			{
				index: 0,
				id: `call_${Math.random().toString(36).slice(2, 8)}`,
				type: "function",
				function: { name: "write", arguments: JSON.stringify({ path, content }) },
			},
		],
	};
	return sse(call, "tool_calls");
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

/** Main-agent requests in order: write the plan, propose it, then (once approved) answer. */
async function startProvider(): Promise<{ url: string; bodies: string[] }> {
	const bodies: string[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body || "{}") as { tools?: Array<{ function?: { name?: string } }> };
			const main = (parsed.tools ?? []).some(tool => tool.function?.name === "write");
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (!main) {
				res.end(sse({ content: "side" }, "stop"));
				return;
			}
			bodies.push(body);
			if (bodies.length === 1) res.end(write("local://demo-plan.md", PLAN));
			else if (bodies.length === 2) res.end(write("xd://propose", "demo"));
			else res.end(sse({ content: "DONE" }, "stop"));
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	cleanups.push(() => {
		server.closeAllConnections();
		return new Promise<void>(done => server.close(() => done()));
	});
	return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies };
}

interface Omp {
	frames: Frame[];
	events: Frame[];
	bridge: GuiBridgeClient;
	send(command: Record<string, unknown>): Promise<Frame>;
}

async function startOmp(url: string): Promise<Omp> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-auto-plan-"));
	chmodSync(isolated, 0o700);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-auto-plan-repo-")));
	cleanups.push(() => {
		rmSync(isolated, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  fake:\n    baseUrl: ${url}\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        reasoning: false\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
	);
	const address = newBridgeAddress();
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: configDirName(isolated),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_BRIDGE: address,
	};
	for (const key of ["ELECTRON_RUN_AS_NODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
		Reflect.deleteProperty(env, key);
	const child: ChildProcessWithoutNullStreams = spawn(
		OMP_COMMAND.file,
		[
			...OMP_COMMAND.args,
			...["--mode", "rpc-ui", "--no-extensions", "--no-skills", "--no-rules"],
			...["--model", "fake/m1", "-e", resolve("resources/gui-bridge/index.ts")],
		],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	const bridge = new GuiBridgeClient(address);
	const events: Frame[] = [];
	bridge.onEvent(event => events.push(event));
	cleanups.push(async () => {
		bridge.close();
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		await exited;
		clearTimeout(timer);
		removeBridgeAddress(address);
	});
	const frames: Frame[] = [];
	const responses = new Map<string, (frame: Frame) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as Frame & { id?: string };
			if (frame.type === "response" && frame.id && responses.has(frame.id)) responses.get(frame.id)?.(frame);
			else frames.push(frame);
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
	return {
		frames,
		events,
		bridge,
		send: command =>
			new Promise<Frame>(done => {
				const id = `c${++counter}`;
				responses.set(id, done);
				child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			}),
	};
}

/** The session stock reports: a new one has another id and another file. */
async function session(send: Omp["send"]): Promise<{ sessionId: unknown; sessionFile: unknown }> {
	const { data } = await send({ type: "get_state" });
	const state: { sessionId?: unknown; sessionFile?: unknown } = data && typeof data === "object" ? data : {};
	return { sessionId: state.sessionId, sessionFile: state.sessionFile };
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map(part => (typeof part?.text === "string" ? part.text : "")).join("") : "";
}

/**
 * What the model was asked turn by turn: each request that ends in a user message, by its text. Stock's own
 * `<system-reminder>` blocks (the date before a prompt, its plan-mode nudge after a turn that proposed nothing) are
 * not turns anyone sent.
 */
function userTurns(bodies: readonly string[]): string[] {
	return bodies.flatMap(body => {
		const messages: Array<{ role?: string; content?: unknown }> = JSON.parse(body).messages ?? [];
		const last = messages.at(-1);
		const said = last?.role === "user" ? text(last.content) : "";
		const sent = said.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
		return sent ? [sent] : [];
	});
}

/** The approved-plan prompt the model was sent, if any: a message whose text starts with stock's "Plan approved.". */
function approvedPrompt(bodies: readonly string[]): string | undefined {
	for (const body of bodies) {
		const parsed: { messages?: Array<{ content?: unknown }> } = JSON.parse(body);
		for (const message of parsed.messages ?? []) {
			const prompt = text(message.content);
			if (prompt.includes("Plan approved.")) return prompt;
		}
	}
	return undefined;
}

/** Rethrows a failed wait with what the model was asked and which tools ran. */
function explained(bodies: readonly string[], frames: readonly Frame[], events: readonly Frame[]) {
	return (error: unknown): never => {
		const requests = bodies.map(body => {
			const messages: Array<{ role?: string; content?: unknown }> = JSON.parse(body).messages ?? [];
			const last = messages.at(-1);
			return `${messages.length} messages, last ${last?.role}: ${JSON.stringify(last?.content).slice(0, 300)}`;
		});
		const tools = frames
			.filter(frame => frame.type === "tool_execution_end")
			.map(frame => `${frame.toolName} error=${frame.isError} ${JSON.stringify(frame.result).slice(0, 400)}`);
		throw new Error(
			[
				`requests:\n${requests.join("\n")}`,
				`tools:\n${tools.join("\n")}`,
				`bridge events: ${events.map(event => event.type).join(", ")}`,
			].join("\n"),
			{ cause: error },
		);
	};
}

/** Whether a turn ended at or after `from`, an index into the frames. */
const turnEnded = (frames: readonly Frame[], from = 0) =>
	frames.slice(from).some(frame => frame.type === "agent_end" && frame.isTerminal !== false);

/** Plan mode the user turned on, up to the card: the agent wrote a plan and proposed it, and that turn is over. */
async function proposed() {
	const provider = await startProvider();
	const omp = await startOmp(provider.url);
	await omp.bridge.request("modes.set_plan_mode", { enabled: true });
	await omp.send({ type: "prompt", message: PROMPT });
	try {
		await expect.poll(() => omp.events.some(event => event.type === "plan_proposal"), { timeout: 60_000 }).toBe(true);
		await expect.poll(() => turnEnded(omp.frames), { timeout: 30_000 }).toBe(true);
	} catch (error) {
		explained(provider.bodies, omp.frames, omp.events)(error);
	}
	const planFilePath = omp.events.find(event => event.type === "plan_proposal")?.planFilePath;
	/** The card's answer, and the `plan_proposal_resolved` frame that takes the card off every window. */
	const answer = async (params: Record<string, unknown>) => {
		const result = await omp.bridge.request("modes.plan_approval", params);
		await expect
			.poll(() => omp.events.filter(event => event.type === "plan_proposal_resolved"), { timeout: 30_000 })
			.toEqual([{ type: "plan_proposal_resolved", planFilePath }]);
		return result;
	};
	return { provider, ...omp, answer };
}

describe.skipIf(!existsSync(omp))("a plan the automatic mode choice entered, on stock omp", () => {
	it("is approved by itself when proposed: no card, plan mode ends, the plan runs in the same session", async () => {
		const provider = await startProvider();
		const { frames, events, bridge, send } = await startOmp(provider.url);
		const before = await session(send);
		await bridge.request("modes.set_plan_mode", { enabled: true, auto: true });
		await send({ type: "prompt", message: PROMPT });
		// The execution turn reads stock's approved-plan prompt with the plan itself inlined. (Stock's loop may send
		// one more request after the propose call before the bridge's abort lands; the approved turn comes after it.)
		try {
			await expect.poll(() => approvedPrompt(provider.bodies), { timeout: 60_000 }).toContain("Plan approved.");
		} catch (error) {
			explained(provider.bodies, frames, events)(error);
		}
		expect(approvedPrompt(provider.bodies)).toContain("Add the greeting file.");
		await expect.poll(() => turnEnded(frames), { timeout: 30_000 }).toBe(true);
		expect(events.some(event => event.type === "plan_proposal")).toBe(false);
		expect(await bridge.request("modes.get_plan_mode", {})).toMatchObject({ enabled: false });
		expect(await session(send)).toEqual(before);
	}, 120_000);

	it("still waits for the person's answer when the user turned plan mode on", async () => {
		const { provider, bridge } = await proposed();
		// The proposal waits for an answer, with plan mode still on, and no approved turn runs.
		expect(await bridge.request("modes.get_plan_mode", {})).toMatchObject({
			enabled: true,
			proposal: { title: expect.any(String) },
		});
		expect(approvedPrompt(provider.bodies)).toBeUndefined();
	}, 120_000);

	it("runs the plan in a new session with plan mode off when the card approves and executes", async () => {
		const { provider, frames, bridge, send, answer } = await proposed();
		const before = await session(send);
		expect(before).toEqual({ sessionId: expect.any(String), sessionFile: expect.any(String) });
		const answered = frames.length;
		expect(await answer({ approved: true, option: "execute" })).toEqual({ approved: true, dispatched: true });
		await expect.poll(() => approvedPrompt(provider.bodies), { timeout: 60_000 }).toContain("Plan approved.");
		expect(approvedPrompt(provider.bodies)).toContain("Add the greeting file.");
		await expect.poll(() => turnEnded(frames, answered), { timeout: 30_000 }).toBe(true);
		expect(await bridge.request("modes.get_plan_mode", {})).toMatchObject({ enabled: false });
		const after = await session(send);
		expect(after.sessionId).not.toBe(before.sessionId);
		expect(after.sessionFile).not.toBe(before.sessionFile);
	}, 120_000);

	it("sends the card's feedback as the next turn and keeps plan mode on when the card rejects with it", async () => {
		const { provider, frames, bridge, send, answer } = await proposed();
		const before = await session(send);
		const answered = frames.length;
		expect(await answer({ approved: false, feedback: "use a smaller step" })).toEqual({
			approved: false,
			dispatched: true,
		});
		await expect.poll(() => userTurns(provider.bodies), { timeout: 60_000 }).toEqual([PROMPT, "use a smaller step"]);
		await expect.poll(() => turnEnded(frames, answered), { timeout: 30_000 }).toBe(true);
		const mode = await bridge.request("modes.get_plan_mode", {});
		expect(mode).toMatchObject({ enabled: true });
		expect(mode).not.toHaveProperty("proposal");
		expect(approvedPrompt(provider.bodies)).toBeUndefined();
		expect(await session(send)).toEqual(before);
	}, 120_000);

	it("sends nothing and keeps plan mode on when the card rejects without feedback", async () => {
		const { provider, bridge, send, answer } = await proposed();
		expect(await answer({ approved: false })).toEqual({ approved: false, dispatched: false, reason: "rejected" });
		const mode = await bridge.request("modes.get_plan_mode", {});
		expect(mode).toMatchObject({ enabled: true });
		expect(mode).not.toHaveProperty("proposal");
		// The person's next message is the next thing the model is asked: the rejection put no turn before it.
		await send({ type: "prompt", message: "what now" });
		await expect.poll(() => userTurns(provider.bodies), { timeout: 60_000 }).toEqual([PROMPT, "what now"]);
		expect(approvedPrompt(provider.bodies)).toBeUndefined();
	}, 120_000);
});
