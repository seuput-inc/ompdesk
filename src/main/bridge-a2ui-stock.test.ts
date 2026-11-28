import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { A2UI_ANSWER_FIELD, a2uiMarkerToolCallId } from "../../resources/gui-bridge/modes/a2ui-contracts";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp, runStock, stockSource } from "./test-bridge-probe";
import { removeWhenFree } from "./test-folders";

/**
 * The `a2ui` tool on the installed stock omp (docs/design/a2ui.md §8, unit 1's first tests):
 * - stock's JSON-Schema validator over the merged A2UI schema, with the core's own rules, agrees with every one of
 *   A2UI's own v1.0 test cases (src/main/fixtures/a2ui-spec-cases.json) and terminates on its recursive refs;
 * - with the real bridge and a scripted OpenAI-compatible provider on loopback (no credentials, no model spend): the main
 *   agent is offered the tool; a surface without an event button returns at once; one with it raises one stock `form`
 *   request carrying the marker, and the answer, a dismissal and Stop each end the call as the design says; a refused
 *   call raises no request.
 */

describe.skipIf(!stockSource("pi-ai", "utils/schema/json-schema-validator.ts"))(
	"A2UI messages on stock's validator",
	() => {
		it("agree with A2UI's own v1.0 test cases, and the tool description's example is valid", () => {
			const validator = stockSource("pi-ai", "utils/schema/json-schema-validator.ts");
			const verdicts = runStock<{ disagree: string[]; total: number; example: unknown[] }>(`
			import cases from ${JSON.stringify(resolve("src/main/fixtures/a2ui-spec-cases.json"))};
			import { a2uiToolDescription, checkA2uiMessages, checkA2uiCall } from ${JSON.stringify(resolve("resources/gui-bridge/modes/a2ui-core.ts"))};
			import { validateJsonSchemaValue } from ${JSON.stringify(validator)};
			const BASIC = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
			const OURS = "https://github.com/seuput-inc/ompdesk/a2ui/v1";
			const disagree = [];
			for (const c of cases.cases) {
				// OMPdesk's catalog stands in for the basic one the cases name.
				const messages = (Array.isArray(c.data) ? c.data : [c.data]).map(m => JSON.parse(JSON.stringify(m).replaceAll(BASIC, OURS)));
				const valid = checkA2uiMessages(messages, validateJsonSchemaValue).length === 0;
				if (valid !== c.valid) disagree.push(c.file + ": " + c.description);
			}
			const example = JSON.parse(a2uiToolDescription().split("\\nExample: ")[1]);
			console.log(JSON.stringify({ disagree, total: cases.cases.length, example: checkA2uiCall(example, [], validateJsonSchemaValue).errors }));
		`);
			expect(verdicts.total).toBe(106);
			expect(verdicts.disagree).toEqual([]);
			expect(verdicts.example).toEqual([]);
		});
	},
);

type Frame = { type: string; [key: string]: unknown };
type ToolStep = { tool: string; args: Record<string, unknown> };
type Step = { text: string } | ToolStep;

interface ProviderRequest {
	tools: string[];
	toolResults: string[];
}

function sse(chunks: unknown[]): string {
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function completion(step: Step, tools: string[]): string {
	const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m1" };
	const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
	if ("text" in step) {
		return sse([
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
		]);
	}
	const name = tools.find(tool => tool === step.tool || tool.endsWith(`_${step.tool}`)) ?? step.tool;
	const call = { index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function" };
	return sse([
		{
			...base,
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [{ ...call, function: { name, arguments: JSON.stringify(step.args) } }],
					},
					finish_reason: null,
				},
			],
		},
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
	]);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(part => textOf((part as { text?: unknown }).text ?? "")).join("");
	return "";
}

/** Each user prompt names the a2ui call to make; after its result the model ends the turn with "done". */
async function startProvider(calls: Record<string, ToolStep>) {
	const requests: ProviderRequest[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body) as {
				messages: Array<{ role: string; content: unknown }>;
				tools?: Array<{ function?: { name?: string } }>;
			};
			const tools = (parsed.tools ?? []).map(tool => tool.function?.name ?? "");
			const last = parsed.messages.findLast(
				m => m.role === "tool" || (m.role === "user" && textOf(m.content).includes("a2ui-case ")),
			);
			requests.push({
				tools,
				toolResults: parsed.messages.filter(m => m.role === "tool").map(m => textOf(m.content)),
			});
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			// The prompt names its case (`a2ui-case <name>`); what else rides the user message does not matter.
			const named = last?.role === "user" ? /a2ui-case (\w+)/.exec(textOf(last.content))?.[1] : undefined;
			const step = named ? calls[named] : undefined;
			res.end(completion(step ?? { text: "done" }, tools));
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => {
			server.closeAllConnections();
			return new Promise<void>(done => server.close(() => done()));
		},
	};
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

async function startOmp(providerUrl: string) {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-a2ui-"));
	chmodSync(isolated, 0o700);
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-a2ui-cwd-")));
	writeFileSync(
		join(agentDir, "models.yml"),
		[
			"providers:",
			"  fake:",
			`    baseUrl: ${providerUrl}`,
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
		OMP_GUI_TEST_A2UI: "1",
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]) Reflect.deleteProperty(env, key);
	const child: ChildProcessWithoutNullStreams = spawn(
		OMP_COMMAND.file,
		[
			...OMP_COMMAND.args,
			"--mode",
			"rpc-ui",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--model",
			"fake/m1",
			"-e",
			resolve("resources/gui-bridge/index.ts"),
		],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = Promise.withResolvers<void>();
	child.once("exit", () => exited.resolve());
	const frames: Frame[] = [];
	const waiters: Array<() => void> = [];
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			frames.push(JSON.parse(line) as Frame);
		} catch {
			// not a frame
		}
		for (const wake of waiters.splice(0)) wake();
	});
	const bridge = new GuiBridgeClient(address);
	let counter = 0;
	const harness = {
		frames,
		write(frame: Record<string, unknown>) {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
		},
		prompt(message: string) {
			harness.write({ id: `p${++counter}`, type: "prompt", message });
		},
		/** The first frame from `from` on that matches, and its index. */
		async waitFrame(
			predicate: (frame: Frame) => boolean,
			from = 0,
			ms = 60_000,
		): Promise<{ frame: Frame; index: number }> {
			const end = Date.now() + ms;
			let seen = from;
			for (;;) {
				for (; seen < frames.length; seen++)
					if (predicate(frames[seen])) return { frame: frames[seen], index: seen };
				const left = end - Date.now();
				if (left <= 0) {
					throw new Error(
						`timeout waiting for a frame; frames: ${JSON.stringify(frames.slice(-6)).slice(0, 1500)}\nstderr: ${stderr.slice(-1500)}`,
					);
				}
				await Promise.race([
					new Promise<void>(wake => waiters.push(wake)),
					new Promise(wake => setTimeout(wake, left)),
				]);
			}
		},
		async stop() {
			bridge.close();
			child.kill("SIGKILL");
			await exited.promise;
			removeBridgeAddress(address);
			await removeWhenFree(isolated);
			await removeWhenFree(root);
		},
	};
	cleanups.push(() => harness.stop());
	await harness.waitFrame(frame => frame.type === "ready");
	const deadline = Date.now() + 60_000;
	for (;;) {
		try {
			await bridge.connect(1_000);
			break;
		} catch (error) {
			if (Date.now() > deadline) throw new Error(`bridge never came up: ${String(error)}\n${stderr.slice(-2000)}`);
			await new Promise(wake => setTimeout(wake, 300));
		}
	}
	return harness;
}

const text = (id: string, value: string) => ({ id, component: "Text", text: value });
function surface(surfaceId: string, withButton: boolean) {
	const children = withButton ? ["title", "ok"] : ["title"];
	return {
		version: "1.0",
		createSurface: {
			surfaceId,
			sendDataModel: true,
			components: [
				{ id: "root", component: "Column", children },
				text("title", "Ship it?"),
				...(withButton
					? [
							{
								id: "ok",
								component: "Button",
								child: "ok_label",
								action: { event: { name: "ship", context: { how: { "@path": "/how" } } } },
							},
							text("ok_label", "Ship"),
						]
					: []),
			],
			dataModel: { how: "fast" },
		},
	};
}

const CALLS: Record<string, ToolStep> = {
	show: { tool: "a2ui", args: { messages: [surface("info", false)] } },
	ask: { tool: "a2ui", args: { messages: [surface("ship_1", true)] } },
	dismiss: { tool: "a2ui", args: { messages: [surface("ship_2", true)] } },
	stale: {
		tool: "a2ui",
		args: { messages: [{ version: "1.0", updateDataModel: { surfaceId: "ship_1", path: "/how", value: "slow" } }] },
	},
	stop: { tool: "a2ui", args: { messages: [surface("ship_3", true)] } },
};

const isFormRequest = (frame: Frame) => frame.type === "extension_ui_request" && frame.method === "form";
const toolEnd = (frame: Frame) => frame.type === "tool_execution_end";
const turnEnd = (frame: Frame) => frame.type === "agent_end";

describe.skipIf(!existsSync(omp))("the a2ui tool on stock omp", () => {
	it("is offered to the main agent, shows at once, waits for the person, and ends on an answer, a dismissal or Stop", async () => {
		const provider = await startProvider(CALLS);
		cleanups.push(() => provider.close());
		const harness = await startOmp(provider.url);

		// Display only: no form request, the result says it was shown.
		harness.prompt("a2ui-case show");
		const shown = await harness.waitFrame(turnEnd);
		expect(provider.requests[0].tools).toContain("a2ui");
		expect(harness.frames.slice(0, shown.index).some(isFormRequest)).toBe(false);
		expect(provider.requests.at(-1)?.toolResults.at(-1)).toContain("Shown to the person: info");

		// An event button: one form request carrying the marker of this call; the answer is the tool result.
		harness.prompt("a2ui-case ask");
		const asked = await harness.waitFrame(isFormRequest, shown.index + 1);
		const callId = a2uiMarkerToolCallId(String(asked.frame.html));
		// Stock may print the call's start after the request it raised.
		const started = await harness.waitFrame(
			frame => frame.type === "tool_execution_start" && frame.toolCallId === callId,
			shown.index + 1,
		);
		expect(started.frame.toolName).toBe("a2ui");
		const action = {
			name: "ship",
			surfaceId: "ship_1",
			sourceComponentId: "ok",
			context: { how: "fast" },
			dataModel: { how: "fast" },
		};
		harness.write({
			type: "extension_ui_response",
			id: asked.frame.id,
			data: { [A2UI_ANSWER_FIELD]: JSON.stringify(action) },
		});
		const answered = await harness.waitFrame(toolEnd, asked.index + 1);
		expect(answered.frame).toMatchObject({ toolCallId: callId, isError: false, result: { details: { action } } });
		const afterAnswer = await harness.waitFrame(turnEnd, answered.index + 1);
		expect(provider.requests.at(-1)?.toolResults.at(-1)).toContain('pressed ok (action "ship") on surface ship_1');

		// Dismissed: the person closed the card.
		harness.prompt("a2ui-case dismiss");
		const dismissing = await harness.waitFrame(isFormRequest, afterAnswer.index + 1);
		harness.write({ type: "extension_ui_response", id: dismissing.frame.id, cancelled: true });
		const dismissed = await harness.waitFrame(toolEnd, dismissing.index + 1);
		expect(dismissed.frame).toMatchObject({ isError: false, result: { details: { dismissed: true } } });
		const afterDismiss = await harness.waitFrame(turnEnd, dismissed.index + 1);

		// A surface of an earlier turn cannot change: an error result with the spec's error, and nobody is asked.
		harness.prompt("a2ui-case stale");
		const refused = await harness.waitFrame(toolEnd, afterDismiss.index + 1);
		expect(refused.frame).toMatchObject({
			isError: true,
			result: { details: { errors: [{ code: "INTEGRITY_ERROR", surfaceId: "ship_1" }] } },
		});
		const afterStale = await harness.waitFrame(turnEnd, refused.index + 1);
		expect(harness.frames.slice(afterDismiss.index + 1, afterStale.index).some(isFormRequest)).toBe(false);

		// Stop while it waits: stock withdraws the request and the call ends as an error without details.
		harness.prompt("a2ui-case stop");
		const waiting = await harness.waitFrame(isFormRequest, afterStale.index + 1);
		harness.write({ id: "abort-1", type: "abort" });
		const stopped = await harness.waitFrame(toolEnd, waiting.index + 1);
		expect(stopped.frame).toMatchObject({ isError: true });
		// A thrown error: stock gives it empty details, never `errors`, so the renderer keeps the card drawn.
		expect(stopped.frame.result).not.toHaveProperty("details.errors");
		await harness.waitFrame(
			frame =>
				frame.type === "extension_ui_request" && frame.method === "cancel" && frame.targetId === waiting.frame.id,
			waiting.index + 1,
		);
	}, 180_000);
});
