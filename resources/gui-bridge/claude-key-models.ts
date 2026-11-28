import { isClaudeKeyProvider } from "./claude-key-id";

export const CLAUDE_API_URL = "https://api.anthropic.com";

export type ClaudeKeyAdditions = { stamp: string; models: Record<string, { id: string; name: string }[]> };

export function isClaudeKeyAccount(config: {
	id: string;
	api: string;
	baseUrl: string;
	auth?: string;
	hasApiKey?: boolean;
}): boolean {
	return (
		isClaudeKeyProvider(config.id) &&
		config.api === "anthropic-messages" &&
		config.baseUrl === CLAUDE_API_URL &&
		config.auth === "apiKey" &&
		config.hasApiKey !== false
	);
}

type OfferedModel = { name: string; contextWindow?: number };

/** Anthropic's read-only entitlement check. Never follow a redirect with a credential, or return a provider's error body. */
export async function offeredClaudeModels(baseUrl: string, apiKey: string): Promise<Map<string, OfferedModel>> {
	const url = new URL("/v1/models", CLAUDE_API_URL);
	const unavailable = "Could not read the models available to this Claude API key";
	if (baseUrl.replace(/\/$/, "") !== url.origin || !apiKey || apiKey.startsWith("!")) throw new Error(unavailable);
	const models = new Map<string, OfferedModel>();
	const cursors = new Set<string>();
	const signal = AbortSignal.timeout(10_000);
	url.searchParams.set("limit", "1000");
	try {
		for (;;) {
			const response = await fetch(url, {
				headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
				redirect: "error",
				signal,
			});
			if (!response.ok) throw new Error();
			const page = await response.json();
			if (!Array.isArray(page?.data) || typeof page.has_more !== "boolean") throw new Error();
			for (const row of page.data) {
				if (typeof row?.id !== "string" || !row.id.trim()) throw new Error();
				const name = typeof row.display_name === "string" && row.display_name ? row.display_name : row.id;
				if (row.id.includes(apiKey) || name.includes(apiKey)) throw new Error();
				const limit = row.max_input_tokens;
				models.set(row.id, { name, ...(Number.isSafeInteger(limit) && limit > 0 && { contextWindow: limit }) });
			}
			if (!page.has_more) break;
			if (
				typeof page.last_id !== "string" ||
				!page.last_id ||
				page.last_id.includes(apiKey) ||
				cursors.has(page.last_id)
			) {
				throw new Error();
			}
			cursors.add(page.last_id);
			url.searchParams.set("after_id", page.last_id);
		}
	} catch {
		// Even a local fetch exception can quote an invalid header value.
		throw new Error(unavailable);
	}
	return models;
}
