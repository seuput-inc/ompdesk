import { describe, expect, it, vi } from "vitest";
import {
	pickedMenuItems,
	type SessionMenuActions,
	type SessionMenuFacts,
	sessionMenuItems,
	sessionSwipeItems,
} from "./session-menu";

const t = (key: string, params?: Record<string, string | number>) =>
	params ? `${key}:${Object.values(params).join(",")}` : key;

const stored: SessionMenuFacts = {
	stored: true,
	hasTab: false,
	busy: false,
	tabFocused: false,
	tabInSplit: false,
	splitShown: false,
	canCloseTab: true,
	unread: false,
	chat: false,
	pinned: false,
	muted: false,
	archived: false,
	agentHidden: false,
	canMoveUp: true,
	canMoveDown: true,
};

const noop = () => {};
const every: SessionMenuActions = {
	openSplit: noop,
	openWindow: noop,
	splitTab: noop,
	unsplit: noop,
	closeTab: noop,
	rename: noop,
	togglePin: noop,
	toggleMute: noop,
	moveUp: noop,
	moveDown: noop,
	moveToProject: noop,
	toggleArchive: noop,
	toggleAgentHidden: noop,
	copyTitle: noop,
	reveal: noop,
	saveBundle: noop,
	remove: noop,
};

const build = (facts: Partial<SessionMenuFacts>, actions: SessionMenuActions = every, altHint = true) =>
	sessionMenuItems({ facts: { ...stored, ...facts }, actions, t, altHint, platform: "mac" });
const ids = (facts: Partial<SessionMenuFacts>, actions?: SessionMenuActions) =>
	build(facts, actions).map(item => item.id);

describe("sessionMenuItems", () => {
	it("lists a stored session no tab holds in groups: open, edit, copy title and show in folder, delete last", () => {
		const items = build({});
		expect(items.map(item => item.id)).toEqual([
			"session-open-split",
			"session-open-window",
			"session-rename",
			"session-pin",
			"session-mute",
			"session-move-up",
			"session-move-down",
			"session-move",
			"session-archive",
			"session-agent-hidden",
			"session-copy-title",
			"session-reveal",
			"session-delete",
		]);
		// Each group starts with a divider; no item inside a group has one.
		expect(items.filter(item => item.separatorBefore).map(item => item.id)).toEqual([
			"session-open-split",
			"session-rename",
			"session-copy-title",
			"session-delete",
		]);
		expect(items.at(-1)?.danger).toBe(true);
	});

	it("has no Open, Open in new tab or Copy path", () => {
		for (const id of ids({}, every)) expect(id).not.toMatch(/^session-(open|open-tab|copy-path)$/);
	});

	it("leaves out an action the list does not support instead of disabling it", () => {
		const host: SessionMenuActions = {
			...every,
			reveal: undefined,
			toggleAgentHidden: undefined,
			toggleMute: undefined,
		};
		expect(ids({}, host)).toEqual([
			"session-open-split",
			"session-open-window",
			"session-rename",
			"session-pin",
			"session-move-up",
			"session-move-down",
			"session-move",
			"session-archive",
			"session-copy-title",
			"session-delete",
		]);
		expect(ids({}, { remove: noop })).toEqual(["session-delete"]);
		expect(ids({}, {})).toEqual([]);
	});

	it("gives a session a tab holds its split and close items, not Open in split view, and one diagnostics item", () => {
		const held = build({ hasTab: true });
		expect(held.map(item => item.id)).toEqual([
			"session-open-window",
			"session-split-right",
			"session-split-bottom",
			"session-close-tab",
			"session-rename",
			"session-pin",
			"session-mute",
			"session-move-up",
			"session-move-down",
			"session-move",
			"session-archive",
			"session-agent-hidden",
			"session-copy-title",
			"session-reveal",
			"session-dump-bundle",
			"session-delete",
		]);
		// A tab's session cannot move to another project or be archived while the tab holds it.
		expect(held.find(item => item.id === "session-move")?.disabled).toBe(true);
		expect(held.find(item => item.id === "session-archive")?.disabled).toBe(true);
	});

	it("has no diagnostics item without a tab, and never a disabled stand-in or an anonymized twin", () => {
		expect(ids({ hasTab: false })).not.toContain("session-dump-bundle");
		expect(ids({ hasTab: true }).filter(id => id.includes("dump"))).toEqual(["session-dump-bundle"]);
	});

	it("saves the anonymized bundle when Option/Alt was held while choosing the diagnostics item", () => {
		const saveBundle = vi.fn();
		const item = build({ hasTab: true }, { saveBundle }).find(entry => entry.id === "session-dump-bundle");
		item?.onSelect({ altKey: false });
		item?.onSelect({ altKey: true });
		item?.onSelect();
		expect(saveBundle.mock.calls).toEqual([[false], [true], [false]]);
	});

	it("names the Alt variant as the item's hint: ⌥ on macOS, Alt on Windows, none on a touch screen", () => {
		const hint = (platform: "mac" | "windows", altHint = true) =>
			sessionMenuItems({
				facts: { ...stored, hasTab: true },
				actions: every,
				t,
				altHint,
				platform,
			}).find(item => item.id === "session-dump-bundle")?.hint;
		expect(hint("mac")).toBe("diagnosticBundle.anonymizeHint:⌥");
		expect(hint("windows")).toBe("diagnosticBundle.anonymizeHint:Alt");
		expect(hint("mac", false)).toBeUndefined();
	});

	it("offers Restore for an archived session no tab holds, Archive otherwise", () => {
		expect(ids({ archived: true })).toContain("session-restore");
		expect(ids({ archived: true })).not.toContain("session-archive");
		expect(ids({ archived: true, hasTab: true })).toContain("session-archive");
		expect(ids({ archived: false })).toContain("session-archive");
	});

	it("keeps pins on top: a move that would cross the pinned edge is disabled, not absent", () => {
		const items = build({ canMoveUp: false, canMoveDown: true });
		expect(items.find(item => item.id === "session-move-up")?.disabled).toBe(true);
		expect(items.find(item => item.id === "session-move-down")?.disabled).toBe(false);
	});

	it("has no Move to project… for a chat", () => {
		expect(ids({ chat: true })).not.toContain("session-move");
	});

	it("disables Close and Delete while the session runs, with the reason", () => {
		const items = build({ hasTab: true, busy: true });
		for (const id of ["session-close-tab", "session-delete"]) {
			const item = items.find(entry => entry.id === id);
			expect(item?.disabled).toBe(true);
			expect(item?.disabledReason).toBe("sidebar.menu.taskRunning");
		}
	});

	it("a row with no file yet (a new tab) has only what a tab can do: no edits, no delete", () => {
		expect(ids({ stored: false, hasTab: true })).toEqual([
			"session-split-right",
			"session-split-bottom",
			"session-close-tab",
			"session-agent-hidden",
			"session-dump-bundle",
		]);
	});

	it("offers Remove split while a split is on screen, and no split items for the focused tab or a pane already in it", () => {
		expect(ids({ hasTab: true, tabFocused: true, splitShown: true })).toEqual(
			expect.arrayContaining(["session-unsplit"]),
		);
		expect(ids({ hasTab: true, tabFocused: true })).not.toContain("session-split-right");
		expect(ids({ hasTab: true, tabInSplit: true, splitShown: true })).not.toContain("session-split-right");
		expect(ids({ hasTab: true, canCloseTab: false })).not.toContain("session-close-tab");
	});

	it("offers Mark as unread only for a tab out of view that carries no done mark", () => {
		const markUnread = vi.fn();
		const marking = { ...every, markUnread };
		const item = build({ hasTab: true }, marking).find(entry => entry.id === "session-mark-unread");
		expect(item?.label).toBe("sidebar.menu.markUnread");
		item?.onSelect();
		expect(markUnread).toHaveBeenCalledOnce();
		for (const facts of [
			{ hasTab: false },
			{ tabFocused: true },
			{ tabInSplit: true, splitShown: true },
			{ unread: true },
		])
			expect(ids({ hasTab: true, ...facts }, marking)).not.toContain("session-mark-unread");
	});

	it("opens and stops each port the open tab's processes listen on, lowest first, after the view group", () => {
		const openPort = vi.fn();
		const stopPort = vi.fn();
		const vite = { pid: 7, startedMs: 100, name: "node", ports: [5173] };
		const api = { pid: 9, name: "bun", ports: [3000] };
		const items = build({ hasTab: true, ports: [vite, api] }, { ...every, openPort, stopPort });
		const portIds = items.map(item => item.id).filter(id => id.startsWith("session-port"));
		expect(portIds).toEqual([
			"session-port-open-3000",
			"session-port-stop-3000",
			"session-port-open-5173",
			"session-port-stop-5173",
		]);
		expect(items.find(item => item.id === "session-port-open-3000")?.separatorBefore).toBe(true);
		// A process whose start nobody knows cannot be told from a later one with its id: it is not stopped from here.
		expect(items.find(item => item.id === "session-port-stop-3000")?.disabled).toBe(true);
		items.find(item => item.id === "session-port-open-5173")?.onSelect?.();
		items.find(item => item.id === "session-port-stop-5173")?.onSelect?.();
		expect(openPort).toHaveBeenCalledWith(5173);
		expect(stopPort).toHaveBeenCalledWith(vite, 5173);
		// A session no tab holds has no processes of its own to list.
		expect(ids({ ports: [vite] }, { ...every, openPort, stopPort }).some(id => id.startsWith("session-port"))).toBe(
			false,
		);
	});

	it("offers one Move to <computer> per connected paired computer after Archive, held back while the session runs", () => {
		const run = vi.fn();
		const handOff = {
			hosts: [
				{ id: "mini", name: "Mac mini" },
				{ id: "pc", name: "Desktop" },
			],
			run,
		};
		const items = build({}, { ...every, handOff });
		const at = items.findIndex(item => item.id === "session-archive");
		expect(items.slice(at + 1, at + 3).map(item => [item.id, item.label])).toEqual([
			["session-hand-off-mini", "sidebar.menu.handOff:Mac mini"],
			["session-hand-off-pc", "sidebar.menu.handOff:Desktop"],
		]);
		items[at + 2]?.onSelect();
		expect(run).toHaveBeenCalledWith("pc");
		const busy = build({ busy: true, hasTab: true }, { ...every, handOff }).find(
			item => item.id === "session-hand-off-mini",
		);
		expect(busy).toMatchObject({ disabled: true, disabledReason: "sidebar.menu.taskRunning" });
		// Paired, but none connected: one item that says why it cannot be taken.
		const none = build({}, { ...every, handOff: { hosts: [], run } }).filter(item =>
			item.id.startsWith("session-hand-off"),
		);
		expect(none).toMatchObject([
			{ id: "session-hand-off", disabled: true, disabledReason: "sidebar.handOff.noneOnline" },
		]);
		// A list that cannot hand off (a paired host's rows) has no such item at all.
		expect(ids({}).some(id => id.startsWith("session-hand-off"))).toBe(false);
	});
});

describe("pickedMenuItems", () => {
	it("archives only the picked rows no tab holds, refuses when every one is held, and deletes them all, last", () => {
		const actions = { toggleArchive: vi.fn(), remove: vi.fn() };
		const items = pickedMenuItems({ count: 3, archivable: 2, archived: false, actions, t });
		expect(items.map(item => [item.id, item.label, item.disabled ?? false])).toEqual([
			["picked-archive", "sidebar.menu.archiveCount:2", false],
			["picked-delete", "sidebar.menu.deleteCount:3", false],
		]);
		expect(items.at(-1)?.danger).toBe(true);
		const held = pickedMenuItems({ count: 2, archivable: 0, archived: false, actions, t });
		expect(held[0]?.disabled).toBe(true);
		expect(held[0]?.disabledReason).toBe("sidebar.archiveOpenTab");
		const restore = pickedMenuItems({ count: 2, archivable: 2, archived: true, actions, t });
		expect(restore[0]?.id).toBe("picked-restore");
	});
});

describe("sessionSwipeItems", () => {
	it("uncovers the row's enabled Mark as unread to the right and Archive or Restore to the left", () => {
		const outOfView = sessionSwipeItems(build({ hasTab: true }, { ...every, markUnread: noop }));
		expect(outOfView.leading?.id).toBe("session-mark-unread");
		// Archive is disabled while a tab holds the session, so the swipe leaves it out.
		expect(outOfView.trailing).toEqual([]);
		const archived = sessionSwipeItems(build({ archived: true }));
		expect(archived.leading).toBeUndefined();
		expect(archived.trailing.map(item => item.id)).toEqual(["session-restore"]);
		expect(sessionSwipeItems(build({})).trailing.map(item => item.id)).toEqual(["session-archive"]);
	});
});
