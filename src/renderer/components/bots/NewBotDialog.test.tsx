import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_PURPOSE_MAX } from "../../../shared/bots";
import { I18nProvider } from "../../lib/i18n";
import type { NewBotDraft } from "./bot-launch";
import { NewBotDialog } from "./NewBotDialog";

const create = vi.hoisted(() => vi.fn());
vi.mock("./bot-launch", () => ({ createBot: create, openBotDialog: vi.fn() }));
vi.mock("../../stores/bots", () => ({
	useBotsStore: (select: (store: unknown) => unknown) => select({ state: { bots: [{ name: "Courier" }] } }),
}));

const dom = parseHTML("<html><body></body></html>");
const { document, window, Event, HTMLElement, Element, Node } = dom;
let root: Root;
const close = vi.fn();

beforeEach(() => {
	Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
		fn(0);
		return 0;
	});
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
	Object.assign(window, {
		omp: {
			bots: {
				importSources: async () => ({ sources: [] }),
			},
		},
	});
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container as never);
});
afterEach(async () => {
	await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});
async function mount(draft: Partial<NewBotDraft>) {
	await act(async () =>
		root.render(
			<I18nProvider>
				<NewBotDialog draft={draft} onClose={close} />
			</I18nProvider>,
		),
	);
}
function field(selector: string) {
	const found = document.querySelector(selector);
	if (!found) throw new Error(`Missing ${selector}`);
	return found;
}
async function send(selector: string, type: string) {
	await act(async () => {
		field(selector).dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
	});
}

describe("NewBotDialog", () => {
	it.each([
		{ draft: { name: "" }, selector: "input" },
		{ draft: { name: "Writer", purpose: "x".repeat(BOT_PURPOSE_MAX + 1) }, selector: "textarea" },
	])("focuses $selector after invalid submit", async ({ draft, selector }) => {
		await mount(draft);
		const focus = vi.spyOn(field(selector) as unknown as HTMLElement, "focus");
		await send("form", "submit");
		expect(focus).toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});
	it("retains the draft when creation is refused", async () => {
		create.mockRejectedValueOnce(new Error("Creation refused"));
		const draft = { name: "Writer", purpose: "Deliver notes", model: "@writer" };
		await mount(draft);
		await send("form", "submit");
		expect(create).toHaveBeenCalledWith(expect.objectContaining(draft));
		expect(document.body.textContent).toContain("Creation refused");
		expect((field("input") as unknown as HTMLInputElement).value).toBe(draft.name);
		expect((field("textarea") as unknown as HTMLTextAreaElement).value).toBe(draft.purpose);
		expect(close).not.toHaveBeenCalled();
		await send("form", "submit");
		expect(create.mock.lastCall?.[0]).toMatchObject(draft);
	});
});
