import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { core, stopCore } from "../core/process";
import { realCoreTimers } from "../core/test-clock";
import { localDay } from "../omp-log-tail";
import { seededDevice, writeWebDevices } from "../web/test-web-devices";
import { PeerQuota } from "./peer-quota";

const dirs: string[] = [];

afterEach(async () => {
	await realCoreTimers();
});

afterAll(async () => {
	await stopCore();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The clock both sides read, set to `date` and held there. */
async function at(date: Date): Promise<void> {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(date);
	await core().call("clock.manual", { nowMs: date.getTime() });
}

type Store = "peers" | "web";

/** A userData whose one device ("laptop") carries `extra` (limits, usage), and the quota over it. */
function rig(store: Store, extra: Record<string, unknown> = {}) {
	const userData = mkdtempSync(join(tmpdir(), "peer-quota-"));
	dirs.push(userData);
	const changed: string[] = [];
	if (store === "peers") {
		const peer = {
			deviceId: "laptop",
			name: "laptop",
			staticPub: "A".repeat(43),
			nodeId: "nLAPTOP",
			login: null,
			pairedAt: 0,
			...extra,
		};
		writeFileSync(join(userData, "remote-peers.json"), JSON.stringify({ v: 1, peers: [peer] }));
	} else {
		writeWebDevices(userData, [{ ...seededDevice({ deviceId: "laptop" }).record, ...extra }]);
	}
	const quota = new PeerQuota(store, userData, id => changed.push(id));
	const file = join(userData, store === "peers" ? "remote-peers.json" : "web-devices.json");
	const onDisk = () => {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, Array<Record<string, unknown>>>;
		return (parsed[store === "peers" ? "peers" : "devices"] ?? [])[0];
	};
	return { quota, changed, onDisk };
}

describe.each(["peers", "web"] as const)("the per-device limit over the %s records", store => {
	it("has no limit until one is set, and counts per local day", async () => {
		await at(new Date(2026, 9, 15, 23, 59));
		const { quota, changed } = rig(store);

		quota.record("laptop", { requests: 1, tokens: 900 });
		expect(quota.view("laptop")).toEqual({ limits: {}, usage: { requests: 1, tokens: 900 } });
		expect(changed).toEqual(["laptop"]);

		expect(quota.setLimits("laptop", { requestsPerDay: 2, tokensPerDay: 1_000 })).toBe(true);
		quota.record("laptop", { tokens: 100 });
		expect(quota.reserve("laptop", 1, "one")).toEqual({ ok: false, refusal: "tokens" });
		quota.setLimits("laptop", { requestsPerDay: 2 });
		expect(quota.view("laptop")?.limits).toEqual({ requestsPerDay: 2 });
		expect(quota.reserve("laptop", 1, "one").ok).toBe(true);
		expect(quota.reserve("laptop", 1, "two")).toEqual({ ok: false, refusal: "requests" });

		// The next day starts from zero.
		await at(new Date(2026, 9, 16, 0, 1));
		expect(quota.view("laptop")?.usage).toEqual({ requests: 0, tokens: 0 });
		expect(() => quota.reserve("laptop", 1, "one")).toThrow("[quota_duplicate]");
		expect(quota.reserve("laptop", 1, "two").ok).toBe(true);
		expect(quota.view("laptop")?.usage).toEqual({ requests: 1, tokens: 0 });
	});

	it("removes the limits with an empty object and knows no unknown device", () => {
		const { quota } = rig(store);
		quota.setLimits("laptop", { tokensPerDay: 0 });
		expect(quota.reserve("laptop", 1, "one")).toEqual({ ok: false, refusal: "tokens" });
		quota.setLimits("laptop", {});
		expect(quota.view("laptop")?.limits).toEqual({});
		expect(quota.reserve("laptop", 1, "one").ok).toBe(true);
		expect(quota.setLimits("nobody", { requestsPerDay: 1 })).toBe(false);
		expect(quota.view("nobody")).toBeNull();
		expect(() => quota.reserve("nobody", 1, "one")).toThrow();
	});

	it("reserves a request when it checks, so requests at limit minus one let exactly one through", async () => {
		await at(new Date(2026, 9, 15, 12, 0));
		const { quota, onDisk } = rig(store, {
			limits: { requestsPerDay: 3 },
			usage: { day: "2026-10-15", requests: 2, tokens: 0 },
		});

		const results = Array.from({ length: 5 }, (_, index) => quota.reserve("laptop", 1, `request-${index}`));
		expect(results.filter(result => result.ok)).toHaveLength(1);
		expect(results.filter(result => !result.ok)).toEqual(Array(4).fill({ ok: false, refusal: "requests" }));
		expect(quota.view("laptop")?.usage.requests).toBe(3);
		await vi.waitFor(() => expect(onDisk()?.usage).toEqual({ day: "2026-10-15", requests: 3, tokens: 0 }));
	});

	it("gives a reserved request back on refund, once", () => {
		const { quota } = rig(store, { limits: { requestsPerDay: 1 } });

		const first = quota.reserve("laptop", 1, "one");
		if (!first.ok) throw new Error("expected a reservation");
		expect(quota.reserve("laptop", 1, "two")).toEqual({ ok: false, refusal: "requests" });
		first.refund();
		first.refund();
		expect(quota.view("laptop")?.usage.requests).toBe(0);
		expect(() => quota.reserve("laptop", 1, "one")).toThrow("[quota_duplicate]");
		expect(quota.reserve("laptop", 1, "two").ok).toBe(true);
		first.refund();
		expect(quota.view("laptop")?.usage.requests).toBe(1);
	});

	it("does not take a request off the new day when a refund lands after midnight", async () => {
		await at(new Date(2026, 9, 15, 23, 59));
		const { quota, onDisk } = rig(store, { limits: { requestsPerDay: 5 } });
		const reservation = quota.reserve("laptop", 1, "one");
		if (!reservation.ok) throw new Error("expected a reservation");
		await at(new Date(2026, 9, 16, 0, 1));
		quota.record("laptop", { requests: 2 });
		reservation.refund();
		expect(quota.view("laptop")?.usage).toEqual({ requests: 2, tokens: 0 });
		await vi.waitFor(() => expect(onDisk()?.usage).toEqual({ day: localDay(new Date()), requests: 2, tokens: 0 }));
	});

	it("counts a weighted reservation, such as a benchmark's model requests, and never lets one cross the limit", () => {
		const { quota } = rig(store, { limits: { requestsPerDay: 10 } });
		expect(quota.reserve("laptop", 40, "large")).toEqual({ ok: false, refusal: "requests" });
		expect(quota.reserve("laptop", 6, "first").ok).toBe(true);
		expect(quota.reserve("laptop", 6, "second")).toEqual({ ok: false, refusal: "requests" });
		expect(quota.reserve("laptop", 4, "third").ok).toBe(true);
		expect(quota.reserve("laptop", 1, "last").ok).toBe(false);
		expect(quota.view("laptop")?.usage.requests).toBe(10);
	});
});
