import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { appLaunchOptions } from "./harness";

export const keys = ["offline-probe-key-a", "offline-probe-key-b"];
export const shared = "probe-shared";
export const offered = [
	[shared, "probe-only-a"],
	[shared, "probe-only-b"],
];

export async function profile(real: boolean) {
	// Run stock only on the hosted Windows runner, never on a developer's machine or with their credentials.
	expect(process.env.RUNNER_ENVIRONMENT).toBe("github-hosted");
	const root = await mkdtemp(join(tmpdir(), "omp-key-accounts-"));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => join(root, name));
	await Promise.all([project, desktop, agent].map(dir => mkdir(dir)));
	await writeFile(
		join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			accountRotation: "even",
			lastProject: project,
			autoTitle: false,
			nextPromptSuggestions: false,
			nextPromptInline: false,
			judgeAssist: false,
		}),
	);
	const options = await appLaunchOptions({
		project,
		desktop,
		agent,
		profile: root,
		env: real
			? { OMP_GUI_OMP: undefined }
			: { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1", OMP_GUI_TEST_SIGNED_OUT: "1" },
	});
	for (const name of Object.keys(options.env)) {
		if (/KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^CLAUDE_/i.test(name)) delete options.env[name];
	}
	return { options, agent, project };
}

export async function ready(page: Page) {
	await expect
		.poll(() => page.evaluate(() => window.omp?.sidecar.getStatus()), { timeout: 90_000 })
		.toMatchObject({ status: "ready" });
}

export async function provider(refuse?: (res: ServerResponse) => void) {
	const lists: number[] = [];
	const posts: number[] = [];
	const guards = new Set<string>();
	const turns: { prompt: string; account: number }[] = [];
	const hints: { skill: string; account: number; model: string; process: string }[] = [];
	const server = createServer(async (req, res) => {
		if (req.method === "GET" && /^\/guard\/\d+$/.test(req.url ?? "")) {
			guards.add(String(req.url));
			res.writeHead(204).end();
			return;
		}
		const account = keys.indexOf(String(req.headers["x-api-key"] ?? ""));
		if (req.method === "POST") posts.push(account);
		if (account < 0) {
			res.writeHead(401).end();
			return;
		}
		if (req.method === "GET" && req.url?.split("?")[0] === "/v1/models") {
			lists.push(account);
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					data: offered[account].map(id => ({ id, type: "model", display_name: id })),
					has_more: false,
				}),
			);
			return;
		}
		if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/messages") {
			res.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of req) body += chunk;
		const {
			messages,
			model,
		}: { messages: { role: string; content: string | { text?: string }[] }[]; model: string } = JSON.parse(body);
		const lastUser = messages.findLast(message => message.role === "user");
		const prompt = /test-key-turn-[12]/.exec(JSON.stringify(lastUser?.content ?? ""))?.[0];
		if (prompt) turns.push({ prompt, account });
		if (refuse && prompt === "test-key-turn-1") return refuse(res);
		const content = messages.length === 1 && messages[0]?.role === "user" ? messages[0].content : "";
		const text = typeof content === "string" ? content : (content[0]?.text ?? "");
		if (!prompt && text.startsWith("Compress into one routing hint of at most 12 words:")) {
			const skill = /^Skill: ([^\r\n]+)\r?$/m.exec(text)?.[1];
			if (skill) hints.push({ skill, account, model, process: String(req.headers["x-fixture-pid"]) });
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const event = (type: string, data: object) =>
			res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
		event("message_start", {
			message: {
				id: "msg_probe",
				type: "message",
				role: "assistant",
				model: shared,
				content: [],
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		});
		event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		event("content_block_delta", {
			index: 0,
			delta: { type: "text_delta", text: `Local answer ${prompt?.at(-1) ?? ""}` },
		});
		event("content_block_stop", { index: 0 });
		event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
		event("message_stop", {});
		res.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing loopback port");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		guards,
		lists,
		posts,
		turns,
		hints,
		close: () => server.close(),
	};
}

export async function guardProvider(project: string, env: NodeJS.ProcessEnv, origin: string) {
	// Redirect only after stock chooses headers for the official host. Never contact the provider.
	const preload = join(project, "guard.cjs");
	await writeFile(join(project, "bunfig.toml"), 'preload = ["./guard.cjs"]\n');
	await writeFile(
		preload,
		`
if (!globalThis.__keyFixtureGuard) {
globalThis.__keyFixtureGuard = true;
const origin = ${JSON.stringify(origin)}, allowed = ${JSON.stringify(keys)};
for (const [module, method] of [["node:https", "get"], ["node:https", "request"], ["node:tls", "connect"]]) {
	require(module)[method] = () => { throw new Error("external TLS blocked by the Claude account fixture"); };
}
const send = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
	const request = new Request(input, init), url = new URL(request.url);
	if (url.origin === origin) return send(input, { ...init, redirect: "error" });
	if (url.origin !== "https://api.anthropic.com" ||
		!((request.method === "GET" && url.pathname === "/v1/models") ||
		  (request.method === "POST" && url.pathname === "/v1/messages"))) {
		throw new Error("external request blocked by the Claude account fixture");
	}
	if (!allowed.includes(request.headers.get("x-api-key"))) {
		throw new Error("expected a dummy fixture key in x-api-key");
	}
	if (request.method === "POST") request.headers.set("x-fixture-pid", String(process.pid));
	return send(origin + url.pathname + url.search, {
		method: request.method, headers: request.headers,
		body: request.method === "POST" ? await request.arrayBuffer() : undefined,
		signal: request.signal, redirect: "error",
	});
}, { preconnect() {} });
if (process.argv.includes("rpc-ui")) void send(origin + "/guard/" + process.pid);
}
`,
	);
	env.NODE_OPTIONS = `--require "${preload.replaceAll("\\", "/")}"`;
	env.PI_REQUEST_COMPRESSION = "0";
}

export async function seedKeyModels(agent: string) {
	await writeFile(
		join(agent, "models.yml"),
		JSON.stringify({
			providers: Object.fromEntries(
				keys.map((key, i) => [
					i === 0 ? "anthropic-api-key" : "anthropic-api-key-2",
					{
						baseUrl: "https://api.anthropic.com",
						auth: "apiKey",
						api: "anthropic-messages",
						apiKey: key,
						models: offered[i].map(id => ({ id, name: id, reasoning: false })),
					},
				]),
			),
		}),
	);
	await writeFile(join(agent, "config.yml"), JSON.stringify({ modelRoles: { default: shared } }));
}
