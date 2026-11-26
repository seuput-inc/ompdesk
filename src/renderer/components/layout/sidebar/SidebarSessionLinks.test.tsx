/**
 * Session links on a row: its words read the store, which reads each computer's links once and again on each change
 * push naming that computer; the dialog adds a pasted link, removes one with its ✕ and opens one in the browser, on
 * the computer that runs the session.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLink, SessionLinksCommand } from "../../../../shared/session-links";
import { I18nProvider, useT } from "../../../lib/i18n";
import { useAllSessionLinks, useSessionLinksStore } from "../../../stores/session-links";
import { SessionLinksDialog, sessionLinksWords } from "./SidebarSessionLinks";

/** A row's tooltip words for PATH, as the sidebar builds them (a paired host's section passes its id). */
function RowWords({ device }: { device?: string }) {
	const t = useT();
	return <span data-session-links>{sessionLinksWords(t, useAllSessionLinks(device)[PATH] ?? []) ?? ""}</span>;
}

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};
// React-DOM's input-event polyfill hooks the legacy propertychange API; typing works without it.
if (typeof elementPrototype.attachEvent !== "function") elementPrototype.attachEvent = () => {};
if (typeof elementPrototype.detachEvent !== "function") elementPrototype.detachEvent = () => {};

const PATH = "/s/a.jsonl";
const PR: SessionLink = { url: "https://github.com/acme/api/pull/12", kind: "pr", repo: "acme/api", number: 12 };
const PAGE: SessionLink = { url: "https://example.com/spec", kind: "url" };

const HOST = "host-1";
/** Each computer's links (`""` this one). */
let stored: Record<string, Record<string, SessionLink[]>> = {};
let changed: ((change: { device?: string }) => void) | null = null;
const omp = {
	sessions: {
		links: vi.fn(async (command: SessionLinksCommand, device?: string) =>
			command.type === "session_links"
				? (stored[device ?? ""] ?? {})
				: command.type === "session_link_add"
					? PAGE
					: [],
		),
	},
	events: {
		onSessionLinksChanged: vi.fn((callback: (change: { device?: string }) => void) => {
			changed = callback;
			return () => {
				changed = null;
			};
		}),
	},
	system: { openExternal: vi.fn(async (_url: string) => {}) },
};
Reflect.set(window, "omp", omp);

let container: HTMLElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

async function dispatch(target: EventTarget, event: Event): Promise<void> {
	await act(async () => {
		target.dispatchEvent(event);
	});
	await flush();
}

beforeEach(() => {
	stored = { "": { [PATH]: [PR, PAGE] }, [HOST]: { [PATH]: [PR] } };
	vi.clearAllMocks();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const node of [...document.body.childNodes]) node.remove();
	useSessionLinksStore.getState().reset();
});

describe("session links on a row", () => {
	it("says the links in the row's words, and follows each change push", async () => {
		await mount(<RowWords />);
		const words = () => container.querySelector("[data-session-links]")?.textContent;
		expect(words()).toBe(`2 linked\nacme/api#12\n${PAGE.url}`);
		expect(omp.sessions.links).toHaveBeenCalledTimes(1);

		stored[""] = { [PATH]: [PAGE] };
		await act(async () => changed?.({}));
		await flush();
		expect(words()).toContain("1 linked");

		stored[""] = {};
		await act(async () => changed?.({}));
		await flush();
		expect(words()).toBe("");
	});

	it("reads a paired host's row from that host, and follows only that host's pushes", async () => {
		await mount(<RowWords device={HOST} />);
		const words = () => container.querySelector("[data-session-links]")?.textContent;
		expect(words()).toBe("1 linked\nacme/api#12");
		expect(omp.sessions.links).toHaveBeenCalledWith({ type: "session_links" }, HOST);

		// This computer's change is not the host's: nothing is read for the host's row.
		await act(async () => changed?.({}));
		await flush();
		expect(omp.sessions.links).toHaveBeenCalledTimes(1);

		stored[HOST] = { [PATH]: [PR, PAGE] };
		await act(async () => changed?.({ device: HOST }));
		await flush();
		expect(words()).toContain("2 linked");
	});
});

describe("SessionLinksDialog", () => {
	it("adds a pasted https link, removes one, and opens one in the browser", async () => {
		await mount(<SessionLinksDialog onClose={() => {}} sessionPath={PATH} />);
		const dialog = document.querySelector("[data-session-links-dialog]");
		if (!dialog) throw new Error("dialog not found");
		expect(dialog.querySelectorAll("[data-session-link]")).toHaveLength(2);

		const input = dialog.querySelector("input");
		if (!input) throw new Error("input not found");
		await dispatch(input, new Event("focusin", { bubbles: true }));
		let proto: object | null = Object.getPrototypeOf(input);
		let setter: ((value: string) => void) | undefined;
		while (proto && !setter) {
			setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
			proto = Object.getPrototypeOf(proto);
		}
		setter?.call(input, ` ${PAGE.url} `);
		await dispatch(input, new Event("input", { bubbles: true }));
		await dispatch(input, new Event("keyup", { bubbles: true }));
		await dispatch(dialog, new Event("submit", { bubbles: true, cancelable: true }));
		expect(omp.sessions.links).toHaveBeenCalledWith(
			{ type: "session_link_add", sessionPath: PATH, url: PAGE.url },
			undefined,
		);

		const pr = dialog.querySelector(`[data-session-link="${PR.url}"]`);
		const buttons = pr?.querySelectorAll("button") ?? [];
		expect(buttons[0]?.textContent).toBe("acme/api#12");
		await dispatch(buttons[0] as unknown as EventTarget, new Event("click", { bubbles: true }));
		expect(omp.system.openExternal).toHaveBeenCalledWith(PR.url);
		await dispatch(buttons[1] as unknown as EventTarget, new Event("click", { bubbles: true }));
		expect(omp.sessions.links).toHaveBeenCalledWith(
			{ type: "session_link_remove", sessionPath: PATH, url: PR.url },
			undefined,
		);
	});

	it("changes a paired host's session on that host", async () => {
		await mount(<SessionLinksDialog device={HOST} onClose={() => {}} sessionPath={PATH} />);
		const dialog = document.querySelector("[data-session-links-dialog]");
		if (!dialog) throw new Error("dialog not found");
		const pr = dialog.querySelector(`[data-session-link="${PR.url}"]`);
		expect(dialog.querySelectorAll("[data-session-link]")).toHaveLength(1);
		const remove = pr?.querySelectorAll("button")[1];
		await dispatch(remove as unknown as EventTarget, new Event("click", { bubbles: true }));
		expect(omp.sessions.links).toHaveBeenCalledWith(
			{ type: "session_link_remove", sessionPath: PATH, url: PR.url },
			HOST,
		);
	});

	it("refuses text that is no https link before anything is sent", async () => {
		await mount(<SessionLinksDialog onClose={() => {}} sessionPath={PATH} />);
		const dialog = document.querySelector("[data-session-links-dialog]");
		if (!dialog) throw new Error("dialog not found");
		await dispatch(dialog, new Event("submit", { bubbles: true, cancelable: true }));
		expect(omp.sessions.links).toHaveBeenCalledTimes(1);
	});
});
