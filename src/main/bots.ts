/**
 * The core owns the registry. Legacy readers receive `botsChanged`; item feeds negotiate their own pushes.
 */

import type { z } from "zod";
import type { BotContext } from "../../resources/gui-bridge/modes/bots-contracts";
import type { Bot, BotsState, ItemChangeRequest, ItemChangeResult, ItemsV2Change, SharedBots } from "../shared/bots";
import type { ItemsV2Reply, ItemsV2Request } from "../shared/items-v2";
import type { BotsRoomPostSchema, SharedBotsDeltaSchema, SharedBotsSchema } from "./remote/app-protocol";
import type { PeerItemCheck, PeerItemStep, PeerItemVerdict } from "./remote/item-work";

/** What this computer heard of a paired host's bots: a copy or a change of it, its link up or down, or that it is gone. */
export interface HostBotsUpdate {
	device: string;
	name?: string;
	online?: boolean;
	/** As the link carried it (`app-protocol.ts`); the core checks every row. */
	change?: z.infer<typeof SharedBotsSchema> | z.infer<typeof SharedBotsDeltaSchema>;
	feed?: ItemsV2Reply<{ protocol: 2; action: "itemsFeed" }>;
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
	peerItemReceipt(peer: string, tab: string, step: PeerItemStep): Promise<unknown>;
	ownerGrantsPeerItem(device: string, tab: string, check: PeerItemCheck): Promise<PeerItemVerdict>;
	/** A device's agent asks one of this computer's bots by name (`host.bots.home`): refused unless it may reach it. */
	home(name: string, deviceId: string, deviceName: string, fromBot?: boolean): Promise<{ path: string; name: string }>;
	/** This computer's bots and items as its paired devices get them (`host.bots.list`). */
	share(): Promise<SharedBots>;
	itemsV2?(request: ItemsV2Request): Promise<unknown>;
	itemsChange?(request: ItemChangeRequest): Promise<ItemChangeResult>;
	cached?(device: string, legacy?: boolean): Promise<{ feed?: unknown; legacy?: unknown } | null>;
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

interface FeedReader {
	send(change: ItemsV2Change): void;
	active: boolean;
	pending: number;
	latest: number;
	dirty: boolean | undefined;
}

/** Only a successful feed negotiates pushes. Keep changes racing its first read until it succeeds. */
export class ItemFeedViewers<K> {
	readonly #pages = new Map<K, Map<string | null, FeedReader>>();
	readonly #legacy = new Set<K>();
	readonly #onLegacyChange?: (active: boolean) => void;

	constructor(onLegacyChange?: (active: boolean) => void) {
		this.#onLegacyChange = onLegacyChange;
	}

	get hasLegacyReaders(): boolean {
		return this.#legacy.size !== 0;
	}

	async read<T>(key: K, device: string | null, send: FeedReader["send"], query: () => Promise<T>): Promise<T> {
		let sources = this.#pages.get(key);
		if (!sources) {
			sources = new Map();
			this.#pages.set(key, sources);
		}
		let reader = sources.get(device);
		if (!reader) {
			reader = { send, active: false, pending: 0, latest: 0, dirty: undefined };
			sources.set(device, reader);
		}
		const ticket = ++reader.latest;
		reader.pending++;
		try {
			const reply = await query();
			if (this.#pages.get(key) !== sources || reader.latest !== ticket)
				throw new Error("Item feed read was superseded");
			if (!reader.active) {
				reader.active = true;
				if (reader.dirty !== undefined) reader.send({ device, reseed: reader.dirty });
				reader.dirty = undefined;
			}
			return reply;
		} finally {
			if (--reader.pending === 0 && !reader.active) {
				sources.delete(device);
				if (!sources.size && this.#pages.get(key) === sources) this.#pages.delete(key);
			}
		}
	}

	changed(device: string | null, reseed: boolean): void {
		for (const sources of this.#pages.values()) {
			const reader = sources.get(device);
			if (reader?.active) reader.send({ device, reseed });
			else if (reader) reader.dirty = reseed || (reader.dirty ?? false);
		}
	}

	legacyRead(key: K): void {
		const first = !this.hasLegacyReaders;
		this.#legacy.add(key);
		if (first) this.#onLegacyChange?.(true);
	}

	wantsLegacy(key: K): boolean {
		return this.#legacy.has(key);
	}

	forget(key: K): void {
		this.#pages.delete(key);
		if (this.#legacy.delete(key) && !this.hasLegacyReaders) this.#onLegacyChange?.(false);
	}
}

const quietFolders = new Map<string, Pick<Bot, "folder" | "quiet">>();
const listeners = new Set<(state: BotsState) => void>();

/** Forward a legacy body without retaining its item histories in main. */
export function setBotsState(state: BotsState): void {
	for (const listener of listeners) listener(state);
}

export function onBotsState(listener: (state: BotsState) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function setBotQuietFolders(folders: readonly Pick<Bot, "folder" | "quiet">[]): void {
	quietFolders.clear();
	for (const entry of folders) quietFolders.set(entry.folder, entry);
}

/** The bot whose chats run in `cwd` (a tab in a bot's folder is one of its chats). */
export function botOfFolder(cwd: string | undefined): Pick<Bot, "folder" | "quiet"> | undefined {
	return cwd ? quietFolders.get(cwd) : undefined;
}
