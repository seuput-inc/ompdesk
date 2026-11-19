/**
 * Credit use, live half (the rules are credit-spend-core.ts). The GUI passes the switch in `OMP_GUI_CREDIT_SPEND` at
 * spawn and `credit_spend_set` whenever Settings changes it; it acts on the omp's next request.
 *
 * While off, these stock seams carry it, all on the process's one `AuthStorage` (subagents in this process and in
 * worker threads resolve their keys through it), from the moment the bridge's areas load:
 *
 * - ChatGPT's usage provider is stock's own wrapped as a runtime override (`usage.providerFor` then
 *   `usage.setProvider`): its `/wham/usage` answer reaches stock's parser without the `credits` block, so a spent plan
 *   reads spent and stock's selector blocks the account from the report and ranks a sibling first; the report's `raw`
 *   keeps the provider's real answer for the credits figure (account-credits.ts `rawCredits`). A response's
 *   `x-codex-*` headers are parsed without the 2xx verdict, so a window at 100 % reads spent, not "allowed". The
 *   override keeps its reports apart from other omps' (`cacheVersion`; stock auth-storage.ts keys the cache by it), so
 *   a terminal omp's report that says "allowed on credits" never reaches this one, and this one's never reaches it.
 * - Every account stock hands a request is checked after stock picked it, on both ways a request gets one:
 *   `keys.getWithCredential` (the agent loop, subagents, titles, judges, a forced token refresh; `keys.get` is the
 *   prompt-time availability probe and stays stock) and `oauth.access` (Codex web search and the live transport, which
 *   ask stock's selector for the account itself). One whose plan is spent by its own report, or that a provider's
 *   answer said is past its plan, is refused with a usage-limit error. Stock then blocks it until the reset
 *   (`limits.markReached`), moves the session to an account with plan left, or walks `retry.fallbackChains`.
 * - A ChatGPT account that holds credits is read again before a request once its report can no longer be trusted
 *   for the plan it shows left (`reportTrust`), through the override's own fetch: stock hears nothing of a served
 *   request's limits.
 * - `after_provider_response` reads Claude's `overage-in-use` header and remembers the account until the claimed
 *   window resets, because Claude's usage answer can still read under 100 % while extra usage serves. What is
 *   remembered is one file of the agent directory, so every OMPdesk omp, a new session's first request included,
 *   knows it.
 *
 * On: the override is removed (`usage.removeProvider`), the checks pass everything, and nothing is remembered.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AuthStorage, UsageFetchContext, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	CREDITS_HELD,
	type CreditProvider,
	creditSpendEnabled,
	holdsCredits,
	isCreditProvider,
	type LimitedLedger,
	NEAR_SPENT_AGE_MS,
	overageCoversAccount,
	overageUntil,
	parseLimited,
	planSpentError,
	planSpentUntil,
	reportTrust,
	setCreditSpend,
	UNREAD_HOLD_MS,
	UNREAD_USAGE_ERROR,
	withoutCredits,
} from "./credit-spend-core";
import { guard } from "./health";
import { scopedUsageLimits } from "./omp/pi-ai/auth/usage-report";
import { defaultRankingStrategy } from "./omp/pi-ai/usage/registry";
import { appendRetryAfterHint } from "./omp/pi-ai/utils/retry-after";
import { getAgentDir } from "./omp/pi-utils";

/** Stock `UsageService.report` (one stored credential); not on the `UsageApi` interface (settings.ts reads it the same way). */
interface CredentialUsageReporter {
	report(provider: string, credential: unknown, options?: { baseUrl?: string }): Promise<UsageReport | null>;
}

const CODEX = "openai-codex";

/**
 * The cache namespace of the credits-hidden ChatGPT reports: stock's own version under a prefix no stock provider
 * uses, so it moves with stock's (a stock bump retires these rows as well) and never meets a stock row.
 */
const HIDDEN_CREDITS_CACHE_BASE = 9_000_000;

/** Marks the override, so a later apply finds stock's provider under it. */
const WRAPPED = Symbol.for("ompdesk.credit-spend.wrapped");
type WrappedProvider = UsageProvider & { [WRAPPED]: UsageProvider };

function isWrapped(provider: UsageProvider | undefined): provider is WrappedProvider {
	return provider !== undefined && WRAPPED in provider;
}

/** Stock's fetch context as it last reached the override: the check's own usage reads go out the same way. */
let usageContext: UsageFetchContext | undefined;

function codexWithoutCredits(stock: UsageProvider): WrappedProvider {
	const parseHeaders = stock.parseRateLimitHeaders;
	return {
		...stock,
		[WRAPPED]: stock,
		cacheVersion: HIDDEN_CREDITS_CACHE_BASE + (stock.cacheVersion ?? 0),
		async fetchUsage(params, ctx) {
			usageContext = ctx;
			let answer: unknown;
			const hiding: UsageFetchContext["fetch"] = Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
					const response = await ctx.fetch(input, init);
					const url = input instanceof Request ? input.url : String(input);
					if (!response.ok || !new URL(url).pathname.endsWith("/wham/usage")) return response;
					answer = await response.json();
					return new Response(JSON.stringify(withoutCredits(answer)), {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					});
				},
				{ preconnect: ctx.fetch.preconnect },
			);
			const report = await stock.fetchUsage(params, { ...ctx, fetch: hiding });
			if (!report || answer === undefined) return report;
			const metadata = holdsCredits(answer) ? { ...report.metadata, [CREDITS_HELD]: true } : report.metadata;
			return { ...report, metadata, raw: answer };
		},
		...(parseHeaders
			? { parseRateLimitHeaders: (headers: Record<string, string>, now?: number) => parseHeaders(headers, now, {}) }
			: {}),
	};
}

/** Puts ChatGPT's usage provider in the state the switch names; a no-op when it already is. */
function applyUsageProvider(auth: AuthStorage): void {
	const current = auth.usage.providerFor(CODEX);
	if (creditSpendEnabled()) {
		if (isWrapped(current)) auth.usage.removeProvider(CODEX);
		return;
	}
	if (current && !isWrapped(current)) auth.usage.setProvider(CODEX, codexWithoutCredits(current));
}

/** Beside the credential store its ids belong to, so every OMPdesk omp of this agent directory reads the same one. */
const ledgerPath = () => path.join(getAgentDir(), "ompdesk-credit-limits.json");

/** What the file could not take (an agent directory that cannot be written): it still holds in this process. */
const unsaved = new Map<string, number>();

/** What the providers' answers said is past its plan, for every omp of the agent directory: the file's contents. */
function readLedger(now: number): LimitedLedger {
	let ledger: LimitedLedger = {};
	try {
		ledger = parseLimited(fs.readFileSync(ledgerPath(), "utf8"), now);
	} catch {
		// No file yet, or one that cannot be read.
	}
	for (const [key, until] of unsaved) {
		if (until > now) ledger[key] = until;
	}
	return ledger;
}

function writeLedger(ledger: LimitedLedger): void {
	try {
		// Rename over the file so a concurrent reader never sees half a write.
		const temp = `${ledgerPath()}.${process.pid}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(ledger), { mode: 0o600 });
		fs.renameSync(temp, ledgerPath());
		unsaved.clear();
	} catch {
		for (const [key, until] of Object.entries(ledger)) unsaved.set(key, until);
	}
}

function remember(key: string, until: number, now: number): void {
	writeLedger({ ...readLedger(now), [key]: until });
}

/** A reset pass gave the account its plan back: what its answers said before no longer holds, in any omp. */
export function forgetLimited(provider: string, credentialId: number): void {
	const account = `${provider}\0${credentialId}`;
	const ledger = readLedger(Date.now());
	for (const key of Object.keys(ledger)) {
		if (key !== account && !key.startsWith(`${account}\0`)) continue;
		unsaved.delete(key);
		delete ledger[key];
	}
	writeLedger(ledger);
}

/** The check's own reads of a ChatGPT account whose cached report is too old, one at a time per account. */
const freshReads = new Map<number, { at: number; read: Promise<UsageReport | null> }>();

/** When this omp last let a request go out on a ChatGPT account. */
const sentAt = new Map<number, number>();

/**
 * The account's newest usage report: stock's cached one, or the check's own read when that one is too old for the
 * plan it shows left (`reportTrust`). `confirmed` is false when a report that had to be read again could not be: a
 * failed read is not tried again for `NEAR_SPENT_AGE_MS`.
 */
async function codexReport(
	auth: AuthStorage,
	credentialId: number,
	credential: { access: string; expires?: number; accountId?: string; email?: string },
	baseUrl: string | undefined,
	cached: UsageReport | null,
	now: number,
): Promise<{ report: UsageReport | null; confirmed: boolean }> {
	const held = freshReads.get(credentialId);
	const last = held ? await held.read : null;
	const newest = last && last.fetchedAt > (cached?.fetchedAt ?? 0) ? last : cached;
	const trust = reportTrust(newest, now, sentAt.get(credentialId));
	if (trust === "current") return { report: newest, confirmed: true };
	const unread = { report: newest, confirmed: trust === "aging" };
	if (held && !last && now - held.at < NEAR_SPENT_AGE_MS) return unread;
	// Another request of this account started the read meanwhile: wait for that one.
	if (freshReads.get(credentialId) !== held) return codexReport(auth, credentialId, credential, baseUrl, cached, now);
	const provider = auth.usage.providerFor(CODEX);
	if (!isWrapped(provider)) return unread;
	const read = provider
		.fetchUsage(
			{
				provider: CODEX,
				credential: {
					type: "oauth",
					accessToken: credential.access,
					expiresAt: credential.expires,
					accountId: credential.accountId,
					email: credential.email,
				},
				baseUrl,
			},
			usageContext ?? { fetch },
		)
		.catch(() => null);
	freshReads.set(credentialId, { at: now, read });
	const fresh = await read;
	return fresh ? { report: fresh, confirmed: true } : unread;
}

/** Why and until when an account must not serve a request. `unread`: its usage could not be read, not that it is spent. */
interface Refusal {
	until: number;
	unread?: true;
}

/** Whether the account must not serve `modelId`, by a provider's answer or its own report; undefined when it may. */
async function refusal(
	auth: AuthStorage,
	provider: CreditProvider,
	credentialId: number,
	options: { baseUrl?: string; modelId?: string } | undefined,
	now: number,
): Promise<Refusal | undefined> {
	const account = `${provider}\0${credentialId}`;
	const ledger = readLedger(now);
	const remembered = ledger[account] ?? (options?.modelId ? ledger[`${account}\0${options.modelId}`] : undefined);
	if (remembered !== undefined) return { until: remembered };
	const entry = auth.credentials.list(provider).find(row => row.id === credentialId);
	if (entry?.credential.type !== "oauth") return undefined;
	const reporter = auth.usage as unknown as CredentialUsageReporter;
	const cached = await reporter.report(provider, entry.credential, { baseUrl: options?.baseUrl });
	let until: number | undefined;
	if (provider === CODEX) {
		until = planSpentUntil(provider, cached, now);
		if (until === undefined) {
			const read = await codexReport(auth, credentialId, entry.credential, options?.baseUrl, cached, now);
			until = planSpentUntil(provider, read.report, now);
			if (until === undefined && !read.confirmed) return { until: now + UNREAD_HOLD_MS, unread: true };
		}
	} else {
		// The windows stock counts for this model (a model's own week included), as account-rotation.ts reads them.
		const strategy = options?.modelId ? defaultRankingStrategy(provider) : undefined;
		const context = { modelId: options?.modelId };
		const modelRows =
			cached && strategy
				? (strategy.scopeLimitsForReserve?.(cached, context) ?? scopedUsageLimits(strategy, cached, context))
				: [];
		until = planSpentUntil(provider, cached, now, modelRows);
	}
	return until === undefined ? undefined : { until };
}

/** Refuses the account stock picked for a request when its plan is spent; passes everything while credit use is on. */
async function refuseSpent(
	auth: AuthStorage,
	provider: string,
	credentialId: number | undefined,
	options: { baseUrl?: string; modelId?: string; recordAffinity?: boolean } | undefined,
): Promise<void> {
	if (creditSpendEnabled() || credentialId === undefined || !isCreditProvider(provider)) return;
	const now = Date.now();
	const refused = await refusal(auth, provider, credentialId, options, now);
	if (!refused) {
		// A request goes out on it now (account-rotation.ts's ranking probe, `recordAffinity: false`, sends none).
		if (provider === CODEX && options?.recordAffinity !== false) sentAt.set(credentialId, Date.now());
		return;
	}
	const message = refused.unread ? UNREAD_USAGE_ERROR : planSpentError(provider, refused.until, now);
	throw new Error(appendRetryAfterHint(message, { "retry-after-ms": String(refused.until - now) }));
}

/** The checks, installed once per AuthStorage. */
const gated = new WeakSet<object>();

function gate(auth: AuthStorage): void {
	if (gated.has(auth)) return;
	gated.add(auth);
	const key = auth.keys.getWithCredential.bind(auth.keys);
	auth.keys.getWithCredential = async (provider, sessionId, options) => {
		const resolved = await key(provider, sessionId, options);
		await refuseSpent(auth, provider, resolved?.credentialId, options);
		return resolved;
	};
	// Codex web search and the live transport ask stock's selector for the account itself (pi-ai auth/oauth.ts
	// `access`, auth-retry.ts `withOAuthAccess`), past the key check above, so a spent account with credits served them.
	const access = auth.oauth.access.bind(auth.oauth);
	auth.oauth.access = async (provider, sessionId, options) => {
		const resolved = await access(provider, sessionId, options);
		await refuseSpent(auth, provider, resolved?.credentialId, options);
		return resolved;
	};
}

function apply(auth: AuthStorage): void {
	gate(auth);
	applyUsageProvider(auth);
	if (!creditSpendEnabled()) return;
	unsaved.clear();
	try {
		fs.rmSync(ledgerPath(), { force: true });
	} catch {
		// On passes every request whatever the file holds.
	}
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	const applyTo = (auth: AuthStorage | undefined) => {
		if (!auth) return;
		try {
			apply(auth);
		} catch (err) {
			pi.logger.warn("gui-bridge: credit use setting not applied", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};
	const mainStorage = () => pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session?.modelRegistry.authStorage;
	// At once, not at the next turn start: the areas load at the omp's first use (main's connection, or the first
	// prompt's `input`), and a one-shot request (a title, a judge, a suggestion) resolves its key with no turn at all.
	applyTo(mainStorage());
	// An omp started without the bridge loads this before its session exists (credit-spend-run.ts), and one of them
	// never runs a turn (the memory judge's host asks its model right after `session_start`).
	pi.on("session_start", () => applyTo(mainStorage()));
	pi.on("before_agent_start", async (_event, ctx) => {
		// A subagent in a worker thread holds a proxy of the main thread's AuthStorage, which already carries it.
		if (ctx.agent.kind === "main") applyTo(ctx.modelRegistry.authStorage);
		return undefined;
	});
	pi.on("after_provider_response", (event, ctx) => {
		const model = ctx.model;
		if (creditSpendEnabled() || model?.provider !== "anthropic") return;
		const auth = ctx.modelRegistry.authStorage;
		const sessionId = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session?.sessionId;
		const now = Date.now();
		const until = overageUntil(event.headers, now);
		if (until === undefined) return;
		const active = auth.oauth.accounts(model.provider, sessionId).find(entry => entry.active);
		if (!active) return;
		const account = `${model.provider}\0${active.credentialId}`;
		remember(overageCoversAccount(event.headers) ? account : `${account}\0${model.id}`, until, now);
	});
}

export const methods = guard("creditSpend", {
	/** `{enabled: boolean}`: main sends it to every live local omp on change and on bridge connect. */
	credit_spend_set: async (params, env) => {
		const state = setCreditSpend(params);
		apply(env.session().modelRegistry.authStorage);
		return state;
	},
	/**
	 * `{}`, asked by main before it runs stock's `omp commit` for the commit-message button (omp-launch.ts
	 * `withCreditSpendRuns`). That run builds an AuthStorage of its own and loads no extension hook (stock
	 * commit/pipeline.ts), so the switch cannot ride along. This omp, which carries the checks, picks the models the
	 * run will pick (stock's own selection) and resolves each one's key as a request of this omp would: the refusal
	 * is what main shows instead of running it. Every area module loads at startup, so the two stock modules load here.
	 */
	credit_spend_commit_check: async (_params, env) => {
		const session = env.session();
		apply(session.modelRegistry.authStorage);
		if (creditSpendEnabled()) return {};
		const { resolvePrimaryModel, resolveSmolModel } = await import("./omp/pi-coding-agent/commit/model-selection");
		const { resolveApiKeyOnce } = await import("./omp/pi-ai");
		const primary = await resolvePrimaryModel(undefined, session.settings, session.modelRegistry);
		const smol = await resolveSmolModel(session.settings, session.modelRegistry, primary.model, primary.apiKey);
		await resolveApiKeyOnce(primary.apiKey);
		if (smol.model !== primary.model) await resolveApiKeyOnce(smol.apiKey);
		return {};
	},
});
