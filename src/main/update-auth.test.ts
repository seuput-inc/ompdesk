/**
 * The stored update token against a macOS keychain that would ask for the login password: the real shim `safeStorage`
 * with a fake key fetch (the "mock keychain") that answers `keychain-would-ask`. Nothing here touches a keychain.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcErrorCode } from "../shared/ipc-error-codes";
import { KEYCHAIN_WOULD_ASK } from "../shared/keychain";
import { createSafeStorage, type KeyFetcher } from "./shell-host/electron/safe-storage";
import { prepareShellPolicyFixture, type ShellPolicyFixture, shellPolicyFixture } from "./shell-policy-test-rig";

const holder = vi.hoisted(() => ({ userData: "", safeStorage: null as unknown, gh: "" }));
let fixture: ShellPolicyFixture;

async function authFileCall<T>(method: string, bytes?: Buffer): Promise<T> {
	const result = await fixture.call<T | { error: string }>(`updateAuth.${method}`, {
		profile: holder.userData,
		bytes: bytes && Array.from(bytes),
	});
	if (result && typeof result === "object" && "error" in result) throw new Error(String(result.error));
	return result as T;
}

vi.mock("electron", () => ({
	app: { getPath: () => holder.userData, getVersion: () => "0.0.0" },
	net: { fetch: vi.fn() },
	updateHost: {
		async readUpdateTokenCiphertext() {
			const bytes = await authFileCall<number[] | null>("read");
			return bytes === null ? null : Buffer.from(bytes);
		},
		updateTokenFileStatus: () => authFileCall("status"),
		saveUpdateTokenCiphertext: (bytes: Buffer) => authFileCall("save", bytes),
		dropUpdateTokenFile: () => authFileCall("drop"),
		clearUpdateTokenFiles: () => authFileCall("clear"),
	},
	get safeStorage() {
		return holder.safeStorage;
	},
}));
vi.mock("./shell-env", () => ({ resolveLoginShellEnv: async () => ({ env: {} }), spawnPath: async () => "" }));
vi.mock("./core/process", () => ({
	core: () => ({
		async call() {
			if (!holder.gh) throw new Error("no gh");
			return { result: holder.gh, bin: null };
		},
	}),
}));

const WORKING_KEY = { kind: "mac-v10", password: Buffer.from("test-password").toString("base64") } as const;

let fetches: number;

function keychain(answer: ReturnType<KeyFetcher>): void {
	fetches = 0;
	holder.safeStorage = createSafeStorage(
		{ kind: "mac-v10-lazy" },
		{
			warn: () => undefined,
			fetchKey: () => {
				fetches += 1;
				return answer;
			},
		},
	);
}

async function authModule() {
	return import("./update-auth");
}

beforeAll(prepareShellPolicyFixture, 120_000);
beforeEach(async () => {
	fixture = await shellPolicyFixture();
	holder.gh = "";
	holder.userData = mkdtempSync(join(tmpdir(), "ompdesk-update-auth-"));
	vi.resetModules();
	delete process.env.GH_TOKEN;
	delete process.env.GITHUB_TOKEN;
});
afterEach(async () => {
	await fixture.close();
	rmSync(holder.userData, { recursive: true, force: true });
	delete process.env.GH_TOKEN;
});

const tokenFile = () => join(holder.userData, "update-token.bin");

describe("a stored update token when the keychain would ask", () => {
	it("is dropped, the file removed and the reason kept, and the keychain is asked once", async () => {
		writeFileSync(tokenFile(), Buffer.from("v10whatever"));
		keychain({ unavailable: KEYCHAIN_WOULD_ASK });
		const { resolveUpdateToken, updateAuthInfo } = await authModule();
		expect(await resolveUpdateToken()).toBeUndefined();
		expect(existsSync(tokenFile())).toBe(false);
		expect(readFileSync(join(holder.userData, "update-token.dropped"), "utf8")).toBe(KEYCHAIN_WOULD_ASK);
		expect(await resolveUpdateToken()).toBeUndefined();
		expect(await updateAuthInfo()).toMatchObject({
			source: null,
			hasStoredToken: false,
			droppedReason: KEYCHAIN_WOULD_ASK,
		});
		expect(fetches).toBe(1);
	});

	it("leaves the keychain alone while GH_TOKEN answers: the stored token is never read", async () => {
		writeFileSync(tokenFile(), Buffer.from("v10whatever"));
		process.env.GH_TOKEN = "from-env";
		keychain({ unavailable: KEYCHAIN_WOULD_ASK });
		const { resolveUpdateToken } = await authModule();
		expect(await resolveUpdateToken()).toEqual({ token: "from-env", source: "env" });
		expect(fetches).toBe(0);
		expect(existsSync(tokenFile())).toBe(true);
	});

	it("uses the gh login before reading the saved token", async () => {
		writeFileSync(tokenFile(), Buffer.from("v10whatever"));
		holder.gh = "fixture-gh\n";
		keychain({ unavailable: KEYCHAIN_WOULD_ASK });
		const { resolveUpdateToken } = await authModule();
		expect(await resolveUpdateToken()).toEqual({ token: "fixture-gh", source: "gh" });
		expect(fetches).toBe(0);
		expect(existsSync(tokenFile())).toBe(true);
	});

	it("reports an unreadable file without probing the keychain; a missing file is quiet", async () => {
		keychain({ unavailable: KEYCHAIN_WOULD_ASK });
		const { resolveUpdateToken } = await authModule();
		const log = join(holder.userData, "logs", "gui-runtime.jsonl");
		expect(await resolveUpdateToken()).toBeUndefined();
		expect(existsSync(log)).toBe(false);
		mkdirSync(tokenFile());
		expect(await resolveUpdateToken()).toBeUndefined();
		expect(readFileSync(log, "utf8")).toContain('"phase":"file"');
		expect(fetches).toBe(0);
	});

	it("uses the environment once the token is dropped", async () => {
		writeFileSync(tokenFile(), Buffer.from("v10whatever"));
		keychain({ unavailable: KEYCHAIN_WOULD_ASK });
		const { resolveUpdateToken } = await authModule();
		expect(await resolveUpdateToken()).toBeUndefined();
		process.env.GH_TOKEN = "later-env";
		expect(await resolveUpdateToken()).toEqual({ token: "later-env", source: "env" });
		expect(fetches).toBe(1);
	});

	it("refuses to save a new one with the same reason, without asking the keychain again", async () => {
		keychain({ unavailable: KEYCHAIN_WOULD_ASK });
		const { storeUpdateToken } = await authModule();
		const failure = await storeUpdateToken("ghp_secret").catch((error: unknown) => error);
		expect(ipcErrorCode(failure)).toBe("keychain_would_ask");
		await storeUpdateToken("ghp_secret").catch(() => undefined);
		expect(fetches).toBe(1);
		expect(existsSync(tokenFile())).toBe(false);
	});

	it("another reason keeps the old code and drops nothing", async () => {
		writeFileSync(tokenFile(), Buffer.from("v10whatever"));
		keychain({ unavailable: "access to the keychain item was denied" });
		const { resolveUpdateToken, storeUpdateToken } = await authModule();
		expect(await resolveUpdateToken()).toBeUndefined();
		expect(existsSync(tokenFile())).toBe(true);
		expect(ipcErrorCode(await storeUpdateToken("x").catch((error: unknown) => error))).toBe(
			"safe_storage_unavailable",
		);
	});

	it("falls back to anonymous access if the dropped-token marker cannot be written", async () => {
		writeFileSync(tokenFile(), Buffer.from("v10whatever"));
		mkdirSync(join(holder.userData, "update-token.dropped"));
		keychain({ unavailable: KEYCHAIN_WOULD_ASK });
		const { resolveUpdateToken } = await authModule();
		expect(await resolveUpdateToken()).toBeUndefined();
		const log = readFileSync(join(holder.userData, "logs", "gui-runtime.jsonl"), "utf8");
		expect(log).toContain("keychain-operation-failed");
		expect(log).not.toContain("The saved update token was removed");
		expect(existsSync(tokenFile())).toBe(false);
	});

	it.each(["key", "decrypt"] as const)(
		"distinguishes a %s failure without deleting the token or exposing it in diagnostics",
		async phase => {
			const token = "private-diagnostic-fixture-token";
			const sealed = createSafeStorage(WORKING_KEY).encryptString(token);
			if (phase === "decrypt") sealed.write("v11", 0, "ascii");
			writeFileSync(tokenFile(), sealed);
			keychain(phase === "key" ? { unavailable: "reader failed (status=7)" } : WORKING_KEY);
			const { resolveUpdateToken, updateAuthInfo } = await authModule();
			expect(await resolveUpdateToken()).toBeUndefined();
			expect(readFileSync(tokenFile())).toEqual(sealed);
			expect(await updateAuthInfo()).toMatchObject({ source: null, hasStoredToken: true, droppedReason: null });
			const text = readFileSync(join(holder.userData, "logs", "gui-runtime.jsonl"), "utf8");
			const records: unknown[] = text
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(records).toContainEqual(
				expect.objectContaining({
					details: expect.objectContaining({ event: "stored-token-read", phase }),
				}),
			);
			expect(text).not.toContain(token);
			expect(text).not.toContain(sealed.toString("base64"));
		},
	);
});

describe("a stored update token when the keychain answers", () => {
	it("saves, reads back, and clears the dropped marker", async () => {
		writeFileSync(join(holder.userData, "update-token.dropped"), KEYCHAIN_WOULD_ASK);
		keychain(WORKING_KEY);
		const { storeUpdateToken, resolveUpdateToken, updateAuthInfo, clearUpdateToken } = await authModule();
		await storeUpdateToken("ghp_secret");
		expect(await resolveUpdateToken()).toEqual({ token: "ghp_secret", source: "stored" });
		expect(await updateAuthInfo()).toMatchObject({ hasStoredToken: true, droppedReason: null });
		expect(fetches).toBe(1);
		await clearUpdateToken();
		expect(await updateAuthInfo()).toMatchObject({ hasStoredToken: false, droppedReason: null });
	});

	it("rejects save and clear if the dropped marker cannot be removed", async () => {
		mkdirSync(join(holder.userData, "update-token.dropped"));
		keychain(WORKING_KEY);
		const { storeUpdateToken, clearUpdateToken, resolveUpdateToken } = await authModule();
		await expect(storeUpdateToken("fixture")).rejects.toThrow();
		expect(await resolveUpdateToken()).toEqual({ token: "fixture", source: "stored" });
		await expect(clearUpdateToken()).rejects.toThrow();
		expect(existsSync(tokenFile())).toBe(false);
	});
});
