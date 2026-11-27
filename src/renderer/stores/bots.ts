/**
 * This computer's bots and their items as the core holds them (`BotsState`, `src/shared/bots.ts`): read once, then
 * kept by main's `BOTS_STATE` pushes and by every change's answer. The last read paints the first frame
 * (`lib/last-read.ts`, kind `panel`), so the sidebar's Bots section and the Bots page never open empty.
 *
 * A paired computer's own window and its phone page read their own computer's bots: bots live where their folders are.
 */
import { create } from "zustand";
import type { Bot, BotsRequest, BotsState } from "../../shared/bots";
import { lastRead, rememberRead } from "../lib/last-read";

const READ_KEY = "bots";
const EMPTY: BotsState = { bots: [], items: [] };

interface BotsStore {
	state: BotsState;
	/** A live read or push arrived this run (until then `state` is the last run's). */
	live: boolean;
	/** Applies the owner's change; the state after it is kept. Rejects with the core's reason. */
	command: (request: BotsRequest) => Promise<BotsState>;
	receive: (state: BotsState) => void;
	reset: () => void;
}

export const useBotsStore = create<BotsStore>()(set => ({
	state: lastRead<BotsState>(undefined, READ_KEY) ?? EMPTY,
	live: false,
	command: async request => {
		const state = await window.omp.bots.command(request);
		useBotsStore.getState().receive(state);
		return state;
	},
	receive: state => {
		rememberRead(undefined, READ_KEY, state);
		set({ state, live: true });
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

/** The bot whose chats run in `cwd`. */
export function botOfFolder(bots: readonly Bot[], cwd: string | undefined | null): Bot | undefined {
	return cwd ? bots.find(bot => bot.folder === cwd) : undefined;
}

/** The bot `session` (a session file) is a chat of. */
export function botOfSession(bots: readonly Bot[], session: string | undefined | null): Bot | undefined {
	return session ? bots.find(bot => bot.home === session || bot.sessions.includes(session)) : undefined;
}

export function useBots(): readonly Bot[] {
	return useBotsStore(s => s.state.bots);
}
