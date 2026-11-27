import { describe, expect, it } from "vitest";
import type { UsageReport } from "../../../../shared/rpc-types";
import { usageAccountGroups, usageWindowLimits } from "./usage-groups";

describe("usageAccountGroups", () => {
	const windows = (provider: string) => [
		{ id: `${provider}:5h`, label: "5h", usedFraction: 0.15, windowId: "5h" },
		{ id: `${provider}:7d:fable`, label: "Claude 7 Day (Fable)", usedFraction: 0.39, windowId: "7d" },
	];
	const report = (provider: string, account: string, patch: Partial<UsageReport> = {}): UsageReport => ({
		provider,
		account,
		fetchedAt: 0,
		limits: windows(provider),
		...patch,
	});

	it("groups measured accounts and leaves out an account without windows or credits", () => {
		const reports = [
			report("openai-codex", "z@x.com"),
			report("anthropic", "b@x.com"),
			report("openrouter", "key", { limits: [] }),
			report("anthropic", "a@x.com"),
			report("openai-codex", "y@x.com"),
		];
		const groups = usageAccountGroups(reports, null);
		expect(groups.map(group => group.provider)).toEqual(["anthropic", "openai-codex"]);
		expect(groups.map(group => group.accounts.map(entry => entry.report.account))).toEqual([
			["a@x.com", "b@x.com"],
			["y@x.com", "z@x.com"],
		]);
	});

	it("lists a balance without windows in the detail, not the percentage summary", () => {
		const balance = report("factory-droid", "lab@example.com", {
			limits: [{ id: "factory-droid:extra-balance", label: "Balance", used: 0, limit: 12 }],
			credits: { kind: "balance", limitId: "factory-droid:extra-balance", remaining: 12, unit: "usd" },
		});
		const empty = report("factory-droid", "empty@example.com", { limits: [] });
		expect(usageAccountGroups([empty, balance], null)[0]?.accounts.map(entry => entry.report)).toEqual([balance]);
		expect(usageAccountGroups([empty, balance], null, false)).toEqual([]);
	});

	it("keeps quota windows beside a reported credit limit", () => {
		const quota = windows("anthropic");
		const mixed = report("anthropic", "team@example.com", {
			limits: [...quota, { id: "anthropic:extra", label: "Extra usage", used: 9, limit: 10 }],
			credits: { kind: "monthlyCap", limitId: "anthropic:extra", remaining: 1, limit: 10, unit: "usd" },
		});
		expect(usageWindowLimits(mixed)).toEqual(quota);
		expect(usageAccountGroups([mixed], null, false)[0]?.accounts[0]?.report).toBe(mixed);
	});

	it("keeps a fixed order by address and marks the session's own account without moving it", () => {
		const reports = [report("anthropic", "b@x.com", { active: true }), report("anthropic", "a@x.com")];
		const [group] = usageAccountGroups(reports, "anthropic");
		expect(group?.accounts.map(entry => [entry.report.account, entry.inUse])).toEqual([
			["a@x.com", false],
			["b@x.com", true],
		]);
	});

	it("puts the provider this tab uses, or holds the session's account, first", () => {
		const reports = [report("anthropic", "a@x.com"), report("openai-codex", "c@x.com")];
		const used = usageAccountGroups(reports, "openai-codex");
		expect(used.map(group => group.provider)).toEqual(["openai-codex", "anthropic"]);
		const pinned = [report("anthropic", "a@x.com"), report("openai-codex", "c@x.com", { active: true })];
		expect(usageAccountGroups(pinned, null).map(group => [group.provider, group.inUse])).toEqual([
			["openai-codex", true],
			["anthropic", false],
		]);
	});
});
