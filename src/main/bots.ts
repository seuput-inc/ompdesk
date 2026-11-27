/**
 * Main's copy of the bots state the core's agent control holds (`agentctl/journal/bots.rs`, told as `botsChanged`):
 * every window gets it as `BOTS_STATE`, and main reads it where it must know whether a tab is a bot's chat (a quiet
 * result notifies nothing, a bot chat's spawn carries its owner's launch flags). The core owns every change; this only
 * keeps the latest.
 */

import type { z } from "zod";
import type { BotContext } from "../../resources/gui-bridge/modes/bots-contracts";
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

export type PeerBotHome = { device: string; cwd: string; sessionId: string; sessionPath: string };
export type PeerBotIntent = { context: BotContext; mail: { id: string; text: string; content: string } | null };

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
	from(request: unknown, deviceId: string, deviceName: string, createKey?: string): Promise<unknown>;
	/** Whether the host durably recorded this exact create. An unknown outcome is not a refund. */
	created(device: string, createKey: string): Promise<boolean>;
	candidate(home: PeerBotHome): Promise<boolean>;
	observe(home: PeerBotHome): Promise<PeerBotIntent | null>;
	receipt(mail: PeerBotHome & { id: string; journaled: true }): Promise<boolean>;
	limited(mail: PeerBotHome & { id: string }): Promise<boolean>;
	/** What this computer heard of a paired host's bots; `applied` false: read its whole copy again. */
	remote(update: HostBotsUpdate): Promise<{ applied: boolean }>;
	/** A paired host's bot posted in one of this computer's groups. */
	roomPost(post: HostBotsRoomPost): Promise<unknown>;
}

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
	return current.bots.find(bot => !bot.device && bot.folder === cwd);
}
