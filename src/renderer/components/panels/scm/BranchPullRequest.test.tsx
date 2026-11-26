/**
 * The Changes panel's branch PR (linkedom): the PR `pr_for_branch` names, with its state and its checks' line; a
 * branch with none offers to link one for the session; a repository GitHub cannot read shows nothing.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubBranchPr } from "../../../../shared/github";
import type { RpcCommand } from "../../../../shared/rpc-types";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});

// react-dom must load after linkedom's globals above, so these imports cannot be static.
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("../../../lib/i18n");
const { useSessionStore } = await import("../../../stores/session");
const { useSessionLinksStore } = await import("../../../stores/session-links");
const { BranchPullRequest } = await import("./BranchPullRequest");

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
	checks: { success: 2, failure: 1, pending: 0 },
	state: "OPEN",
};

let root: Root | undefined;

function install(answer: () => Promise<unknown>): void {
	const command = vi.fn(async (cmd: RpcCommand) =>
		cmd.type === "github"
			? answer().then(
					data => ({ type: "response", command: "github", success: true, data }),
					error => ({ type: "response", command: "github", success: false, error: String(error) }),
				)
			: { type: "response", command: cmd.type, success: true, data: {} },
	);
	Object.assign(window, {
		omp: {
			rpc: { command },
			sessions: { links: vi.fn(async () => ({})) },
			events: { onSessionLinksChanged: () => () => {} },
		},
	});
}

async function mount(): Promise<string> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () => root?.render(<I18nProvider>{<BranchPullRequest branch="feat" />}</I18nProvider>));
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
	return host.textContent ?? "";
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	useSessionStore.setState({ sessionFile: null });
	useSessionLinksStore.getState().reset();
});

describe("BranchPullRequest", () => {
	it("shows the branch's PR, its state and its failing checks", async () => {
		install(async () => PR);
		const text = await mount();
		expect(text).toContain("#7 Add a thing");
		expect(text).toContain("open");
		expect(text).toContain("1 failing checks");
	});

	it("offers to link a PR for the session when the branch has none", async () => {
		useSessionStore.setState({ sessionFile: "/s/a.jsonl" });
		install(async () => null);
		const text = await mount();
		expect(text).toContain("No pull request for this branch");
		expect(text).toContain("Link a pull request");
	});

	it("shows nothing when GitHub cannot be read for the checkout", async () => {
		useSessionStore.setState({ sessionFile: "/s/a.jsonl" });
		install(async () => Promise.reject(new Error("no_github_remote")));
		expect(await mount()).toBe("");
	});
});
