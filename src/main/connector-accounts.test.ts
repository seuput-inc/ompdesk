import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorAccounts, parseBotConnectorsRequest, parseGoogleClientFile } from "./connector-accounts";
import type { SecretBox } from "./secret-files";

const box: SecretBox = {
	available: () => true,
	encrypt: text => Buffer.from(`sealed:${Buffer.from(text).toString("hex")}`),
	decrypt: data => Buffer.from(data.toString().slice(7), "hex").toString(),
};

const CLIENT = JSON.stringify({
	installed: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-client-secret-1" },
});

let dir: string;
beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in connector import tests")));
	dir = mkdtempSync(join(tmpdir(), "ompdesk-connectors-"));
});
afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

function pickFile(text: string) {
	const path = join(dir, "dummy-input");
	writeFileSync(path, text);
	return async () => path;
}

describe("owner-selected connector credentials", () => {
	it("cancel and malformed files do not check or persist credentials", async () => {
		const core = vi.fn(async () => {
			throw new Error("unexpected network operation");
		});
		const accounts = new ConnectorAccounts({ dir, box, core });
		const request = { action: "importSlack", mode: "socket" } as const;
		expect(await accounts.command(request, async () => null)).toEqual({ slack: [], google: [] });
		expect(readdirSync(dir)).toEqual([]);
		const bad = "dummy-not-JSON";
		await expect(accounts.command(request, pickFile(bad))).rejects.toThrow(/^Could not connect the account\./);
		expect(readdirSync(dir)).toEqual(["dummy-input"]);
		expect(core).not.toHaveBeenCalled();
	});

	it("keeps both Slack modes and returns only account metadata", async () => {
		const core = vi.fn(async (method: string) => {
			if (method !== "connectors.slackCheck") throw new Error("unexpected network operation");
			return { team: "Test", teamId: "T123", userId: "U123" };
		});
		const accounts = new ConnectorAccounts({ dir, box, core });
		const botToken = "xoxb-dummy-token";
		const appToken = "xapp-dummy-token";
		const signingSecret = "dummy-signing-secret";
		const first = await accounts.command(
			{ action: "importSlack", mode: "socket" },
			pickFile(JSON.stringify({ botToken, appToken })),
		);
		const id = first.importedId ?? "";
		const second = await accounts.command(
			{ action: "importSlack", mode: "url", id },
			pickFile(JSON.stringify({ signingSecret })),
		);
		expect(second).toEqual({
			importedId: id,
			google: [],
			slack: [
				{
					id,
					team: "Test",
					teamId: "T123",
					botUserId: "U123",
					socketMode: true,
					signingSecret: true,
					needsReentry: false,
				},
			],
		});
		expect(new ConnectorAccounts({ dir, box, core }).slackTokens(id)).toEqual({ botToken, appToken, signingSecret });
	});

	it("returns only the connected Linear id and discards downstream error text", async () => {
		const key = "lin_api_dummy-key";
		const id = "linear-abcdefghijklmnopqrstuvwx";
		const connectLinear = vi.fn(async () => id);
		const accounts = new ConnectorAccounts({ dir, box, core: fakeCore("").core, connectLinear });
		const pick = pickFile(`${key}\n`);
		expect(await accounts.command({ action: "importLinear" }, pick)).toEqual({
			slack: [],
			google: [],
			importedId: id,
		});
		expect(connectLinear).toHaveBeenCalledWith(key);
		connectLinear.mockRejectedValueOnce(new Error(key));
		await expect(accounts.command({ action: "importLinear" }, pick)).rejects.toThrow(
			/^Could not connect the account\. Check the credential file and sign-in, then try again\.$/,
		);
	});
});

/** A core that signs `email` in, and the calls it was asked. */
function fakeCore(email: string) {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	const core = async (method: string, params: object) => {
		calls.push({ method, params: params as Record<string, unknown> });
		if (method === "connectors.googleSignIn")
			return { flow: "f1", url: "https://accounts.google.com/o/oauth2/v2/auth" };
		if (method === "connectors.googleSignInWait") return { refreshToken: "1//refresh-token", email };
		if (method === "connectors.googleToken") return { accessToken: "ya29.access" };
		throw new Error(`unexpected ${method}`);
	};
	return { calls, core };
}

describe("a bot's Google sign-in", () => {
	it("keeps the tokens sealed and out of the state, and reads Gmail with XOAUTH2", async () => {
		const { calls, core } = fakeCore("Ana@Example.com");
		const opened: string[] = [];
		const accounts = new ConnectorAccounts({
			dir,
			box,
			core,
			openExternal: async url => {
				opened.push(url);
			},
		});
		const state = await accounts.command({ action: "signInGoogle" }, pickFile(CLIENT));
		expect(state.google).toEqual([
			{ id: expect.stringMatching(/^google-[0-9a-f]{16}$/), email: "ana@example.com", needsReentry: false },
		]);
		expect(opened).toEqual(["https://accounts.google.com/o/oauth2/v2/auth"]);
		expect(calls[0]?.params).toEqual({
			clientId: "123-abc.apps.googleusercontent.com",
			clientSecret: "GOCSPX-client-secret-1",
		});
		// Nothing a window or the plain file sees carries a secret.
		const plain = [
			JSON.stringify(state),
			readFileSync(join(dir, "bot-connectors.json"), "utf8"),
			...readdirSync(join(dir, "bot-connectors")).map(name =>
				readFileSync(join(dir, "bot-connectors", name), "utf8"),
			),
		].join("\n");
		for (const secret of ["GOCSPX-client-secret-1", "1//refresh-token"]) expect(plain).not.toContain(secret);

		// A relaunch reads it back; the core gets it per use.
		const again = new ConnectorAccounts({ dir, box, core });
		expect(again.googleSign("ana@example.com")).toEqual({
			clientId: "123-abc.apps.googleusercontent.com",
			clientSecret: "GOCSPX-client-secret-1",
			refreshToken: "1//refresh-token",
		});
		expect(await again.gmailMailbox("work")).toBeNull();
		expect(await again.gmailMailbox("google:ana@example.com")).toMatchObject({
			id: "google:ana@example.com",
			address: "ana@example.com",
			connection: {
				host: "imap.gmail.com",
				port: 993,
				login: { username: "ana@example.com", password: "ya29.access", oauth: true },
			},
		});

		// Signing the same account in again keeps its id; removing it forgets it.
		const id = state.google[0]?.id ?? "";
		expect((await again.command({ action: "signInGoogle", id })).google.map(account => account.id)).toEqual([id]);
		expect((await again.command({ action: "removeGoogle", id })).google).toEqual([]);
		expect(() => again.googleSign("ana@example.com")).toThrow(/sign in on the bot's page/);
	});

	it("takes only a Desktop app client file", () => {
		expect(parseGoogleClientFile(CLIENT).clientId).toBe("123-abc.apps.googleusercontent.com");
		expect(() =>
			parseGoogleClientFile(
				JSON.stringify({ web: { client_id: "x.apps.googleusercontent.com", client_secret: "s" } }),
			),
		).toThrow(/Desktop app/);
		expect(() => parseGoogleClientFile("{")).toThrow(/client file/);
		expect(() =>
			parseGoogleClientFile(JSON.stringify({ installed: { client_id: "nope", client_secret: "GOCSPX-x1234567" } })),
		).toThrow(/client file/);
		expect(() => parseBotConnectorsRequest({ action: "signInGoogle", clientFile: CLIENT })).toThrow();
		expect(() => parseBotConnectorsRequest({ action: "importLinear", path: "dummy-file" })).toThrow();
	});
});
