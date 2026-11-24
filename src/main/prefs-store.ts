/**
 * Main's client of the preference files the core owns (`native/ompdesk/crates/core/src/prefs`): `prefs.json`,
 * `window-state.json` and `sidebar-device-order.json` in userData, with the API `electron-store` gave them (a dotted
 * key is a nested path, `get` answers a fresh copy, `set(key, undefined)` is refused). Every call is a synchronous
 * call of the core's hub, so a read in the same tick as a change sees it. The core writes the file off main's thread;
 * a full disk keeps the change in the core's memory and retries it (`store.saveFailed`, `core-saves.ts`).
 */
import { join } from "node:path";
import { app } from "electron";
import { hub, sharedInstance } from "./core/hub";

const instance = sharedInstance("prefs");

export class PrefsStore<T extends Record<string, unknown> = Record<string, unknown>> {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	get<K extends keyof T & string>(key: K): T[K] | undefined;
	get<K extends keyof T & string>(key: K, fallback: NonNullable<T[K]>): NonNullable<T[K]>;
	get(key: string, fallback?: unknown): unknown;
	get(key: string, fallback?: unknown): unknown {
		const { value } = this.#call<{ value?: unknown }>("get", { key });
		return value === undefined ? fallback : value;
	}

	has(key: string): boolean {
		return this.#call<boolean>("has", { key });
	}

	set<K extends keyof T & string>(key: K, value: T[K]): void;
	set(key: string, value: unknown): void;
	set(key: string, value: unknown): void {
		if (value === undefined) throw new TypeError("Use `delete()` to clear values");
		this.#call("set", { key, value });
	}

	delete(key: string): void {
		this.#call("delete", { key });
	}

	get store(): T {
		return this.#call<T>("store", {});
	}

	set store(value: T) {
		this.#call("replace", { value });
	}

	#call<R>(method: string, params: Record<string, unknown>): R {
		return hub().callOnce<R>(instance, method, { file: this.path, ...params });
	}
}

/** `<userData>/<name>.json`, where electron-store kept a store of that name. */
export function prefsFile<T extends Record<string, unknown> = Record<string, unknown>>(name: string): PrefsStore<T> {
	return new PrefsStore<T>(join(app.getPath("userData"), `${name}.json`));
}
