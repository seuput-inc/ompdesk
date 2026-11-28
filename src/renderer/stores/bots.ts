/**
 * This computer's bots and their items as the core holds them (`BotsState`, `src/shared/bots.ts`): read once, then
 * kept by main's `BOTS_STATE` pushes and by every change's answer. The last read paints the first frame
 * (`lib/last-read.ts`, kind `panel`), so the sidebar's Bots section and the Bots page never open empty.
 *
 * Each paired host's bots come in the same state (`remote`, the copy the core keeps of each host): `state.bots` and
 * `state.items` list them after this computer's own, each tagged with its host's `device` (orca-bots-remote). A change
 * to one goes to its host through the core, which routes it by the bot's or item's id; nothing of it is written here.
 */
import { create } from "zustand";
import type { Bot, BotsRequest, BotsState } from "../../shared/bots";
import { translate } from "../lib/i18n";
import { lastRead, rememberRead } from "../lib/last-read";

const READ_KEY = "bots";
const EMPTY: BotsState = { bots: [], items: [] };

interface BotsStore {
	/** This computer's bots and items, then each paired host's (tagged `device`). */
	state: BotsState;
	/** A live read or push arrived this run (until then `state` is the last run's). */
	live: boolean;
	/** Applies the owner's change; the state after it is kept. Rejects with the core's reason. */
	command: (request: BotsRequest) => Promise<BotsState>;
	receive: (state: BotsState) => void;
	reset: () => void;
}

/** The state the views list: this computer's bots and items, then each paired host's, tagged with its device. */
export function listedBots(state: BotsState): BotsState {
	const remote = state.remote ?? [];
	if (remote.length === 0) return state;
	return {
		...state,
		bots: [...state.bots, ...remote.flatMap(host => host.bots.map(bot => ({ ...bot, device: host.device })))],
		items: [...state.items, ...remote.flatMap(host => host.items.map(item => ({ ...item, device: host.device })))],
	};
}

/** The offline host a change to a paired host's bot or item would go to (its name), else null. */
function offlineOwner(state: BotsState, request: BotsRequest): string | null {
	if ((request.action === "item" || request.action === "itemBatch") && request.device !== undefined) {
		if (request.device === null) return null;
		const host = state.remote?.find(known => known.device === request.device);
		return host?.online ? null : (host?.name ?? request.device);
	}
	const id = "id" in request ? request.id : "ids" in request ? request.ids?.[0] : undefined;
	if (!id) return null;
	const device =
		request.action === "item"
			? state.items.find(item => item.id === id)?.device
			: state.bots.find(bot => bot.id === id)?.device;
	const host = device ? state.remote?.find(known => known.device === device) : undefined;
	return host && !host.online ? host.name : null;
}

export const useBotsStore = create<BotsStore>()(set => ({
	state: listedBots(lastRead<BotsState>(undefined, READ_KEY) ?? EMPTY),
	live: false,
	command: async request => {
		const offline = offlineOwner(useBotsStore.getState().state, request);
		if (offline) throw new Error(translate("bots.remote.offlineChange", { device: offline }));
		const state = await window.omp.bots.command(request);
		useBotsStore.getState().receive(state);
		return state;
	},
	receive: ({ deleteChanged: _deleteChanged, refused: _refused, itemBatchResult: _batch, ...state }) => {
		rememberRead(undefined, READ_KEY, state);
		set({ state: listedBots(state), live: true });
	},
	reset: () => set({ state: EMPTY, live: false }),
}));

let subscribed = false;

/** Reads the bots once and follows main's pushes; a page without the bridge (tests) is skipped. */
export function ensureBots(): void {
	if (subscribed || typeof window === "undefined" || typeof window.omp?.bots?.command !== "function") return;
	subscribed = true;
	window.omp.bots.onState(state => useBotsStore.getState().receive(state));
	window.omp.bots
		.command({ action: "get" })
		.then(state => useBotsStore.getState().receive(state))
		.catch(() => {});
}

/** The bot may have edited its soul since the last read. */
export function refreshBots(): void {
	void useBotsStore
		.getState()
		.command({ action: "get" })
		.catch(() => {});
}

/** Tests: forget the subscription too. */
export function resetBotsForTest(): void {
	subscribed = false;
	useBotsStore.getState().reset();
}

/** The bot whose chats run in `cwd` on `device` (absent = this computer). */
export function botOfFolder(bots: readonly Bot[], cwd: string | undefined | null, device?: string): Bot | undefined {
	return cwd ? bots.find(bot => bot.folder === cwd && bot.device === device) : undefined;
}

/** The bot named `name` (any case) on `device` (absent = this computer): a transcript's bot is its host's. */
export function botNamed(bots: readonly Bot[], name: string, device?: string): Bot | undefined {
	const wanted = name.toLowerCase();
	return bots.find(bot => bot.device === device && bot.name.toLowerCase() === wanted);
}

/** The bot `session` (a session file on `device`, absent = this computer) is a chat of. */
export function botOfSession(
	bots: readonly Bot[],
	session: string | undefined | null,
	device?: string,
): Bot | undefined {
	return session
		? bots.find(bot => bot.device === device && (bot.home === session || bot.sessions.includes(session)))
		: undefined;
}

/** Every bot the views list: this computer's, then each paired host's (`device` set). */
export function useBots(): readonly Bot[] {
	return useBotsStore(s => s.state.bots);
}
