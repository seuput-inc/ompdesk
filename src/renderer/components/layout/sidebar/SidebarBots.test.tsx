/**
 * The sidebar's Bots section: a bot's row says its second line and unfolds to its chats, the options re-sort it, and
 * its menu deletes it through the core after asking.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotDeletePreview, BotsState } from "../../../../shared/bots";
import type { RemoteState } from "../../../../shared/ipc-types";
import { I18nProvider, loadLocale, setLanguageOverride } from "../../../lib/i18n";
import { lastRead } from "../../../lib/last-read";
import { listedBots, useBotsStore } from "../../../stores/bots";
import { useBotsView } from "../../../stores/bots-view";
import { useRemoteStore } from "../../../stores/remote";
import { useToastStore } from "../../../stores/toast";
import { BotDialogs } from "../../bots/BotDialogs";
import { openBotDialog, useBotDialogs } from "../../bots/bot-launch";
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
const deletePreview = vi.fn<(request: { id: string }) => Promise<BotDeletePreview>>();
Reflect.set(window, "omp", { bots: { command, deletePreview, onState: () => () => {} } });

let container: HTMLElement;
let root: Root;

async function render(entries: SidebarBotEntry[]): Promise<void> {
	await act(async () => {
		root.render(
			<I18nProvider>
				<SidebarBots entries={entries} filtering={false} />
				<BotDialogs />
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
	deletePreview.mockReset();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const node of [...document.body.childNodes]) node.remove();
	useBotsView.getState().reset();
	useBotsStore.getState().reset();
	useRemoteStore.getState().reset();
	useBotDialogs.getState().close();
	useToastStore.setState({ toasts: [] });
	setLanguageOverride(null);
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
		const row = container.querySelector('[data-bot-row="z"]');
		const detail = document.getElementById(row?.getAttribute("aria-describedby") ?? "");
		expect(detail?.querySelector("time")?.textContent).toBeTruthy();
		expect(detail?.textContent).toContain("Reviews pull requests.");
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

describe("bot deletion confirmation", () => {
	const preview = { chats: 1, workers: 2, kept: 3, digest: "a".repeat(64) };

	async function open(lang: "en" | "ko", onDeleted?: () => void) {
		await loadLocale(lang);
		setLanguageOverride(lang);
		openBotDialog({ kind: "delete", bot: bot("a", "Ada"), onDeleted });
		await render([]);
	}

	const dialog = () => document.querySelector('[role="dialog"]');
	const button = (label: string) =>
		[...(dialog()?.querySelectorAll("button") ?? [])].find(b => b.textContent === label);

	it("waits for the preview, hides every zero line and keeps the folder and memory", async () => {
		const pending = Promise.withResolvers<BotDeletePreview>();
		deletePreview.mockReturnValueOnce(pending.promise);
		const ada = bot("a", "Ada");
		useBotsStore.setState({ state: { bots: [ada], items: [] } });
		await render([entry(ada, botFacts(ada, [], 0))]);
		await click(container.querySelector('[data-bot-row="a"]'), "contextmenu");
		await click([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === "Delete bot…"));
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(deletePreview).toHaveBeenCalledWith({ id: "a" });
		expect(button("Delete bot")?.hasAttribute("disabled")).toBe(true);
		await act(async () => pending.resolve({ ...preview, chats: 0, workers: 0, kept: 0 }));
		expect(dialog()?.querySelectorAll("[data-bot-delete-count]")).toHaveLength(0);
		expect(dialog()?.textContent).toContain("permanently deletes the bot, its routines and the transcripts");
		expect(dialog()?.textContent).not.toContain("Handed-over sessions");
		expect(dialog()?.textContent).toContain("The folder and its memory files will stay at /b/a.");
		await click(button("Cancel"));
		expect(command).not.toHaveBeenCalled();
	});

	it.each([
		{
			lang: "en" as const,
			chats: "Bot chats to delete: 1",
			workers: "Bot-created workers to delete: 2",
			kept: "Sessions to keep: 3",
			handed: "ordinary sessions",
			other: "Other bots keep their chats",
			unknown: "unknown origin",
			permanent: "permanently",
			confirm: "Delete bot",
		},
		{
			lang: "ko" as const,
			chats: "삭제할 봇 채팅: 1개",
			workers: "봇이 만든 워커 2개 삭제",
			kept: "남겨 둘 세션: 3개",
			handed: "일반 세션",
			other: "다른 봇의 채팅은 그 봇에 남고",
			unknown: "누가 만들었는지 알 수 없는",
			permanent: "영구히",
			confirm: "봇 삭제",
		},
	])("shows both deleted and kept counts in $lang and submits the exact plan", async row => {
		deletePreview.mockResolvedValueOnce(preview);
		const done = vi.fn();
		await open(row.lang, done);
		for (const kind of ["chats", "workers", "kept"] as const)
			expect(dialog()?.querySelector(`[data-bot-delete-count="${kind}"]`)?.textContent).toBe(row[kind]);
		expect(dialog()?.textContent).toContain("/b/a");
		expect(dialog()?.textContent).toContain(row.permanent);
		for (const note of [row.handed, row.other, row.unknown]) expect(dialog()?.textContent).toContain(note);
		expect(command).not.toHaveBeenCalled();
		await click(button(row.confirm));
		expect(command).toHaveBeenCalledWith({ action: "delete", id: "a", expected: preview });
		expect(done).toHaveBeenCalledOnce();
		expect(dialog()).toBeNull();
	});

	it("reports a failed preview without offering deletion", async () => {
		deletePreview.mockRejectedValueOnce(new Error("Host unavailable"));
		await open("en");
		expect(button("Delete bot")?.disabled).toBe(true);
		expect(dialog()?.textContent).toContain("reopen");
		expect(command).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts).toMatchObject([
			{ variant: "error", title: "Couldn't preview bot deletion" },
		]);
	});

	it("keeps a failed delete open without offering the old plan again", async () => {
		deletePreview.mockResolvedValueOnce({ ...preview, workers: 0, kept: 0 });
		command.mockRejectedValueOnce(new Error("Connection lost"));
		const done = vi.fn();
		await open("en", done);
		expect(dialog()?.querySelectorAll("[data-bot-delete-count]")).toHaveLength(1);
		await click(button("Delete bot"));
		expect(done).not.toHaveBeenCalled();
		expect(button("Delete bot")?.disabled).toBe(true);
		expect(dialog()?.textContent).toContain("reopen");
		expect(useToastStore.getState().toasts).toMatchObject([{ variant: "error", title: "Couldn't delete the bot" }]);
	});

	it.each([
		{
			lang: "en" as const,
			confirm: "Delete bot",
			changed: "sessions affected by this deletion changed",
			chats: 1,
			workers: 2,
			kept: 3,
		},
		{ lang: "ko" as const, confirm: "봇 삭제", changed: "남겨 둘 세션이 바뀌었어요", chats: 0, workers: 3, kept: 1 },
	])("requires another confirmation for a replacement plan in $lang", async row => {
		const replacement = { chats: row.chats, workers: row.workers, kept: row.kept, digest: "b".repeat(64) };
		const pending = Promise.withResolvers<BotsState>();
		deletePreview.mockResolvedValueOnce(preview);
		command.mockReturnValueOnce(pending.promise);
		const done = vi.fn();
		await open(row.lang, done);
		const original = dialog();
		const confirm = button(row.confirm);
		if (!confirm) throw new Error(`No ${row.confirm} button`);
		await act(async () => {
			confirm.click();
			confirm.click();
		});
		expect(command.mock.calls).toEqual([[{ action: "delete", id: "a", expected: preview }]]);
		expect(dialog()).toBe(original);
		expect(confirm.disabled).toBe(true);
		expect(button(row.lang === "en" ? "Cancel" : "취소")?.disabled).toBe(true);
		await act(async () => pending.resolve({ bots: [bot("a", "Ada")], items: [], deleteChanged: replacement }));
		expect(dialog()).toBe(original);
		expect(dialog()?.textContent).toContain(row.changed);
		for (const kind of ["chats", "workers", "kept"] as const) {
			const line = dialog()?.querySelector(`[data-bot-delete-count="${kind}"]`);
			if (replacement[kind]) expect(line?.textContent).toContain(String(replacement[kind]));
			else expect(line).toBeNull();
		}
		expect(useBotsStore.getState().state).not.toHaveProperty("deleteChanged");
		expect(lastRead<BotsState>(undefined, "bots")).not.toHaveProperty("deleteChanged");
		await act(async () => {
			confirm.dispatchEvent(Object.assign(new Event("click", { bubbles: true }), { detail: 2 }));
		});
		expect(command).toHaveBeenCalledOnce();
		expect(done).not.toHaveBeenCalled();
		await click(button(row.confirm));
		expect(command).toHaveBeenNthCalledWith(2, { action: "delete", id: "a", expected: replacement });
		expect(done).toHaveBeenCalledOnce();
		expect(dialog()).toBeNull();
	});

	it("does not let a late delete reply close a newer confirmation for the same bot", async () => {
		const pending = Promise.withResolvers<BotsState>();
		deletePreview.mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, kept: 4 });
		command.mockReturnValueOnce(pending.promise);
		const done = vi.fn();
		await open("en", done);
		await click(button("Delete bot"));
		await act(async () => openBotDialog({ kind: "delete", bot: bot("a", "Ada") }));
		await act(async () => pending.resolve({ bots: [], items: [] }));
		expect(dialog()?.textContent).toContain("Sessions to keep: 4");
		expect(done).not.toHaveBeenCalled();
		expect(command).toHaveBeenCalledOnce();
	});
});
