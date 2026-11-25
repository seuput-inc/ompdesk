/**
 * GithubRenderer (linkedom): the entity card's state chip reads in the UI's language, whatever GitHub word stock puts
 * there: a PR or issue state, a draft PR, or a run's conclusion; a state GitHub adds later as GitHub spells it. An
 * open pull request's card reads it again every minute and stops for good once it reads merged.
 */
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as GithubLib from "../../../lib/github";
import { I18nProvider, setLanguageOverride } from "../../../lib/i18n";
import type { ToolRendererProps } from "../ToolCard";

// No answer unless a test gives one: a card's own read never settles.
const github = vi.fn((..._args: unknown[]): Promise<unknown> => new Promise(() => {}));
vi.mock("../../../lib/github", async importOriginal => ({
	...(await importOriginal<typeof GithubLib>()),
	github: (...args: unknown[]) => github(...args),
}));

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// react-dom must load after linkedom's globals above, so these imports cannot be static.
const { createRoot } = await import("react-dom/client");
const { GithubRenderer } = await import("./GithubRenderer");

let root: Root | undefined;
let container: { remove: () => void } | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	setLanguageOverride(null);
});

async function chip(text: string, details: Record<string, unknown> = {}): Promise<string | undefined> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	container = host;
	root = createRoot(host as unknown as Element);
	const props = {
		args: { op: "pr_view", repo: "o/r" },
		result: { content: [{ type: "text", text }], details },
		isPartial: false,
	} as unknown as ToolRendererProps;
	await act(async () => root?.render(createElement(I18nProvider, null, createElement(GithubRenderer, props))));
	return host.querySelector(".rounded-full")?.textContent ?? undefined;
}

describe("GithubRenderer state chip", () => {
	it("names a draft PR and a run's conclusion in Korean, an unknown state as GitHub spells it", async () => {
		setLanguageOverride("ko");
		expect(await chip("# Pull Request #7: Add a thing\nState: DRAFT")).toBe("초안");
		await act(async () => root?.unmount());
		container?.remove();
		expect(await chip("# Pull Request #7: Add a thing", { conclusion: "timed_out" })).toBe("시간 초과");
		await act(async () => root?.unmount());
		container?.remove();
		expect(await chip("# Issue #3: Broken\nState: OPEN")).toBe("열림");
		await act(async () => root?.unmount());
		container?.remove();
		expect(await chip("# Issue #3: Broken\nState: BRAND_NEW")).toBe("brand new");
	});
});

describe("GithubRenderer open in browser", () => {
	it("is a named button, so a screen reader and the focus tooltip say what it opens", async () => {
		await chip("# Pull Request #7: Add a thing\nState: OPEN");
		const open = document.querySelector("[data-github-open]");
		expect(open?.tagName).toBe("BUTTON");
		expect(open?.getAttribute("aria-label")).toBe("Open in browser");
		expect(open?.getAttribute("type")).toBe("button");
	});
});

describe("GithubRenderer open an issue in the GitHub center", () => {
	it("asks Agents › GitHub for the issue of a github.com repository", async () => {
		const { useGithubNav } = await import("../../../stores/github-nav");
		const { useUiStore } = await import("../../../stores/ui");
		await chip("# Issue #3: Broken\nState: OPEN\nURL: https://github.com/o/r/issues/3");
		const open = document.querySelector("[data-github-issue-center]") as unknown as HTMLElement | null;
		expect(open?.getAttribute("aria-label")).toBe("Open in Agents › GitHub");
		await act(async () => open?.dispatchEvent(new Event("click", { bubbles: true })));
		expect(useGithubNav.getState().issue).toEqual({ repo: "o/r", number: 3 });
		expect(useUiStore.getState().agentsTab).toBe("github");
		useGithubNav.setState({ issue: null });
	});
});

describe("GithubRenderer live pull request", () => {
	const peek = (state: string, title: string) => ({
		number: 8,
		title,
		state,
		isPr: true,
		isDraft: false,
		author: "octocat",
		comments: 0,
		url: "https://github.com/o/r/pull/8",
		updatedAt: "2026-11-26T00:00:00Z",
	});

	it("reads an open PR again every minute while shown and stops once it is merged", async () => {
		vi.useFakeTimers();
		try {
			github.mockReset();
			github
				.mockResolvedValueOnce(peek("OPEN", "Add a thing, renamed"))
				.mockResolvedValueOnce(peek("MERGED", "Add a thing, renamed"))
				.mockImplementation(() => new Promise(() => {}));
			await chip("# Pull Request #8: Add a thing\nState: OPEN");
			const card = () => ({
				state: document.querySelector("[data-github-state]")?.getAttribute("data-github-state"),
				text: document.body.textContent ?? "",
			});
			expect(github).toHaveBeenCalledTimes(1);
			expect(github.mock.calls[0]).toEqual([{ op: "item_peek", number: 8, repo: "o/r" }, true]);
			expect(card().text).toContain("Add a thing, renamed");
			expect(card().state).toBe("open");
			await act(async () => vi.advanceTimersByTime(60_000));
			expect(github).toHaveBeenCalledTimes(2);
			expect(card().state).toBe("merged");
			await act(async () => vi.advanceTimersByTime(5 * 60_000));
			expect(github).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("never reads a PR the tool already saw merged or closed", async () => {
		github.mockClear();
		await chip("# Pull Request #9: Old\nState: MERGED");
		await act(async () => root?.unmount());
		container?.remove();
		await chip("# Pull Request #10: Gone\nState: CLOSED");
		expect(github).not.toHaveBeenCalled();
	});

	it("links owner/repo#n mentions in the tool's text", async () => {
		await chip("# Issue #3: Broken\nState: OPEN\nSee octo/app#42 and docs/readme.md");
		const mention = document.querySelector("[data-github-mention]");
		expect(mention?.getAttribute("href")).toBe("https://github.com/octo/app/issues/42");
		expect(mention?.textContent).toBe("octo/app#42");
	});
});
