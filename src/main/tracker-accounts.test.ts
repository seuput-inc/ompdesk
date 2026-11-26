import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrackerList } from "../shared/trackers";
import type { SecretBox } from "./secret-files";
import { TrackerAccounts } from "./tracker-accounts";

const KEY = "lin_api_secretsecretsecret";

const box: SecretBox = {
	available: () => true,
	encrypt: text => Buffer.from(`sealed:${Buffer.from(text).toString("hex")}`),
	decrypt: data => Buffer.from(data.toString().slice(7), "hex").toString(),
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompdesk-trackers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A core that verifies any Linear key and answers lists from `list`, recording what it was sent. */
function fakeCore(
	list: (params: { accounts: { id: string; authorization: string }[] }) => TrackerList | Promise<TrackerList>,
) {
	const calls: { op: string; accounts?: { id: string; authorization: string }[] }[] = [];
	const core = async (params: object) => {
		const sent = params as { op: string; accounts?: { id: string; authorization: string }[] };
		calls.push(sent);
		if (sent.op === "linear_verify")
			return { viewer: { id: "u1", name: "Ada", email: "" }, org: { id: "o1", name: "Acme", urlKey: "acme" } };
		if (sent.op === "list") return list(sent as Parameters<typeof list>[0]);
		throw new Error(`unexpected ${sent.op}`);
	};
	return { calls, core };
}

describe("TrackerAccounts", () => {
	it("keeps the key out of state and trackers.json and hands it to the core only", async () => {
		const { calls, core } = fakeCore(() => ({ items: [], hasMore: false, errors: [] }));
		const accounts = new TrackerAccounts({ dir, box, core, proxyPref: () => undefined });
		const state = await accounts.accounts({ action: "connect", draft: { provider: "linear", apiKey: KEY } });
		const id = state.accounts[0].id;

		expect(state.accounts).toMatchObject([{ provider: "linear", label: "Acme", needsReconnect: false }]);
		expect(JSON.stringify(state)).not.toContain(KEY);
		expect(readFileSync(join(dir, "trackers.json"), "utf8")).not.toContain(KEY);
		for (const file of readdirSync(join(dir, "trackers")))
			expect(readFileSync(join(dir, "trackers", file), "utf8")).not.toContain(KEY);

		// Another run reads the sealed key back for the core.
		const again = new TrackerAccounts({ dir, box, core, proxyPref: () => undefined });
		await again.command({ action: "list", provider: "linear", account: id, preset: "assigned" });
		expect(calls.at(-1)?.accounts?.[0]).toMatchObject({ id, authorization: KEY });
	});

	it("joins two windows' same list into one core read", async () => {
		const pending = Promise.withResolvers<TrackerList>();
		const { calls, core } = fakeCore(() => pending.promise);
		const accounts = new TrackerAccounts({ dir, box, core, proxyPref: () => undefined });
		const { accounts: connected } = await accounts.accounts({
			action: "connect",
			draft: { provider: "linear", apiKey: KEY },
		});
		const request = { action: "list", provider: "linear", account: connected[0].id, preset: "open" } as const;
		const first = accounts.command(request);
		const second = accounts.command(request);
		await Promise.resolve();
		pending.resolve({ items: [], hasMore: false, errors: [] });
		expect(await second).toEqual(await first);
		expect(calls.filter(call => call.op === "list")).toHaveLength(1);
	});

	it("marks an account the service refused as needing a new key", async () => {
		const { core } = fakeCore(params => ({
			items: [],
			hasMore: false,
			errors: [{ accountId: params.accounts[0].id, accountLabel: "Acme", type: "auth", message: "revoked" }],
		}));
		const accounts = new TrackerAccounts({ dir, box, core, proxyPref: () => undefined });
		const { accounts: connected } = await accounts.accounts({
			action: "connect",
			draft: { provider: "linear", apiKey: KEY },
		});
		await accounts.command({ action: "list", provider: "linear", account: "all", preset: "all" });
		expect(accounts.state().accounts[0]).toMatchObject({ id: connected[0].id, needsReconnect: true });
	});
});
