/**
 * LinkPeek (linkedom): a GitHub issue or pull request link asks `item_peek` for its repository and number (and its
 * Enterprise host, never github.com's); any other https link asks the core's `web_peek` for the page without its
 * fragment; an answer is kept, so the same link shown again asks nothing.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GithubLib from "../../lib/github";

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

const github = vi.fn();
vi.mock("../../lib/github", async importOriginal => ({
	...(await importOriginal<typeof GithubLib>()),
	github: (...args: unknown[]) => github(...args),
}));
const command = vi.fn();
Object.assign(window, { omp: { rpc: { command } } });

// react-dom must load after linkedom's globals above, so these imports cannot be static.
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("../../lib/i18n");
const { LinkPeek } = await import("./LinkPeek");

let root: Root | undefined;

beforeEach(() => {
	github.mockReset();
	command.mockReset();
	// linkedom knows no `:focus-visible`: every focus here comes from the keyboard.
	const matches = HTMLElement.prototype.matches;
	vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
		return selector === ":focus-visible" ? true : matches.call(this, selector);
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

/** Mounts the link and focuses it from the keyboard, which opens its card at once. */
async function peek(href: string): Promise<string> {
	await act(async () => root?.unmount());
	document.body.innerHTML = "";
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<LinkPeek href={href}>
					<a href={href}>link</a>
				</LinkPeek>
			</I18nProvider>,
		),
	);
	const link = host.querySelector("a") as unknown as HTMLElement;
	await act(async () => link.dispatchEvent(new Event("focusin", { bubbles: true })));
	// The card's body loads on first use (React.lazy): let it arrive and render.
	await act(async () => {
		await import("./LinkPeekCard");
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
	return document.querySelector("[data-hover-card]")?.textContent ?? "";
}

const item = {
	number: 12,
	title: "Peek at links",
	state: "OPEN",
	isPr: true,
	isDraft: false,
	author: "octocat",
	comments: 3,
	url: "https://github.com/octo/app/pull/12",
	updatedAt: "2026-11-26T00:00:00Z",
};

describe("LinkPeek", () => {
	it("reads a GitHub pull request with item_peek for its repository and number, not the web page", async () => {
		github.mockResolvedValue(item);
		const text = await peek("https://github.com/octo/app/pull/12/files#diff");
		expect(github).toHaveBeenCalledTimes(1);
		expect(github.mock.calls[0]?.[0]).toEqual({ op: "item_peek", number: 12, repo: "octo/app" });
		expect(command).not.toHaveBeenCalled();
		expect(text).toContain("Peek at links");
		expect(text).toContain("#12");
	});

	it("names an Enterprise host, and an issue link asks the same way", async () => {
		github.mockResolvedValue({ ...item, number: 5, isPr: false, title: "An issue" });
		await peek("https://ghe.corp.example/team/tool/issues/5");
		expect(github.mock.calls[0]?.[0]).toEqual({
			op: "item_peek",
			number: 5,
			repo: "team/tool",
			host: "ghe.corp.example",
		});
	});

	it("reads any other https page through the core's web_peek, once while its answer is kept", async () => {
		command.mockResolvedValue({
			success: true,
			data: { title: "Example docs", description: "What the page says about itself." },
		});
		const text = await peek("https://docs.example.org/guide?lang=en#install");
		expect(command).toHaveBeenCalledTimes(1);
		expect(command.mock.calls[0]?.[0]).toEqual({ type: "web_peek", url: "https://docs.example.org/guide?lang=en" });
		expect(github).not.toHaveBeenCalled();
		expect(text).toContain("Example docs");
		expect(text).toContain("What the page says about itself.");
		// The same page again, its card mounted afresh: the kept answer paints and nothing is asked.
		const again = await peek("https://docs.example.org/guide?lang=en#other");
		expect(command).toHaveBeenCalledTimes(1);
		expect(again).toContain("Example docs");
	});

	it("shows no card for plain http, a bare host or a local link", async () => {
		for (const href of ["http://example.org/", "https://intranet/", "https://192.168.0.1/", "local://notes.md"]) {
			expect(await peek(href)).toBe("");
		}
		expect(command).not.toHaveBeenCalled();
		expect(github).not.toHaveBeenCalled();
	});
});
