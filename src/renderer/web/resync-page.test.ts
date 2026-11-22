import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	reconcileTabs: vi.fn<(options?: { resync?: boolean }) => Promise<boolean>>(),
	state: {
		activeTabId: "a" as string | null,
		tabs: [] as { id: string; status: string }[],
	},
	visible: ["a"] as string[],
	recoverTabSession: vi.fn(async (_tabId: string, _required: "core" | "all") => true),
	captured: new Map(),
	capture: vi.fn(() => mocks.captured),
	settle: vi.fn(() => true),
	restore: vi.fn(),
	loadRemoteState: vi.fn(async () => {}),
	refreshHeldSessionLists: vi.fn(async () => true),
	refreshReview: vi.fn(async (_tabId: string) => {}),
}));

vi.mock("../stores/tabs", () => ({
	useTabsStore: { getState: () => ({ ...mocks.state, reconcileTabs: mocks.reconcileTabs }) },
	visibleTabIds: () => mocks.visible,
	captureTabExtensionUiRequests: mocks.capture,
	settleTabExtensionUiRequests: mocks.settle,
	restoreTabExtensionUiRequests: mocks.restore,
}));
vi.mock("../hooks/session-hydration", () => ({
	recoverTabSession: mocks.recoverTabSession,
}));
vi.mock("../stores/remote", () => ({ loadRemoteState: mocks.loadRemoteState }));
vi.mock("../stores/session-list", () => ({ refreshHeldSessionLists: mocks.refreshHeldSessionLists }));
vi.mock("../stores/agent-review", () => ({
	useAgentReviewStore: { getState: () => ({ refresh: mocks.refreshReview }) },
}));

const { resyncPage } = await import("./resync-page");

const openRequests = vi.fn(async () => [{ tabId: "a", request: { id: "ask-1" } }]);
const shownState = vi.fn(async () => [{ tabId: "a", request: { id: "status-1", method: "setStatus" } }]);

beforeEach(() => {
	vi.clearAllMocks();
	(globalThis as { window?: unknown }).window = { omp: { ui: { openRequests, shownState } } };
	mocks.reconcileTabs.mockResolvedValue(true);
	mocks.state.tabs = [
		{ id: "a", status: "running" },
		{ id: "b", status: "ready" },
		{ id: "c", status: "error" },
		{ id: "d", status: "running" },
	];
	mocks.visible = ["a", "b", "c"];
});

describe("resyncPage (one in-place catch-up pass after a reconnect that missed events)", () => {
	it("takes the host's tab list as the whole truth, then re-reads every visible live tab, the asks and the snapshots", async () => {
		expect(await resyncPage()).toBe(true);
		expect(mocks.reconcileTabs).toHaveBeenCalledWith({ resync: true });
		// Visible and ready or running: a mid-reply tab merges what it missed; an errored one and a background tab
		// (which reads its own when shown) are left alone.
		expect(mocks.recoverTabSession.mock.calls).toEqual([
			["a", "core"],
			["b", "core"],
		]);
		expect(mocks.settle).toHaveBeenCalledWith([{ tabId: "a", request: { id: "ask-1" } }], mocks.captured);
		// The status texts, widgets and title the host's tabs show: the missed frames that set them are not repeated.
		expect(mocks.restore).toHaveBeenCalledWith([{ tabId: "a", request: { id: "status-1", method: "setStatus" } }]);
		expect(mocks.loadRemoteState).toHaveBeenCalledOnce();
		expect(mocks.refreshHeldSessionLists).toHaveBeenCalledOnce();
		// The sessions each shown tab opened: main's pushes of that list went down with the socket.
		expect(mocks.refreshReview.mock.calls.map(call => call[0])).toEqual(["a", "b", "c"]);
	});

	it("fails without reading anything else when the host cannot list the tabs (the link dropped again)", async () => {
		mocks.reconcileTabs.mockResolvedValue(false);
		expect(await resyncPage()).toBe(false);
		expect(mocks.recoverTabSession).not.toHaveBeenCalled();
		expect(openRequests).not.toHaveBeenCalled();
		expect(mocks.settle).not.toHaveBeenCalled();
	});

	it("keeps a phone catch-up pending when one visible tab lacks its state or transcript", async () => {
		mocks.recoverTabSession.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		expect(await resyncPage()).toBe(false);
		expect(await resyncPage()).toBe(true);
	});

	it("fails when a read throws, so the pass is tried again", async () => {
		openRequests.mockRejectedValueOnce(new Error("The link to the computer dropped"));
		await expect(resyncPage()).rejects.toThrow("dropped");
		expect(mocks.settle).not.toHaveBeenCalled();
	});

	it("does not acknowledge a failed held-list read or a raced approval snapshot", async () => {
		mocks.refreshHeldSessionLists.mockResolvedValueOnce(false);
		expect(await resyncPage()).toBe(false);
		expect(mocks.settle).toHaveBeenCalledWith([{ tabId: "a", request: { id: "ask-1" } }], mocks.captured);
		expect(mocks.restore).toHaveBeenCalledWith([{ tabId: "a", request: { id: "status-1", method: "setStatus" } }]);
		mocks.settle.mockReturnValueOnce(false);
		expect(await resyncPage()).toBe(false);
	});
});
