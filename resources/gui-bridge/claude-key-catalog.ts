import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ProviderDiscoveryState } from "../../src/shared/rpc-types";
import {
	CLAUDE_API_URL,
	type ClaudeKeyAdditions,
	isClaudeKeyAccount,
	isClaudeKeyProvider,
	offeredClaudeModels,
} from "./claude-key-models";

type Provider = {
	api: string;
	baseUrl: string;
	auth?: string;
	apiKey?: string;
	models?: { id: string }[];
};
type Offers = Map<string, { models: Set<string> | null; fetchedAt: number } | null>;
type Proof = { offers: Offers; partial?: boolean; additions?: ClaudeKeyAdditions };
type Source = { stamp: string; routeIds: string };
const pending = new WeakMap<
	AgentSession,
	Source & { retryKey?: string; result: Promise<ClaudeKeyAdditions | undefined> }
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
	return offered === null ? undefined : (offered?.models?.has(model.id) ?? false);
}

export function keyDiscoveryStates(session: AgentSession): ProviderDiscoveryState[] {
	const states: ProviderDiscoveryState[] = [];
	const offers = verified(session)?.proof.offers;
	if (!offers) return states;
	for (const [provider, offer] of offers) {
		if (!offer) continue;
		const { models, fetchedAt } = offer;
		states.push({
			provider,
			status: models === null ? "unavailable" : models.size ? "ok" : "empty",
			optional: true,
			stale: false,
			fetchedAt,
			models: models ? [...models] : [],
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

async function discover(session: AgentSession, rows: Map<string, Model>, bytes: Buffer, stamp: string): Promise<Proof> {
	const config = Bun.YAML.parse(bytes.toString("utf8")) as { providers?: Record<string, Provider> } | null;
	const offers: Offers = new Map();
	const additions: ClaudeKeyAdditions = { stamp, models: {} };
	await Promise.all(
		Array.from(rows, async ([id, model]) => {
			const entry = config?.providers?.[id];
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
				const models = await offeredClaudeModels(CLAUDE_API_URL, key).catch(() => null);
				offers.set(id, { models: models && new Set(models.keys()), fetchedAt: Date.now() });
				if (!models) return;
				const saved = new Set((entry.models ?? []).map(row => row.id));
				for (const [modelId, name] of models) {
					if (saved.has(modelId)) continue;
					additions.models[id] ??= [];
					additions.models[id].push({ id: modelId, name });
				}
			} catch {
				// Never relay a resolver error or infer an offer from a previous successful lookup.
			}
		}),
	);
	if (
		createHash("sha256")
			.update(await fileContents(session))
			.digest("hex") !== stamp
	)
		throw new Error("Model config changed");
	return { offers, ...(Object.keys(additions.models).length ? { additions } : {}) };
}

/** No dedicated stock rows: no config read, credential resolution, or network. Otherwise verify once per file or explicit refresh. */
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
	let bytes: Buffer;
	try {
		bytes = await fileContents(session);
	} catch {
		last.delete(session);
		pending.delete(session);
		return;
	}
	const stamp = createHash("sha256").update(bytes).digest("hex");
	const routeIds = [...rows.keys()].sort().join(",");
	try {
		const inflight = pending.get(session);
		if (inflight?.stamp === stamp && inflight.routeIds === routeIds) {
			if (!inflight.retryKey || (!force && (!retryKey || inflight.retryKey === retryKey)))
				return await inflight.result;
			await inflight.result;
			return discoverClaudeKeys(session, force, retryKey);
		}
		const previous = verified(session);
		const prior = previous?.stamp === stamp && previous.routeIds === routeIds ? previous.proof : undefined;
		if (!force && !retryKey && prior && !prior.partial) return prior.additions;
		const retained = retryKey && prior ? new Map(prior.offers) : undefined;
		if (retryKey) {
			retained?.delete(retryKey);
			for (const id of rows.keys()) if (id !== retryKey) rows.delete(id);
		}
		if (retained) last.set(session, { stamp, routeIds, proof: { offers: retained, partial: true } });
		else last.delete(session);
		const read = {
			stamp,
			routeIds,
			retryKey,
			result: discover(session, rows, bytes, stamp).then((proof): ClaudeKeyAdditions | undefined => {
				if (pending.get(session) !== read) return;
				if (retryKey) {
					if (retained) {
						for (const [id, offer] of proof.offers) retained.set(id, offer);
						proof.offers = retained;
					}
					proof.partial = !prior || prior.partial;
					if (prior?.additions) {
						const models = { ...prior.additions.models };
						delete models[retryKey];
						Object.assign(models, proof.additions?.models);
						if (Object.keys(models).length) proof.additions = { stamp, models };
					}
				}
				last.set(session, { stamp, routeIds, proof });
				return proof.additions;
			}),
		};
		pending.set(session, read);
		try {
			return await read.result;
		} catch {
			if (pending.get(session) === read) last.delete(session);
			return;
		} finally {
			if (pending.get(session) === read) pending.delete(session);
		}
	} catch {
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
		const current = createHash("sha256")
			.update(await fileContents(session))
			.digest("hex");
		if (current === stamp && last.get(session) === cached && !pending.has(session)) {
			last.set(session, {
				stamp,
				routeIds: cached.routeIds,
				proof: { offers: cached.proof.offers, partial: cached.proof.partial },
			});
		}
	} catch {
		// Keep ordinary providers visible when stock cannot reload the configured key.
	}
}
