import { createHash } from "node:crypto";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ClaudeApiRoute } from "../../src/shared/rpc-types";
import {
	activePins as active,
	claudeDispatch,
	claudeRouteRefusal,
	DISPATCH_ENTRY,
	journalPin,
	type Pin,
	ROUTE_ENTRY,
	receipt,
} from "./claude-api-route-core";
import { isClaudeKeyProvider } from "./claude-key-id";
import { CLAUDE_API_URL, offeredClaudeModels } from "./claude-key-models";
import { guard } from "./health";
import { createAssistantMessageEventStream } from "./omp/pi-ai";
import { lookup } from "./omp/pi-coding-agent/config/registry";
import { overridable } from "./settings-override";

const attached = new WeakSet<AgentSession>();
const verified = new WeakMap<AgentSession, { provider: string; modelId: string; digest: string }>();
const digestKey = (key: string) => createHash("sha256").update(key).digest("hex");
const changing = new WeakSet<AgentSession>();
const unconfirmed = new WeakMap<AgentSession, string | null>();
const recovery = ["retry.enabled", "retry.modelFallback", "retry.usageAwareFallback"];
const priorOverrides = new WeakMap<object, Map<string, unknown>>();

function officialModel(model: Model | undefined, provider: string, id: string): model is Model {
	return (
		model?.provider === provider &&
		model.id === id &&
		model.api === "anthropic-messages" &&
		model.isOAuth !== true &&
		!model.transport &&
		model.baseUrl?.replace(/\/$/, "") === CLAUDE_API_URL
	);
}

function sync(session: AgentSession, pin = journalPin(session.sessionManager.getBranch())) {
	const previous = active.get(session);
	if (pin) {
		if (!previous) {
			const prior = new Map<string, unknown>();
			for (const id of recovery) {
				const setting = lookup(id);
				if (setting && session.settings.hasRuntimeOverride(setting)) prior.set(id, setting.get(session.settings));
				overridable(id).override(session.settings, false);
			}
			priorOverrides.set(session, prior);
		}
		active.set(session, pin);
	} else if (previous) {
		const prior = priorOverrides.get(session);
		for (const id of recovery) {
			if (prior?.has(id)) overridable(id).override(session.settings, prior.get(id));
			else overridable(id).clearOverride(session.settings);
		}
		priorOverrides.delete(session);
		unconfirmed.delete(session);
		active.delete(session);
	}
}

function attach(session: AgentSession, pin?: Pin) {
	if (!attached.has(session)) {
		const stream = session.agent.streamFn;
		session.agent.streamFn = async function (model, context, options) {
			if (changing.has(session)) throw new Error("Claude API route selection is in progress");
			const pin = active.get(session);
			if (!pin) return stream.call(this, model, context, options);
			if (!officialModel(model, pin.provider, pin.modelId))
				throw new Error("The selected Claude API route is unavailable; no request was sent");
			const transmit = options?.fetch ?? fetch;
			const user =
				session.sessionManager
					.getBranchView()
					.findLast(entry => entry.type === "message" && entry.message.role === "user")?.id ?? null;
			// Pass a value, not stock's rotating auth resolver, to the entire probe ladder and answer.
			const key = await session.modelRegistry.getApiKey(model, session.sessionId);
			if (!key) throw new Error("The selected Claude API key is unavailable");
			const digest = digestKey(key);
			const known = verified.get(session);
			if (known?.digest !== digest || known.provider !== pin.provider || known.modelId !== pin.modelId) {
				if (!(await offeredClaudeModels(model.baseUrl, key)).has(pin.modelId))
					throw new Error("The selected Claude API key no longer offers this model");
				verified.set(session, { provider: pin.provider, modelId: pin.modelId, digest });
			}
			const probing =
				model.thinking?.unverified &&
				options?.reasoning !== undefined &&
				!options.disableReasoning &&
				!options.forceReasoningOff;
			// Six adaptive tiers and one neutral control, then at most six budget tiers.
			const gate = claudeDispatch(probing ? 13 : 0);
			const signal = options?.signal ? AbortSignal.any([options.signal, gate.signal]) : gate.signal;
			let intent: Promise<void> | undefined;
			let attempted = false;
			let refusal: ClaudeApiRoute["refusal"];
			const answerReady = probing ? Promise.withResolvers<void>() : undefined;
			const dispatched = stream.call(this, model, context, {
				...options,
				apiKey: key,
				signal,
				onPayload(...args) {
					gate.answer();
					answerReady?.resolve();
					return options?.onPayload?.(...args);
				},
				fallbacks: [],
				disableServerSideFallback: true,
				fetch: async (input, init) => {
					const url = new URL(input instanceof Request ? input.url : input);
					const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
					const kind = gate.attempt(init?.body);
					if (
						url.origin !== CLAUDE_API_URL ||
						url.pathname !== "/v1/messages" ||
						headers.get("x-api-key") !== key ||
						headers.has("authorization")
					)
						return gate.stop("Claude API dispatch requires the selected API key and official endpoint");
					if (!intent) {
						if (unconfirmed.get(session) === user)
							return gate.stop("The previous Claude API request has no confirmed outcome; send a new prompt");
						unconfirmed.set(session, user);
						session.sessionManager.appendCustomEntry(DISPATCH_ENTRY, {});
						intent = session.sessionManager.flush();
					}
					await intent;
					signal.throwIfAborted();
					const current = active.get(session);
					if (
						current?.provider !== pin.provider ||
						current.modelId !== pin.modelId ||
						!session.modelRegistry.find(pin.provider, pin.modelId)
					)
						return gate.stop("The selected Claude API route changed");
					attempted = true;
					if (kind === "answer") refusal = undefined;
					try {
						const response = await transmit(input, { ...init, redirect: "error" });
						const status = response.status;
						if (status === 400 || status === 402 || status === 429) {
							const body =
								status === 402
									? undefined
									: await response
											.clone()
											.json()
											.catch(() => undefined);
							const classified = claudeRouteRefusal(status, response.headers.get("retry-after"), body);
							if (classified) {
								refusal ??= classified;
								if (kind === "answer" && typeof classified === "object" && classified.kind === "transient") {
									// Only stock's provider loop may resend this payload. It owns the delay, cap and budget.
									gate.retryAnswer(init?.body);
									return response;
								}
								return gate.stop(`Claude API returned HTTP ${status}; automatic replay is disabled`);
							}
							if (kind === "answer") return gate.stop(`Claude API returned HTTP ${status}; no retry was sent`);
						}
						if (kind === "answer" && status >= 500)
							return gate.stop(`Claude API returned HTTP ${status}; automatic replay is disabled`);
						if (kind === "probe" && !response.ok && status !== 400 && status !== 422) {
							return gate.stop(`Claude API thinking probe returned HTTP ${status}; no answer was sent`);
						}
						return response;
					} catch {
						if (gate.signal.aborted) throw gate.signal.reason;
						return gate.stop(
							"The Claude API request failed without a confirmed response; automatic replay is disabled",
						);
					}
				},
			});
			return Promise.resolve(dispatched).then(async response => {
				// A refused probe rejects stock's stream before there is an assistant event to annotate.
				// Wait only for probe resolution, not the answer's first token or completion.
				if (answerReady) {
					try {
						await Promise.race([answerReady.promise, response.result()]);
					} catch {
						if (!attempted || !refusal) return response;
						const terminal = createAssistantMessageEventStream();
						const message = {
							role: "assistant" as const,
							api: model.api,
							provider: model.provider,
							model: model.id,
							content: [],
							stopReason: "error" as const,
							errorMessage: gate.signal.reason.message,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							timestamp: Date.now(),
							claudeApiRoute: { ...receipt(pin), refusal },
						};
						terminal.push({ type: "error", reason: "error", error: message });
						return terminal;
					}
				}
				// The agent loop awaits this same finalized message before journaling and emitting message_end.
				void response.result().then(
					message => {
						if (attempted)
							Object.assign(message, { claudeApiRoute: refusal ? { ...receipt(pin), refusal } : receipt(pin) });
						if (gate.signal.aborted && (message.stopReason === "error" || message.stopReason === "aborted"))
							message.errorMessage = gate.signal.reason.message;
						else if (
							typeof refusal === "object" &&
							refusal.kind === "transient" &&
							message.stopReason === "error"
						)
							message.errorMessage = "Claude API returned HTTP 429";
						if (
							message.stopReason !== "error" &&
							message.stopReason !== "aborted" &&
							message.content.some(
								block => block.type === "toolCall" || (block.type === "text" && block.text.trim()),
							) &&
							unconfirmed.get(session) === user
						)
							unconfirmed.delete(session);
					},
					() => {},
				);
				return response;
			});
		};
		const retry = session.retry;
		session.retry = function (...args) {
			unconfirmed.delete(session);
			return retry.apply(this, args);
		};
		// Stock emits model_changed before this append, and never emits it for same-model reselection.
		const journal = session.sessionManager;
		const append = journal.appendModelChange;
		journal.appendModelChange = function (...args) {
			const id = append.apply(this, args);
			if (active.has(session)) sync(session);
			return id;
		};
		attached.add(session);
	}
	if (pin) sync(session, pin);
}

export function install(pi: ExtensionAPI) {
	const restore = () => {
		const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
		if (!session?.sessionManager?.getBranch) return;
		const pin = journalPin(session.sessionManager.getBranch());
		if (pin) attach(session, pin);
		else if (active.has(session)) sync(session);
	};
	pi.on("session_start", restore);
	pi.on("session_switch", restore);
	pi.on("session_branch", restore);
	pi.on("session_tree", restore);
	restore();
}

type Offer =
	| { provider: string; digest: string; reason?: never }
	| { provider: string; reason: ClaudeApiRoute["skipped"][number]["reason"]; digest?: never };
let pending:
	| { ticket: number; session: AgentSession; leaf: string | null; modelId: string; offers: Offer[] }
	| undefined;
let generation = 0;

export const methods = guard("claudeApiRoute", {
	"claude_api.offers": async (params, env) => {
		const { modelId, providers } = (params ?? {}) as { modelId?: unknown; providers?: unknown };
		if (
			typeof modelId !== "string" ||
			!modelId ||
			!Array.isArray(providers) ||
			!providers.every(p => typeof p === "string" && isClaudeKeyProvider(p))
		) {
			throw new Error("Invalid Claude API model selection");
		}
		const ticket = ++generation;
		pending = undefined;
		const session = env.session();
		const leaf = session.sessionManager.getLeafId();
		await session.modelRegistry.awaitBackgroundRefresh();
		const disabled = lookup("disabledProviders")?.get(session.settings) as string[] | undefined;
		const offers: Offer[] = await Promise.all(
			providers.map(async (provider): Promise<Offer> => {
				if (disabled?.includes(provider)) return { provider, reason: "disabled" };
				const model = session.modelRegistry.find(provider, modelId);
				const source = model ?? session.modelRegistry.getProviderModels(provider)[0];
				if (!source || !officialModel(source, provider, source.id)) return { provider, reason: "unavailable" };
				try {
					const key = await session.modelRegistry.getApiKey(source, session.sessionId);
					if (!key) return { provider, reason: "unavailable" };
					if (!(await offeredClaudeModels(source.baseUrl, key)).has(modelId))
						return { provider, reason: "not-offered" };
					if (!officialModel(model, provider, modelId)) return { provider, reason: "unavailable" };
					return { provider, digest: digestKey(key) };
				} catch {
					return { provider, reason: "unverified" };
				}
			}),
		);
		if (ticket !== generation || env.session() !== session || session.sessionManager.getLeafId() !== leaf)
			throw new Error("Session changed during Claude API key verification");
		pending = { ticket, session, leaf, modelId, offers };
		return {
			ticket,
			eligible: offers.filter(o => !o.reason).map(o => o.provider),
			pinned: active.get(session)?.provider,
		};
	},
	"claude_api.select": async (params, env) => {
		const { provider, ticket } = (params ?? {}) as { provider?: string; ticket?: number };
		const pick = pending;
		const session = env.session();
		if (
			!pick ||
			pick.ticket !== ticket ||
			pick.session !== session ||
			session.sessionManager.getLeafId() !== pick.leaf ||
			session.isStreaming ||
			changing.has(session)
		)
			throw new Error("Claude API selection expired or session is busy");
		pending = undefined;
		const offer = pick.offers.find(o => o.provider === provider && !o.reason);
		if (!provider || !offer?.digest) throw new Error("No verified Claude API key offers this model");
		const model = session.modelRegistry.find(provider, pick.modelId);
		if (!officialModel(model, provider, pick.modelId)) throw new Error("Selected Claude API route changed");
		const pin: Pin = {
			modelId: model.id,
			provider,
			skipped: pick.offers
				.filter(o => o.provider !== provider)
				.map(o => ({
					provider: o.provider,
					reason: o.reason ?? "not-selected",
				})),
		};
		attach(session);
		changing.add(session);
		try {
			await session.setModel(model);
			if (env.session() !== session || !officialModel(session.model, provider, model.id))
				throw new Error("Session model changed during Claude API selection");
			session.sessionManager.appendCustomEntry(ROUTE_ENTRY, pin);
			verified.set(session, { provider, modelId: model.id, digest: offer.digest });
			sync(session);
			await session.sessionManager.ensureOnDisk();
			await session.sessionManager.flush();
		} finally {
			changing.delete(session);
		}
		const { id, name, contextWindow, maxTokens, cost } = model;
		return { provider, id, name, contextWindow, maxTokens, cost, claudeApiRoute: receipt(pin) };
	},
});
