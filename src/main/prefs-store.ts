/**
 * Main's client of the preference files the core owns (`native/ompdesk/crates/core/src/prefs`): `prefs.json`,
 * `window-state.json` and `sidebar-device-order.json` in userData, with the API `electron-store` gave them (a dotted
 * key is a nested path, `get` answers a fresh copy, `set(key, undefined)` is refused).
 *
 * The core is the one owner and writer; a change is a synchronous hub call, so it is committed before `set` returns.
 * A read is answered from the core once and then from this process's copy of that answer, because reads are hot: a
 * full Windows e2e run read prefs 131 times a second (up to 1 000 in a busy launch; `language` alone was half), and
 * a hub call per read held main's thread 11 % of the time. A change drops every answer the changed key could reach
 * (same first path segment, or any key with an escape), so the next read asks the core again and a read in the same
 * tick as a change sees it. A lost hub drops every answer: the next core reads the files again.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { hub } from "./core/hub";

interface Answers {
	/** Key → its value, or `undefined` for a key the core holds nothing under. */
	keys: Map<string, unknown>;
	whole: Record<string, unknown> | null;
}

/** One copy per file, shared by every `PrefsStore` on it. */
const answers = new Map<string, Answers>();

let instanceId: number | null = null;

function instance(): number {
	if (instanceId !== null) return instanceId;
	const id = hub().nextId();
	hub().open(
		id,
		"prefs",
		{},
		{
			item: () => {},
			ask: q => {
				throw new Error(`the prefs ask nothing (${q})`);
			},
			lost: () => {
				if (instanceId === id) instanceId = null;
				answers.clear();
			},
		},
	);
	instanceId = id;
	return id;
}

/** The first segment of a dotted key, or null when an escape makes it unclear. */
function head(key: string): string | null {
	return key.includes("\\") ? null : (key.split(/[.[]/, 1)[0] ?? "");
}

function copy<V>(value: V): V {
	return value !== null && typeof value === "object" ? structuredClone(value) : value;
}

export class PrefsStore<T extends Record<string, unknown> = Record<string, unknown>> {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	get<K extends keyof T & string>(key: K): T[K] | undefined;
	get<K extends keyof T & string>(key: K, fallback: NonNullable<T[K]>): NonNullable<T[K]>;
	get(key: string, fallback?: unknown): unknown;
	get(key: string, fallback?: unknown): unknown {
		const value = this.#read(key);
		return value === undefined ? fallback : copy(value);
	}

	has(key: string): boolean {
		return this.#read(key) !== undefined;
	}

	set<K extends keyof T & string>(key: K, value: T[K]): void;
	set(key: string, value: unknown): void;
	set(key: string, value: unknown): void {
		if (value === undefined) throw new TypeError("Use `delete()` to clear values");
		this.#write(key, "set", { key, value });
	}

	delete(key: string): void {
		this.#write(key, "delete", { key });
	}

	get store(): T {
		const cached = this.#answers();
		cached.whole ??= this.#call<Record<string, unknown>>("store", {});
		return copy(cached.whole) as T;
	}

	set store(value: T) {
		this.#write(null, "replace", { value });
	}

	#answers(): Answers {
		let cached = answers.get(this.path);
		if (!cached) {
			cached = { keys: new Map(), whole: null };
			answers.set(this.path, cached);
		}
		return cached;
	}

	#read(key: string): unknown {
		if (probeDir) probe.reads++;
		const cached = this.#answers();
		if (cached.keys.has(key)) return cached.keys.get(key);
		const { value } = this.#call<{ value?: unknown }>("get", { key });
		// The call may have lost the hub and dropped every copy: keep the answer in the one there is now.
		this.#answers().keys.set(key, value);
		return value;
	}

	/** A change: committed by the core, then every answer it could reach is dropped. `key` null reaches all. */
	#write(key: string | null, method: string, params: Record<string, unknown>): void {
		try {
			this.#call(method, params);
		} finally {
			const cached = this.#answers();
			cached.whole = null;
			const changed = key === null ? null : head(key);
			for (const known of [...cached.keys.keys()]) {
				const reached = head(known);
				if (changed === null || reached === null || reached === changed) cached.keys.delete(known);
			}
		}
	}

	#call<R>(method: string, params: Record<string, unknown>): R {
		if (!probeDir) return hub().callOnce<R>(instance, method, { file: this.path, ...params });
		const started = performance.now();
		try {
			return hub().callOnce<R>(instance, method, { file: this.path, ...params });
		} finally {
			probe.durations.push(Math.round((performance.now() - started) * 1000));
			const name = `${method} ${String(params.key ?? "")}`;
			probe.keys.set(name, (probe.keys.get(name) ?? 0) + 1);
		}
	}
}

// probe only: counts reads and times every prefs hub call, written to OMP_GUI_PREFS_PROBE_DIR.
const probeDir = process.env.OMP_GUI_PREFS_PROBE_DIR;
const probe = { reads: 0, durations: [] as number[], keys: new Map<string, number>() };
function writeProbe(): void {
	if (!probeDir || probe.reads === 0) return;
	const sorted = [...probe.durations].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	const stats = hub().stats;
	mkdirSync(probeDir, { recursive: true });
	writeFileSync(
		join(probeDir, `${process.pid}.json`),
		JSON.stringify({
			uptimeS: Math.round(process.uptime()),
			reads: probe.reads,
			calls: sorted.length,
			p50Us: at(0.5),
			p99Us: at(0.99),
			maxUs: sorted.at(-1) ?? 0,
			totalMs: Math.round(sorted.reduce((s, v) => s + v, 0) / 1000),
			hubCalls: stats.calls,
			hubTotalMs: Math.round(stats.totalUs / 1000),
			keys: [...probe.keys].sort((a, b) => b[1] - a[1]).slice(0, 25),
		}),
	);
}
if (probeDir) {
	hub().measuring = true;
	setInterval(writeProbe, 20_000).unref();
	process.on("exit", writeProbe);
}

/** `<userData>/<name>.json`, where electron-store kept a store of that name. */
export function prefsFile<T extends Record<string, unknown> = Record<string, unknown>>(name: string): PrefsStore<T> {
	return new PrefsStore<T>(join(app.getPath("userData"), `${name}.json`));
}
