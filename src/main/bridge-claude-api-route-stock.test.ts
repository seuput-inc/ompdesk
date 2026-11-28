import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { ompPackageRoot } from "./omp-runtime";
import { INSTALLED_OMP, stockFixtureEnv, stopOmpDaemon } from "./test-bridge-probe";
import { removeWhenFree } from "./test-folders";

const providers = ["anthropic-api-key", "anthropic-api-key-2", "anthropic-api-key-3", "anthropic-api-key-4"];
const keys = ["dummy-key-one", "dummy-key-two", "dummy-key-three", "dummy-disabled-key"];
const modelId = "claude-fixture";
const receipt = {
	provider: providers[1],
	skipped: [
		{ provider: providers[0], reason: "not-selected" },
		{ provider: providers[2], reason: "not-offered" },
		{ provider: providers[3], reason: "disabled" },
	],
};
const timed = {
	status: 429,
	retryAfter: "1",
	refusal: { kind: "transient", retryAfterSeconds: 1 },
	error: {
		type: "rate_limit_error",
		message: "private-fixture-detail",
		details: { error_code: "ramp_limit_exceeded" },
	},
} as const;
const failures = {
	balance: {
		status: 400,
		refusal: "lowCredit",
		error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API" },
	},
	limit: {
		status: 429,
		refusal: "rateLimit",
		error: { type: "rate_limit_error", message: "unclassified rate limit" },
	},
	spend: {
		status: 429,
		refusal: { kind: "monthly", resumesAt: Date.UTC(2026, 8, 1) },
		error: {
			type: "rate_limit_error",
			message: "You will regain access on 2026-09-01 at 00:00 UTC.",
			details: { error_code: "enforced_spend_limit_reached" },
		},
	},
	console: {
		status: 400,
		refusal: { kind: "console" },
		error: { type: "invalid_request_error", message: "You have reached your specified workspace API usage limits." },
	},
	exhausted: timed,
	cancelled: timed,
	overCap: { ...timed, retryAfter: "3", refusal: { kind: "transient", retryAfterSeconds: 3 } },
	payment: { status: 402, refusal: "billing", error: { type: "billing_error", message: "fixture payment required" } },
} as const;
const cases = [
	"ok",
	"partial",
	"empty",
	"disconnect",
	"server-error",
	"recovered",
	...Object.keys(failures),
	"after-refusal",
];

// No provider is reachable. Only fixture keys can reach this process's loopback listener.
const guard = `
for (const [mod, method] of [['node:https','request'], ['node:https','get'], ['node:tls','connect']])
 require(mod)[method] = () => { throw Error('External transport disabled: ' + mod + '.' + method); };
const scheduler = require('node:timers/promises').scheduler;
const wait = scheduler.wait.bind(scheduler);
globalThis.retryWaits = [];
scheduler.wait = (ms, options) => {
 const scenario = globalThis.routeCase;
 if (['recovered','exhausted','cancelled'].includes(scenario) && options?.signal && ms >= 1000) {
  globalThis.retryWaits.push({scenario, ms});
  if (scenario === 'cancelled') globalThis.cancelRouteWait();
  if (scenario === 'exhausted') ms = 0;
 }
 return wait(ms, options);
};
const local = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
 const url = new URL(input instanceof Request ? input.url : input);
 const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
 if (url.origin !== 'https://api.anthropic.com' || !${JSON.stringify(keys)}.includes(headers.get('x-api-key')) || !['/v1/models','/v1/messages'].includes(url.pathname)) throw Error('External network disabled');
 headers.set('x-fixture-case', globalThis.routeCase ?? 'setup');
 return local(process.env.FIXTURE_ORIGIN + url.pathname + url.search, {...init, headers, redirect:'error'});
}, {preconnect: () => {}});
`;

function stream(empty: boolean) {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_fixture",
				type: "message",
				role: "assistant",
				model: modelId,
				content: [],
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		...(!empty
			? [
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture answer" } },
					{ type: "content_block_stop", index: 0 },
				]
			: []),
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: empty ? 0 : 2 } },
		{ type: "message_stop" },
	];
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

it.skipIf(!existsSync(INSTALLED_OMP))(
	"stock retries only a documented main 429 on the selected key and journals the final result without fallback",
	async () => {
		const root = ompPackageRoot(INSTALLED_OMP);
		if (!root) throw new Error("Cannot locate installed omp");
		const home = mkdtempSync(join(tmpdir(), "omp-route-"));
		const env = stockFixtureEnv(home);
		const agent = join(home, "agent");
		mkdirSync(agent);
		const config = JSON.stringify({
			modelRoles: { default: `${providers[0]}/${modelId}` },
			disabledProviders: [providers[3]],
			retry: {
				enabled: true,
				maxRetries: 1,
				baseDelayMs: 50,
				maxDelayMs: 1000,
				fallbackOn: "any",
				fallbackChains: { default: [`${providers[0]}/${modelId}`] },
			},
		});
		writeFileSync(join(agent, "config.yml"), config);
		writeFileSync(
			join(agent, "models.yml"),
			JSON.stringify({
				providers: Object.fromEntries(
					providers.map((p, i) => [
						p,
						{
							api: "anthropic-messages",
							baseUrl: "https://api.anthropic.com",
							auth: "apiKey",
							apiKey: keys[i],
							models: [{ id: modelId, name: modelId, reasoning: false }],
						},
					]),
				),
			}),
		);
		const preload = join(home, "guard.js");
		writeFileSync(preload, guard);
		const bridge = join(home, "bridge");
		cpSync(resolve("resources/gui-bridge"), bridge, { recursive: true });
		const extension = join(bridge, "probe.ts");
		writeFileSync(
			extension,
			`
import { install, methods } from "./claude-api-route";
export default function(pi) {
 console.error('fixture: loaded');
 install(pi);
 pi.on('session_start', () => { void (async () => {
  console.error('fixture: session started');
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = {pi, session:()=>session, emit:()=>{}, context:()=>undefined};
   const restored = !!process.env.FIXTURE_RESTORE;
   let result;
   if (!restored) {
    const offers = await methods['claude_api.offers'](${JSON.stringify({ providers, modelId })}, env);
    console.error('fixture: eligible', offers.eligible);
    result = await methods['claude_api.select']({ticket:offers.ticket,provider:${JSON.stringify(providers[1])}},env);
   }
   const live = [], turns = [];
   globalThis.cancelRouteWait = () => session.agent.abort();
   session.subscribe(e => { if (e.type==='message_end' && e.message.role==='assistant') live.push(e.message.claudeApiRoute); });
   for (const name of restored ? ['refused', 'restored'] : ${JSON.stringify(cases)}) {
    console.error('fixture: prompt', name);
    globalThis.routeCase=name;
    await session.prompt('fixture '+name);
    const last=session.sessionManager.getBranch().findLast(e=>e.type==='message' && e.message.role==='assistant')?.message;
    turns.push({reason:last?.stopReason,receipt:last?.claudeApiRoute,error:last?.errorMessage});
   }
   if (restored) {
    await session.setModel(session.model);
    globalThis.routeCase='explicit';
    await session.prompt('fixture explicit');
   }
   await session.sessionManager.flush();
   console.error('ROUTE='+JSON.stringify({result,live,turns,waits:globalThis.retryWaits,sessionFile:session.sessionManager.getSessionFile(),retryEnabled:session.autoRetryEnabled}));
   process.exit(0);
  } catch(e) { console.error(e); process.exit(1); }
 })(); });
}`,
		);
		const messages: { key: number; scenario: string }[] = [];
		const server = createServer((req, res) => {
			const key = keys.indexOf(String(req.headers["x-api-key"]));
			if (req.method === "GET") {
				res.setHeader("content-type", "application/json");
				if (req.headers["x-fixture-case"] === "refused")
					return res.end(JSON.stringify({ data: [], has_more: false }));
				return res.end(JSON.stringify({ data: [{ id: key === 2 ? "other" : modelId }], has_more: false }));
			}
			const scenario = String(req.headers["x-fixture-case"]);
			messages.push({ key, scenario });
			if (scenario === "disconnect") return req.socket.destroy();
			if (scenario === "server-error") return res.writeHead(503).end();
			const willRecover = scenario === "recovered" || scenario === "explicit";
			const failure = Object.hasOwn(failures, scenario)
				? failures[scenario as keyof typeof failures]
				: willRecover && messages.filter(m => m.scenario === scenario).length === 1
					? timed
					: undefined;
			if (failure) {
				const { status, error } = failure;
				return res
					.writeHead(status, {
						...("retryAfter" in failure ? { "retry-after": failure.retryAfter } : {}),
						"content-type": "application/json",
					})
					.end(JSON.stringify({ type: "error", error }));
			}
			if (scenario === "partial") {
				const partial = stream(false).split("event: message_delta")[0];
				const error = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } });
				return res
					.writeHead(200, { "content-type": "text/event-stream" })
					.end(`${partial}event: error\ndata: ${error}\n\n`);
			}
			return res.writeHead(200, { "content-type": "text/event-stream" }).end(stream(scenario === "empty"));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const run = async (sessionFile?: string) => {
				const child = spawn(
					"bun",
					[
						"--preload",
						preload,
						join(root, "dist", "cli.js"),
						"--mode",
						"rpc",
						"--no-extensions",
						"--no-skills",
						"--no-rules",
						"--no-title",
						"--tools=",
						"-e",
						extension,
						...(sessionFile ? ["--session", sessionFile] : []),
					],
					{
						cwd: home,
						env: {
							...env,
							FIXTURE_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
							FIXTURE_RESTORE: sessionFile,
						},
						stdio: ["pipe", "ignore", "pipe"],
						timeout: 60_000,
					},
				);
				let stderr = "";
				child.stderr.setEncoding("utf8").on("data", data => {
					stderr += data;
				});
				const [code] = await once(child, "close");
				expect(code, `${stderr.slice(-3000)}\nLoopback POST ordinals: ${JSON.stringify(messages)}`).toBe(0);
				const line = stderr.split("\n").find(line => line.startsWith("ROUTE="));
				if (!line) throw new Error("Stock exited without reporting its turn");
				return JSON.parse(line.slice(6));
			};
			const row = await run();
			expect(row.result).toMatchObject({ provider: providers[1], id: modelId, claudeApiRoute: receipt });
			expect(row.live).toEqual(
				cases.map(scenario => {
					// Stop during the wait is stock's neutral cancellation, not a terminal provider refusal.
					if (scenario === "cancelled") return null;
					return Object.hasOwn(failures, scenario)
						? { ...receipt, refusal: failures[scenario as keyof typeof failures].refusal }
						: receipt;
				}),
			);
			expect(row.turns.map((t: { receipt?: unknown }) => t.receipt ?? null)).toEqual(row.live);
			expect(row.turns[0].reason).toBe("stop");
			expect(row.turns[1].reason).toBe("error");
			expect(row.turns[cases.indexOf("recovered")]).toEqual({ reason: "stop", receipt });
			expect(row.turns[cases.indexOf("cancelled")].reason).toBe("aborted");
			expect(JSON.stringify(row.turns)).not.toContain("private-fixture-detail");
			expect(row.waits.map((w: { scenario: string }) => w.scenario)).toEqual([
				"recovered",
				...Array(10).fill("exhausted"),
				"cancelled",
			]);
			expect(row.waits.every((w: { ms: number }) => w.ms >= 1000)).toBe(true);
			expect(row.retryEnabled).toBe(false);
			expect(row.sessionFile).toBeTruthy();
			const restored = await run(row.sessionFile);
			expect(restored.live).toEqual([null, receipt, null]);
			expect(restored.retryEnabled).toBe(true);
			expect(messages).toEqual(
				[...cases, "restored", "explicit"].flatMap(scenario => {
					const count = scenario === "exhausted" ? 11 : ["recovered", "explicit"].includes(scenario) ? 2 : 1;
					return Array(count).fill({ key: 1, scenario });
				}),
			);
			expect(readFileSync(join(agent, "config.yml"), "utf8")).toBe(config);
		} finally {
			server.closeAllConnections();
			server.close();
			stopOmpDaemon(home, env);
			await removeWhenFree(home);
		}
	},
	90_000,
);
