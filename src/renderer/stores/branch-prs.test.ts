import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubBranchPr } from "../../shared/github";
import {
	ACTIVE_REFRESH_MS,
	backoffMs,
	branchPrKey,
	IDLE_REFRESH_MS,
	resetBranchPrs,
	useBranchPrs,
	watchBranchPrs,
} from "./branch-prs";

const PR: GithubBranchPr = {
	number: 7,
	title: "Add a thing",
	url: "https://github.com/o/r/pull/7",
	isDraft: false,
	authorLogin: "me",
	headRefName: "feat",
	baseRefName: "main",
	additions: 1,
	deletions: 0,
	updatedAt: "2026-11-25T00:00:00Z",
	reviewDecision: null,
	checks: { success: 1, failure: 0, pending: 0 },
	state: "OPEN",
};

const SELECTED = { root: "/repo/a", branch: "feat" };
const OTHER = { root: "/repo/b", branch: "fix" };

let pullRequest: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	pullRequest = vi.fn(async (root: string) => (root === SELECTED.root ? PR : null));
	const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
	Object.assign(globalThis, {
		document: doc,
		window: Object.assign(new EventTarget(), { omp: { sessions: { pullRequest } } }),
	});
});

afterEach(() => {
	resetBranchPrs();
	vi.useRealTimers();
	delete (globalThis as Record<string, unknown>).document;
});

const readsOf = (row: { root: string }) => pullRequest.mock.calls.filter(([root]) => root === row.root).length;

describe("branch PRs: Orca's refresh tiers", () => {
	it("reads each shown branch once, then a selected one each minute and the rest each 15 minutes", async () => {
		watchBranchPrs("local", [SELECTED, OTHER], [SELECTED]);
		await vi.advanceTimersByTimeAsync(0);
		expect(readsOf(SELECTED)).toBe(1);
		expect(readsOf(OTHER)).toBe(1);
		expect(useBranchPrs.getState().prs[branchPrKey(SELECTED)]).toEqual(PR);
		expect(useBranchPrs.getState().prs[branchPrKey(OTHER)]).toBeNull();

		await vi.advanceTimersByTimeAsync(ACTIVE_REFRESH_MS + 30_000);
		expect(readsOf(SELECTED)).toBe(2);
		expect(readsOf(OTHER)).toBe(1);

		await vi.advanceTimersByTimeAsync(IDLE_REFRESH_MS);
		expect(readsOf(OTHER)).toBe(2);
	});

	it("waits longer after each failed read of a branch", async () => {
		pullRequest.mockRejectedValue(new Error("offline"));
		watchBranchPrs("local", [OTHER], [OTHER]);
		await vi.advanceTimersByTimeAsync(0);
		expect(readsOf(OTHER)).toBe(1);
		await vi.advanceTimersByTimeAsync(backoffMs(1) + 30_000);
		expect(readsOf(OTHER)).toBe(2);
		// The second failure waits two minutes, not the selected tier's one.
		await vi.advanceTimersByTimeAsync(ACTIVE_REFRESH_MS);
		expect(readsOf(OTHER)).toBe(2);
		await vi.advanceTimersByTimeAsync(backoffMs(2));
		expect(readsOf(OTHER)).toBe(3);
		expect(backoffMs(9)).toBe(IDLE_REFRESH_MS);
	});

	it("keeps at most 8 branches in the minute tier", async () => {
		const rows = Array.from({ length: 10 }, (_, index) => ({ root: `/repo/${index}`, branch: "main" }));
		watchBranchPrs("local", rows, rows);
		await vi.advanceTimersByTimeAsync(0);
		expect(pullRequest).toHaveBeenCalledTimes(10);
		await vi.advanceTimersByTimeAsync(ACTIVE_REFRESH_MS + 30_000);
		expect(pullRequest).toHaveBeenCalledTimes(18);
	});

	it("stops reading the rows of a view that went", async () => {
		watchBranchPrs("device:h", [{ ...OTHER, device: "h" }], []);
		await vi.advanceTimersByTimeAsync(0);
		watchBranchPrs("device:h", [], []);
		await vi.advanceTimersByTimeAsync(IDLE_REFRESH_MS * 2);
		expect(pullRequest).toHaveBeenCalledTimes(1);
		expect(pullRequest.mock.calls[0]).toEqual([OTHER.root, OTHER.branch, "h"]);
	});
});
