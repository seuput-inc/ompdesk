import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot, BotsRequest, BotsState } from "../../../shared/bots";
import { I18nProvider } from "../../lib/i18n";
import { resetLastReadForTest } from "../../lib/last-read";
import { resetBotsForTest, useBotsStore } from "../../stores/bots";
import LegacyPeerRequests from "./LegacyPeerRequests";

const bot: Bot = {
	id: "courier",
	name: "Courier",
	legacyPeerRequest: "Desk",
	folder: "/bots/courier",
	home: null,
	sessions: [],
	paused: false,
	model: null,
	autoApprove: false,
	reach: [],
	staleDays: null,
	lookAround: null,
	tidy: null,
	quiet: [],
	createdAt: "2026-11-01T00:00:00Z",
};
const state: BotsState = { bots: [bot], items: [] };
const command = vi.fn<(request: BotsRequest) => Promise<BotsState>>();
let root: Root;

beforeEach(() => {
	const { window, document, HTMLElement, Event, Node } = parseHTML("<html><body></body></html>");
	const globals = { window, document, HTMLElement, Event, Node, IS_REACT_ACT_ENVIRONMENT: true };
	for (const [key, value] of Object.entries(globals)) {
		vi.stubGlobal(key, value);
	}
	Reflect.set(window, "omp", { bots: { command, onState: () => () => {} } });
	command.mockReset().mockResolvedValue(state);
	root = createRoot(globalThis.document.body);
});
afterEach(async () => {
	await act(async () => root.unmount());
	resetBotsForTest();
	resetLastReadForTest();
	vi.unstubAllGlobals();
});

async function mount() {
	await act(async () =>
		root.render(
			<I18nProvider>
				<LegacyPeerRequests />
			</I18nProvider>,
		),
	);
}
function choose(name: string) {
	const button = [...document.querySelectorAll("button")].find(b => b.textContent === name);
	if (!button) throw new Error(`Missing button: ${name}`);
	return act(async () => button.click());
}

it("keeps one row per local, unpaused bot awaiting its first access decision after repeated pushes", async () => {
	await mount();
	const pushed: BotsState = {
		bots: [
			bot,
			{ ...bot, id: "second" },
			{ ...bot, id: "off", paused: true },
			{ ...bot, id: "explicit", allPaired: false },
			{ ...bot, id: "list", reach: ["studio"] },
			{ ...bot, id: "unasked", legacyPeerRequest: undefined },
		],
		items: [],
		remote: [{ device: "away", name: "Away", online: true, bots: [{ ...bot, id: "remote" }], items: [] }],
	};
	for (let i = 0; i < 2; i++) await act(async () => useBotsStore.getState().receive(pushed));
	const rows = [...document.querySelectorAll("[data-legacy-peer-request]")];
	expect(rows.map(row => row.getAttribute("data-legacy-peer-request"))).toEqual(["courier", "second"]);
	expect(rows[0]?.textContent).toContain("A bot on “Desk” tried to message “Courier”");
});

it.each([
	["Allow paired computers", true],
	["Only me", false],
] as const)("saves %s for just this bot", async (name, allow) => {
	await mount();
	command.mockResolvedValueOnce({ bots: [{ ...bot, allPaired: allow }], items: [] });
	await choose(name);
	expect(command).toHaveBeenLastCalledWith({ action: "allowLegacyPeers", ids: [bot.id], allow });
	expect(document.querySelector("[data-legacy-peer-request]")).toBeNull();
});

it("leaves a failed choice available and drops a stale choice on refresh without replaying it", async () => {
	await mount();
	command.mockRejectedValueOnce(new Error("could not save"));
	await choose("Only me");
	expect(document.querySelector('[role="alert"]')?.textContent).toContain("Try again");
	command
		.mockRejectedValueOnce(new Error("already decided"))
		.mockResolvedValueOnce({ bots: [{ ...bot, allPaired: false }], items: [] });
	await choose("Allow paired computers");
	expect(document.querySelector("[data-legacy-peer-request]")).toBeNull();
	expect(command.mock.calls.map(([request]) => request.action)).toEqual([
		"get",
		"allowLegacyPeers",
		"get",
		"allowLegacyPeers",
		"get",
	]);
});
