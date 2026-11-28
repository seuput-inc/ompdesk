import type { Bot, BotsState } from "../../shared/bots";
import type { ItemSummary, ItemsV2Reply, ItemsV2Request, ListedBotsState } from "../../shared/items-v2";
import { parseItemsV2Reply } from "../../shared/items-v2";
import { KIND_LIMITS, snapshotNs, snapshots } from "../lib/snapshot-cache";

type Feed = ItemsV2Reply<Extract<ItemsV2Request, { action: "itemsFeed" }>>;
type Seed = Extract<Feed, { kind: "seed" }>;
type Summary = ItemSummary & { device?: string };
export type HostInfo = { device: string; name: string; online: boolean };
const key = "items.v2";
export function cachedHosts(): HostInfo[] {
	const value = snapshots().read<HostInfo[]>("panel", snapshotNs(), `${key}:hosts`)?.value;
	return Array.isArray(value)
		? value.filter(h => h && typeof h.device === "string" && typeof h.name === "string")
		: [];
}
export const cacheHosts = (hosts: HostInfo[]) => snapshots().write("panel", snapshotNs(), `${key}:hosts`, hosts);

/** One source's open rows. The two positions address a row in its host list and in the flattened list. */
export class ItemFeed {
	readonly slots = new Map<string, number>();
	readonly globalSlots = new Map<string, number>();
	readonly byBot = new Map<string, { rows: Summary[]; slots: Map<number, number> }>();
	readonly revisions = new Map<string, number>();
	readonly linkRevisions = new Map<string, number>();
	rows: Summary[] = [];
	bots: Bot[] = [];
	rooms?: BotsState["rooms"];
	looks?: BotsState["looks"];
	counts: Seed["counts"] = Object.create(null);
	version?: string;
	ready = false;
	epoch?: string;
	private base?: string;

	constructor(readonly device: string | null) {}

	seed(seed: Seed, revision: number, persist: boolean) {
		this.version = seed.version;
		this.epoch = seed.version.replace(/\.\d+$/, "");
		this.base = seed.version;
		this.counts = Object.assign(Object.create(null), seed.counts);
		const { device } = this;
		this.bots = device ? seed.bots.map(bot => ({ ...bot, device })) : seed.bots;
		this.rooms = seed.rooms;
		this.looks = seed.looks;
		this.rows = device ? seed.open.map(row => ({ ...row, device })) : [...seed.open];
		this.indexRows();
		this.revisions.clear();
		this.linkRevisions.clear();
		for (const bot of this.bots) {
			this.revisions.set(bot.id, revision);
			this.linkRevisions.set(bot.id, revision);
		}
		if (persist) this.cacheSeed(seed);
	}

	// Paint the last seed with its latest row replacements. Never negotiate a delta from an evictable cache.
	restore(revision: number) {
		const ns = snapshotNs(this.device);
		const saved = snapshots().read<Omit<Seed, "open"> & { pages: number }>("panel", ns, key)?.value;
		if (!saved || !Number.isSafeInteger(saved.pages) || saved.pages < 0 || saved.pages >= KIND_LIMITS.panel) return;
		try {
			const { pages, ...head } = saved;
			const open: ItemSummary[] = [];
			for (let i = 0; i < pages; i++) {
				const rows = snapshots().read<ItemSummary[]>("panel", ns, `${key}:base:${head.version}:${i}`)?.value;
				if (!rows) continue;
				for (const row of rows) {
					const patch = snapshots().read<ItemSummary>("panel", ns, `${key}:${head.version}:${row.id}`)?.value;
					open.push(
						patch && patch.id === row.id && patch.bot === row.bot && patch.version >= row.version ? patch : row,
					);
				}
			}
			for (const bot of head.bots) {
				const count = snapshots().read<Seed["counts"][string]>(
					"panel",
					ns,
					`${key}:count:${head.version}:${bot.id}`,
				)?.value;
				if (count) head.counts[bot.id] = count;
			}
			const seed = parseItemsV2Reply({ protocol: 2, action: "itemsFeed" }, { ...head, open });
			if (seed.kind !== "seed") return;
			this.seed(seed, revision, false);
			this.version = undefined;
		} catch {
			// A damaged first-frame cache is not an authoritative empty feed.
		}
	}

	private cacheSeed({ open, ...head }: Seed) {
		const ns = snapshotNs(this.device);
		const pages = Math.min(KIND_LIMITS.panel - 1, Math.ceil(open.length / 50));
		for (let i = 0; i < pages; i++)
			snapshots().write("panel", ns, `${key}:base:${head.version}:${i}`, open.slice(i * 50, (i + 1) * 50));
		snapshots().write("panel", ns, key, { ...head, pages });
	}

	private indexRows() {
		this.slots.clear();
		this.byBot.clear();
		this.rows.forEach((row, i) => {
			this.slots.set(row.id, i);
			let group = this.byBot.get(row.bot);
			if (!group) {
				group = { rows: [], slots: new Map() };
				this.byBot.set(row.bot, group);
			}
			group.slots.set(row.number, group.rows.length);
			group.rows.push(row);
		});
	}

	delta(delta: Extract<Feed, { kind: "delta" }>, state: ListedBotsState, revision: number) {
		if (delta.base !== this.version) throw new Error("Item feed base mismatch");
		this.version = delta.version;
		let structure = false,
			facts = false,
			inbox = false;
		for (const id of delta.remove) {
			const slot = this.slots.get(id);
			if (slot === undefined) continue;
			const bot = this.rows[slot].bot;
			this.revisions.set(bot, revision);
			this.linkRevisions.set(bot, revision);
			this.slots.delete(id);
			structure = true;
		}
		if (structure) {
			this.rows = this.rows.filter(row => this.slots.has(row.id));
			this.indexRows();
		}
		for (const update of delta.set) {
			const row = this.device ? { ...update, device: this.device } : update;
			const slot = this.slots.get(row.id);
			this.revisions.set(row.bot, revision);
			if (slot === undefined) {
				this.slots.set(row.id, this.rows.length);
				this.rows.push(row);
				this.linkRevisions.set(row.bot, revision);
				structure = true;
				continue;
			}
			const old = this.rows[slot];
			if (
				old.session !== row.session ||
				old.title !== row.title ||
				old.status !== row.status ||
				old.sessionLinks.length !== row.sessionLinks.length ||
				old.sessionLinks.some((s, i) => s !== row.sessionLinks[i])
			)
				this.linkRevisions.set(row.bot, revision);
			facts ||=
				old.title !== row.title ||
				old.status !== row.status ||
				old.stale !== row.stale ||
				old.snoozedUntil !== row.snoozedUntil ||
				old.closedAt !== row.closedAt ||
				old.question?.id !== row.question?.id ||
				old.question?.text !== row.question?.text;
			inbox ||=
				old.askedAt !== row.askedAt ||
				(old.question?.id === undefined &&
					row.question?.id === undefined &&
					(old.question !== undefined || row.question !== undefined) &&
					JSON.stringify(old.question) !== JSON.stringify(row.question));
			this.rows[slot] = row;
			const group = this.byBot.get(row.bot);
			const groupSlot = group?.slots.get(row.number);
			if (group && groupSlot !== undefined) group.rows[groupSlot] = row;
			const global = this.globalSlots.get(row.id);
			if (global !== undefined) state.items[global] = row;
			if (!structure) snapshots().write("panel", snapshotNs(this.device), `${key}:${this.base}:${row.id}`, update);
		}
		for (const [bot, next] of Object.entries(delta.counts)) {
			const prev = this.counts[bot];
			if (
				prev &&
				prev.archiveRevision === next.archiveRevision &&
				prev.openCount === next.openCount &&
				prev.closedTotal === next.closedTotal
			)
				continue;
			this.counts[bot] = next;
			this.revisions.set(bot, revision);
			this.linkRevisions.set(bot, revision);
			if (!structure) snapshots().write("panel", snapshotNs(this.device), `${key}:count:${this.base}:${bot}`, next);
		}
		if (structure) {
			this.indexRows();
			const open = this.rows.map(({ device: _device, ...summary }) => summary);
			this.cacheSeed({
				protocol: 2,
				kind: "seed",
				version: this.version,
				open,
				counts: this.counts,
				bots: this.bots,
				rooms: this.rooms,
				looks: this.looks,
			});
			this.base = this.version;
		}
		return { structure, facts, inbox };
	}
}
