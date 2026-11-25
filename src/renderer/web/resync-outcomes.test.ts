import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	remote: vi.fn(async () => true),
	hosted: vi.fn(async () => true),
	hydrate: vi.fn(async () => true),
	review: vi.fn(async () => true),
	captured: new Map(),
	settle: vi.fn(() => true),
	restore: vi.fn(),
}));

vi.mock("../stores/tabs", () => ({
	useTabsStore: { getState: () => ({ reconcileTabs: async () => true, tabs: [{ id: "tab", status: "ready" }] }) },
	visibleTabIds: () => ["tab"],
	captureTabExtensionUiRequests: () => mocks.captured,
	settleTabExtensionUiRequests: mocks.settle,
	restoreTabExtensionUiRequests: mocks.restore,
}));
vi.mock("../hooks/session-hydration", () => ({ hydrateTabSession: mocks.hydrate, recoverTabSession: mocks.hydrate }));
vi.mock("../stores/remote", () => ({ loadRemoteState: mocks.remote }));
vi.mock("../stores/hosted-sessions", () => ({ loadHostedSessions: mocks.hosted }));
vi.mock("../stores/session-list", () => ({ refreshHeldSessionLists: async () => true }));
vi.mock("../stores/agent-review", () => ({ useAgentReviewStore: { getState: () => ({ refresh: mocks.review }) } }));

import { resyncPage } from "./resync-page";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("authoritative recovery outcomes", () => {
	it.each(["remote", "hosted", "hydrate", "review"] as const)(
		"keeps a loss pending when %s did not recover",
		async which => {
			vi.stubGlobal("window", { omp: { ui: { openRequests: async () => [], shownState: async () => [] } } });
			mocks[which].mockResolvedValueOnce(false);
			expect(await Reflect.apply(resyncPage, undefined, [{ strict: true }])).toBe(false);
		},
	);

	it("restores a local approval and shown state even when an offline host prevents ACK", async () => {
		const open = [{ tabId: "tab", request: { id: "missed-ask", method: "ask", questions: [] } }];
		const shown = [{ tabId: "tab", request: { id: "status", method: "setStatus" } }];
		vi.stubGlobal("window", { omp: { ui: { openRequests: async () => open, shownState: async () => shown } } });
		mocks.hosted.mockResolvedValueOnce(false);
		expect(await Reflect.apply(resyncPage, undefined, [{ strict: true }])).toBe(false);
		expect(mocks.settle).toHaveBeenCalledWith(open, mocks.captured);
		expect(mocks.restore).toHaveBeenCalledWith(shown);
	});

	it("restores the successful local approval snapshot when a different read rejects", async () => {
		const open = [{ tabId: "tab", request: { id: "missed-ask", method: "ask", questions: [] } }];
		vi.stubGlobal("window", { omp: { ui: { openRequests: async () => open, shownState: async () => [] } } });
		mocks.hosted.mockRejectedValueOnce(new Error("offline"));
		expect(await Reflect.apply(resyncPage, undefined, [{ strict: true }])).toBe(false);
		expect(mocks.settle).toHaveBeenCalledWith(open, mocks.captured);
		expect(mocks.restore).toHaveBeenCalledWith([]);
	});

	it("does not restore a raced snapshot over a newly arrived ask while another read failed", async () => {
		const open = [{ tabId: "tab", request: { id: "older-ask", method: "ask", questions: [] } }];
		vi.stubGlobal("window", { omp: { ui: { openRequests: async () => open, shownState: async () => [] } } });
		mocks.hosted.mockResolvedValueOnce(false);
		mocks.settle.mockReturnValueOnce(false);
		expect(await Reflect.apply(resyncPage, undefined, [{ strict: true }])).toBe(false);
		expect(mocks.settle).toHaveBeenCalledWith(open, mocks.captured);
		expect(mocks.restore).not.toHaveBeenCalled();
	});
});
