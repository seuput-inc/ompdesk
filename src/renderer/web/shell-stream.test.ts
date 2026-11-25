import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_EVENTS } from "../../shared/ipc-types";
import { resetSnapshotsForTest } from "../lib/snapshot-cache";
import { resetSessionListFeeds, sessionListFeed } from "../stores/session-list";
import { installShellResync } from "./resync";
import { resyncPage } from "./resync-page";

vi.mock("../stores/tabs", () => ({
	useTabsStore: { getState: () => ({ reconcileTabs: async () => true, tabs: [], activeTabId: null }) },
	visibleTabIds: () => [],
	captureTabExtensionUiRequests: () => new Map(),
	restoreTabExtensionUiRequests: () => {},
	settleTabExtensionUiRequests: () => true,
}));
vi.mock("../hooks/session-hydration", () => ({
	hydrateTabSession: async () => {},
	recoverTabSession: async () => true,
}));
vi.mock("../stores/remote", () => ({ loadRemoteState: async () => true }));
vi.mock("../stores/hosted-sessions", () => ({ loadHostedSessions: async () => true }));
vi.mock("../stores/agent-review", () => ({ useAgentReviewStore: { getState: () => ({ refresh: async () => {} }) } }));

class MemoryStorage {
	readonly items = new Map<string, string>();
	get length() {
		return this.items.size;
	}
	key(index: number) {
		return [...this.items.keys()][index] ?? null;
	}
	getItem(key: string) {
		return this.items.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.items.set(key, value);
	}
	removeItem(key: string) {
		this.items.delete(key);
	}
}

class NoStorageImport {
	status = 204;
	open(): void {}
	send(): void {}
	getResponseHeader(): null {
		return null;
	}
}

afterEach(() => {
	resetSessionListFeeds();
	resetSnapshotsForTest();
	vi.unstubAllGlobals();
});

describe("CEF event stream recovery", () => {
	it("refreshes a held session snapshot after its last deletion delta is evicted, without a later delta", async () => {
		const win = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
		const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
		vi.stubGlobal("window", win);
		vi.stubGlobal("document", doc);
		vi.stubGlobal("localStorage", new MemoryStorage());
		vi.stubGlobal("XMLHttpRequest", NoStorageImport);
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start: value => {
				controller = value;
			},
		});
		const row = (path: string) => ({ path, title: path, modified: 1, size: 1 });
		let current = { version: "e.1", sessions: [row("/deleted"), row("/kept")] };
		let reads = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).endsWith("/__ipc/events")) return new Response(body);
				if (String(input).endsWith("/__ipc/invoke")) {
					const request = JSON.parse(String(init?.body));
					if (request.channel === "sessions:list") {
						reads++;
						return Response.json({ value: current });
					}
					return Response.json({ value: [] });
				}
				throw new Error(`unexpected fetch ${String(input)}`);
			}),
		);
		await import("../../preload/shell");
		const feed = sessionListFeed("global");
		const release = feed.retain();
		try {
			await vi.waitFor(() =>
				expect(feed.store.getState().sessions.map(session => session.path)).toEqual(["/deleted", "/kept"]),
			);
			current = { version: "e.2", sessions: [row("/kept")] };
			const received: unknown[] = [];
			const unsubscribe = window.omp.events.onLogBatch(value => received.push(value));
			const queued = [
				{
					channel: "sessions:changed",
					args: [{ list: { base: "e.1", version: "e.2", set: [], remove: ["/deleted"] } }],
				},
				...Array.from({ length: 4096 }, (_, index) => ({ channel: IPC_EVENTS.LOG_LINE, args: [index] })),
			];
			queued.shift();
			controller?.enqueue(
				new TextEncoder().encode(
					`${queued.map(frame => JSON.stringify(frame)).join("\n")}\n${JSON.stringify({ stream: "reset" })}\n`,
				),
			);
			await vi.waitFor(() => expect(received.length).toBe(4096));
			const stream = Reflect.get(win, "__ompShellStream");
			installShellResync(stream, () => resyncPage({ strict: true }), vi.fn());
			await vi.waitFor(() => expect(feed.store.getState().sessions.map(session => session.path)).toEqual(["/kept"]));
			expect(reads).toBe(2);
			expect(received).toEqual(Array.from({ length: 4096 }, (_, index) => index));
			unsubscribe();
		} finally {
			release();
		}
	});
});
