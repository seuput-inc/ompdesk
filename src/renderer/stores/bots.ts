/** The v2 feed owns each device's open rows. Commands never install an unversioned item snapshot over it. */
import { create } from "zustand";
import type { Bot, BotsRequest, BotsState, ItemChangeRequest } from "../../shared/bots";
import type { ListedBotsState, ListedItem } from "../../shared/items-v2";
import { translate } from "../lib/i18n";
import { webRuntime } from "../web/runtime";
import { cachedHosts, cacheHosts, type HostInfo, ItemFeed } from "./item-feed";
import { useRemoteStore } from "./remote";

const EMPTY: ListedBotsState = { bots: [], items: [] };
const sources = new Map<string | null, ItemFeed>();
let hosts = new Map(cachedHosts().map(h => [h.device, { ...h, online: false }]));
let mirrored: HostInfo[] = [];
let revision = 0;
function source(device: string | null) {
	let feed = sources.get(device);
	if (!feed) {
		feed = new ItemFeed(device);
		sources.set(device, feed);
	}
	return feed;
}
for (const device of [null, ...hosts.keys()]) source(device).restore(++revision);

function listedSources(): ListedBotsState {
	const local = source(null);
	const state: ListedBotsState = { items: [], bots: [], rooms: local.rooms, looks: local.looks };
	for (const device of [null, ...hosts.keys()]) {
		const feed = source(device);
		feed.globalSlots.clear();
		for (const row of feed.rows) {
			feed.globalSlots.set(row.id, state.items.length);
			state.items.push(row);
		}
		for (const bot of feed.bots) state.bots.push(bot);
		if (device) {
			state.remote ??= [];
			state.remote.push({ ...hosts.get(device)!, bots: feed.bots, items: feed.rows });
		}
	}
	return state;
}

export function itemCounts(device: string | undefined, bot: string) {
	return sources.get(device ?? null)?.counts[bot];
}

export function listedItem(state: ListedBotsState, device: string | undefined, id: string): ListedItem | undefined {
	const slot = sources.get(device ?? null)?.globalSlots.get(id);
	if (slot !== undefined) {
		const row = state.items[slot];
		if (row?.id === id && row.device === device) return row;
	}
	// Directly supplied (v1) lists have no feed index.
	return state === indexed ? undefined : state.items.find(row => row.id === id && row.device === device);
}

const NO_ROWS: readonly ListedItem[] = [];
export function listedBotItems(state: ListedBotsState, device: string | undefined, bot: string): readonly ListedItem[] {
	if (state !== indexed) return state.items.filter(row => row.device === device && row.bot === bot);
	return sources.get(device ?? null)?.byBot.get(bot)?.rows ?? NO_ROWS;
}

export function listedItemByNumber(state: ListedBotsState, device: string | undefined, bot: string, number: number) {
	if (state !== indexed)
		return state.items.find(row => row.device === device && row.bot === bot && row.number === number);
	const group = sources.get(device ?? null)?.byBot.get(bot);
	const slot = group?.slots.get(number);
	return slot === undefined ? undefined : group?.rows[slot];
}

let indexed = listedSources();
export const itemEpoch = (device: string | null) => sources.get(device)?.epoch;
type CommandResult = Pick<BotsState, "rooms" | "deleteChanged" | "refused" | "itemBatchResult"> &
	Partial<Pick<ListedBotsState, "bots" | "remote">>;
type StoreRequest =
	| Exclude<BotsRequest, { action: ItemChangeRequest["action"] }>
	| (ItemChangeRequest & { device: string | null });

interface BotsStore {
	/** This computer's bots and items, then each paired host's (tagged `device`). */
	state: ListedBotsState;
	/** A live read or push arrived this run (until then `state` is the last run's). */
	live: boolean;
	hostLive: (device?: string) => boolean;
	/** Applies the owner's change; the state after it is kept. Rejects with the core's reason. */
	command: (request: StoreRequest) => Promise<CommandResult>;
	itemRevision: (device: string | undefined, bot: string) => number;
	linkRevision: (device: string | undefined, bot: string) => number;
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
function offlineOwner(state: ListedBotsState, request: BotsRequest): string | null {
	if (
		(request.action === "item" || request.action === "itemBatch" || request.action === "itemsOpened") &&
		request.device !== undefined
	) {
		if (!request.device) return null;
		const host = state.remote?.find(known => known.device === request.device);
		return host?.online ? null : (host?.name ?? request.device);
	}
	const id = "id" in request ? request.id : undefined;
	const device = id && state.bots.find(bot => bot.id === id)?.device;
	const host = device ? state.remote?.find(known => known.device === device) : undefined;
	return host && !host.online ? host.name : null;
}

export const useBotsStore = create<BotsStore>()((set, get) => ({
	state: indexed,
	live: false,
	hostLive: device => (device ? Boolean(hosts.get(device)?.online && sources.get(device)?.ready) : get().live),
	itemRevision: (device, bot) => sources.get(device ?? null)?.revisions.get(bot) ?? 0,
	linkRevision: (device, bot) => sources.get(device ?? null)?.linkRevisions.get(bot) ?? 0,
	command: async request => {
		const offline = offlineOwner(get().state, request);
		if (offline) throw new Error(translate("bots.remote.offlineChange", { device: offline }));
		if (request.action === "item" || request.action === "itemBatch" || request.action === "itemsOpened") {
			const { device, ...change } = request;
			return window.omp.bots.itemChange(device, change);
		}
		if (request.action === "get") {
			await readFeed(null, true);
			return get().state;
		}
		// The command may remove its own routing row. Resolve its host before dispatch.
		const device =
			"device" in request
				? request.device
				: "id" in request
					? get().state.bots.find(bot => bot.id === request.id)?.device
					: undefined;
		const reply = await window.omp.bots.command(request);
		// A lost follow-up read does not undo the owner's confirmed write.
		await readFeed(device ?? null, true).catch(() => {});
		return reply;
	},
	reset: () => set({ state: EMPTY, live: false }),
}));

const reads = new Map<string | null, { again: boolean; seed: boolean; promise: Promise<void> }>();
let stop: (() => void) | undefined;

function publish() {
	indexed = listedSources();
	useBotsStore.setState({ state: indexed });
}

function readFeed(device: string | null, force: boolean): Promise<void> {
	const prior = reads.get(device);
	if (prior) {
		prior.again = true;
		prior.seed ||= force;
		return prior.promise;
	}
	const read = { again: false, seed: force, promise: Promise.resolve() };
	reads.set(device, read);
	read.promise = (async () => {
		const feed = source(device);
		try {
			do {
				read.again = false;
				const since = read.seed ? undefined : feed.version;
				read.seed = false;
				try {
					const next = await window.omp.bots.itemsV2(device, {
						protocol: 2,
						action: "itemsFeed",
						...(since && { since }),
					});
					if (reads.get(device) !== read) return;
					if (read.again) continue;
					const previous = feed.version?.match(/^(.+)\.(\d+)$/);
					const incoming = next.version.match(/^(.+)\.(\d+)$/);
					// An offline mirror may still be behind the live feed that this window holds.
					if (previous && incoming && previous[1] === incoming[1] && Number(previous[2]) > Number(incoming[2]))
						return;
					if (next.kind === "seed") {
						feed.seed(next, ++revision, true);
						if (device === null) {
							mirrored = next.remote ?? [];
							discover(false);
						}
						publish();
					} else if (
						!since ||
						next.base !== since ||
						next.base !== feed.version ||
						previous?.[1] !== incoming?.[1]
					) {
						if (!since) throw new Error("An item seed is required");
						read.again = read.seed = true;
						continue;
					} else if (
						next.version !== since ||
						next.set.length ||
						next.remove.length ||
						Object.keys(next.counts).length
					) {
						const { structure, facts, inbox } = feed.delta(next, indexed, ++revision);
						if (structure) publish();
						else {
							if (facts || inbox) indexed = { ...indexed };
							useBotsStore.setState({ state: indexed });
						}
					}
					if (!feed.ready) {
						feed.ready = true;
						useBotsStore.setState(device === null ? { live: true } : {});
					}
				} catch (error) {
					if (since && error instanceof Error && error.message.includes("Item feed base mismatch"))
						read.again = read.seed = true;
					if (!read.again) throw error;
				}
			} while (read.again && reads.get(device) === read);
		} finally {
			if (reads.get(device) === read) reads.delete(device);
		}
	})();
	return read.promise;
}

function discover(notify = true) {
	const peers = useRemoteStore.getState().state?.hosts;
	const next = new Map(mirrored.map(h => [h.device, h]));
	if (!peers || !source(null).version) for (const [device, h] of hosts) if (!next.has(device)) next.set(device, h);
	for (const peer of peers ?? [])
		next.set(peer.deviceId, { device: peer.deviceId, name: peer.name, online: peer.state === "online" });
	let changed = next.size !== hosts.size;
	const fetch: string[] = [];
	for (const [device, h] of next) {
		const old = hosts.get(device);
		if (!old || h.online !== old.online || h.name !== old.name) changed = true;
		const feed = source(device);
		if (old && h.online !== old.online) {
			feed.ready = false;
			reads.delete(device);
		}
		if (!old || (h.online && !old.online) || (!feed.version && !reads.has(device))) fetch.push(device);
	}
	for (const device of hosts.keys())
		if (!next.has(device)) {
			sources.delete(device);
			reads.delete(device);
		}
	hosts = next;
	if (changed) {
		cacheHosts([...hosts.values()]);
		if (notify) publish();
	}
	for (const device of fetch) void readFeed(device, false).catch(() => {});
}

export function ensureBots(): void {
	if (stop || typeof window === "undefined" || !window.omp?.bots?.itemsV2) return;
	const off = window.omp.bots.onItemsV2Changed(({ device, reseed }) => {
		if (!device || hosts.has(device)) void readFeed(device, reseed).catch(() => {});
	});
	const offPeers = useRemoteStore.subscribe((next, prev) => {
		if (next.state?.hosts !== prev.state?.hosts) discover();
	});
	const offLink = webRuntime()?.onConnectionState(state => {
		if (state === "open") for (const device of [null, ...hosts.keys()]) void readFeed(device, false).catch(() => {});
	});
	stop = () => {
		off();
		offPeers();
		offLink?.();
	};
	discover();
	void readFeed(null, true).catch(() => {});
}

/** A bot may have edited its soul without an item change. */
export function refreshBots(): void {
	if (!stop) return ensureBots();
	for (const device of [null, ...hosts.keys()]) void readFeed(device, true).catch(() => {});
}

export function resetBotsForTest(): void {
	stop?.();
	stop = undefined;
	reads.clear();
	sources.clear();
	hosts.clear();
	mirrored = [];
	indexed = EMPTY;
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
