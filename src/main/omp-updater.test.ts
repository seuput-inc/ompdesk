import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { IPC_COMMANDS } from "../shared/ipc-types";
import type { OmpCompatHolding } from "../shared/omp-compat";
import ompTested from "../shared/omp-tested.json";
import type { OmpUpdatedNotice, OmpUpdateState } from "../shared/omp-update";
import { type OmpUpdateLogStep, OmpUpdater, type OmpUpdaterDeps, registerOmpUpdateIpc } from "./omp-updater";
import { OmpUpdateStateSchema } from "./remote/app-protocol";
import type { OmpUpdateOutcome } from "./setup/service";
import { CHECK_INTERVAL_MS, MAX_CHECK_INTERVAL_MS } from "./update-scheduler";
import { type IpcCaller, IpcRegistry } from "./web/ipc-registry";

const HOUR = 60 * 60 * 1000;

/** The omp the harness's OMPdesk was tested with, so the cases below hold whatever omp-tested.json names. */
const TESTED = "18.22.2";

interface Harness {
	updater: OmpUpdater;
	calls: string[];
	states: OmpUpdateState[];
	notices: OmpUpdatedNotice[];
	/** Every runtime-log line, in order: its step and details. */
	logs: [OmpUpdateLogStep, Record<string, unknown>][];
	fetchLatest: Mock<() => Promise<string>>;
	compat: Mock<OmpUpdaterDeps["compat"]>;
	update: Mock<OmpUpdaterDeps["update"]>;
	set: {
		latest: string;
		/** This release's verified list; `latest` (the default) verifies whatever the registry calls newest. */
		verified: string[] | "latest";
		holding: OmpCompatHolding | null;
		installed: string | null;
		enabled: boolean;
		outcome: OmpUpdateOutcome;
	};
}

/**
 * An updater over fakes; every dependency call is logged in order in `calls` (an install that may only run as a
 * named version reads `update <version> exact`). `tested: null` leaves the release's own tested omp.
 */
function harness(
	options: { scheduled?: boolean; enabled?: boolean; installed?: string | null; tested?: string | null } = {},
): Harness {
	const calls: string[] = [];
	const set: Harness["set"] = {
		latest: "18.9.0",
		verified: "latest",
		holding: null,
		installed: options.installed === undefined ? "18.8.7" : options.installed,
		enabled: options.enabled ?? true,
		outcome: { kind: "updated", version: "18.9.0" },
	};
	const states: OmpUpdateState[] = [];
	const notices: OmpUpdatedNotice[] = [];
	const logs: Harness["logs"] = [];
	const fetchLatest = vi.fn(async () => {
		calls.push("fetch");
		return set.latest;
	});
	const compat = vi.fn<OmpUpdaterDeps["compat"]>(async () => ({
		verified: set.verified === "latest" ? [set.latest] : set.verified,
		holding: set.holding,
	}));
	const update = vi.fn<OmpUpdaterDeps["update"]>(async (target, beforeInstall, exactOnly) => {
		calls.push(exactOnly ? `update ${target} exact` : `update ${target}`);
		await beforeInstall();
		if (set.outcome.kind === "updated") set.installed = set.outcome.version;
		return set.outcome;
	});
	const updater = new OmpUpdater({
		scheduled: options.scheduled ?? true,
		enabled: () => set.enabled,
		fetchLatest,
		compat,
		installed: () => set.installed,
		update,
		releaseHelpers: async () => {
			calls.push("release");
		},
		resume: async updated => {
			calls.push(`resume ${updated}`);
		},
		onState: state => states.push(state),
		onUpdated: notice => {
			calls.push(`toast ${notice.version}`);
			notices.push(notice);
		},
		log: (step, details) => logs.push([step, details]),
		...(options.tested === null ? {} : { tested: options.tested ?? TESTED }),
		now: () => Date.now(),
	});
	return { updater, calls, states, notices, logs, fetchLatest, compat, update, set };
}

describe("OmpUpdater", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("checks at launch, installs a newer omp without a click, then checks again every few hours", async () => {
		const h = harness();
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		// Helpers stop right before the installer starts (inside update), come back after it, then the one toast. A pass
		// nobody asked for installs by name only (`exact`), never through stock's own `omp update`.
		expect(h.calls).toEqual(["fetch", "update 18.9.0 exact", "release", "resume true", "toast 18.9.0"]);
		expect(h.updater.state()).toMatchObject({
			phase: "idle",
			installed: "18.9.0",
			latest: "18.9.0",
			updatedTo: "18.9.0",
			failure: null,
		});
		expect(h.states.map(state => state.phase)).toContain("updating");
		h.calls.length = 0;
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
		expect(h.calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		// Up to date: it only asks the registry.
		expect(h.calls).toEqual(["fetch"]);
		expect(h.update).toHaveBeenCalledTimes(1);
		h.updater.dispose();
	});

	it("installs nothing when the registry's latest is not newer than the installed omp", async () => {
		const h = harness({ installed: "18.11.0" });
		h.set.latest = "18.9.0";
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual(["fetch"]);
		expect(h.updater.state()).toMatchObject({ latest: "18.9.0", installed: "18.11.0", failure: null });
		h.updater.dispose();
	});

	it("names the omp this release was tested with, and a paired device reads it from the host's state", () => {
		const h = harness({ tested: null });
		expect(OmpUpdateStateSchema.parse(h.updater.state()).tested).toBe(ompTested.version);
		// A host whose OMPdesk predates the field still parses: its row just names no tested omp.
		const { tested: _, ...older } = h.updater.state();
		expect(OmpUpdateStateSchema.parse(older).tested).toBeUndefined();
		h.updater.dispose();
	});

	it("treats a canary of the installed release as not newer, and installs a canary of a newer release only when asked", async () => {
		const same = harness({ installed: "18.9.0" });
		same.set.latest = "18.9.0-canary.3";
		same.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(same.calls).toEqual(["fetch"]);
		same.updater.dispose();
		// The verified list names exact releases only, so a canary is held whatever a list says, until a person asks.
		const newer = harness({ installed: "18.8.7" });
		newer.set.latest = "18.9.0-canary.3";
		newer.set.outcome = { kind: "updated", version: "18.9.0-canary.3" };
		newer.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(newer.update).not.toHaveBeenCalled();
		expect(newer.updater.state().held).toEqual({ version: "18.9.0-canary.3", reason: "verifying" });
		await newer.updater.updateNow();
		expect(newer.calls.at(-4)).toBe("update 18.9.0-canary.3");
		newer.updater.dispose();
	});

	it("leaves a missing omp to machine setup: no check (stock's needs an omp to run), no failure", async () => {
		const h = harness({ installed: null });
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual([]);
		expect(h.updater.state()).toMatchObject({ phase: "idle", failure: null, latest: null });
		h.updater.dispose();
	});

	it("keeps the registry error as the reason, backs off 4 h → 8 h → 16 h → 24 h, and resets after a good check", async () => {
		const h = harness({ installed: "18.9.0" });
		h.fetchLatest.mockRejectedValue(new Error("getaddrinfo ENOTFOUND registry.npmjs.org"));
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.updater.state().failure).toEqual({
			reason: "check",
			detail: "getaddrinfo ENOTFOUND registry.npmjs.org",
		});
		expect(h.fetchLatest).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(8 * HOUR - 1);
		expect(h.fetchLatest).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.fetchLatest).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(16 * HOUR);
		expect(h.fetchLatest).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS);
		expect(h.fetchLatest).toHaveBeenCalledTimes(4);
		// The network is back: the failure clears and the next check is a normal interval away.
		h.fetchLatest.mockImplementation(async () => "18.9.0");
		await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS);
		expect(h.fetchLatest).toHaveBeenCalledTimes(5);
		expect(h.updater.state().failure).toBeNull();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.fetchLatest).toHaveBeenCalledTimes(6);
		h.updater.dispose();
	});

	it("keeps a failed install's reason in the state, brings the helpers back on the old omp and retries on the next check", async () => {
		const h = harness();
		h.set.outcome = { kind: "failed", failure: { reason: "install", detail: "exit 1 — EBUSY" } };
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual(["fetch", "update 18.9.0 exact", "release", "resume false"]);
		expect(h.notices).toEqual([]);
		expect(h.updater.state()).toMatchObject({
			phase: "idle",
			installed: "18.8.7",
			updatedTo: null,
			failure: { reason: "install", detail: "exit 1 — EBUSY" },
		});
		// The reason stays until a later attempt succeeds.
		h.calls.length = 0;
		h.set.outcome = { kind: "updated", version: "18.9.0" };
		await vi.advanceTimersByTimeAsync(8 * HOUR);
		expect(h.calls).toEqual(["fetch", "update 18.9.0 exact", "release", "resume true", "toast 18.9.0"]);
		expect(h.updater.state().failure).toBeNull();
		h.updater.dispose();
	});

	it("skipped (omp went missing meanwhile) leaves no failure and no toast; helpers stay if never released", async () => {
		const h = harness();
		h.set.outcome = { kind: "skipped" };
		h.update.mockImplementation(async target => {
			h.calls.push(`update ${target}`);
			return { kind: "skipped" };
		});
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual(["fetch", "update 18.9.0"]);
		expect(h.updater.state().failure).toBeNull();
		h.updater.dispose();
	});

	it("does nothing on a timer while the pref is off, but Update now still checks and installs", async () => {
		const h = harness({ enabled: false });
		h.updater.start();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
		expect(h.calls).toEqual([]);
		expect(h.updater.state().enabled).toBe(false);
		await h.updater.updateNow();
		expect(h.calls).toEqual(["fetch", "update 18.9.0", "release", "resume true", "toast 18.9.0"]);
		h.updater.dispose();
	});

	it("turning the pref on checks right away; turning it off stops the timer's checks", async () => {
		const h = harness({ enabled: false, installed: "18.9.0" });
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.fetchLatest).not.toHaveBeenCalled();
		h.set.enabled = true;
		h.updater.prefChanged();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.fetchLatest).toHaveBeenCalledTimes(1);
		h.set.enabled = false;
		h.updater.prefChanged();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
		expect(h.fetchLatest).toHaveBeenCalledTimes(1);
		h.updater.dispose();
	});

	it("never checks on its own in a launch that does not schedule (dev, tests); Update now still works", async () => {
		const h = harness({ scheduled: false });
		h.updater.start();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
		expect(h.calls).toEqual([]);
		expect(h.updater.state().scheduled).toBe(false);
		await h.updater.updateNow();
		expect(h.update).toHaveBeenCalledTimes(1);
		h.updater.dispose();
	});

	it("one run at a time: Update now during a check joins it", async () => {
		const h = harness({ installed: "18.9.0" });
		const gate = Promise.withResolvers<string>();
		h.fetchLatest.mockImplementationOnce(() => gate.promise);
		h.updater.start();
		const joined = h.updater.updateNow();
		gate.resolve("18.9.0");
		await joined;
		await vi.advanceTimersByTimeAsync(0);
		expect(h.fetchLatest).toHaveBeenCalledTimes(1);
		h.updater.dispose();
	});

	it("never runs after dispose", async () => {
		const h = harness();
		h.updater.dispose();
		h.updater.start();
		await h.updater.updateNow();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.calls).toEqual([]);
	});

	it("starts nothing after a quit that lands during an install: no resume, no toast, helpers stay down", async () => {
		const h = harness();
		let release: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		h.update.mockImplementation(async (target, beforeInstall) => {
			h.calls.push(`update ${target}`);
			await beforeInstall();
			await gate;
			return { kind: "updated", version: "18.9.0" };
		});
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual(["fetch", "update 18.9.0", "release"]);

		// Quit: the setup service is cancelled and the install returns while the app tears down.
		h.updater.dispose();
		release();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
		expect(h.calls).toEqual(["fetch", "update 18.9.0", "release"]);
		expect(h.notices).toEqual([]);
	});

	it("does not resume the helpers after a failed install that lands once disposed", async () => {
		const h = harness();
		let release: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		h.update.mockImplementation(async (target, beforeInstall) => {
			h.calls.push(`update ${target}`);
			await beforeInstall();
			await gate;
			return { kind: "failed", failure: { reason: "cancelled" } };
		});
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		h.updater.dispose();
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).not.toContain("resume false");
	});

	it("keeps checking after a throw in the update notice (a window that was destroyed meanwhile)", async () => {
		const h = harness();
		let throws = true;
		const updater = new OmpUpdater({
			scheduled: true,
			enabled: () => true,
			fetchLatest: async () => {
				h.calls.push("fetch");
				return h.set.latest;
			},
			compat: async () => ({ verified: [h.set.latest], holding: null }),
			installed: () => h.set.installed,
			update: async target => {
				h.calls.push(`update ${target}`);
				h.set.installed = target;
				return { kind: "updated", version: target };
			},
			releaseHelpers: async () => {},
			resume: async () => {},
			onState: () => {},
			log: () => {},
			tested: TESTED,
			onUpdated: () => {
				if (throws) throw new Error("Object has been destroyed");
			},
		});
		updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual(["fetch", "update 18.9.0"]);

		throws = false;
		h.set.latest = "18.10.0";
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.calls).toEqual(["fetch", "update 18.9.0", "fetch", "update 18.10.0"]);
		updater.dispose();
	});

	it("Update now starts its check within the call: the phase is checking before anything is awaited", async () => {
		const h = harness({ installed: "18.9.0" });
		const run = h.updater.updateNow();
		expect(h.updater.state().phase).toBe("checking");
		await run;
		expect(h.updater.state().phase).toBe("idle");
		h.updater.dispose();
	});

	it("a cancelled install backs off like any other failure", async () => {
		const h = harness();
		h.set.outcome = { kind: "failed", failure: { reason: "cancelled" } };
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.update).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.update).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.update).toHaveBeenCalledTimes(2);
		h.updater.dispose();
	});

	it("an install that was skipped keeps the back-off of the failures before it", async () => {
		const h = harness();
		h.fetchLatest.mockRejectedValueOnce(new Error("offline"));
		h.update.mockImplementation(async target => {
			h.calls.push(`update ${target}`);
			return { kind: "skipped" };
		});
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(8 * HOUR);
		// The rejected fetch logs nothing: only its retry and the skipped install show.
		expect(h.calls).toEqual(["fetch", "update 18.9.0"]);
		expect(h.fetchLatest).toHaveBeenCalledTimes(2);
		// Still one failure in a row: 8 h again, not 4 h.
		await vi.advanceTimersByTimeAsync(8 * HOUR - 1);
		expect(h.fetchLatest).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.fetchLatest).toHaveBeenCalledTimes(3);
		h.updater.dispose();
	});

	it("a pref change checks now and restarts the timer from there; during a check, or before start, it starts none", async () => {
		const h = harness({ installed: "18.9.0" });
		h.updater.prefChanged();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.fetchLatest).not.toHaveBeenCalled();
		expect(h.states).toHaveLength(1);
		h.updater.start();
		await vi.advanceTimersByTimeAsync(HOUR);
		expect(h.fetchLatest).toHaveBeenCalledTimes(1);
		h.updater.prefChanged();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.fetchLatest).toHaveBeenCalledTimes(2);
		// The launch timer (due at 4 h) is gone: the next check is 4 h after the pref change.
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
		expect(h.fetchLatest).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.fetchLatest).toHaveBeenCalledTimes(3);
		const gate = Promise.withResolvers<string>();
		h.fetchLatest.mockImplementationOnce(() => gate.promise);
		const running = h.updater.updateNow();
		h.updater.prefChanged();
		gate.resolve("18.9.0");
		await running;
		await vi.advanceTimersByTimeAsync(0);
		expect(h.fetchLatest).toHaveBeenCalledTimes(4);
		// The timer still counts from the last scheduled check.
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.fetchLatest).toHaveBeenCalledTimes(5);
		h.updater.dispose();
	});
});

describe("OmpUpdater and the verified list (19 Nov 2026: omp 19.0.0 installed itself on an OMPdesk tested with 18)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const VERIFYING = { version: "19.0.0", reason: "verifying" } as const;
	const SINCE = "2026-11-19T00:18:00.000Z";

	it("a scheduled check that finds an omp runners have not verified installs nothing and says it is being verified", async () => {
		const h = harness({ installed: "18.22.2" });
		h.set.latest = "19.0.0";
		h.set.verified = [];
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.update).not.toHaveBeenCalled();
		expect(h.updater.state()).toMatchObject({
			phase: "idle",
			installed: "18.22.2",
			latest: "19.0.0",
			held: VERIFYING,
			failure: null,
			updatedTo: null,
		});
		expect(h.notices).toEqual([]);
		// Holding is no failure: the next check is one normal interval away, and it holds again.
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.fetchLatest).toHaveBeenCalledTimes(2);
		expect(h.update).not.toHaveBeenCalled();
		const checked = { installed: "18.22.2", latest: "19.0.0", tested: TESTED, verified: null };
		expect(h.logs).toEqual([
			["checked", { path: "launch", ...checked }],
			["held", { path: "launch", installed: "18.22.2", ...VERIFYING }],
			["checked", { path: "scheduled", ...checked }],
			["held", { path: "scheduled", installed: "18.22.2", ...VERIFYING }],
		]);
		h.updater.dispose();
	});

	it("once runners verified it, the next check installs it, whatever its major", async () => {
		const h = harness({ installed: "18.22.2" });
		h.set.latest = "19.0.0";
		h.set.verified = [];
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.update).not.toHaveBeenCalled();
		h.set.verified = ["19.0.0"];
		h.set.outcome = { kind: "updated", version: "19.0.0" };
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.calls).toEqual(["fetch", "fetch", "update 19.0.0 exact", "release", "resume true", "toast 19.0.0"]);
		expect(h.updater.state()).toMatchObject({ installed: "19.0.0", held: null, verified: ["19.0.0"] });
		expect(h.logs.slice(-3)).toEqual([
			["checked", { path: "scheduled", installed: "18.22.2", latest: "19.0.0", tested: TESTED, verified: "19.0.0" }],
			["started", { path: "scheduled", from: "18.22.2", target: "19.0.0" }],
			["finished", { path: "scheduled", from: "18.22.2", target: "19.0.0", version: "19.0.0" }],
		]);
		h.updater.dispose();
	});

	it("an omp runners failed is held as failed, with when they first failed it", async () => {
		const h = harness({ installed: "18.22.2" });
		h.set.latest = "19.0.0";
		h.set.verified = [];
		h.set.holding = { version: "19.0.0", since: SINCE, issue: 41 };
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.update).not.toHaveBeenCalled();
		expect(h.updater.state().held).toEqual({ version: "19.0.0", reason: "failed", since: SINCE });
		expect(h.logs.at(-1)).toEqual([
			"held",
			{ path: "launch", installed: "18.22.2", version: "19.0.0", reason: "failed" },
		]);
		h.updater.dispose();
	});

	it("while the newest is held, a check installs the newest verified omp below it, by name only", async () => {
		const h = harness({ installed: "18.22.0" });
		h.set.latest = "19.0.1";
		h.set.verified = ["18.22.2", "19.0.0"];
		h.set.outcome = { kind: "updated", version: "19.0.0" };
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		// `exact`: stock `omp update` would install 19.0.1, so only an install that names 19.0.0 may run.
		expect(h.calls).toEqual(["fetch", "update 19.0.0 exact", "release", "resume true", "toast 19.0.0"]);
		expect(h.updater.state()).toMatchObject({
			installed: "19.0.0",
			held: { version: "19.0.1", reason: "verifying" },
		});
		expect(h.logs.map(([step]) => step)).toEqual(["checked", "held", "started", "finished"]);
		h.updater.dispose();
	});

	it("with nothing verified for this release yet, a check brings omp up to the tested omp, by name only", async () => {
		const h = harness({ installed: "18.20.0" });
		h.set.latest = "19.0.0";
		h.set.verified = [];
		h.set.outcome = { kind: "updated", version: TESTED };
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual(["fetch", `update ${TESTED} exact`, "release", "resume true", `toast ${TESTED}`]);
		expect(h.updater.state().held).toEqual(VERIFYING);
		h.updater.dispose();
	});

	it("never steps omp down, and never installs a verified omp the registry does not offer yet", async () => {
		const h = harness({ installed: "19.0.0" });
		h.set.latest = "19.0.0";
		h.set.verified = ["18.22.2"];
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.update).not.toHaveBeenCalled();
		expect(h.updater.state().held).toBeNull();
		// A list that names a version newer than the registry's newest (another registry, a mirror behind) waits.
		h.set.verified = ["19.0.0", "19.1.0"];
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.update).not.toHaveBeenCalled();
		h.updater.dispose();
	});

	it("holds a newest that is no exact release rather than install it unasked", async () => {
		const h = harness({ installed: "18.22.2" });
		h.set.latest = "nightly-3f2a";
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.update).not.toHaveBeenCalled();
		expect(h.updater.state().held).toEqual({ version: "nightly-3f2a", reason: "verifying" });
		h.updater.dispose();
	});

	it("the repair pass installs nothing while the pref is off: no check, no install, one line saying so", async () => {
		const h = harness({ enabled: false, installed: "18.22.0" });
		h.set.latest = "18.23.0";
		await h.updater.repair();
		expect(h.calls).toEqual([]);
		expect(h.updater.state().phase).toBe("idle");
		expect(h.logs).toEqual([["skipped", { path: "repair", reason: "auto-update-off" }]]);
		h.updater.dispose();
	});

	it("the repair pass installs nothing in a launch that never updates on its own (dev, tests)", async () => {
		const h = harness({ scheduled: false, installed: "18.22.0" });
		h.set.latest = "18.23.0";
		await h.updater.repair();
		expect(h.calls).toEqual([]);
		expect(h.logs).toEqual([["skipped", { path: "repair", reason: "not-scheduled" }]]);
		h.updater.dispose();
	});

	// The repair cases below never start the timer, so the repair pass is the only one that runs.
	it("the repair pass with the pref on installs a verified newer omp", async () => {
		const h = harness({ installed: "18.22.0" });
		h.set.latest = "18.23.0";
		h.set.outcome = { kind: "updated", version: "18.23.0" };
		await h.updater.repair();
		expect(h.calls).toEqual(["fetch", "update 18.23.0 exact", "release", "resume true", "toast 18.23.0"]);
		expect(h.logs.map(([step, details]) => [step, details.path])).toEqual([
			["checked", "repair"],
			["started", "repair"],
			["finished", "repair"],
		]);
		h.updater.dispose();
	});

	it("the repair pass with the pref on installs no unverified omp", async () => {
		const h = harness({ installed: "18.22.2" });
		h.set.latest = "19.0.0";
		h.set.verified = [];
		await h.updater.repair();
		expect(h.update).not.toHaveBeenCalled();
		expect(h.updater.state()).toMatchObject({ installed: "18.22.2", held: VERIFYING, failure: null });
		expect(h.logs.map(([step, details]) => [step, details.path])).toEqual([
			["checked", "repair"],
			["held", "repair"],
		]);
		h.updater.dispose();
	});

	it("an omp already above the tested major is kept: launch, the timer and the repair pass neither move it back nor install an unverified newer release", async () => {
		const h = harness({ installed: "19.0.0" });
		h.set.latest = "19.0.0";
		h.set.verified = [];
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		// Nothing is newer than what runs: nothing held, and the tested omp is no target (never a step down).
		expect(h.calls).toEqual(["fetch"]);
		expect(h.updater.state()).toMatchObject({ installed: "19.0.0", latest: "19.0.0", held: null, failure: null });
		h.calls.length = 0;
		h.logs.length = 0;
		h.set.latest = "19.0.1";
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		await h.updater.repair();
		expect(h.calls).toEqual(["fetch", "fetch"]);
		expect(h.update).not.toHaveBeenCalled();
		const held = { version: "19.0.1", reason: "verifying" };
		expect(h.updater.state()).toMatchObject({ installed: "19.0.0", latest: "19.0.1", held, failure: null });
		const checked = { installed: "19.0.0", latest: "19.0.1", tested: TESTED, verified: null };
		expect(h.logs).toEqual([
			["checked", { path: "scheduled", ...checked }],
			["held", { path: "scheduled", installed: "19.0.0", ...held }],
			["checked", { path: "repair", ...checked }],
			["held", { path: "repair", installed: "19.0.0", ...held }],
		]);
		h.updater.dispose();
	});

	it("Update now installs a held omp: a person's click is the ask", async () => {
		const h = harness({ installed: "18.22.2" });
		h.set.latest = "19.0.0";
		h.set.verified = [];
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.updater.state().held).toEqual(VERIFYING);
		h.calls.length = 0;
		h.logs.length = 0;
		h.set.outcome = { kind: "updated", version: "19.0.0" };
		await h.updater.updateNow();
		expect(h.calls).toEqual(["fetch", "update 19.0.0", "release", "resume true", "toast 19.0.0"]);
		expect(h.updater.state()).toMatchObject({ installed: "19.0.0", updatedTo: "19.0.0", held: null, failure: null });
		expect(h.logs).toEqual([
			["checked", { path: "manual", installed: "18.22.2", latest: "19.0.0", tested: TESTED, verified: null }],
			["started", { path: "manual", from: "18.22.2", target: "19.0.0" }],
			["finished", { path: "manual", from: "18.22.2", target: "19.0.0", version: "19.0.0" }],
		]);
		// On the omp the person chose, a later check on the timer still installs nothing unverified.
		h.calls.length = 0;
		h.set.latest = "19.0.1";
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.update).toHaveBeenCalledTimes(1);
		expect(h.updater.state().held).toEqual({ version: "19.0.1", reason: "verifying" });
		h.updater.dispose();
	});

	it("Update now with the pref off still installs a held omp", async () => {
		const h = harness({ enabled: false, installed: "18.22.2" });
		h.set.latest = "19.0.0";
		h.set.verified = [];
		h.set.outcome = { kind: "updated", version: "19.0.0" };
		await h.updater.updateNow();
		expect(h.calls).toEqual(["fetch", "update 19.0.0", "release", "resume true", "toast 19.0.0"]);
		h.updater.dispose();
	});

	it("a click that lands while the timer's pass is still checking makes that pass the person's", async () => {
		const h = harness({ installed: "18.22.2" });
		h.set.verified = [];
		const gate = Promise.withResolvers<string>();
		h.fetchLatest.mockImplementationOnce(() => {
			h.calls.push("fetch");
			return gate.promise;
		});
		h.set.outcome = { kind: "updated", version: "19.0.0" };
		h.updater.start();
		const clicked = h.updater.updateNow();
		gate.resolve("19.0.0");
		await clicked;
		expect(h.calls).toEqual(["fetch", "update 19.0.0", "release", "resume true", "toast 19.0.0"]);
		expect(h.logs.map(([step, details]) => [step, details.path])).toEqual([
			["checked", "manual"],
			["started", "manual"],
			["finished", "manual"],
		]);
		// The click was for that pass only: the timer's next one holds 19.0.1.
		h.set.latest = "19.0.1";
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.update).toHaveBeenCalledTimes(1);
		h.updater.dispose();
	});

	it("a click that lands while the pass still reads the verified list installs the held omp", async () => {
		const h = harness({ installed: "18.22.2" });
		h.set.latest = "19.0.0";
		h.set.outcome = { kind: "updated", version: "19.0.0" };
		const gate = Promise.withResolvers<{ verified: string[]; holding: null }>();
		h.compat.mockImplementationOnce(() => gate.promise);
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		const clicked = h.updater.updateNow();
		gate.resolve({ verified: [], holding: null });
		await clicked;
		expect(h.calls).toEqual(["fetch", "update 19.0.0", "release", "resume true", "toast 19.0.0"]);
		expect(h.logs.map(([step, details]) => [step, details.path])).toEqual([
			["checked", "manual"],
			["started", "manual"],
			["finished", "manual"],
		]);
		h.updater.dispose();
	});

	it("a click after the version is chosen changes nothing about the install that runs", async () => {
		const h = harness({ installed: "18.22.0" });
		h.set.latest = "19.0.0";
		h.set.verified = ["18.22.2"];
		const gate = Promise.withResolvers<void>();
		h.update.mockImplementationOnce(async (target, beforeInstall, exactOnly) => {
			h.calls.push(exactOnly ? `update ${target} exact` : `update ${target}`);
			await beforeInstall();
			await gate.promise;
			h.set.installed = "18.22.2";
			return { kind: "updated", version: "18.22.2" };
		});
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		const clicked = h.updater.updateNow();
		gate.resolve();
		await clicked;
		expect(h.calls).toEqual(["fetch", "update 18.22.2 exact", "release", "resume true", "toast 18.22.2"]);
		expect(h.logs.at(-1)).toEqual([
			"finished",
			{ path: "launch", from: "18.22.0", target: "18.22.2", version: "18.22.2" },
		]);
		// 19.0.0 is still held: the next click installs it.
		expect(h.updater.state().held).toEqual(VERIFYING);
		h.updater.dispose();
	});

	it("writes a line for a failed check and for a failed install, each with its path and reason", async () => {
		const h = harness({ installed: "18.22.0" });
		h.fetchLatest.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND registry.npmjs.org"));
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.logs).toEqual([
			["failed", { path: "launch", reason: "check", detail: "getaddrinfo ENOTFOUND registry.npmjs.org" }],
		]);
		h.logs.length = 0;
		h.set.latest = "18.23.0";
		h.set.outcome = { kind: "failed", failure: { reason: "install", detail: "exit 1 — EBUSY" } };
		await h.updater.updateNow();
		expect(h.logs).toEqual([
			["checked", { path: "manual", installed: "18.22.0", latest: "18.23.0", tested: TESTED, verified: "18.23.0" }],
			["started", { path: "manual", from: "18.22.0", target: "18.23.0" }],
			["failed", { path: "manual", target: "18.23.0", reason: "install", detail: "exit 1 — EBUSY" }],
		]);
		h.updater.dispose();
	});

	it("a paired device reads what its host holds from the host's state, an older host's reason included", () => {
		const h = harness();
		for (const held of [
			VERIFYING,
			{ version: "19.0.0", reason: "failed", since: SINCE },
			{ version: "19.0.0", reason: "untested-major" },
		] as const) {
			expect(OmpUpdateStateSchema.parse({ ...h.updater.state(), held }).held).toEqual(held);
		}
		// A host whose OMPdesk predates the fields still parses.
		const { held: _, verified: __, stockAutoTaken: ___, ...older } = h.updater.state();
		const parsed = OmpUpdateStateSchema.parse(older);
		expect(parsed.held).toBeUndefined();
		expect(parsed.verified).toBeUndefined();
		h.updater.dispose();
	});
});

describe("omp update IPC", () => {
	it("serves exactly the state snapshot and Update now; nothing crosses that names a version, command or path", async () => {
		const channels: string[] = [];
		const ipc = new IpcRegistry({ handle: channel => channels.push(channel), on: () => {} });
		const caller: IpcCaller = { win: null, browserWindow: null, sender: { id: 1, once: () => {} } };
		const updater = { state: vi.fn(() => ({ phase: "idle" }) as OmpUpdateState), updateNow: vi.fn(async () => {}) };
		registerOmpUpdateIpc(ipc, updater);
		expect(channels.sort()).toEqual([IPC_COMMANDS.OMP_UPDATE_GET_STATE, IPC_COMMANDS.OMP_UPDATE_NOW].sort());
		expect(await ipc.invoke(IPC_COMMANDS.OMP_UPDATE_GET_STATE, caller, [])).toEqual({ phase: "idle" });
		// The arguments a renderer might add are ignored.
		await ipc.invoke(IPC_COMMANDS.OMP_UPDATE_NOW, caller, ["19.0.0; rm -rf /"]);
		expect(updater.updateNow).toHaveBeenCalledWith();
	});
});
