/**
 * The sidebar's Bots section: a bot's row says its second line and unfolds to its chats, the options re-sort it, and
 * its menu deletes it through the core after asking.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotsState } from "../../../../shared/bots";
import type { RemoteState } from "../../../../shared/ipc-types";
import { I18nProvider } from "../../../lib/i18n";
import { listedBots, useBotsStore } from "../../../stores/bots";
import { useBotsView } from "../../../stores/bots-view";
import { useRemoteStore } from "../../../stores/remote";
import { type BotFacts, botFacts } from "../../bots/bot-view";
import { type SidebarBotEntry, SidebarBots } from "./SidebarBots";

const { document, window, Event, CustomEvent, HTMLElement, Node, MouseEvent } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.MouseEvent = MouseEvent ?? Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

const bot = (id: string, name: string, over: Partial<Bot> = {}): Bot => ({
	id,
	name,
	folder: `/b/${id}`,
	home: null,
	sessions: [],
	paused: false,
	model: null,
	autoApprove: false,
	reach: [],
	staleDays: 7,
	lookAround: null,
	tidy: null,
	quiet: [],
	createdAt: "2026-11-01T00:00:00.000Z",
	...over,
});

const command = vi.fn(async (_request: unknown): Promise<BotsState> => ({ bots: [], items: [] }));
Reflect.set(window, "omp", { bots: { command, onState: () => () => {} } });

let container: HTMLElement;
let root: Root;

async function render(entries: SidebarBotEntry[]): Promise<void> {
	await act(async () => {
		root.render(
			<I18nProvider>
				<SidebarBots entries={entries} filtering={false} />
			</I18nProvider>,
		);
	});
}

async function click(target: Element | null | undefined, event = "click"): Promise<void> {
	if (!target) throw new Error(`no target for ${event}`);
	await act(async () => {
		target.dispatchEvent(new Event(event, { bubbles: true, cancelable: true }));
	});
}

const entry = (value: Bot, facts: BotFacts, chats = 0): SidebarBotEntry => ({
	bot: value,
	facts,
	chats: chats > 0 ? <div data-test-chat>chat of {value.name}</div> : null,
	chatCount: chats,
	current: false,
});

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	command.mockClear();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const node of [...document.body.childNodes]) node.remove();
	useBotsView.getState().reset();
	useBotsStore.getState().reset();
	useRemoteStore.getState().reset();
});

describe("SidebarBots", () => {
	it("says each bot's second line, unfolds its chats and sorts by name on request", async () => {
		const zed = bot("z", "Zed", { specialty: "Reviews pull requests." });
		const ada = bot("a", "Ada", { paused: true });
		useBotsStore.setState({ state: { bots: [zed, ada], items: [] } });
		const zedFacts = botFacts(zed, [], 0);
		await render([
			entry(zed, { ...zedFacts, line: { kind: "purpose", text: "Reviews pull requests." } }, 1),
			entry(ada, botFacts(ada, [], 0)),
		]);
		const names = () =>
			[...container.querySelectorAll("[data-bot-row]")].map(row => row.getAttribute("data-bot-row"));
		// Manual order with no saved order: the newest first (equal here), then as given.
		expect(container.querySelector('[data-bot-entry="z"] [data-bot-line]')?.textContent).toBe(
			"Reviews pull requests.",
		);
		expect(container.querySelector('[data-bot-entry="a"] [data-bot-line]')?.textContent).toBe("Paused");
		expect(container.querySelector('[data-bot-entry="a"] [data-bot-paused]')).not.toBeNull();
		expect(container.querySelector("[data-test-chat]")).toBeNull();
		await click(container.querySelector('[data-bot-fold="z"]'));
		expect(useBotsView.getState().open).toEqual(["z"]);
		expect(container.querySelector("[data-test-chat]")?.textContent).toBe("chat of Zed");
		await act(async () => useBotsView.getState().setSort("name"));
		expect(names()).toEqual(["a", "z"]);
	});

	it("shows one card that makes the first bot while there is none", async () => {
		await render([]);
		expect(container.querySelector("[data-sidebar-bots-empty]")?.textContent).toContain("Your AI teammate");
	});

	it("lists a paired host's bot with its host's name, greyed and refusing changes while the host is offline", async () => {
		const ada = bot("a", "Ada");
		const rex = bot("r", "Rex");
		const asking = {
			id: "item-r1",
			bot: "r",
			number: 1,
			session: "/h/rex.jsonl",
			title: "Pick a day",
			status: "needs_you" as const,
			links: [],
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-01T00:00:00.000Z",
			events: [],
			version: 1,
		};
		useBotsStore.setState({
			state: listedBots({
				bots: [ada],
				items: [],
				remote: [{ device: "dev-a", name: "Mini", online: false, bots: [rex], items: [asking] }],
			}),
		});
		useRemoteStore.setState({
			state: { hosts: [{ deviceId: "dev-a", name: "Mini", state: "offline" }] } as unknown as RemoteState,
			downSince: { "dev-a": Date.now() - 60_000 },
		});
		const listed = useBotsStore.getState().state;
		expect(listed.bots.map(known => [known.id, known.device])).toEqual([
			["a", undefined],
			["r", "dev-a"],
		]);
		expect(listed.items[0]?.device).toBe("dev-a");
		await render([entry(ada, botFacts(ada, [], 0)), entry(listed.bots[1] as Bot, botFacts(rex, [], 1))]);
		expect(container.querySelector('[data-bot-entry="a"] [data-bot-owner]')).toBeNull();
		expect(container.querySelector('[data-bot-entry="r"] [data-bot-owner="dev-a"]')?.textContent).toBe(
			"Mini · offline",
		);
		expect(container.querySelector('[data-bot-entry="r"] .opacity-60')).not.toBeNull();
		// Nothing is written here: a change to the host's item is refused before it leaves, naming the host.
		await expect(
			useBotsStore.getState().command({ action: "item", id: "item-r1", answer: { choice: 0 } }),
		).rejects.toThrow("Mini is offline");
		expect(command).not.toHaveBeenCalled();
	});
});
