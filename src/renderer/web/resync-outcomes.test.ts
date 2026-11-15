import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	remote: vi.fn(async () => true),
	hosted: vi.fn(async () => true),
	hydrate: vi.fn(async () => true),
	review: vi.fn(async () => true),
}));

vi.mock("../stores/tabs", () => ({
	useTabsStore: { getState: () => ({ reconcileTabs: async () => true, tabs: [{ id: "tab", status: "ready" }] }) },
	visibleTabIds: () => ["tab"],
	captureTabExtensionUiRequests: () => new Map(),
	settleTabExtensionUiRequests: () => true,
	restoreTabExtensionUiRequests: () => {},
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
});
