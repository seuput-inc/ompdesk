import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ProviderDiscoveryState } from "../../src/shared/rpc-types";
import { isClaudeKeyProvider } from "./claude-key-id";
import { CLAUDE_API_URL, type ClaudeKeyAdditions, isClaudeKeyAccount, offeredClaudeModels } from "./claude-key-models";
import { bindConfirmedReplacement, confirmKeyReceipt, currentKeyGeneration, keyReceipt } from "./claude-key-receipts";

type Provider = {
	api: string;
	baseUrl: string;
	auth?: string;
	apiKey?: string;
	models?: { id: string; contextWindow?: number }[];
};
type Offer = {
	models: Map<string, number | undefined> | null;
	failed: boolean;
	fetchedAt: number;
	binding?: { generation: string; fingerprint: string };
	confirmedAt?: number;
};
type Offers = Map<string, Offer | null>;
type Proof = { offers: Offers; additions?: ClaudeKeyAdditions };
const FRESH_MS = 5 * 60_000;
type Source = { stamp: string; routeIds: string };
const pending = new WeakMap<
	AgentSession,
	Source & { rows: Map<string, Model>; targeted: boolean; result: Promise<ClaudeKeyAdditions | undefined> }
>();
const last = new WeakMap<AgentSession, Source & { proof: Proof; withdrawn?: boolean }>();

function verified(session: AgentSession) {
	const cached = last.get(session);
	return cached?.withdrawn ? undefined : cached;
}

function candidate(model: { provider: string; api: string; baseUrl?: string }): boolean {
	return isClaudeKeyProvider(model.provider) && model.api === "anthropic-messages" && model.baseUrl === CLAUDE_API_URL;
}

/** Unknown proof withholds a plausible key route; a known unrelated provider keeps stock's catalog rows. */
export function keyOffer(
	session: AgentSession,
	model: Pick<Model, "provider" | "api" | "id" | "baseUrl">,
): boolean | undefined {
	if (!candidate(model)) return undefined;
	const offered = verified(session)?.proof.offers.get(model.provider);
	return offered === null ? undefined : !!offered && !offered.failed && offered.models?.has(model.id) === true;
}

export function keyContextWindow(session: AgentSession, model: Pick<Model, "provider" | "id">): number | undefined {
	return verified(session)?.proof.offers.get(model.provider)?.models?.get(model.id);
}

export function keyDiscoveryStates(session: AgentSession): ProviderDiscoveryState[] {
	const states: ProviderDiscoveryState[] = [];
	const offers = verified(session)?.proof.offers;
	if (!offers) return states;
	for (const [provider, offer] of offers) {
		if (!offer) continue;
		const { models, failed, fetchedAt } = offer;
		states.push({
			provider,
			status: failed ? "unavailable" : models?.size ? "ok" : "empty",
			optional: true,
			stale: failed && models !== null,
			fetchedAt,
			...(failed && offer.confirmedAt !== undefined && { lastConfirmedAt: offer.confirmedAt }),
			models: models ? [...models.keys()] : [],
		});
	}
	return states;
}

async function fileContents(session: AgentSession) {
	const dir = session.settings.getAgentDir();
	try {
		return await readFile(join(dir, "models.yml"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return readFile(join(dir, "models.yaml"));
	}
}

function configuredProviders(bytes: Buffer) {
	return (Bun.YAML.parse(bytes.toString("utf8")) as { providers?: Record<string, Provider> } | null)?.providers;
}

async function discover(
	session: AgentSession,
	rows: Map<string, Model>,
	bytes: Buffer,
	stamp: string,
	prior?: Proof,
): Promise<Proof> {
	const config = configuredProviders(bytes);
	const dir = session.settings.getAgentDir();
	const replacements = new Map<string, string>();
	const offers: Offers = new Map(prior?.offers);
	const additions: ClaudeKeyAdditions = { stamp, models: { ...prior?.additions?.models } };
	await Promise.all(
		Array.from(rows, async ([id, model]) => {
			const entry = config?.[id];
			delete additions.models[id];
			offers.set(id, { models: null, failed: true, fetchedAt: Date.now() });
			if (!entry) return;
			if (!isClaudeKeyAccount({ id, api: entry.api, baseUrl: entry.baseUrl, auth: entry.auth })) {
				offers.set(id, null);
				return;
			}
			const value = entry.apiKey;
			// Check only the literal credential the dedicated dialog wrote, not an environment or command-backed secret.
			if (
				typeof value !== "string" ||
				!value ||
				value.startsWith("!") ||
				Object.hasOwn(process.env, value) ||
				typeof session.modelRegistry.hasCommandBackedApiKey !== "function" ||
				typeof session.modelRegistry.getApiKey !== "function" ||
				session.modelRegistry.hasCommandBackedApiKey(id)
			)
				return;
			try {
				const key = await session.modelRegistry.getApiKey(model, session.sessionId);
				if (key !== value) return;
				const fingerprint = createHash("sha256").update(key).digest("hex");
				const receipt = keyReceipt(dir, id, fingerprint);
				if (receipt.replacedGeneration) replacements.set(id, receipt.replacedGeneration);
				const binding = { fingerprint, generation: receipt.generation };
				const lastModels =
					receipt.confirmedAt === undefined ? null : new Map(receipt.models.map(id => [id, undefined]));
				offers.set(id, {
					models: lastModels,
					confirmedAt: receipt.confirmedAt,
					fetchedAt: Date.now(),
					failed: true,
					binding,
				});
				const models = await offeredClaudeModels(CLAUDE_API_URL, key);
				const saved = new Map((entry.models ?? []).map(row => [row.id, row.contextWindow]));
				const contexts = new Map<string, number | undefined>();
				const fetchedAt = Date.now();
				offers.set(id, { models: contexts, failed: false, fetchedAt, binding });
				for (const [modelId, { name, contextWindow }] of models) {
					contexts.set(modelId, contextWindow ?? saved.get(modelId));
					if (saved.has(modelId)) continue;
					additions.models[id] ??= [];
					additions.models[id].push({ id: modelId, name });
				}
			} catch {
				// Do not send resolver or provider error text to the renderer.
				const attempted = offers.get(id);
				if (attempted) attempted.fetchedAt = Date.now();
			}
		}),
	);
	if (
		createHash("sha256")
			.update(await fileContents(session))
			.digest("hex") !== stamp
	)
		throw new Error("Model config changed");
	for (const [id, offer] of offers) {
		const binding = offer?.binding;
		if (!binding || !offer) continue;
		if (rows.has(id) && !offer.failed && offer.models) {
			const ids = [...offer.models.keys()];
			const replaced = replacements.get(id);
			if (replaced) {
				binding.generation =
					bindConfirmedReplacement(dir, id, binding.fingerprint, replaced, offer.fetchedAt, ids) ?? "";
			} else {
				confirmKeyReceipt(dir, id, binding.fingerprint, binding.generation, offer.fetchedAt, ids);
			}
		}
		if (!binding.generation || currentKeyGeneration(dir, id, binding.fingerprint) !== binding.generation) {
			offers.set(id, { models: null, failed: true, fetchedAt: Date.now() });
			delete additions.models[id];
		}
	}
	return { offers, ...(Object.keys(additions.models).length ? { additions } : {}) };
}

/** Join overlapping reads; each key ages from its own last attempt, including failed attempts. */
export async function discoverClaudeKeys(
	session: AgentSession,
	force: boolean,
	retryKey?: string,
): Promise<ClaudeKeyAdditions | undefined> {
	if (retryKey !== undefined && !isClaudeKeyProvider(retryKey)) return;
	const rows = new Map<string, Model>();
	for (const model of session.getAvailableModels()) if (candidate(model)) rows.set(model.provider, model);
	if (!rows.size || typeof session.settings?.getAgentDir !== "function") {
		last.delete(session);
		pending.delete(session);
		return;
	}
	const unavailable = () => {
		last.set(session, {
			stamp: "",
			routeIds: "",
			proof: {
				offers: new Map([...rows.keys()].map(id => [id, { models: null, failed: true, fetchedAt: Date.now() }])),
			},
		});
	};
	let bytes: Buffer;
	try {
		bytes = await fileContents(session);
	} catch {
		unavailable();
		pending.delete(session);
		return;
	}
	const stamp = createHash("sha256").update(bytes).digest("hex");
	const routeIds = [...rows.keys()].sort().join(",");
	try {
		const inflight = pending.get(session);
		if (inflight?.stamp === stamp && inflight.routeIds === routeIds) {
			if (
				retryKey ? inflight.rows.has(retryKey) : !inflight.targeted && (!force || inflight.rows.size === rows.size)
			)
				return await inflight.result;
			await inflight.result;
			return discoverClaudeKeys(session, force, retryKey);
		}
		const previous = verified(session);
		const prior = previous?.stamp === stamp && previous.routeIds === routeIds ? previous.proof : undefined;
		for (const id of rows.keys()) {
			const offer = prior?.offers.get(id);
			const binding = offer?.binding;
			const sameKey =
				!binding ||
				(binding.generation !== "" &&
					currentKeyGeneration(session.settings.getAgentDir(), id, binding.fingerprint) === binding.generation);
			if (
				retryKey
					? id !== retryKey
					: !force && sameKey && (offer === null || (offer && Date.now() - offer.fetchedAt < FRESH_MS))
			)
				rows.delete(id);
		}
		if (!rows.size) return prior?.additions;
		const retained = new Map(prior?.offers);
		for (const id of rows.keys()) retained.delete(id);
		last.set(session, { stamp, routeIds, proof: { offers: retained } });
		const read = {
			stamp,
			routeIds,
			rows,
			targeted: retryKey !== undefined,
			result: discover(session, rows, bytes, stamp, prior).then((proof): ClaudeKeyAdditions | undefined => {
				if (pending.get(session) !== read) return;
				last.set(session, { stamp, routeIds, proof });
				return proof.additions;
			}),
		};
		pending.set(session, read);
		try {
			return await read.result;
		} catch {
			if (pending.get(session) === read) unavailable();
			return;
		} finally {
			if (pending.get(session) === read) pending.delete(session);
		}
	} catch {
		unavailable();
		return;
	}
}

/** Concurrent readers can submit the same additions. A conflict may arrive before the winning save's reply. */
export async function keyAdditionsSaved(session: AgentSession, previous: string, stamp: string | null): Promise<void> {
	const cached = last.get(session);
	if (cached?.stamp !== previous) return;
	cached.withdrawn = true;
	if (!stamp || typeof session.modelRegistry.refresh !== "function") return;
	try {
		await session.modelRegistry.refresh("offline");
		const bytes = await fileContents(session);
		const current = createHash("sha256").update(bytes).digest("hex");
		if (current === stamp && last.get(session) === cached && !pending.has(session)) {
			const config = configuredProviders(bytes);
			for (const [id, offer] of cached.proof.offers) {
				const contexts = offer?.models;
				if (!contexts) continue;
				for (const row of config?.[id]?.models ?? []) {
					if (contexts.has(row.id) && contexts.get(row.id) === undefined) contexts.set(row.id, row.contextWindow);
				}
			}
			last.set(session, {
				stamp,
				routeIds: cached.routeIds,
				proof: { offers: cached.proof.offers },
			});
		}
	} catch {
		// Keep ordinary providers visible when stock cannot reload the configured key.
	}
}
