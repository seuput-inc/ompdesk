/**
 * Optional GitHub token for the update check. The release repo is public, so
 * updates work with none; a token only raises GitHub's rate limit (60 an hour
 * anonymous) and keeps updates working if the repo is private again. The app
 * never bundles a token. Precedence:
 *   1. GH_TOKEN / GITHUB_TOKEN (launch env, then the login shell's exports);
 *   2. `gh auth token` (the GitHub CLI's login);
 *   3. a token pasted in Settings › Updates, encrypted at rest with safeStorage.
 *
 * On macOS any safeStorage call — `isEncryptionAvailable()` included — opens
 * the "ompdesk Safe Storage" keychain item, and because builds without an
 * Apple Team ID bind keychain access to each build's cdhash, macOS asks for
 * the login password again after every update (and blocks the main process while it waits). So the
 * keychain is touched only when a stored token actually exists, or when the
 * user saves one.
 *
 * Under the shell the keychain is read with user interaction disabled: a read that would ask answers
 * `KEYCHAIN_WOULD_ASK`, and nothing touches the keychain again that run. A stored token that cannot be read for that
 * reason is dropped (its file removed, a marker left that Settings › Updates shows), so the env and `gh` sources apply;
 * saving a new one fails with the same reason.
 */

import { safeStorage } from "electron";
import { codedError } from "../shared/ipc-error-codes";
import type { UpdateAccess, UpdateAuthInfo, UpdateTokenSource } from "../shared/ipc-types";
import { KEYCHAIN_WOULD_ASK } from "../shared/keychain";
import { PRODUCT_REPO } from "../shared/product-repo";
import { coreHeld, ghRunner } from "./local/git/exec";
import { writeRuntimeLog } from "./runtime-log";
import { resolveLoginShellEnv } from "./shell-env";
import { safeStorageUnavailableReason, updateHost } from "./shell-host/shell-calls";
import { executableName } from "./spawn";
import { scrubUpdateText } from "./update-log-core";
import { githubGet } from "./update-release";
import { classifyRepoAccess, firstUpdateToken, type ResolvedUpdateToken } from "./updater-state";

export const GITHUB_API_REPO = `https://api.github.com/repos/${PRODUCT_REPO}`;

const GH_TIMEOUT_MS = 5_000;

async function envToken(): Promise<string | undefined> {
	const launch = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	if (launch) return launch;
	const { env } = await resolveLoginShellEnv();
	return env.GH_TOKEN || env.GITHUB_TOKEN;
}

async function ghToken(): Promise<string | undefined> {
	const gh = await ghRunner(executableName("gh", process.platform));
	gh.maxBytes = 1024 * 1024; // execFile's former limit; a truncated credential is unusable.
	return coreHeld<string>(
		"gh.run",
		{ gh, cwd: process.cwd(), args: ["auth", "token", "--hostname", "github.com"], timeoutMs: GH_TIMEOUT_MS },
		GH_TIMEOUT_MS,
	).catch(() => undefined);
}

/** The last read of the saved token failed (shown in Settings › Updates; the ciphertext stays as it is). */
let storedUnreadable = false;

function noteStoredTokenFailure(phase: "file" | "key" | "decrypt", reason: string): void {
	storedUnreadable = true;
	writeRuntimeLog({
		source: "app-update",
		message: "The saved update token could not be read",
		details: { event: "stored-token-read", phase, reason: scrubUpdateText(reason) },
	});
}

async function storedToken(): Promise<string | undefined> {
	let encrypted: Buffer | null;
	try {
		encrypted = await updateHost().readUpdateTokenCiphertext();
		if (encrypted === null) {
			storedUnreadable = false;
			return undefined;
		}
	} catch (error) {
		const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
		noteStoredTokenFailure("file", typeof code === "string" ? code : "unknown");
		return undefined;
	}
	let phase: "key" | "decrypt" = "key";
	try {
		if (safeStorage.isEncryptionAvailable()) {
			phase = "decrypt";
			const token = safeStorage.decryptString(encrypted);
			storedUnreadable = false;
			return token;
		}
		const reason = safeStorageUnavailableReason();
		if (reason !== KEYCHAIN_WOULD_ASK) {
			noteStoredTokenFailure("key", reason ?? "unavailable");
			return undefined;
		}
	} catch {
		noteStoredTokenFailure(phase, phase === "decrypt" ? "ciphertext-rejected" : "keychain-operation-failed");
		return undefined;
	}
	try {
		await updateHost().dropUpdateTokenFile();
	} catch {
		noteStoredTokenFailure("key", "keychain-operation-failed");
		return undefined;
	}
	writeRuntimeLog({
		source: "app-update",
		message: `The saved update token was removed: it cannot be read on this computer (${KEYCHAIN_WOULD_ASK}); GH_TOKEN, GITHUB_TOKEN and the gh login still apply`,
	});
	return undefined;
}

export function resolveUpdateToken(): Promise<ResolvedUpdateToken | undefined> {
	const lookups: [UpdateTokenSource, () => Promise<string | undefined>][] = [
		["env", envToken],
		["gh", ghToken],
		["stored", storedToken],
	];
	return firstUpdateToken(lookups);
}

/** The repository probe's deadline: a connection that never answers reads as a network failure. */
const REPO_ACCESS_TIMEOUT_MS = 10_000;

/** Whether the release repo is readable with `token`, or anonymously without one. */
export async function checkRepoAccess(token: string | undefined): Promise<UpdateAccess> {
	try {
		const answer = await githubGet(GITHUB_API_REPO, {
			...(token ? { token } : {}),
			timeoutMs: REPO_ACCESS_TIMEOUT_MS,
		});
		return classifyRepoAccess(answer.status, answer.rateLimitRemaining === "0");
	} catch {
		return "network";
	}
}

export async function updateAuthInfo(): Promise<UpdateAuthInfo> {
	const resolved = await resolveUpdateToken();
	// After the resolve: a token it just dropped is no longer stored, and says why.
	const file = await updateHost().updateTokenFileStatus();
	return {
		...file,
		source: resolved?.source ?? null,
		// macOS/Windows always have an OS keystore; probing it would prompt (see top).
		canStore: process.platform !== "linux" || safeStorage.isEncryptionAvailable(),
		unreadable: file.hasStoredToken && storedUnreadable,
	};
}

export async function storeUpdateToken(token: string): Promise<void> {
	if (!safeStorage.isEncryptionAvailable()) {
		if (safeStorageUnavailableReason() === KEYCHAIN_WOULD_ASK)
			throw codedError("keychain_would_ask", "macOS would ask for the login password to open the keychain");
		throw codedError("safe_storage_unavailable", "safeStorage encryption is unavailable");
	}
	await updateHost().saveUpdateTokenCiphertext(safeStorage.encryptString(token));
	storedUnreadable = false;
}

export async function clearUpdateToken(): Promise<void> {
	await updateHost().clearUpdateTokenFiles();
	storedUnreadable = false;
}
