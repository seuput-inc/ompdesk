/**
 * useGithubLoad paints the last answer of its request at the first frame (lib/last-read.ts) and reads again in
 * place: a list opened before is never a spinner, another folder's or another request's answer is never shown.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubRequest } from "../../shared/github";
import { useTabsStore } from "../stores/tabs";
import { type GithubLoad, useGithubLoad } from "./github";
import { rememberRead, resetLastReadForTest } from "./last-read";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");

const REQUEST: GithubRequest = { op: "issue_list", host: "github.com", repo: "acme/widgets" } as GithubRequest;
let seen: GithubLoad<unknown> | null = null;

function Probe({ request, id }: { request: GithubRequest; id: string }) {
	seen = useGithubLoad(request, id);
	return null;
}

let root: ReturnType<typeof createRoot> | null = null;

async function mount(id: string): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(<Probe id={id} request={REQUEST} />);
	});
}

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	seen = null;
	resetLastReadForTest();
	useTabsStore.setState({ tabs: [], activeTabId: null });
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("useGithubLoad snapshots", () => {
	it("returns the last answer of this request on the first render, while the read is still pending", async () => {
		const command = vi.fn(() => new Promise(() => {}));
		Object.assign(window, { omp: { rpc: { command } } });
		rememberRead(undefined, `github:${""}:issue_list:key-1`, [{ number: 1 }], false);
		await mount("key-1");
		expect(seen?.data).toEqual([{ number: 1 }]);
		expect(seen?.loading).toBe(true);
	});

	it("never shows another request's answer", async () => {
		Object.assign(window, { omp: { rpc: { command: vi.fn(() => new Promise(() => {})) } } });
		rememberRead(undefined, `github:${""}:issue_list:key-1`, [{ number: 1 }], false);
		await mount("key-2");
		expect(seen?.data).toBeNull();
	});

	it("replaces the snapshot with the live answer and remembers it", async () => {
		const live = [{ number: 2 }];
		Object.assign(window, {
			omp: {
				rpc: { command: vi.fn(async () => ({ type: "response", command: "github", success: true, data: live })) },
			},
		});
		rememberRead(undefined, `github:${""}:issue_list:key-1`, [{ number: 1 }], false);
		await mount("key-1");
		await act(async () => {
			await Promise.resolve();
		});
		expect(seen?.data).toEqual(live);
		expect(seen?.loading).toBe(false);
	});
});

describe("useGithubLoad freshness", () => {
	const T0 = Date.parse("2026-11-25T10:00:00.000Z");

	it("a return within a minute reads nothing; a later one reads the shown key again in place, in the background", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
		const command = vi.fn(async (_command: unknown) => ({
			type: "response",
			command: "github",
			success: true,
			data: [{ number: 2 }],
		}));
		Object.assign(window, { omp: { rpc: { command } } });
		await mount("key-1");
		expect(command).toHaveBeenCalledTimes(1);
		expect(command).toHaveBeenLastCalledWith({ type: "github", request: REQUEST });

		vi.setSystemTime(T0 + 30_000);
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});
		expect(command).toHaveBeenCalledTimes(1);

		vi.setSystemTime(T0 + 61_000);
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(command).toHaveBeenCalledTimes(2);
		expect(command).toHaveBeenLastCalledWith({ type: "github", request: REQUEST, background: true });
		expect(seen?.data).toEqual([{ number: 2 }]);
		expect(seen?.loading).toBe(false);
	});

	it("GitHub holding the read is a time, never an error", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
		const message = "rate limit reached; paused until 2026-11-25T10:31:00.000Z";
		Object.assign(window, {
			omp: {
				rpc: {
					command: vi.fn(async () => ({
						type: "response",
						command: "github",
						success: false,
						error: message,
						code: "gh_paused",
					})),
				},
			},
		});
		await mount("key-1");
		expect(seen?.error).toBeNull();
		expect(seen?.pausedUntil).toBe(Date.parse("2026-11-25T10:31:00.000Z"));
	});
});
