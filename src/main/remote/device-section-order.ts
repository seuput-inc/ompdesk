import { createHash } from "node:crypto";

const PREF = "rows";
const LOCAL = "local";
// remote/identity.rs accepts this spelling for the random 128-bit device id.
const DEVICE_ID = /^[a-z0-9]{26}$/;
const HASH = /^[0-9a-f]{32}$/;
const MAX_DEVICES = 256;

type Row = [device: string, slot: number, clock: number, writer: string];
interface Prefs {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
}

function hash(id: string): string {
	return createHash("sha256").update(`ompdesk/device-section-order/v1\0${id}`).digest("hex").slice(0, 32);
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function version(a: Row, b: Row): number {
	return a[2] - b[2] || compare(a[3], b[3]);
}

function parse(raw: unknown): Row[] | null {
	if (!Array.isArray(raw) || raw.length > MAX_DEVICES) return null;
	const seen = new Set<string>();
	const rows: Row[] = [];
	for (const entry of raw) {
		if (!Array.isArray(entry) || entry.length !== 4) return null;
		const [key, slot, clock, writer] = entry;
		if (typeof key !== "string" || !HASH.test(key) || seen.has(key)) return null;
		if (typeof writer !== "string" || !HASH.test(writer)) return null;
		if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_DEVICES) return null;
		if (!Number.isSafeInteger(clock) || clock < 0 || clock >= Number.MAX_SAFE_INTEGER) return null;
		seen.add(key);
		rows.push([key, slot, clock, writer]);
	}
	return rows;
}

/** Concurrent claims to a slot: the newest takes it, then each claimant takes the next free slot, wrapping at the end. */
function place(rows: Row[]): Row[] {
	rows.sort((a, b) => version(b, a) || compare(b[0], a[0]));
	// Keep the same newest rows on every relay even if their combined state exceeds the limit.
	if (rows.length > MAX_DEVICES) rows.length = MAX_DEVICES;
	const slots = new Array<Row>(rows.length);
	for (const row of rows) {
		let i = row[1] < rows.length ? row[1] : 0;
		while (slots[i]) i = (i + 1) % rows.length;
		slots[i] = row;
	}
	return slots;
}

export class DeviceSectionOrder {
	readonly #self: string;
	readonly #writer: string;
	readonly #prefs: Prefs;
	#slots: Row[];
	#legacy: unknown;

	constructor(self: string, prefs: Prefs, folds: unknown) {
		if (!DEVICE_ID.test(self)) throw new Error("Invalid local device identity");
		this.#self = self;
		this.#writer = hash(self);
		this.#prefs = prefs;
		const stored = prefs.get(PREF);
		this.#slots = place(parse(stored) ?? []);
		if (stored === undefined || stored === null) {
			if (folds && typeof folds === "object" && "deviceOrder" in folds) this.#legacy = folds.deviceOrder;
		}
	}

	/** Called once the core has read all its paired hosts, offline ones included. Cached host names are not identities. */
	migrate(hostIds: readonly string[]): void {
		const legacy = this.#legacy;
		this.#legacy = undefined;
		if (!Array.isArray(legacy) || !legacy.length || legacy.length > MAX_DEVICES) return;
		const known = this.#keys(hostIds);
		const seen = new Set<string>();
		const rows: Row[] = [];
		for (const id of legacy) {
			const key = known.get(id);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			rows.push([key, rows.length, 0, this.#writer]);
		}
		this.#join(rows);
	}

	#keys(hostIds: readonly string[]): Map<string, string> {
		const keys = new Map<string, string>();
		for (const id of [...new Set([this.#self, ...hostIds])].sort()) {
			if (id === this.#self) keys.set(LOCAL, this.#writer);
			else if (DEVICE_ID.test(id)) keys.set(id, hash(id));
		}
		return keys;
	}

	view(hostIds: readonly string[]): string[] {
		if (!this.#slots.length) return [];
		const visible = new Map<string, string>();
		for (const [id, key] of this.#keys(hostIds)) visible.set(key, id);
		const order: string[] = [];
		for (const [key] of this.#slots) {
			const id = visible.get(key);
			if (id !== undefined) {
				order.push(id);
				visible.delete(key);
			}
		}
		order.push(...visible.values());
		return order;
	}

	set(order: unknown, hostIds: readonly string[]): boolean {
		if (!Array.isArray(order) || order.length > MAX_DEVICES) throw new Error("Invalid device section order");
		if (!order.length) return false;
		const known = this.#keys(hostIds);
		const selected = new Set<string>();
		for (const id of order) {
			const key = known.get(id);
			if (!key || selected.has(key)) throw new Error("Invalid device section order");
			selected.add(key);
		}
		const desired = [...selected];
		const slots = this.#slots.map(([key]) => key);
		if (slots.length) {
			const ranked = new Set(slots);
			for (const key of known.values()) if (!ranked.has(key)) slots.push(key);
		} else slots.push(...desired);

		let next = 0;
		let lastMoved = this.#slots.length ? -1 : slots.length - 1;
		const result = slots.map((occupant, slot) => {
			if (!selected.has(occupant)) return occupant;
			const key = desired[next++]!;
			if (key !== occupant) lastMoved = slot;
			return key;
		});
		if (lastMoved < 0) return false;
		if (lastMoved >= MAX_DEVICES) throw new Error("Too many ranked devices");
		const clock = this.#slots.reduce((n, row) => Math.max(n, row[2]), 0) + 1;
		if (clock >= Number.MAX_SAFE_INTEGER) throw new Error("Device section order clock exhausted");
		const rows: Row[] = [];
		for (let slot = 0; slot <= lastMoved; ++slot) {
			// Reserve moved slots and the part of the unranked tail the edit reached. Leave every other claim alone.
			const key = result[slot]!;
			if (slot >= this.#slots.length || key !== slots[slot]) rows.push([key, slot, clock, this.#writer]);
		}
		return this.#join(rows);
	}

	merge(raw: unknown): boolean {
		const rows = parse(raw);
		return rows !== null && this.#join(rows);
	}

	#join(rows: Row[]): boolean {
		if (!rows.length) return false;
		const byKey = new Map(this.#slots.map(row => [row[0], row]));
		let changed = false;
		for (const row of rows) {
			const old = byKey.get(row[0]);
			// A restored writer could reuse its stamp. Break even that tie without depending on arrival order.
			if (old && (version(row, old) || row[1] - old[1]) <= 0) continue;
			byKey.set(row[0], row);
			changed = true;
		}
		if (!changed) return false;
		const slots = place([...byKey.values()]);
		if (slots.length === this.#slots.length && slots.every((row, i) => row === this.#slots[i])) return false;
		this.#prefs.set(PREF, slots);
		this.#slots = slots;
		return true;
	}

	wire(): Row[] {
		return this.#slots.map(row => [...row]);
	}
}
