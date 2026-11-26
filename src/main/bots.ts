/**
 * Main's copy of the bots state the core's agent control holds (`agentctl/journal/bots.rs`, told as `botsChanged`):
 * every window gets it as `BOTS_STATE`, and main reads it where it must know whether a tab is a bot's chat (a quiet
 * result notifies nothing, a bot chat's spawn carries its owner's launch flags). The core owns every change; this only
 * keeps the latest.
 */

import type { Bot, BotsState } from "../shared/bots";

let current: BotsState = { bots: [], items: [] };
let told = false;
let ask: (() => Promise<BotsState>) | null = null;
const listeners = new Set<(state: BotsState) => void>();

export function botsState(): BotsState {
	return current;
}

/** The core told a new state: keep it and tell every listener. */
export function setBotsState(state: BotsState): void {
	current = state;
	told = true;
	for (const listener of listeners) listener(state);
}

/** How the state is asked of the core (`AgentControl.bots({action: "get"})`), once agent control is up. */
export function setBotsAsk(getState: () => Promise<BotsState>): void {
	ask = getState;
}

/**
 * The state, asked of the core first while none has arrived yet: a bot chat restored right after a relaunch spawns
 * before any change made the core tell it, and its spawn must still carry its owner's flags.
 */
export async function botsStateNow(): Promise<BotsState> {
	if (!told && ask) {
		try {
			setBotsState(await ask());
		} catch {
			// No agent control yet: the spawn goes as any chat's; the core's first tell fixes the next one.
		}
	}
	return current;
}

export function onBotsState(listener: (state: BotsState) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The bot whose chats run in `cwd` (a tab in a bot's folder is one of its chats). */
export function botOfFolder(cwd: string | undefined): Bot | undefined {
	if (!cwd) return undefined;
	return current.bots.find(bot => bot.folder === cwd);
}
