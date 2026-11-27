import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_CREATE_REFUSED, BOT_PURPOSE_MAX } from "../../../shared/bots";
import { I18nProvider } from "../../lib/i18n";
import type { NewBotDraft } from "./bot-launch";
import { BOT_TEMPLATES } from "./bot-templates";
import { NewBotDialog } from "./NewBotDialog";

const create = vi.hoisted(() => vi.fn());
vi.mock("./bot-launch", () => ({ createBot: create, openBotDialog: vi.fn() }));
vi.mock("../../stores/bots", () => ({
	useBotsStore: (select: (store: unknown) => unknown) => select({ state: { bots: [{ name: "Courier" }] } }),
}));
vi.mock("../../stores/remote", () => ({
	usePairedHosts: () => [{ deviceId: "studio", name: "Studio", state: "online", platform: "darwin" }],
	useRemoteStore: (select: (store: unknown) => unknown) =>
		select({ state: { host: { name: "Desk" } }, awaitingReconnectState: false }),
}));

const dom = parseHTML("<html><body></body></html>");
const { document, window, Event, HTMLElement, Element, Node } = dom;
const folder = vi.fn(
	async (name: string, _device?: string): Promise<{ folder: string; peerCreate?: true }> => ({
		folder: `/bots/${name}`,
		peerCreate: true,
	}),
);
const models = vi.fn(async (device?: string) => ({
	roles: [
		{
			id: "writer",
			name: device ? "Studio writer" : "Desk writer",
			section: "chat",
			candidates: [],
			effective: { model: "sample/writer" },
		},
	],
}));
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
			system: { info: async () => ({ platform: "win32" }) },
			bots: {
				createModels: models,
				createFolder: folder,
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
	it("keeps a host with only folder preview unavailable without sending a create", async () => {
		folder.mockImplementationOnce(async () => ({ folder: "/local" }));
		folder.mockImplementationOnce(async () => ({ folder: "/old" }));
		await mount({ device: "studio", name: "Courier" });
		expect(field('option[value="studio"]').hasAttribute("disabled")).toBe(true);
		expect(field('option[value="studio"]').textContent).toContain("Update OMPdesk");
		await send("form", "submit");
		expect(create).not.toHaveBeenCalled();
	});
	it("names the computer where template routines can first be turned on", async () => {
		const template = BOT_TEMPLATES.find(item => item.routines.length > 0);
		if (!template) throw new Error("No template with a routine");
		await mount({ device: "studio", template: { template, line: "Watch changes" } });
		expect(document.body.textContent).toContain("Routines start off. Turn them on at Studio.");
	});
	it("changes the model list and name availability to the selected computer", async () => {
		await mount({ name: "Courier" });
		expect(field("input").getAttribute("aria-invalid")).toBe("true");
		await send('button[id$="-model"]', "click");
		expect(document.body.textContent).toContain("Desk writer");
		Object.defineProperty(field("select"), "value", { configurable: true, value: "studio" });
		await send("select", "change");
		expect(field("input").hasAttribute("aria-invalid")).toBe(false);
		await send('button[id$="-model"]', "click");
		expect(document.body.textContent).toContain("Studio writer");
		expect(document.body.textContent).not.toContain("Desk writer");
	});
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
	it.each([
		["This computer cannot create the bots of this computer.", "Update that computer"],
		['There is already a bot named "Courier".', "Choose another name"],
		["[remote_limit_reached] daily limit", "after midnight"],
		["This device's request limit for today on this computer's models is used up.", "requests-per-day limit"],
		["This device's token limit for today on this computer's models is used up.", "tokens-per-day limit"],
		["remote is offline", "Reconnect"],
		[`${BOT_CREATE_REFUSED}No space available.`, "No bot was created. Reason: No space available."],
		["request timed out", "Check its bot list before trying again. request timed out"],
	])("explains %s without discarding the selected computer or name", async (reason, expected) => {
		create.mockRejectedValueOnce(new Error(reason));
		await mount({ device: "studio", name: "Courier" });
		await send("form", "submit");
		expect(field('[role="alert"]').textContent).toContain("Studio");
		expect(field('[role="alert"]').textContent).toContain(expected);
		expect((field("input") as unknown as HTMLInputElement).value).toBe("Courier");
		expect(close).not.toHaveBeenCalled();
	});
	it("retains the remote draft when creation is refused", async () => {
		create.mockRejectedValueOnce(new Error("Studio refused the request"));
		const draft = { device: "studio", name: "Courier", purpose: "Deliver notes", model: "@writer" };
		await mount(draft);
		await send("form", "submit");
		expect(create).toHaveBeenCalledWith(expect.objectContaining(draft));
		expect(document.body.textContent).toContain("Studio refused the request");
		expect((field("input") as unknown as HTMLInputElement).value).toBe(draft.name);
		expect((field("textarea") as unknown as HTMLTextAreaElement).value).toBe(draft.purpose);
		expect(close).not.toHaveBeenCalled();
		await send("form", "submit");
		expect(create.mock.lastCall?.[0]).toMatchObject(draft);
	});
});
