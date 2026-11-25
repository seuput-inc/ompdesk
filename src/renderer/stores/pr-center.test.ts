/**
 * PR Center store contracts (plan/21): probe gates the list on repo
 * availability, select loads detail and clears per-file state, toggleFile
 * lazy-loads diffs per path (expand → loading → ready, collapse removes),
 * checkout routes the result into a worktree-bound openTab.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcResponse } from "../../shared/rpc-types";
import { rememberRead, resetLastReadForTest } from "../lib/last-read";
import { usePrCenterStore } from "./pr-center";
import { useTabsStore } from "./tabs";

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}
function fail(error: string, code?: string): RpcResponse {
	return { type: "response", command: "test", success: false, error, code };
}

const REPO = { available: true, repo: "acme/widgets", defaultBranch: "main" };
const LIST_ITEM = {
	number: 42,
	title: "Add widget",
	url: "https://github.com/acme/widgets/pull/42",
	isDraft: false,
	authorLogin: "zach",
	headRefName: "feat/widget",
	baseRefName: "main",
	additions: 10,
	deletions: 2,
	updatedAt: "2026-08-01T00:00:00Z",
	reviewDecision: null,
	checks: { success: 2, failure: 0, pending: 0 },
};

function installMockOmp() {
	const omp = {
		rpc: {
			prRepo: vi.fn(async () => ok(REPO)),
			prList: vi.fn(async () => ok([LIST_ITEM])),
			prGet: vi.fn(async () =>
				ok({
					number: 42,
					title: "Add widget",
					url: LIST_ITEM.url,
					isDraft: false,
					authorLogin: "zach",
					body: "body",
					baseRefName: "main",
					headRefName: "feat/widget",
					mergeStateStatus: "CLEAN",
					additions: 10,
					deletions: 2,
					reviewDecision: null,
					files: [{ path: "src/a.ts", changeType: "modified", additions: 10, deletions: 2 }],
					checks: [],
				}),
			),
			prDiff: vi.fn(async () => ok({ diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n" })),
			prCheckout: vi.fn(async () => ok({ path: "/wt/42-deadbeef", branch: "pr-42" })),
		},
		tabs: {
			list: vi.fn(async () => []),
			spawn: vi.fn(async () => ({ tabId: "t9" })),
			close: vi.fn(async () => true),
			setActive: vi.fn(async () => true),
		},
		events: { onTabStatus: vi.fn(() => () => {}) },
	};
	(globalThis as Record<string, unknown>).window = { omp } as unknown as Window;
	return omp;
}

beforeEach(() => {
	installMockOmp();
	usePrCenterStore.getState().reset();
	useTabsStore.setState({ tabs: [], activeTabId: null, bundles: new Map() });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	resetLastReadForTest();
	delete (globalThis as Record<string, unknown>).document;
});

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("pr-center store", () => {
	it("probe stores the repo and loads the list when available", async () => {
		await usePrCenterStore.getState().probe();
		expect(usePrCenterStore.getState().repo).toEqual(REPO);
		expect(usePrCenterStore.getState().list).toHaveLength(1);
	});

	it("probe does not list when the repo is unavailable", async () => {
		const omp = installMockOmp();
		omp.rpc.prRepo.mockResolvedValue(ok({ available: false, reason: "no_github_remote" }));
		await usePrCenterStore.getState().probe();
		const state = usePrCenterStore.getState();
		expect(state.list).toHaveLength(0);
		expect(omp.rpc.prList).not.toHaveBeenCalled();
	});

	it("select loads detail; toggleFile lazy-loads then removes the diff", async () => {
		await usePrCenterStore.getState().probe();
		await usePrCenterStore.getState().select(42);
		expect(usePrCenterStore.getState().detail?.number).toBe(42);

		await usePrCenterStore.getState().toggleFile("src/a.ts");
		const ready = usePrCenterStore.getState().expandedFiles["src/a.ts"];
		expect(ready && "diff" in ready && ready.diff).toContain("diff --git");

		await usePrCenterStore.getState().toggleFile("src/a.ts");
		expect(usePrCenterStore.getState().expandedFiles["src/a.ts"]).toBeUndefined();
	});

	it("select clears a previous selection's expanded files", async () => {
		await usePrCenterStore.getState().probe();
		await usePrCenterStore.getState().select(42);
		await usePrCenterStore.getState().toggleFile("src/a.ts");
		await usePrCenterStore.getState().select(42);
		expect(Object.keys(usePrCenterStore.getState().expandedFiles)).toHaveLength(0);
	});

	it("checkout opens a worktree-bound tab named pr-<N>", async () => {
		const spawn = installMockOmp().tabs.spawn;
		await usePrCenterStore.getState().probe();
		await usePrCenterStore.getState().checkout(42);
		expect(spawn).toHaveBeenCalledWith({
			cwd: "/wt/42-deadbeef",
			sessionPath: undefined,
			kind: "agent",
			worktree: { name: "pr-42", branch: "pr-42", baseCwd: "acme/widgets", path: "/wt/42-deadbeef" },
		});
	});

	it("checkout failure toasts instead of spawning", async () => {
		const omp = installMockOmp();
		omp.rpc.prCheckout.mockResolvedValue(fail("boom", "pr_checkout_failed"));
		await usePrCenterStore.getState().probe();
		await usePrCenterStore.getState().checkout(42);
		expect(omp.tabs.spawn).not.toHaveBeenCalled();
	});
});

describe("pr-center: the last read paints at once", () => {
	const scope = { device: undefined, cwd: "/work/widgets" };

	it("enter() seeds the repo and the list of that folder, and not another folder's", () => {
		rememberRead(undefined, "pr:repo:/work/widgets", REPO, false);
		rememberRead(undefined, "pr:list:/work/widgets:open:all", [LIST_ITEM], false);
		usePrCenterStore.getState().enter(scope);
		expect(usePrCenterStore.getState().repo).toEqual(REPO);
		expect(usePrCenterStore.getState().list).toEqual([LIST_ITEM]);

		usePrCenterStore.getState().enter({ device: undefined, cwd: "/work/other" });
		expect(usePrCenterStore.getState().repo).toBeNull();
		expect(usePrCenterStore.getState().list).toEqual([]);
		usePrCenterStore.getState().enter({ device: "host-b", cwd: "/work/widgets" });
		expect(usePrCenterStore.getState().repo).toBeNull();
	});

	it("select() shows a PR seen before while it reads again, and a slower answer for another PR never replaces it", async () => {
		const omp = installMockOmp();
		usePrCenterStore.getState().enter(scope);
		await usePrCenterStore.getState().probe();
		await usePrCenterStore.getState().select(42);
		expect(usePrCenterStore.getState().detail?.number).toBe(42);

		const slow = Promise.withResolvers<RpcResponse>();
		omp.rpc.prGet.mockReturnValueOnce(slow.promise as never);
		const reading = usePrCenterStore.getState().select(42);
		expect(usePrCenterStore.getState().detail?.number).toBe(42);
		expect(usePrCenterStore.getState().detailLoading).toBe(true);
		omp.rpc.prGet.mockResolvedValueOnce(ok({ number: 43, title: "Other", files: [], checks: [] }) as never);
		await usePrCenterStore.getState().select(43);
		slow.resolve(ok({ number: 42, title: "late" }));
		await reading;
		expect(usePrCenterStore.getState().selected).toBe(43);
		expect(usePrCenterStore.getState().detail?.number).toBe(43);
	});
});

describe("pr-center: one list read at a time, and only its own outcome", () => {
	const C_ITEM = { ...LIST_ITEM, number: 7, title: "Merged one" };

	it.each(["success", "failure"] as const)(
		"switching B→C during A's read reads C once afterwards; A's late %s leaves C's list, error and mark alone",
		async outcome => {
			const omp = installMockOmp();
			const a = Promise.withResolvers<RpcResponse>();
			const c = Promise.withResolvers<RpcResponse>();
			omp.rpc.prList.mockReturnValueOnce(a.promise as never).mockReturnValueOnce(c.promise as never);
			const reading = usePrCenterStore.getState().refresh();
			usePrCenterStore.getState().setListState("closed");
			usePrCenterStore.getState().setListState("merged");
			expect(omp.rpc.prList).toHaveBeenCalledTimes(1);

			a.resolve(outcome === "success" ? ok([LIST_ITEM]) : fail("boom", "github_failed"));
			await reading;
			await flush();
			expect(omp.rpc.prList).toHaveBeenCalledTimes(2);
			expect(omp.rpc.prList).toHaveBeenLastCalledWith("merged", 50, "all", false, {});
			let state = usePrCenterStore.getState();
			expect(state.list).toEqual([]);
			expect(state.error).toBeNull();
			expect(state.listLoading).toBe(true);

			c.resolve(ok([C_ITEM]));
			await flush();
			state = usePrCenterStore.getState();
			expect(state.list).toEqual([C_ITEM]);
			expect(state.listLoading).toBe(false);
			expect(omp.rpc.prList).toHaveBeenCalledTimes(2);
		},
	);

	it("a filter reads its own list, and clearing it paints the plain list read before", async () => {
		const omp = installMockOmp();
		await usePrCenterStore.getState().refresh();
		expect(usePrCenterStore.getState().list).toEqual([LIST_ITEM]);
		const mine = { ...LIST_ITEM, number: 9, title: "Mine" };
		const filtered = Promise.withResolvers<RpcResponse>();
		omp.rpc.prList.mockReturnValueOnce(filtered.promise as never);
		usePrCenterStore.getState().setListFilter({ author: "me" });
		expect(omp.rpc.prList).toHaveBeenLastCalledWith("open", 50, "all", false, { author: "me" });
		expect(usePrCenterStore.getState().list).toEqual([]);
		filtered.resolve(ok([mine]));
		await flush();
		expect(usePrCenterStore.getState().list).toEqual([mine]);
		omp.rpc.prList.mockReturnValueOnce(Promise.withResolvers<RpcResponse>().promise as never);
		usePrCenterStore.getState().setListFilter({});
		expect(usePrCenterStore.getState().list).toEqual([LIST_ITEM]);
	});

	it("a refresh asked while one runs runs once right after it", async () => {
		const omp = installMockOmp();
		const a = Promise.withResolvers<RpcResponse>();
		omp.rpc.prList.mockReturnValueOnce(a.promise as never);
		const reading = usePrCenterStore.getState().refresh();
		void usePrCenterStore.getState().refresh();
		void usePrCenterStore.getState().refresh();
		expect(omp.rpc.prList).toHaveBeenCalledTimes(1);
		a.resolve(ok([LIST_ITEM]));
		await reading;
		await flush();
		expect(omp.rpc.prList).toHaveBeenCalledTimes(2);
		expect(usePrCenterStore.getState().listLoading).toBe(false);
	});

	it("a probe's failure for a folder no longer shown writes nothing", async () => {
		const omp = installMockOmp();
		const answer = Promise.withResolvers<RpcResponse>();
		omp.rpc.prRepo.mockReturnValueOnce(answer.promise as never);
		usePrCenterStore.getState().enter({ device: undefined, cwd: "/work/a" });
		const probing = usePrCenterStore.getState().probe();
		rememberRead(undefined, "pr:repo:/work/b", REPO, false);
		usePrCenterStore.getState().enter({ device: undefined, cwd: "/work/b" });
		answer.resolve(fail("not a repo", "not_a_repo"));
		await probing;
		expect(usePrCenterStore.getState().repo).toEqual(REPO);
		expect(usePrCenterStore.getState().error).toBeNull();
	});
});

describe("pr-center: the window coming back reads stale rows in place", () => {
	const T0 = Date.parse("2026-11-25T10:00:00.000Z");

	function showing(omp: ReturnType<typeof installMockOmp>) {
		const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
		Object.assign(globalThis, { document: doc, window: Object.assign(new EventTarget(), { omp }) });
		return (state: "visible" | "hidden", at: number) => {
			vi.setSystemTime(at);
			doc.visibilityState = state;
			doc.dispatchEvent(new Event("visibilitychange"));
		};
	}

	it("a return within a minute reads nothing, a hidden window never reads, a later return reads in the background", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
		const omp = installMockOmp();
		const turn = showing(omp);
		await usePrCenterStore.getState().probe();
		const stop = usePrCenterStore.getState().watch();
		expect(omp.rpc.prList).toHaveBeenCalledTimes(1);

		turn("visible", T0 + 30_000);
		await flush();
		expect(omp.rpc.prList).toHaveBeenCalledTimes(1);
		turn("hidden", T0 + 90_000);
		await flush();
		expect(omp.rpc.prList).toHaveBeenCalledTimes(1);
		turn("visible", T0 + 91_000);
		await flush();
		expect(omp.rpc.prList).toHaveBeenCalledTimes(2);
		expect(omp.rpc.prList).toHaveBeenLastCalledWith("open", 50, "all", true, {});
		stop();
	});

	it("GitHub holding a background read shows until when, keeps the rows and reads nothing before then", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
		const omp = installMockOmp();
		const turn = showing(omp);
		await usePrCenterStore.getState().probe();
		const stop = usePrCenterStore.getState().watch();
		omp.rpc.prList.mockResolvedValueOnce(
			fail("background reads spent; paused until 2026-11-25T10:31:00.000Z", "gh_paused"),
		);
		turn("visible", T0 + 61_000);
		await flush();
		let state = usePrCenterStore.getState();
		expect(state.pausedUntil).toBe(Date.parse("2026-11-25T10:31:00.000Z"));
		expect(state.list).toEqual([LIST_ITEM]);
		expect(state.error).toBeNull();

		turn("visible", T0 + 20 * 60_000);
		await flush();
		expect(omp.rpc.prList).toHaveBeenCalledTimes(2);

		// A person's read still runs, and its success ends the hold.
		await usePrCenterStore.getState().refresh();
		state = usePrCenterStore.getState();
		expect(omp.rpc.prList).toHaveBeenLastCalledWith("open", 50, "all", false, {});
		expect(state.pausedUntil).toBeNull();
		stop();
	});

	it("a shown PR whose checks still run reads again after 60 s, then 120 s, in the background", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(T0);
		const omp = installMockOmp();
		showing(omp);
		omp.rpc.prGet.mockResolvedValue(
			ok({
				number: 42,
				title: "Add widget",
				files: [],
				checks: [{ name: "ci", status: "IN_PROGRESS", conclusion: null }],
			}) as never,
		);
		await usePrCenterStore.getState().probe();
		const stop = usePrCenterStore.getState().watch();
		await usePrCenterStore.getState().select(42);
		expect(omp.rpc.prGet).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(omp.rpc.prGet).toHaveBeenCalledTimes(2);
		expect(omp.rpc.prGet).toHaveBeenLastCalledWith(42, true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(omp.rpc.prGet).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(omp.rpc.prGet).toHaveBeenCalledTimes(3);
		stop();
		await vi.advanceTimersByTimeAsync(900_000);
		expect(omp.rpc.prGet).toHaveBeenCalledTimes(3);
	});
});
