/**
 * A scripted OpenAI-compatible model on loopback for the manual mode of the Windows update gate (win-update-gate.ps1):
 * the installed app's stock omp runs its turn against it, so the gate needs no credentials and spends nothing. It answers
 * as the provider of src/main/bridge-restore-request-stock.test.ts does.
 *
 *   bun scripted-provider.ts --marker <text> --release <file> [--port 18434]
 *
 * The turn under test is a main-agent request (it offers the bash tool; a title or a suggestion offers none) whose
 * messages hold `--marker`. While `--release` does not exist such a request is held open and never answered, so the turn
 * stays running in the app that sent it. Once the file exists it is answered `CONTINUED`. Each request is judged as it
 * arrives: one held before the file appeared stays unanswered.
 *
 * One JSON line per request on stdout (`phase`: held, continued, side, other; `cut` when a held request's sender went
 * away); the first line says it is listening.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		marker: { type: "string" },
		release: { type: "string" },
		port: { type: "string", default: "18434" },
	},
});
const marker = values.marker ?? "";
const release = values.release ?? "";
if (!marker || !release) throw new Error("usage: bun scripted-provider.ts --marker <text> --release <file> [--port n]");

const SSE = { "content-type": "text/event-stream", "cache-control": "no-cache" };

function completion(text: string): Response {
	const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m1" };
	const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
	const chunks = [
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
	];
	return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: SSE,
	});
}

function toolNames(tools: unknown): string[] {
	if (!Array.isArray(tools)) return [];
	return tools.map(tool => {
		const name = (tool as { function?: { name?: unknown } } | null)?.function?.name;
		return typeof name === "string" ? name : "";
	});
}

const server = Bun.serve({
	port: Number(values.port),
	hostname: "127.0.0.1",
	// A held request stays open for as long as its sender lives.
	idleTimeout: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions"))
			return new Response("not here", { status: 404 });
		const body = (await request.json()) as { messages?: unknown; tools?: unknown };
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const tools = toolNames(body.tools);
		const main = tools.some(name => name.endsWith("bash"));
		const marked = JSON.stringify(messages).includes(marker);
		const phase = !main ? "side" : !marked ? "other" : existsSync(release) ? "continued" : "held";
		console.log(
			JSON.stringify({
				at: Date.now(),
				phase,
				marker: marked,
				main,
				messages: messages.length,
				tools: tools.length,
			}),
		);
		if (phase === "held") {
			request.signal.addEventListener("abort", () => console.log(JSON.stringify({ at: Date.now(), phase: "cut" })));
			return new Response(new ReadableStream({ start() {} }), { headers: SSE });
		}
		return completion(phase === "continued" ? "CONTINUED" : phase === "side" ? "side" : "DONE");
	},
});
console.log(JSON.stringify({ listening: server.port, marker, release }));
