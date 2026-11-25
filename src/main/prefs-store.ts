/**
 * Main's client of the preference files the core owns (`native/ompdesk/crates/core/src/prefs`): `prefs.json`
 * and `sidebar-device-order.json` in userData, with the API `electron-store` gave them (a dotted
 * key is a nested path, `get` answers a fresh copy, `set(key, undefined)` is refused).
 *
 * The core is the one owner and writer; a change is a synchronous hub call, so it is committed before `set` returns.
 * A read is answered from the core once and then from this process's copy of that answer, because reads are hot: a
 * full Windows e2e run read prefs 131 times a second (up to 1 000 in a busy launch; `language` alone was half), and
 * a hub call per read held main's thread 11 % of the time. A change drops every answer the changed key could reach
 * (same first path segment, or any key with an escape), so the next read asks the core again and a read in the same
 * tick as a change sees it. A lost hub drops every answer: the next core reads the files again.
 */
import { join } from "node:path";
import { app } from "electron";
import { codedError, isIpcErrorCode } from "../shared/ipc-error-codes";
import type { LaunchProfile } from "../shared/launch-profile";
import { SIDEBAR_PREFS_KEY, type SidebarChange } from "../shared/sidebar-prefs";
import { hub } from "./core/hub";
import { CoreError } from "./core/process";
import type { RuntimeLogReport } from "./runtime-log-core";

export interface AgentPowersReport {
	/** Prefs that were stored off and are on again. */
	prefs: string[];
	/** Dotted config.yml keys that were off (or stricter) and were removed. */
	stock: string[];
	/** Why config.yml was left alone (unreadable, malformed, not writable); the prefs part still ran. */
	error?: string;
}

/** Where a sidebar change came from: a desktop window, a paired page, a paired computer. */
export type SidebarChangeSource = "window" | "web" | "host";

/** What a sidebar change did: the change as applied and its runtime-log line, both null when it moved nothing. */
export interface SidebarApplied {
	change: SidebarChange | null;
	log: RuntimeLogReport | null;
}

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
			// A change main did not make (a native caller's `prefs::update`).
			item: item => {
				if (item.k === "changed" && typeof item.file === "string" && typeof item.key === "string")
					forget(item.file, item.key);
			},
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

/** Drops the answers of `file` a change of `key` could reach; `key` null reaches all. */
function forget(file: string, key: string | null): void {
	const cached = answers.get(file);
	if (!cached) return;
	cached.whole = null;
	const changed = key === null ? null : head(key);
	for (const known of [...cached.keys.keys()]) {
		const reached = head(known);
		if (changed === null || reached === null || reached === changed) cached.keys.delete(known);
	}
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

	/**
	 * The one-time "every agent power on" migration (`crates/core/src/prefs/powers.rs`): stored offs of the default-on
	 * powers dropped and config.yml's off ones removed, once per profile. Its report, or null when it had already run.
	 */
	migrateAgentPowers(agentDir: string): AgentPowersReport | null {
		return this.#write(null, "migratePowers", { agentDir }) as AgentPowersReport | null;
	}

	/** The workspace's launch profile (`crates/core/src/prefs/launch_profile.rs`); a cwd not absolute is refused. */
	launchProfile(cwd: unknown): LaunchProfile {
		return coded(() => this.#call<LaunchProfile>("launchProfile", { cwd }));
	}

	/** Merges `patch` into the workspace's launch profile under the core's lock; the profile now stored. */
	updateLaunchProfile(cwd: unknown, patch: unknown): LaunchProfile {
		return coded(() => this.#write("launchProfiles", "updateLaunchProfile", { cwd, patch }) as LaunchProfile);
	}

	/** The flags a spawn in `cwd` appends from its launch profile. */
	launchFlags(cwd: string): string[] {
		return this.#call<string[]>("launchFlags", { cwd });
	}

	/**
	 * Applies one `SidebarChange` a page sent (`crates/core/src/prefs/sidebar.rs`) to the blob stored now, from a
	 * desktop window, a paired page or a paired computer. A payload that is not a change is refused.
	 */
	updateSidebar(change: unknown, from: SidebarChangeSource): SidebarApplied {
		return coded(() => this.#write(SIDEBAR_PREFS_KEY, "updateSidebar", { change, from }) as SidebarApplied);
	}

	/** A peer moved the session file `from` to `to`: the host's pin moves along. Whether one did. */
	moveSidebarPin(from: string, to: string): boolean {
		return this.#write(SIDEBAR_PREFS_KEY, "moveSidebarPin", { from, to }) as boolean;
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
		const cached = this.#answers();
		if (cached.keys.has(key)) return cached.keys.get(key);
		const { value } = this.#call<{ value?: unknown }>("get", { key });
		// The call may have lost the hub and dropped every copy: keep the answer in the one there is now.
		this.#answers().keys.set(key, value);
		return value;
	}

	/** A change: committed by the core, then every answer it could reach is dropped. `key` null reaches all. */
	#write(key: string | null, method: string, params: Record<string, unknown>): unknown {
		try {
			return this.#call(method, params);
		} finally {
			forget(this.path, key);
		}
	}

	#call<R>(method: string, params: Record<string, unknown>): R {
		return hub().callOnce<R>(instance, method, { file: this.path, ...params });
	}
}

/** A refusal the page shows in its own words keeps its code (`[code] message`). */
function coded<R>(call: () => R): R {
	try {
		return call();
	} catch (error) {
		if (error instanceof CoreError && isIpcErrorCode(error.code)) throw codedError(error.code, error.message);
		throw error;
	}
}

/** `<userData>/<name>.json`, where electron-store kept a store of that name. */
export function prefsFile<T extends Record<string, unknown> = Record<string, unknown>>(name: string): PrefsStore<T> {
	return new PrefsStore<T>(join(app.getPath("userData"), `${name}.json`));
}

/** A preference file the core found damaged, moved aside and put back from its backup (or emptied). */
export interface RecoveredPrefs {
	file: string;
	quarantined: string | null;
	restored: boolean;
	backupAt: number | null;
}

/** The files the core repaired since the last call, each once (`crates/core/src/prefs` `recover`). */
export function takeRecoveredPrefs(): RecoveredPrefs[] {
	return hub().callOnce<RecoveredPrefs[]>(instance, "recovered", {});
}
