/**
 * Main's copy of the bots state the core's agent control holds (`agentctl/journal/bots.rs`, told as `botsChanged`):
 * every window gets it as `BOTS_STATE`, and main reads it where it must know whether a tab is a bot's chat (a quiet
 * result notifies nothing). The core owns every change; this only keeps the latest.
 */

import type { z } from "zod";
import type { Bot, BotsState, SharedBots } from "../shared/bots";
import type { BotsRoomPostSchema, SharedBotsDeltaSchema, SharedBotsSchema } from "./remote/app-protocol";

/** What this computer heard of a paired host's bots: a copy or a change of it, its link up or down, or that it is gone. */
export interface HostBotsUpdate {
	device: string;
	name?: string;
	online?: boolean;
	/** As the link carried it (`app-protocol.ts`); the core checks every row. */
	change?: z.infer<typeof SharedBotsSchema> | z.infer<typeof SharedBotsDeltaSchema>;
	forget?: true;
}

/** A paired host's bot posted in one of this computer's groups (`host.bots.roomPost`), from host `device`. */
export type HostBotsRoomPost = z.infer<typeof BotsRoomPostSchema> & { device: string };

/**
 * Bots across paired computers (the core's `bots_share.rs`): this computer's bots for its paired devices, and what it
 * hears of theirs. Set once the control tools exist.
 */
export interface HostBots {
	/** A device's agent asks one of this computer's bots by name (`host.bots.home`): refused unless it may reach it. */
	home(name: string, deviceId: string, deviceName: string): Promise<{ path: string; name: string }>;
	/** This computer's bots and items as its paired devices get them (`host.bots.list`). */
	share(): Promise<SharedBots>;
	/** A device's change to one of this computer's bots (`host.bots.command`): the copy after it, or a file. */
	from(request: unknown, deviceId: string, deviceName: string): Promise<unknown>;
	/** What this computer heard of a paired host's bots; `applied` false: read its whole copy again. */
	remote(update: HostBotsUpdate): Promise<{ applied: boolean }>;
	/** A paired host's bot posted in one of this computer's groups. */
	roomPost(post: HostBotsRoomPost): Promise<unknown>;
}

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
