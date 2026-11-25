/**
 * Main's copy of the bots state the core's agent control holds (`agentctl/journal/bots.rs`, told as `botsChanged`):
 * every window gets it as `BOTS_STATE`, and main reads it where it must know whether a tab is a bot's chat (a quiet
 * result notifies nothing). The core owns every change; this only keeps the latest.
 */

import type { Bot, BotsState } from "../shared/bots";

let current: BotsState = { bots: [], items: [] };
const listeners = new Set<(state: BotsState) => void>();

export function botsState(): BotsState {
	return current;
}

/** The core told a new state: keep it and tell every listener. */
export function setBotsState(state: BotsState): void {
	current = state;
	for (const listener of listeners) listener(state);
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
