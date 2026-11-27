import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeHealth, unavailableFeatures } from "./bridge-health";
import { appendRuntimeLogAtPath } from "./runtime-log-core";

function fakeBridge(result: () => Promise<unknown>) {
	const request = vi.fn((_method: string) => result());
	return { bridge: { request: <T>(method: string) => request(method) as Promise<T> }, request };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("unavailableFeatures", () => {
	it("reads distinct feature ids, whether any is core, and ignores malformed entries", () => {
		expect(
			unavailableFeatures({
				ompVersion: "19.0.0",
				unavailable: [
					{ feature: "goalBudget", missing: ["x"] },
					{ feature: "goalBudget" },
					{ feature: 3 },
					null,
					"btw",
				],
			}),
		).toEqual({ features: ["goalBudget"], core: false });
		expect(
			unavailableFeatures({ unavailable: [{ feature: "jobs" }, { feature: "relaunchResume", core: true }] }),
		).toEqual({ features: ["jobs", "relaunchResume"], core: true });
		expect(unavailableFeatures({ unavailable: [] })).toEqual({ features: [], core: false });
		expect(unavailableFeatures(null)).toEqual({ features: [], core: false });
	});
});

describe("BridgeHealth", () => {
	it("probes once per omp version and queues one warning for the first window that takes it", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const notify = vi.fn();
		const health = new BridgeHealth(notify);
		const broken = fakeBridge(async () => ({
			ompVersion: "19.0.0",
			unavailable: [
				{ feature: "goalBudget", missing: ["AgentSession.goalRuntime.onBudgetMutated"] },
				{ feature: "guidedGoal", missing: ["@oh-my-pi/pi-coding-agent/goals/settings"] },
			],
		}));

		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: broken.bridge });
		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: broken.bridge });

		expect(broken.request).toHaveBeenCalledTimes(1);
		expect(broken.request).toHaveBeenCalledWith("capabilities");
		expect(notify).toHaveBeenCalledTimes(1);
		expect(health.take()).toEqual([
			{ kind: "unsupportedOptional", ompVersion: "19.0.0", features: ["goalBudget", "guidedGoal"] },
		]);
		expect(health.take()).toEqual([]);

		// A different omp (after `omp update` + restart) is checked again.
		const healthy = fakeBridge(async () => ({ ompVersion: "19.0.1", unavailable: [] }));
		await health.observe({ connected: true, ompVersion: "19.0.1", bridge: healthy.bridge });
		expect(healthy.request).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(health.take()).toEqual([]);
	});

	it("probes again after an omp update and warns when the new omp dropped a feature the old one had", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const notify = vi.fn();
		const health = new BridgeHealth(notify);
		const before = fakeBridge(async () => ({ ompVersion: "18.8.7", unavailable: [] }));
		await health.observe({ connected: true, ompVersion: "18.8.7", bridge: before.bridge });
		expect(health.take()).toEqual([]);
		expect(health.supports("18.8.7", "goalBudget")).toBe(true);

		// omp updated itself; the tab that restarted on it reports its own version.
		const after = fakeBridge(async () => ({
			ompVersion: "18.9.0",
			unavailable: [{ feature: "goalBudget", missing: ["AgentSession.goalRuntime.onBudgetMutated"] }],
		}));
		await health.observe({ connected: true, ompVersion: "18.9.0", bridge: after.bridge });
		expect(after.request).toHaveBeenCalledWith("capabilities");
		expect(notify).toHaveBeenCalledTimes(1);
		expect(health.take()).toEqual([{ kind: "unsupportedOptional", ompVersion: "18.9.0", features: ["goalBudget"] }]);
		expect(health.supports("18.9.0", "goalBudget")).toBe(false);
		// The old version's answer stays; a second tab on 18.9.0 does not warn twice.
		expect(health.supports("18.8.7", "goalBudget")).toBe(true);
		await health.observe({ connected: true, ompVersion: "18.9.0", bridge: after.bridge });
		expect(after.request).toHaveBeenCalledTimes(1);
	});

	it("answers whether a probed omp version serves a feature, and doesn't know before a probe", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const health = new BridgeHealth(() => {});
		expect(health.supports("18.8.0", "accountRotation")).toBeNull();
		const old = fakeBridge(async () => ({ unavailable: [{ feature: "accountRotation", missing: ["x"] }] }));
		await health.observe({ connected: true, ompVersion: "18.7.0", bridge: old.bridge });
		const current = fakeBridge(async () => ({ unavailable: [] }));
		await health.observe({ connected: true, ompVersion: "18.8.0", bridge: current.bridge });
		expect(health.supports("18.7.0", "accountRotation")).toBe(false);
		expect(health.supports("18.7.0", "goalBudget")).toBe(true);
		expect(health.supports("18.8.0", "accountRotation")).toBe(true);
	});

	it("retries on the next sidecar when the capabilities request itself fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const health = new BridgeHealth(() => {});
		const dropped = fakeBridge(async () => {
			throw new Error("GUI bridge disconnected");
		});
		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: dropped.bridge });
		expect(health.take()).toEqual([]);

		const next = fakeBridge(async () => ({ unavailable: [{ feature: "mcp", missing: ["x"] }] }));
		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: next.bridge });
		expect(next.request).toHaveBeenCalledTimes(1);
		// No version in the result: the sidecar's own omp version stands in.
		expect(health.take()).toEqual([{ kind: "unsupportedOptional", ompVersion: "19.0.0", features: ["mcp"] }]);
	});

	it("reports a bridge that never connected once per version", async () => {
		const notify = vi.fn();
		const health = new BridgeHealth(notify);
		const failure = {
			connected: false,
			ompVersion: "19.0.0",
			error: "did not accept a connection within 3000ms",
		} as const;
		await health.observe(failure);
		await health.observe(failure);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(health.take()).toEqual([
			{ kind: "unavailable", ompVersion: "19.0.0", reason: "did not accept a connection within 3000ms" },
		]);
	});
});

describe("BridgeHealth self-repair", () => {
	const lacking = (version: string) =>
		fakeBridge(async () => ({
			ompVersion: version,
			unavailable: [{ feature: "relaunchResume", missing: ["x"], core: true }],
		}));
	const omp = { processAlive: true };

	it("newest omp still lacks a core capability: one repair attempt, the toast still shows", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const onIncompatible = vi.fn();
		const notify = vi.fn();
		const health = new BridgeHealth(notify, onIncompatible);
		await health.observe({ connected: true, ompVersion: "19.0.1", bridge: lacking("19.0.1").bridge }, omp);
		expect(onIncompatible).toHaveBeenCalledExactlyOnceWith("19.0.1");
		expect(health.take()).toEqual([{ kind: "unsupported", ompVersion: "19.0.1", features: ["relaunchResume"] }]);
	});

	it("an omp that lacks only optional actions is reported, not repaired", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const onIncompatible = vi.fn();
		const health = new BridgeHealth(vi.fn(), onIncompatible);
		const newer = fakeBridge(async () => ({
			ompVersion: "19.1.0",
			unavailable: [{ feature: "abortCompaction", missing: ["AgentSession.abortCompaction"] }],
		}));
		await health.observe({ connected: true, ompVersion: "19.1.0", bridge: newer.bridge }, omp);
		expect(onIncompatible).not.toHaveBeenCalled();
		expect(health.take()).toEqual([
			{ kind: "unsupportedOptional", ompVersion: "19.1.0", features: ["abortCompaction"] },
		]);
		expect(health.supports("19.1.0", "abortCompaction")).toBe(false);
		expect(health.supports("19.1.0", "jobs")).toBe(true);
	});

	it("a second probe of the same version, connected or not, starts no new attempt", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const onIncompatible = vi.fn();
		const health = new BridgeHealth(vi.fn(), onIncompatible);
		await health.observe({ connected: true, ompVersion: "19.0.1", bridge: lacking("19.0.1").bridge }, omp);
		await health.observe({ connected: true, ompVersion: "19.0.1", bridge: lacking("19.0.1").bridge }, omp);
		await health.observe({ connected: false, ompVersion: "19.0.1", error: "x" }, omp);
		expect(onIncompatible).toHaveBeenCalledTimes(1);
		await health.observe({ connected: false, ompVersion: "19.0.2", error: "x" }, omp);
		expect(onIncompatible).toHaveBeenCalledTimes(2);
	});

	it("a healthy omp starts none", async () => {
		const onIncompatible = vi.fn();
		const health = new BridgeHealth(vi.fn(), onIncompatible);
		const ok = fakeBridge(async () => ({ ompVersion: "19.0.2", unavailable: [] }));
		await health.observe({ connected: true, ompVersion: "19.0.2", bridge: ok.bridge }, omp);
		expect(onIncompatible).not.toHaveBeenCalled();
	});

	it("a paired host's incompatible omp is toasted here but never repairs this computer's omp", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const onIncompatible = vi.fn();
		const health = new BridgeHealth(vi.fn(), onIncompatible);
		await health.observe({ connected: true, ompVersion: "19.0.1", bridge: lacking("19.0.1").bridge });
		await health.observe({ connected: false, ompVersion: "19.0.3", error: "x" });
		expect(health.take()).toHaveLength(2);
		expect(onIncompatible).not.toHaveBeenCalled();
	});
});

describe("BridgeHealth record", () => {
	const lacking = fakeBridge(async () => ({
		ompVersion: "19.0.0",
		unavailable: [
			{ feature: "abortCompaction", missing: ["AgentSession.abortCompaction"] },
			{ feature: "jobs", missing: ["@oh-my-pi/pi-coding-agent/modes/view-model/overlays/job-tree#buildJobTree"] },
		],
	}));
	const healthy = fakeBridge(async () => ({ ompVersion: "19.0.1", unavailable: [] }));
	const clock = (start: number) => {
		let now = start;
		return () => now++;
	};

	it("writes one line per omp version this computer runs, however many tabs connect", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const log = vi.fn();
		const health = new BridgeHealth(vi.fn(), () => {}, { log });
		for (let tab = 0; tab < 3; tab++) {
			await health.observe(
				{ connected: true, ompVersion: "19.0.0", bridge: lacking.bridge },
				{ processAlive: true },
			);
		}
		await health.observe({ connected: true, ompVersion: "19.0.1", bridge: healthy.bridge }, { processAlive: true });
		await health.observe({ connected: false, ompVersion: "19.0.2", error: "no socket" }, { processAlive: true });
		await health.observe({ connected: false, ompVersion: "19.0.2", error: "no socket" }, { processAlive: true });
		expect(log.mock.calls.map(([line]) => line)).toEqual([
			{
				source: "bridge-health",
				message: "probed",
				details: {
					ompVersion: "19.0.0",
					ok: false,
					unavailable: [
						{ feature: "abortCompaction", missing: ["AgentSession.abortCompaction"] },
						{
							feature: "jobs",
							missing: ["@oh-my-pi/pi-coding-agent/modes/view-model/overlays/job-tree#buildJobTree"],
						},
					],
					level: "warn",
				},
			},
			{ source: "bridge-health", message: "probed", details: { ompVersion: "19.0.1", ok: true, unavailable: [] } },
			{
				source: "bridge-health",
				message: "unreachable",
				details: { ompVersion: "19.0.2", ok: false, reason: "no socket", level: "warn" },
			},
		]);
	});

	it("keeps and logs nothing for a paired host's omp, and still records the same version run here", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const log = vi.fn();
		const health = new BridgeHealth(vi.fn(), () => {}, { log });
		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: lacking.bridge });
		expect(log).not.toHaveBeenCalled();
		expect(health.report()).toEqual({ results: [] });
		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: lacking.bridge }, { processAlive: true });
		expect(log).toHaveBeenCalledTimes(1);
		expect(health.report().results.map(result => result.ompVersion)).toEqual(["19.0.0"]);
	});

	it("reports the latest result per version, running versions first, counting the omps that still run", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const health = new BridgeHealth(vi.fn(), () => {}, { now: clock(1_000) });
		const first = { processAlive: true };
		const second = { processAlive: true };
		const gone = { processAlive: true };
		await health.observe({ connected: false, ompVersion: "18.22.2", error: "no socket" }, gone);
		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: lacking.bridge }, first);
		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: lacking.bridge }, second);
		await health.observe({ connected: true, ompVersion: "19.0.1", bridge: healthy.bridge }, { processAlive: false });
		gone.processAlive = false;
		expect(health.report()).toEqual({
			results: [
				{
					ompVersion: "19.0.0",
					at: 1_001,
					ok: false,
					running: 2,
					unavailable: [
						{ feature: "abortCompaction", missing: ["AgentSession.abortCompaction"] },
						{
							feature: "jobs",
							missing: ["@oh-my-pi/pi-coding-agent/modes/view-model/overlays/job-tree#buildJobTree"],
						},
					],
				},
				{ ompVersion: "19.0.1", at: 1_002, ok: true, running: 0, unavailable: [] },
				{ ompVersion: "18.22.2", at: 1_000, ok: false, running: 0, unavailable: [], unreachable: "no socket" },
			],
		});
	});

	it("counts an omp under the version it restarted on, not the one it ran before", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const health = new BridgeHealth(vi.fn(), () => {}, { now: clock(1) });
		const tab = { processAlive: true };
		await health.observe({ connected: true, ompVersion: "19.0.0", bridge: lacking.bridge }, tab);
		await health.observe({ connected: true, ompVersion: "19.0.1", bridge: healthy.bridge }, tab);
		expect(health.report().results.map(({ ompVersion, running }) => [ompVersion, running])).toEqual([
			["19.0.1", 1],
			["19.0.0", 0],
		]);
	});

	it("lands in gui-runtime.jsonl with each missing label, healthy and degraded alike", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const dir = mkdtempSync(join(tmpdir(), "ompdesk-bridge-health-"));
		try {
			const file = join(dir, "gui-runtime.jsonl");
			const health = new BridgeHealth(vi.fn(), () => {}, {
				log: report => appendRuntimeLogAtPath(file, report, { appVersion: "1", platform: "darwin", pid: 1 }),
			});
			await health.observe(
				{ connected: true, ompVersion: "19.0.1", bridge: healthy.bridge },
				{ processAlive: true },
			);
			await health.observe(
				{ connected: true, ompVersion: "19.0.0", bridge: lacking.bridge },
				{ processAlive: true },
			);
			const lines = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as { source: string; message: string; details: unknown });
			expect(lines.map(({ source, message, details }) => ({ source, message, details }))).toEqual([
				{
					source: "bridge-health",
					message: "probed",
					details: { ompVersion: "19.0.1", ok: true, unavailable: [] },
				},
				{
					source: "bridge-health",
					message: "probed",
					details: {
						ompVersion: "19.0.0",
						ok: false,
						level: "warn",
						unavailable: [
							{ feature: "abortCompaction", missing: ["AgentSession.abortCompaction"] },
							{
								feature: "jobs",
								missing: ["@oh-my-pi/pi-coding-agent/modes/view-model/overlays/job-tree#buildJobTree"],
							},
						],
					},
				},
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("an omp lacking most features still logs a parseable list, the first whole entries and how many were left out", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const dir = mkdtempSync(join(tmpdir(), "ompdesk-bridge-health-"));
		try {
			const file = join(dir, "gui-runtime.jsonl");
			const health = new BridgeHealth(vi.fn(), () => {}, {
				log: report => appendRuntimeLogAtPath(file, report, { appVersion: "1", platform: "darwin", pid: 1 }),
			});
			const unavailable = Array.from({ length: 120 }, (_, index) => ({
				feature: `feature${index}`,
				missing: [`@oh-my-pi/pi-coding-agent/session/agent-session#AgentSession.method${index}`],
			}));
			const broken = fakeBridge(async () => ({ ompVersion: "20.0.0", unavailable }));
			await health.observe({ connected: true, ompVersion: "20.0.0", bridge: broken.bridge }, { processAlive: true });
			const [line] = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map(
					text =>
						JSON.parse(text) as {
							details: { ok: boolean; unavailable: unknown; unavailableOmitted?: number };
						},
				);
			const logged = line?.details.unavailable;
			expect(line?.details.ok).toBe(false);
			expect(Array.isArray(logged)).toBe(true);
			const kept = logged as typeof unavailable;
			expect(kept.length).toBeGreaterThan(0);
			expect(kept).toEqual(unavailable.slice(0, kept.length));
			expect(line?.details.unavailableOmitted).toBe(unavailable.length - kept.length);
			expect(health.report().results[0]?.unavailable).toHaveLength(unavailable.length);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
