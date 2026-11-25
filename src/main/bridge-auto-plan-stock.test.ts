import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { OMP_COMMAND, INSTALLED_OMP as omp, stockFixtureEnv, stopOmpDaemon } from "./test-bridge-probe";
import { removeWhenFree } from "./test-folders";

/**
 * A plan the automatic mode choice entered for one request (bridge `modes.set_plan_mode {auto: true}`) is approved
 * by the bridge itself the moment the agent proposes it: no `plan_proposal` frame (so no card in any window), plan
 * mode ends, and the execution turn starts in the same session with the plan inlined in stock's approved-plan prompt.
 * A plan mode the user turned on still waits for the person's answer. Installed omp, scripted loopback provider, no
 * spend.
 */

type Frame = { type: string; [key: string]: unknown };

const PLAN = "# Demo\n\n1. Add the greeting file.\n2. Run the checks.\n";

function sse(delta: unknown, finish: string): string {
	const frame = (value: unknown, reason: string | null = null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
	return `${frame({ role: "assistant", content: "" })}${frame(delta)}${frame({}, finish)}data: [DONE]\n\n`;
}

function toolCall(name: string, args: Record<string, string>): string {
	const call = {
		tool_calls: [
			{
				index: 0,
				id: `call_${Math.random().toString(36).slice(2, 8)}`,
				type: "function",
				function: { name, arguments: JSON.stringify(args) },
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
			if (bodies.length === 1) res.end(toolCall("write", { path: "local://demo-plan.md", content: PLAN }));
			else if (bodies.length !== 2) res.end(sse({ content: "DONE" }, "stop"));
			else if (parsed.tools?.some(tool => tool.function?.name === "propose")) {
				res.end(toolCall("propose", { title: "demo" }));
			} else if (body.includes("xd://propose")) {
				res.end(toolCall("write", { path: "xd://propose", content: "demo" }));
			} else {
				res.end(toolCall("bash", { command: "propose demo; false" }));
			}
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

async function startOmp(url: string, tools?: string): Promise<Omp> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-auto-plan-"));
	chmodSync(isolated, 0o700);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-auto-plan-repo-")));
	const env = stockFixtureEnv(isolated);
	cleanups.push(async () => {
		stopOmpDaemon(isolated, env);
		await removeWhenFree(isolated);
		await removeWhenFree(root);
	});
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  fake:\n    baseUrl: ${url}\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        reasoning: false\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
	);
	const address = newBridgeAddress();
	env.OMP_GUI_BRIDGE = address;
	const child: ChildProcessWithoutNullStreams = spawn(
		OMP_COMMAND.file,
		[
			...OMP_COMMAND.args,
			...["--mode", "rpc-ui", "--no-extensions", "--no-skills", "--no-rules"],
			...["--model", "fake/m1", "-e", resolve("resources/gui-bridge/index.ts")],
			...(tools ? ["--tools", tools] : []),
		],
		{ cwd: root, env },
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

async function sessionId(send: Omp["send"]): Promise<unknown> {
	const { data } = await send({ type: "get_state" });
	return data && typeof data === "object" && "sessionId" in data ? data.sessionId : undefined;
}

/** The approved-plan prompt the model was sent, if any: a message whose text starts with stock's "Plan approved.". */
function approvedPrompt(bodies: readonly string[]): string | undefined {
	for (const body of bodies) {
		const parsed: { messages?: Array<{ content?: unknown }> } = JSON.parse(body);
		for (const message of parsed.messages ?? []) {
			const text =
				typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? message.content.map(part => (typeof part?.text === "string" ? part.text : "")).join("")
						: "";
			if (text.includes("Plan approved.")) return text;
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

describe.skipIf(!existsSync(omp))("a plan the automatic mode choice entered, on stock omp", () => {
	it("is approved by itself when proposed: no card, plan mode ends, the plan runs in the same session", async () => {
		const provider = await startProvider();
		const { frames, events, bridge, send } = await startOmp(provider.url);
		const before = await sessionId(send);
		await bridge.request("modes.set_plan_mode", { enabled: true, auto: true });
		await send({ type: "prompt", message: "add a greeting file and run the checks" });
		// The execution turn reads stock's approved-plan prompt with the plan itself inlined. (Stock's loop may send
		// one more request after the propose call before the bridge's abort lands; the approved turn comes after it.)
		try {
			await expect.poll(() => approvedPrompt(provider.bodies), { timeout: 60_000 }).toContain("Plan approved.");
		} catch (error) {
			explained(provider.bodies, frames, events)(error);
		}
		expect(approvedPrompt(provider.bodies)).toContain("Add the greeting file.");
		await expect
			.poll(() => frames.some(frame => frame.type === "agent_end" && frame.isTerminal !== false), {
				timeout: 30_000,
			})
			.toBe(true);
		expect(events.some(event => event.type === "plan_proposal")).toBe(false);
		expect(await bridge.request("modes.get_plan_mode", {})).toMatchObject({ enabled: false });
		expect(await sessionId(send)).toBe(before);
	}, 120_000);

	it("still waits for the person's answer when the user turned plan mode on", async () => {
		const provider = await startProvider();
		const { frames, events, bridge, send } = await startOmp(provider.url, "read,write,edit");
		await bridge.request("modes.set_plan_mode", { enabled: true });
		await send({ type: "prompt", message: "add a greeting file and run the checks" });
		try {
			await expect.poll(() => events.some(event => event.type === "plan_proposal"), { timeout: 60_000 }).toBe(true);
		} catch (error) {
			explained(provider.bodies, frames, events)(error);
		}
		// The proposal waits for an answer, with plan mode still on, and no approved turn runs.
		expect(await bridge.request("modes.get_plan_mode", {})).toMatchObject({
			enabled: true,
			proposal: { title: expect.any(String) },
		});
		expect(approvedPrompt(provider.bodies)).toBeUndefined();
		expect(await bridge.request("modes.plan_approval", { approved: false })).toMatchObject({
			approved: false,
			dispatched: false,
		});
		expect(await bridge.request("modes.get_plan_mode", {})).not.toHaveProperty("proposal");
	}, 120_000);
});
