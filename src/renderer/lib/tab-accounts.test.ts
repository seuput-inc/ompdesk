import { afterEach, describe, expect, it, vi } from "vitest";
import { askTabAccount, resetTabAccounts, useTabAccounts } from "./tab-accounts";
import { USAGE_POLL_MS } from "./usage-reports";

const globals = globalThis as Record<string, unknown>;

function installRpc(reports: unknown[]) {
	const commandForTab = vi.fn(async () => ({ success: true, data: { reports } }));
	globals.window = { omp: { rpc: { commandForTab } } };
	return commandForTab;
}

afterEach(() => {
	resetTabAccounts();
	delete globals.window;
});

describe("the account an open tab's session runs on", () => {
	it("names the accounts the session is pinned to, and reads a tab at most once per usage interval", async () => {
		const commandForTab = installRpc([
			{ provider: "anthropic", fetchedAt: 0, limits: [], account: "work@example.com", active: true },
			{ provider: "anthropic", fetchedAt: 0, limits: [], account: "home@example.com" },
			{ provider: "openai", fetchedAt: 0, limits: [], account: "work@example.com", active: true },
		]);
		askTabAccount("t1", 1_000);
		await commandForTab.mock.results[0]?.value;
		await Promise.resolve();
		expect(useTabAccounts.getState().accounts.t1).toEqual(["work@example.com"]);
		askTabAccount("t1", 1_000 + USAGE_POLL_MS - 1);
		expect(commandForTab).toHaveBeenCalledTimes(1);
		askTabAccount("t1", 1_000 + USAGE_POLL_MS);
		expect(commandForTab).toHaveBeenCalledTimes(2);
		expect(commandForTab).toHaveBeenCalledWith("t1", { type: "get_usage" });
	});

	it("leaves the tooltip without an account when the read fails", async () => {
		const commandForTab = vi.fn(async () => ({ success: false, error: "offline" }));
		globals.window = { omp: { rpc: { commandForTab } } };
		askTabAccount("t2", 0);
		await commandForTab.mock.results[0]?.value;
		await Promise.resolve();
		expect(useTabAccounts.getState().accounts.t2).toBeUndefined();
	});
});
