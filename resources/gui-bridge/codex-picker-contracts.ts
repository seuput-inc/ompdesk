/** Only the built-in ChatGPT discovery route attaches this account's `/models` provenance.
 * A custom endpoint or protocol using the same provider/model selector is not this route. */
export function codexAccountAccess(row: {
	provider: string;
	api?: string;
	baseUrl?: string;
	headers?: unknown;
	resolveHeaders?: unknown;
	accountAccess?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
	return row.provider === "openai-codex" &&
		row.api === "openai-codex-responses" &&
		row.baseUrl === "https://chatgpt.com/backend-api" &&
		!row.headers &&
		!row.resolveHeaders
		? row.accountAccess
		: undefined;
}
