import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve as absolute, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_USAGE_ENV } from "../../resources/gui-bridge/credit-spend-core";
import { creditSpendRun } from "./omp-launch";
import { ompPackageRoot } from "./omp-runtime";
import { configDirName, INSTALLED_OMP } from "./test-bridge-probe";

/**
 * What a turn sends once an account's plan is spent but it still has credits (ChatGPT) or extra usage (Claude), on
 * the installed omp, with OMPdesk's credit-use switch off and on (resources/gui-bridge/credit-spend.ts). Nothing real
 * is contacted: made-up OAuth credentials in an empty private home, Claude's base URL on a fake on 127.0.0.1 (plain
 * http, so stock's `node:https` Cowork transport hands it to `fetch`), and a `--preload` that sends every `fetch` for
 * chatgpt.com (where stock always reads Codex usage) to the fake, refuses and records every other non-loopback
 * `fetch`, and refuses every `node:https` / `node:tls` connection. The fake answers by the account's token.
 */

const HOUR = 3_600_000;
const resetSec = (hours: number) => Math.floor((Date.now() + hours * HOUR) / 1000);

type ProviderId = "openai-codex" | "anthropic";

interface Account {
	/** Codex `/wham/usage` or Claude `/api/oauth/usage` body. */
	usage: unknown;
	/** The same once the account has served a model request, as the provider counts it; absent: `usage` throughout. */
	usageAfter?: unknown;
	/** Response headers the model request carries. */
	headers: Record<string, string>;
}

interface Scenario {
	provider: ProviderId;
	accounts: Record<string, Account>;
	prompts: number;
	/** `none`: stock alone; `off`/`on`: the bridge's credit-spend switch installed in that state. */
	mode: "none" | "off" | "on";
	/** A Claude model the turn falls back to (`retry.fallbackChains`), served by account `fallback`. */
	fallback?: boolean;
	/** Read the accounts list (Settings) after the turns, for the credits figure. */
	credits?: boolean;
	/** The session's model: the provider's first whose id holds this. */
	model?: string;
	/**
	 * No turn and no `credit_spend_set`: the switch is the spawn env's, the bridge's hooks are installed once the
	 * session exists (as its areas load at first use), and one request goes out as a title or a judge call makes it.
	 */
	oneShot?: boolean;
	/**
	 * No turn: stock's answer to a 401 (a forced refresh of the session's account, then its key again), then the
	 * account as Codex web search asks for it (`oauth.access`).
	 */
	refresh?: boolean;
	/**
	 * No turn and no bridge hooks of the probe's own: omp also loads `credit-spend-run.ts` before the probe, as the
	 * memory judge's host is started (core `care/judge.rs` `run_host`), and one request goes out after `session_start`.
	 */
	host?: boolean;
	/** No turn: main's question before the commit-message button's `omp commit` (`credit_spend_commit_check`). */
	commitCheck?: boolean;
}

const codexSpent = (credits: boolean, used = 100) => ({
	plan_type: "plus",
	rate_limit: {
		allowed: used < 100,
		limit_reached: used >= 100,
		primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_at: resetSec(3) },
		secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: resetSec(100) },
	},
	credits: credits ? { has_credits: true, unlimited: false, balance: "500" } : { has_credits: false },
});

const codexHeaders = (used: number) => ({
	"x-codex-primary-used-percent": String(used),
	"x-codex-primary-window-minutes": "300",
	"x-codex-primary-reset-at": String(resetSec(3)),
	"x-codex-secondary-used-percent": "40",
	"x-codex-secondary-window-minutes": "10080",
	"x-codex-secondary-reset-at": String(resetSec(100)),
});

const claudeUsage = (fiveHour: number) => ({
	five_hour: { utilization: fiveHour, resets_at: new Date(Date.now() + 3 * HOUR).toISOString() },
	seven_day: { utilization: 40, resets_at: new Date(Date.now() + 100 * HOUR).toISOString() },
	extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 120, utilization: 2.4 },
});

const claudeHeaders = (fiveHour: number, overage: boolean) => ({
	"anthropic-ratelimit-unified-5h-utilization": String(fiveHour / 100),
	"anthropic-ratelimit-unified-5h-reset": String(resetSec(3)),
	"anthropic-ratelimit-unified-7d-utilization": "0.4",
	"anthropic-ratelimit-unified-7d-reset": String(resetSec(100)),
	"anthropic-ratelimit-unified-representative-claim": "five_hour",
	"anthropic-ratelimit-unified-overage-status": overage ? "allowed" : "rejected",
	"anthropic-ratelimit-unified-overage-in-use": overage ? "true" : "false",
});

const GUARD = `
const LOOPBACK = { "127.0.0.1": true, localhost: true, "[::1]": true };
const realFetch = globalThis.fetch;
const record = { blocked: [] };
Object.defineProperty(globalThis, "__ompdeskNetGuard", { value: record });
const target = input => {
 try { return new URL(input instanceof Request ? input.url : String(input)); } catch { return undefined; }
};
async function guarded(input, init) {
 const url = target(input);
 if (url && (url.hostname === "chatgpt.com" || url.hostname === "auth.openai.com")) {
  const faked = process.env.OMPDESK_CREDIT_FAKE + "/" + url.hostname + url.pathname + url.search;
  return realFetch(input instanceof Request ? new Request(faked, input) : faked, init);
 }
 if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || LOOPBACK[url.hostname] !== true) {
  record.blocked.push(url ? url.protocol + "//" + url.host + url.pathname : String(input));
  throw new TypeError("ompdesk test guard: non-loopback request refused");
 }
 return realFetch(input, init);
}
guarded.preconnect = () => {};
globalThis.fetch = guarded;
for (const [name, module, method] of [["https", require("node:https"), "request"], ["https", require("node:https"), "get"], ["tls", require("node:tls"), "connect"]]) {
 module[method] = (...args) => {
  const first = args[0];
  record.blocked.push(name + "." + method + " " + (typeof first === "string" || first instanceof URL ? String(first) : (first && (first.hostname || first.host)) || "?"));
  throw new TypeError("ompdesk test guard: " + name + "." + method + " refused");
 };
}
`;

// Static imports: the probe sits beside a copy of resources/gui-bridge, so these resolve the way they do in the app.
const PROBE = `
import { completeSimple } from "@oh-my-pi/pi-ai";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { install, methods as credit } from "./credit-spend";
import { methods as settings } from "./settings";
export default function (pi) {
 const scenario = JSON.parse(process.env.OMPDESK_CREDIT_SCENARIO);
 if (scenario.mode !== "none" && !scenario.oneShot && !scenario.host) install(pi);
 pi.on("session_start", () => {
  void (async () => {
   try {
    const guard = globalThis.__ompdeskNetGuard;
    if (!guard || globalThis.fetch.name !== "guarded") throw new Error("the network guard preload did not run");
    pi.registerProvider("anthropic", { baseUrl: process.env.OMPDESK_CREDIT_FAKE + "/api.anthropic.com" });
    const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
    const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
    const auth = session.modelRegistry.authStorage;
    for (const name of Object.keys(scenario.accounts)) {
     const provider = name === "fallback" ? "anthropic" : scenario.provider;
     const token = provider === "anthropic" ? "sk-ant-oat01-probe-" + name : "probe-" + name;
     await auth.credentials.upsert(provider, {
      type: "oauth",
      access: token,
      refresh: "probe-refresh-" + name,
      expires: Date.now() + 10 * 365 * 24 * 3600_000,
      email: name + "@example.invalid",
      accountId: "acct-" + name,
     });
    }
    const models = session.modelRegistry.getAll();
    if (scenario.fallback) {
     const fallback = models.find(candidate => candidate.provider === "anthropic");
     lookup("retry.fallbackChains").set(session.settings, { [scenario.provider + "/*"]: ["anthropic/" + fallback.id] });
    }
    await session.setModel(models.find(candidate => candidate.provider === scenario.provider && (!scenario.model || candidate.id.includes(scenario.model))));
    if (scenario.oneShot) install(pi);
    else if (scenario.mode !== "none" && !scenario.host) await credit.credit_spend_set({ enabled: scenario.mode === "on" }, env);
    const turns = [];
    if (scenario.commitCheck) {
     // Stock's commit selection reads the commit and smol roles: the scenario's account answers for both.
     const selector = scenario.provider + "/" + session.model.id;
     lookup("modelRoles").set(session.settings, { commit: selector, smol: selector });
     let thrown;
     try {
      await credit.credit_spend_commit_check({}, env);
     } catch (error) {
      thrown = String((error && error.message) || error);
     }
     turns.push({ thrown, text: thrown ? undefined : "checked" });
    }
    if (scenario.oneShot || scenario.host) {
     let thrown, reply;
     try {
      reply = await completeSimple(
       session.model,
       { systemPrompt: ["Answer briefly."], messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
       { apiKey: session.modelRegistry.resolver(session.model, session.sessionId) },
      );
     } catch (error) {
      thrown = String((error && error.message) || error);
     }
     turns.push({ thrown, stopReason: reply?.stopReason, error: reply?.errorMessage });
    }
    if (scenario.refresh) {
     let thrown, key;
     try {
      key = await session.modelRegistry.resolver(session.model, session.sessionId)({
       error: Object.assign(new Error("401 Unauthorized"), { status: 401 }),
       lastChance: false,
       previousKey: "probe-spent",
      });
     } catch (error) {
      thrown = String((error && error.message) || error);
     }
     turns.push({ thrown, text: key ? "key" : undefined });
     let access;
     try {
      access = await auth.oauth.access(scenario.provider, session.sessionId);
      thrown = undefined;
     } catch (error) {
      thrown = String((error && error.message) || error);
     }
     turns.push({ thrown, text: access ? "access" : undefined });
    }
    for (let index = 0; index < scenario.prompts; index++) {
     let thrown;
     try {
      await session.prompt("hello " + index);
     } catch (error) {
      thrown = String((error && error.message) || error);
     }
     const last = [...session.agent.state.messages].reverse().find(message => message.role === "assistant");
     turns.push({
      thrown,
      stopReason: last?.stopReason,
      error: last?.errorMessage,
      provider: last?.provider,
      text: last?.content?.filter(part => part.type === "text").map(part => part.text).join(""),
     });
    }
    const listed = scenario.credits ? await settings.provider_accounts({ providerId: scenario.provider }, env) : undefined;
    const credits = listed?.accounts.map(account => account.credits ?? null);
    const model = session.model;
    const providerBase = session.modelRegistry.getProviderBaseUrl?.(scenario.provider);
    const [row] = auth.credentials.list(scenario.provider);
    const statuses = async baseUrl => (await auth.usage.report(scenario.provider, row.credential, { baseUrl }))?.limits.map(limit => limit.id + ":" + limit.status);
    const reports = { modelBase: model?.baseUrl, providerBase, viaModel: await statuses(model?.baseUrl), viaProvider: await statuses(providerBase) };
    console.error("CREDIT_PROBE=" + JSON.stringify({ turns, credits, reports, model: model?.id, blocked: guard.blocked }));
    process.exit(0);
   } catch (error) {
    console.error("CREDIT_PROBE=" + JSON.stringify({ error: String((error && error.stack) || error) }));
    process.exit(1);
   }
  })();
 });
}
`;

interface Received {
	method: string;
	host: string;
	path: string;
	account: string;
}

function sse(events: Array<[string, unknown]>): string {
	return events
		.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`)
		.join("");
}

const CODEX_REPLY = sse([
	["response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }],
	[
		"response.output_item.added",
		{
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
	],
	["response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "served" }],
	[
		"response.output_item.done",
		{
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "served", annotations: [] }],
			},
		},
	],
	[
		"response.completed",
		{
			response: {
				id: "resp_1",
				status: "completed",
				output: [],
				usage: {
					input_tokens: 10,
					output_tokens: 2,
					total_tokens: 12,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			},
		},
	],
]);

const claudeReply = (model: string) =>
	sse([
		[
			"message_start",
			{
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model,
					content: [],
					stop_reason: null,
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			},
		],
		["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { index: 0, delta: { type: "text_delta", text: "served" } }],
		["content_block_stop", { index: 0 }],
		["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
		["message_stop", {}],
	]);

function fakeProviders(received: Received[], scenarios: () => Scenario) {
	return createServer((request: IncomingMessage, response: ServerResponse) => {
		let body = "";
		request.on("data", chunk => {
			body += chunk;
		});
		request.on("end", () => {
			const [, host = "", ...rest] = (request.url ?? "").split("/");
			const path = `/${rest.join("/")}`;
			const token = String(request.headers.authorization ?? request.headers["x-api-key"] ?? "");
			const account = token.match(/probe-([a-z]+)/)?.[1] ?? "";
			received.push({ method: request.method ?? "", host, path: path.split("?")[0] ?? path, account });
			const scenario = scenarios();
			const scripted = scenario.accounts[account];
			const answer = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
				response.writeHead(status, { "content-type": "application/json", ...headers });
				response.end(JSON.stringify(payload));
			};
			if (request.method === "POST" && host === "auth.openai.com" && path.startsWith("/oauth/token")) {
				const name = body.match(/probe-refresh-([a-z]+)/)?.[1] ?? "";
				return answer(200, {
					access_token: `probe-${name}`,
					refresh_token: `probe-refresh-${name}`,
					expires_in: 3600,
					token_type: "Bearer",
				});
			}
			if (!scripted) return answer(404, { error: "no such account" });
			if (
				request.method === "GET" &&
				(path.startsWith("/backend-api/wham/usage") || path.startsWith("/api/oauth/usage"))
			) {
				const served = received.some(
					entry =>
						entry.account === account && entry.method === "POST" && /\/responses|\/messages/.test(entry.path),
				);
				return answer(200, served && scripted.usageAfter !== undefined ? scripted.usageAfter : scripted.usage);
			}
			if (request.method === "POST" && path.startsWith("/backend-api/codex/responses")) {
				response.writeHead(200, { "content-type": "text/event-stream", ...scripted.headers });
				return response.end(CODEX_REPLY);
			}
			if (request.method === "POST" && path.startsWith("/v1/messages")) {
				const model = String((JSON.parse(body || "{}") as { model?: unknown }).model ?? "claude");
				response.writeHead(200, { "content-type": "text/event-stream", ...scripted.headers });
				return response.end(claudeReply(model));
			}
			return answer(404, { error: "not scripted" });
		});
	});
}

interface ProbeResult {
	turns?: Array<{ thrown?: string; stopReason?: string; error?: string; provider?: string; text?: string }>;
	credits?: unknown[];
	reports?: unknown;
	/** The session's model id. */
	model?: string;
	blocked?: string[];
	error?: string;
}

/** Puts the network guard, a copy of the bridge and omp's config into the private home; returns how omp starts in it. */
function stage(isolated: string): { cli: string[]; bridge: string } {
	const root = ompPackageRoot(INSTALLED_OMP);
	if (!root) throw new Error(`no omp package behind ${INSTALLED_OMP}`);
	chmodSync(isolated, 0o700);
	const guard = join(isolated, "net-guard.js");
	const bridge = join(isolated, "bridge");
	cpSync(absolute("resources/gui-bridge"), bridge, { recursive: true });
	writeFileSync(guard, GUARD);
	writeFileSync(join(bridge, "credit-spend-probe.ts"), PROBE);
	writeFileSync(
		join(isolated, "config.yml"),
		"retry:\n  maxRetries: 1\n  baseDelayMs: 50\n  maxDelayMs: 1000\n  fallbackOn: usage-limit\n",
	);
	// omp 18.22.1+ (pi-catalog wire/codex-version.ts) fetches `@openai/codex`'s npm version without a fresh record;
	// one no newer than stock's pin keeps that pin and leaves the network alone.
	writeFileSync(
		join(isolated, "codex-client-version.json"),
		JSON.stringify({ version: "0.0.0", checkedAt: Date.now() }),
	);
	return { cli: ["--preload", guard, join(root, "dist", "cli.js")], bridge };
}

function ompEnv(isolated: string, fake: string, extra: Record<string, string>): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: isolated,
		USERPROFILE: isolated,
		PI_CODING_AGENT_DIR: isolated,
		PI_CONFIG_DIR: configDirName(isolated, isolated),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		PI_NO_TITLE: "1",
		PI_CODEX_WEBSOCKET: "0",
		OPENAI_API_KEY: "probe-not-a-real-key",
		OMPDESK_CREDIT_FAKE: fake,
		...extra,
	};
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_OAUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"OPENROUTER_API_KEY",
		"TYPESAFE_API_KEY",
		"OMP_GUI_BRIDGE",
	]) {
		Reflect.deleteProperty(env, key);
	}
	return env;
}

/** `home`: an agent directory to run in and leave behind, so a second run is another session of the same computer. */
function runProbe(fake: string, scenario: Scenario, home?: string): Promise<ProbeResult> {
	const isolated = home ?? mkdtempSync(join(tmpdir(), "ompdesk-credit-spend-"));
	const { cli, bridge } = stage(isolated);
	const env = ompEnv(isolated, fake, {
		// The switch as main passes it at spawn (omp-launch.ts `sessionEnv`), never this test run's own.
		OMP_GUI_CREDIT_SPEND: scenario.mode === "on" ? "1" : "0",
		OMPDESK_CREDIT_SCENARIO: JSON.stringify(scenario),
	});
	const args = [
		...cli,
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		...(scenario.host ? creditSpendRun(bridge, false).args : []),
		"-e",
		join(bridge, "credit-spend-probe.ts"),
	];
	const { promise, resolve, reject } = Promise.withResolvers<ProbeResult>();
	const child = spawn("bun", args, { env, stdio: ["pipe", "ignore", "pipe"], timeout: 60_000 });
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", chunk => {
		stderr += chunk;
	});
	child.on("error", reject);
	child.on("close", () => {
		if (!home) rmSync(isolated, { recursive: true, force: true });
		const line = stderr.split("\n").find(value => value.startsWith("CREDIT_PROBE="));
		if (!line) reject(new Error(`no probe result; omp stderr:\n${stderr.slice(-2500)}`));
		else resolve(JSON.parse(line.slice("CREDIT_PROBE=".length)) as ProbeResult);
	});
	return promise;
}

/** A scheduled run's and a PR draft's own arguments (schedules.ts `ompRunLauncher`, local/git/pr.ts). */
const PRINT_RUN = ["--no-session", "--tools=", "--no-lsp", "--no-extensions", "--no-skills", "--no-rules"];
/** The core's for memory's upkeep and curation (native/ompdesk/crates/core/src/upkeep/model.rs `run_smol`). */
const UPKEEP_RUN = [
	"--mode",
	"json",
	"--tools=",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-title",
	"--thinking",
	"off",
	"--system-prompt",
	"Answer briefly.",
];

/**
 * `omp -p` in `home` as OMPdesk starts it without a bridge: only what `creditSpendRun` (omp-launch.ts) gives every
 * such run right after `-p`, then the run's `own` arguments, the prompt on stdin.
 */
function runPrint(
	fake: string,
	home: string,
	model: string,
	enabled: boolean,
	own = PRINT_RUN,
	extraEnv: Record<string, string> = {},
): Promise<string> {
	const { cli, bridge } = stage(home);
	const run = creditSpendRun(bridge, enabled);
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn("bun", [...cli, "-p", ...run.args, ...own, "--model", model], {
		env: ompEnv(home, fake, { ...run.env, ...extraEnv }),
		stdio: ["pipe", "pipe", "pipe"],
		timeout: 60_000,
	});
	let output = "";
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8").on("data", chunk => {
			output += chunk;
		});
	}
	child.on("error", reject);
	child.on("close", () => resolve(output));
	child.stdin.end("hello");
	return promise;
}

describe.skipIf(!existsSync(INSTALLED_OMP))("credit spend on the installed omp", () => {
	const received: Received[] = [];
	let current: Scenario | undefined;
	const server = fakeProviders(received, () => {
		if (!current) throw new Error("no scenario");
		return current;
	});
	let base = "";

	beforeAll(async () => {
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		return closed.promise;
	});

	const run = async (scenario: Scenario, home?: string) => {
		received.length = 0;
		current = scenario;
		const probe = await runProbe(base, scenario, home);
		const sent = received
			.filter(
				entry => entry.method === "POST" && (entry.path.includes("/responses") || entry.path.includes("/messages")),
			)
			.map(entry => entry.account);
		return { probe, sent, received: [...received] };
	};

	const codexSingle = (mode: Scenario["mode"], extra: Partial<Scenario> = {}): Scenario => ({
		provider: "openai-codex",
		accounts: { spent: { usage: codexSpent(true), headers: codexHeaders(100) } },
		prompts: 2,
		mode,
		...extra,
	});
	const claudeSingle = (mode: Scenario["mode"], usage: number, headerUse: number): Scenario => ({
		provider: "anthropic",
		accounts: { spent: { usage: claudeUsage(usage), headers: claudeHeaders(headerUse, true) } },
		prompts: 2,
		mode,
	});
	const served = { stopReason: "stop", text: "served" };
	const refused = (brand: string) => ({
		stopReason: "error",
		error: expect.stringMatching(
			new RegExp(`^usage_limit_reached: this ${brand} account reached its plan's usage limit`),
		),
	});
	// Every case: nothing left the machine but loopback.
	const quiet = (probe: ProbeResult) =>
		expect(probe.blocked?.filter(entry => !entry.endsWith("/models") && !entry.includes("models.json"))).toEqual([]);

	it("stock alone (and credit use on) sends a spent ChatGPT account with credits every request", async () => {
		for (const mode of ["none", "on"] as const) {
			const { probe, sent } = await run(codexSingle(mode));
			expect(probe.error, mode).toBeUndefined();
			expect(sent, mode).toEqual(["spent", "spent"]);
			expect(probe.turns, mode).toMatchObject([served, served]);
			quiet(probe);
		}
	}, 120_000);

	it("off: a spent ChatGPT account with credits gets no request, the turn ends in the usage limit, and the credits still show", async () => {
		const { probe, sent } = await run(codexSingle("off", { credits: true }));
		expect(probe.error).toBeUndefined();
		expect(sent).toEqual([]);
		expect(probe.turns).toMatchObject([refused("ChatGPT"), refused("ChatGPT")]);
		expect(probe.credits).toEqual([
			{ kind: "balance", limitId: "openai-codex:credits", remaining: 500, unit: "credits" },
		]);
		quiet(probe);
	}, 60_000);

	it("off: with an account that has plan left, that one serves", async () => {
		const { probe, sent } = await run(
			codexSingle("off", {
				accounts: {
					spent: { usage: codexSpent(true), headers: codexHeaders(100) },
					fresh: { usage: codexSpent(false, 20), headers: codexHeaders(20) },
				},
			}),
		);
		expect(sent).toEqual(["fresh", "fresh"]);
		expect(probe.turns).toMatchObject([served, served]);
		quiet(probe);
	}, 60_000);

	it("off: with a fallback chain the turn goes on on the fallback model", async () => {
		const { probe, sent } = await run(
			codexSingle("off", {
				fallback: true,
				accounts: {
					spent: { usage: codexSpent(true), headers: codexHeaders(100) },
					fallback: { usage: claudeUsage(20), headers: claudeHeaders(20, false) },
				},
			}),
		);
		expect(probe.error).toBeUndefined();
		expect(sent.filter(account => account === "spent")).toEqual([]);
		expect(sent.length).toBeGreaterThan(0);
		expect(new Set(sent)).toEqual(new Set(["fallback"]));
		expect(probe.turns?.at(-1)).toMatchObject({ ...served, provider: "anthropic" });
		quiet(probe);
	}, 60_000);

	// Stock never hears a served Codex request's limits (pi-ai providers/openai-codex-responses.ts calls no
	// `onResponse`; measured on 18.18.9: the report still read 90 % after a 2xx at 100 %), so the account served on
	// credits until its next usage report, about 5 minutes. The check reads the usage of an account near its plan's
	// end again before each request that follows one of its own: the request that crosses is the last one served.
	it("off: a ChatGPT plan that runs out between two usage reports stops at the next request", async () => {
		const crossing = { usage: codexSpent(true, 90), usageAfter: codexSpent(true), headers: codexHeaders(100) };
		const { probe, sent, received } = await run(codexSingle("off", { accounts: { spent: crossing } }));
		expect(probe.error).toBeUndefined();
		expect(sent, JSON.stringify(probe.reports)).toEqual(["spent"]);
		expect(probe.turns).toMatchObject([served, refused("ChatGPT")]);
		// One usage read after the served request found it.
		const order = received.filter(entry => /\/wham\/usage|\/responses/.test(entry.path)).map(entry => entry.path);
		expect(order.indexOf("/backend-api/codex/responses")).toBeLessThan(order.lastIndexOf("/backend-api/wham/usage"));
		quiet(probe);
		// Stock alone goes on on credits.
		const stock = await run(codexSingle("none", { accounts: { spent: crossing } }));
		expect(stock.sent).toEqual(["spent", "spent"]);
	}, 120_000);

	it("off from the spawn env alone: a one-shot request before any turn or switch push sends a spent account nothing", async () => {
		const { probe, sent } = await run(codexSingle("off", { prompts: 0, oneShot: true }));
		expect(probe.error).toBeUndefined();
		expect(sent).toEqual([]);
		const [turn] = probe.turns ?? [];
		expect(turn?.error ?? turn?.thrown).toMatch(
			/usage_limit_reached: this ChatGPT account reached its plan's usage limit/,
		);
		quiet(probe);
	}, 60_000);

	it("off: the key of a forced token refresh, and the account Codex web search asks for, are refused like any other", async () => {
		const { probe, sent, received } = await run(codexSingle("off", { prompts: 0, refresh: true }));
		expect(probe.error).toBeUndefined();
		expect(received.filter(entry => entry.host === "auth.openai.com").map(entry => entry.path)).toEqual([
			"/oauth/token",
		]);
		expect(sent).toEqual([]);
		const refusal = expect.stringMatching(
			/^usage_limit_reached: this ChatGPT account reached its plan's usage limit/,
		);
		// Stock's 401 step (a forced refresh, then the key), then `oauth.access` as web search and the live transport call it.
		expect(probe.turns).toMatchObject([{ thrown: refusal }, { thrown: refusal }]);
		expect(probe.turns?.map(turn => turn.text)).toEqual([undefined, undefined]);
		quiet(probe);
	}, 60_000);

	// A scheduled run, a PR draft and memory's own model calls are `omp -p` with no bridge, so stock alone served
	// them from credits. With what main gives every such run (omp-launch.ts `creditSpendRun`) the run's first request
	// is refused.
	it("an omp -p run beside the sessions follows the switch: off sends a spent account nothing, on sends it", async () => {
		const home = mkdtempSync(join(tmpdir(), "ompdesk-credit-spend-home-"));
		try {
			// The account, stored as on a signed-in computer.
			const { probe } = await run(codexSingle("off", { prompts: 0 }), home);
			expect(probe.error).toBeUndefined();
			const model = `openai-codex/${probe.model}`;
			const posts = () =>
				received
					.filter(entry => entry.method === "POST" && entry.path.includes("/responses"))
					.map(entry => entry.account);
			for (const own of [PRINT_RUN, UPKEEP_RUN]) {
				received.length = 0;
				const off = await runPrint(base, home, model, false, own);
				expect(posts(), off.slice(-800)).toEqual([]);
				expect(off).toContain("Credit use setting is off");
			}
			received.length = 0;
			// A scheduled run's usage: the same extension writes stock's tally where `OMP_GUI_RUN_USAGE` says.
			const usageFile = join(home, "run.usage.json");
			const on = await runPrint(base, home, model, true, PRINT_RUN, { [RUN_USAGE_ENV]: usageFile });
			expect(posts(), on.slice(-800)).toEqual(["spent"]);
			const usage = JSON.parse(readFileSync(usageFile, "utf8")) as Record<string, unknown>;
			for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost"])
				expect(typeof usage[field], field).toBe("number");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 180_000);

	it("off: an omp that loads the check alone and never runs a turn (the memory judge's host) sends a spent account nothing", async () => {
		const { probe, sent } = await run(codexSingle("off", { prompts: 0, host: true }));
		expect(probe.error).toBeUndefined();
		expect(sent).toEqual([]);
		const [turn] = probe.turns ?? [];
		expect(turn?.error ?? turn?.thrown).toMatch(
			/usage_limit_reached: this ChatGPT account reached its plan's usage limit/,
		);
		quiet(probe);
	}, 60_000);

	// `omp commit` takes no extension, so main asks the tab's omp first (`credit_spend_commit_check`): it resolves the
	// models stock's commit pipeline would pick through the checks.
	it("the commit-message check: off refuses for a spent account and sends nothing, passes with plan left, and on never asks", async () => {
		const spent = await run(codexSingle("off", { prompts: 0, commitCheck: true }));
		expect(spent.probe.error).toBeUndefined();
		expect(spent.sent).toEqual([]);
		expect(spent.probe.turns).toMatchObject([
			{ thrown: expect.stringMatching(/^usage_limit_reached: this ChatGPT account reached its plan's usage limit/) },
		]);
		const fresh = { fresh: { usage: codexSpent(false, 20), headers: codexHeaders(20) } };
		const room = await run(codexSingle("off", { prompts: 0, commitCheck: true, accounts: fresh }));
		expect(room.probe.turns).toEqual([{ text: "checked" }]);
		expect(room.sent).toEqual([]);
		const on = await run(codexSingle("on", { prompts: 0, commitCheck: true }));
		expect(on.probe.turns).toEqual([{ text: "checked" }]);
	}, 180_000);

	it("Claude at 100 %: stock and on send both requests, off sends none", async () => {
		for (const mode of ["none", "on"] as const) {
			const { probe, sent } = await run(claudeSingle(mode, 100, 100));
			expect(sent, mode).toEqual(["spent", "spent"]);
			expect(probe.turns, mode).toMatchObject([served, served]);
			quiet(probe);
		}
		const { probe, sent } = await run(claudeSingle("off", 100, 100));
		expect(sent).toEqual([]);
		expect(probe.turns).toMatchObject([refused("Claude"), refused("Claude")]);
		quiet(probe);
	}, 120_000);

	// The one request no client can refuse: Claude's usage answer shows no spent window and only the response says
	// extra usage served it (pi-ai providers/anthropic.ts hands the headers on after the request went out). What that
	// answer said is kept for the computer, so a new session's first request is refused.
	it("Claude under 100 % in its usage answer but served on extra usage: off sends the request that finds out, then none, a new session's first included", async () => {
		const home = mkdtempSync(join(tmpdir(), "ompdesk-credit-spend-home-"));
		try {
			const first = await run(claudeSingle("off", 60, 98), home);
			expect(first.sent).toEqual(["spent"]);
			expect(first.probe.turns).toMatchObject([served, refused("Claude")]);
			quiet(first.probe);
			const next = await run(claudeSingle("off", 60, 98), home);
			expect(next.probe.error).toBeUndefined();
			expect(next.sent).toEqual([]);
			expect(next.probe.turns).toMatchObject([refused("Claude"), refused("Claude")]);
			quiet(next.probe);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 120_000);

	it("off: a Claude model whose own week is spent gets no request, though the shared windows have room", async () => {
		const usage = {
			...claudeUsage(60),
			seven_day_opus: { utilization: 100, resets_at: new Date(Date.now() + 50 * HOUR).toISOString() },
		};
		const scenario = (mode: Scenario["mode"]): Scenario => ({
			provider: "anthropic",
			accounts: { spent: { usage, headers: claudeHeaders(60, true) } },
			prompts: 1,
			mode,
			model: "opus",
		});
		const off = await run(scenario("off"));
		expect(off.probe.error).toBeUndefined();
		expect(off.sent).toEqual([]);
		expect(off.probe.turns).toMatchObject([refused("Claude")]);
		quiet(off.probe);
		const on = await run(scenario("on"));
		expect(on.sent).toEqual(["spent"]);
	}, 120_000);
});
