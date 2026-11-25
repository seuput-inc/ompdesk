/**
 * PR Center actions (linkedom): merge with a chosen method after the dialog,
 * no merge for a closed PR, the conversation list with its review threads,
 * review posts, thread replies and resolves.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { GithubPrConversation } from "../../../../shared/github";
import type { RpcCommand, RpcPrDetail } from "../../../../shared/rpc-types";
import type { GithubLoad } from "../../../lib/github";
import { I18nProvider } from "../../../lib/i18n";
import { usePrCenterStore } from "../../../stores/pr-center";
import { useToastStore } from "../../../stores/toast";
import { PrMergeButton } from "./PrActions";
import { hunkTail, PrConversation, reviewFeedback } from "./PrConversation";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// react-dom must load after linkedom's globals above, so this import cannot be static.
const { createRoot } = await import("react-dom/client");

interface TestElement {
	disabled: boolean;
	checked: boolean;
	value: string;
	textContent: string | null;
	remove: () => void;
	dispatchEvent: (event: object) => boolean;
	getAttribute: (name: string) => string | null;
}

const DETAIL: RpcPrDetail = {
	number: 7,
	title: "Add a thing",
	url: "https://github.com/o/r/pull/7",
	isDraft: false,
	authorLogin: "me",
	body: "",
	baseRefName: "main",
	headRefName: "feat/thing",
	mergeStateStatus: "CLEAN",
	state: "OPEN",
	additions: 1,
	deletions: 0,
	reviewDecision: null,
	files: [],
	checks: [],
};

const CONVERSATION: GithubPrConversation = {
	id: "PR_7",
	bodyImages: {},
	comments: [
		{
			id: "IC_1",
			databaseId: 1,
			author: "alice",
			body: "Looks fine",
			createdAt: "2026-10-01T00:00:00Z",
			url: "",
			reactions: [],
		},
	],
	reviews: [
		{
			id: "R_1",
			author: "bob",
			body: "",
			state: "APPROVED",
			createdAt: "2026-10-02T00:00:00Z",
			url: "",
			reactions: [],
		},
	],
	threads: [
		{
			id: "T_1",
			isResolved: false,
			path: "a.ts",
			line: 3,
			diffHunk: "@@ -1,3 +1,3 @@\n a\n-b\n+c",
			comments: [
				{
					id: "RC_1",
					databaseId: 41,
					author: "carol",
					body: "nit",
					createdAt: "2026-10-03T00:00:00Z",
					url: "",
					reactions: [],
				},
			],
		},
	],
	timeline: [],
};

const loaded = (reload = vi.fn()): GithubLoad<GithubPrConversation> => ({
	data: CONVERSATION,
	error: null,
	errorCode: null,
	loading: false,
	pausedUntil: null,
	reload,
	refresh: vi.fn(),
});

let command: Mock<(cmd: RpcCommand) => Promise<unknown>>;
let root: Root;
let container: TestElement;

function install(): void {
	command = vi.fn(async (cmd: RpcCommand) => ({
		type: "response",
		command: cmd.type,
		success: true,
		data: cmd.type === "github" && cmd.request.op === "assignable" ? ["alice", "bob"] : {},
	}));
	(window as unknown as { omp: unknown }).omp = {
		rpc: {
			command,
			prList: vi.fn(async () => ({ success: true, data: [] })),
			prGet: vi.fn(async () => ({ success: true, data: DETAIL })),
		},
	};
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(node: React.ReactNode): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{node}</I18nProvider>);
	});
	await flush();
}

const queryAll = (selector: string) => Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
const buttonByText = (text: string, scope = "") =>
	queryAll(`${scope} button`).find(button => button.textContent?.trim() === text);
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}
const click = (element: TestElement) => dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
const sent = () => command.mock.calls.map(([cmd]) => cmd);

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	for (const node of queryAll("[role=dialog]")) node.remove();
	usePrCenterStore.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("PR Center actions", () => {
	it("merges with the chosen method and deletes the head branch on GitHub", async () => {
		install();
		usePrCenterStore.setState({ selected: 7 });
		await mount(<PrMergeButton detail={DETAIL} />);
		await click(buttonByText("Merge")!);
		// linkedom's <select> value is read-only: drive the controlled select's React onChange.
		const select = queryAll("[role=dialog] select")[0] as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(select).find(key => key.startsWith("__reactProps$"));
		const props = propsKey ? (select[propsKey] as { onChange?: (event: object) => void }) : undefined;
		await act(async () => props?.onChange?.({ target: { value: "squash" } }));
		await click(buttonByText("Squash and merge", "[role=dialog]")!);
		await flush();
		expect(sent()).toContainEqual({ type: "pr_merge", number: 7, method: "squash", deleteBranch: true });
		expect(useToastStore.getState().toasts.map(toast => toast.message)).toContain("PR #7 merged");
	});

	it("offers no merge on a merged pull request", async () => {
		install();
		await mount(<PrMergeButton detail={{ ...DETAIL, state: "MERGED" }} />);
		expect(buttonByText("Merge")).toBeUndefined();
	});

	it("lists the conversation with its threads and posts an approval", async () => {
		install();
		const reload = vi.fn();
		await mount(<PrConversation detail={DETAIL} load={loaded(reload)} />);
		const text = document.body.textContent ?? "";
		expect(text).toContain("Conversation (3)");
		expect(text).toContain("@alice");
		expect(text).toContain("Approved");
		expect(text).toContain("a.ts:3");
		expect(buttonByText("Comment")!.disabled).toBe(true);
		await click(buttonByText("Approve")!);
		await flush();
		expect(sent()).toContainEqual({ type: "pr_review", number: 7, event: "approve", body: "" });
		expect(reload).toHaveBeenCalled();
	});

	it("resolves a review thread by its id", async () => {
		install();
		const reload = vi.fn();
		await mount(<PrConversation detail={DETAIL} load={loaded(reload)} />);
		// An unresolved thread shows open.
		await click(buttonByText("Resolve", "[data-pr-thread]")!);
		await flush();
		expect(sent()).toContainEqual({
			type: "github",
			request: { op: "thread_resolve", threadId: "T_1", resolved: true },
		});
		expect(reload).toHaveBeenCalled();
	});
});

describe("hunkTail", () => {
	it("keeps a short hunk whole", () => {
		expect(hunkTail("@@ -1,2 +1,2 @@\n a\n b")).toBe("@@ -1,2 +1,2 @@\n a\n b");
	});

	it("moves the header's starts past the lines it leaves out", () => {
		const hunk = ["@@ -10,5 +20,5 @@", " one", "-two", "+deux", " three", " four"].join("\n");
		// Left out: " one" (both sides) and "-two" (old only): old starts at 12, new at 21.
		expect(hunkTail(hunk, 3)).toBe(["@@ -12,2 +21,3 @@", "+deux", " three", " four"].join("\n"));
	});
});

describe("reviewFeedback", () => {
	it("hands an agent what reviewers asked for: worded comments and reviews, unresolved threads with their line", () => {
		const resolved = { ...CONVERSATION.threads[0]!, id: "T_2", isResolved: true };
		const entries = reviewFeedback({ ...CONVERSATION, threads: [...CONVERSATION.threads, resolved] });
		expect(entries.map(entry => [entry.kind, entry.author, entry.body])).toEqual([
			["comment", "alice", "Looks fine"],
			["inline", "carol", "nit"],
		]);
		expect(entries[1]).toMatchObject({ path: "a.ts", line: 3 });
	});
});
