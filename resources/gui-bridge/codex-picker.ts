import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { codexAccountAccess } from "./codex-picker-contracts";

const CODEX = "openai-codex";
const storedKey = new WeakMap<AgentSession["modelRegistry"]["authStorage"], { generation: number; found: boolean }>();

/** Only a sole, identified OAuth route can be disproved by another account's cache. */
export async function pickerAccounts(session: AgentSession, rows: readonly Model[]): Promise<Set<string> | undefined> {
	if (!rows.some(row => codexAccountAccess(row))) return undefined;
	const { authStorage } = session.modelRegistry;
	const [{ getEnvApiKeyName }, { listLogoutAccounts }] = await Promise.all([
		import("./omp/pi-ai"),
		import("./omp/pi-coding-agent/slash-commands/helpers/logout"),
	]);
	const variable = getEnvApiKeyName(CODEX);
	if (!variable || variable in process.env || session.modelRegistry.hasCommandBackedApiKey(CODEX)) return undefined;
	let known = storedKey.get(authStorage);
	if (!known || known.generation !== authStorage.credentials.generation) {
		const stored = await listLogoutAccounts(authStorage, CODEX, session.sessionId);
		known = { generation: authStorage.credentials.generation, found: stored.some(row => row.type === "api_key") };
		storedKey.set(authStorage, known);
	}
	if (known.found || authStorage.keys.source(CODEX)?.kind !== "oauth") return undefined;
	const accounts = authStorage.oauth.accounts(CODEX);
	if (!accounts.length || accounts.some(account => !account.accountId)) return undefined;
	return new Set(accounts.flatMap(account => account.accountId ?? []));
}

export function pickerAvailability(row: Model, accounts: ReadonlySet<string> | undefined) {
	const access = codexAccountAccess(row);
	if (!access || !accounts) return undefined;
	const ids = Object.keys(access);
	if (!ids.length) return undefined;
	return ids.some(id => accounts.has(id)) ? "account-verified" : "account-unverified";
}

const lastAccountSet = new WeakMap<AgentSession["modelRegistry"], string>();

/** Stock's Codex cache key includes the endpoint and client version, not the account set. */
export async function refreshForeignCatalog(
	session: AgentSession,
	alreadyOnline: boolean,
	retry = false,
): Promise<void> {
	const rows = session.getAvailableModels();
	const accounts = await pickerAccounts(session, rows);
	const registry = session.modelRegistry;
	if (!accounts) {
		lastAccountSet.delete(registry);
		return;
	}
	const key = JSON.stringify([...accounts].sort());
	const previous = lastAccountSet.get(registry);
	lastAccountSet.set(registry, key);
	if (alreadyOnline || (key === previous && !retry)) return;
	if (
		(previous !== undefined && previous !== key) ||
		rows.some(row => pickerAvailability(row, accounts) === "account-unverified")
	) {
		await registry.refreshDiscoverableProviders([CODEX], "online");
	}
}
