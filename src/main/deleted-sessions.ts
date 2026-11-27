/**
 * Sessions the user deleted: main's client of the core's tombstone record (`native/ompdesk/crates/core/src/sessions/
 * deleted.rs`, hub kind `deleted`). The core keeps and saves the record and answers the pool, the layout restore and
 * the turn resume itself; main asks it for the session index, a paired device and the agent tools. Every call is a
 * synchronous hub call, so a tombstone is there for the next line that asks.
 */
import { hub } from "./core/hub";

export const MAX_TOMBSTONES = 2000;

let current: string | null = null;
let instanceId: number | null = null;

/**
 * The instance, opened naming the profile's record: a core that started again learns the file from the open, before
 * the pool, the layout restore or the resume asks it about a session.
 */
function instance(): number {
	if (instanceId !== null) return instanceId;
	const id = hub().nextId();
	hub().open(
		id,
		"deleted",
		{ current },
		{
			item: () => {},
			ask: q => {
				throw new Error(`the tombstones ask nothing (${q})`);
			},
			lost: () => {
				if (instanceId === id) instanceId = null;
			},
		},
	);
	instanceId = id;
	return id;
}

/** Names the profile's record to the core before an instance whose checks read it opens (pool, layout, resume). */
export function deletedSessionsOpen(): void {
	instance();
}

export class DeletedSessions {
	readonly #file: string | null;

	constructor(file: string | null) {
		this.#file = file;
	}

	#call<R>(method: string, params: Record<string, unknown> = {}): R {
		return hub().callOnce<R>(instance, method, { file: this.#file, ...params });
	}

	has(path: string | undefined, device?: string): boolean {
		return path !== undefined && this.#call<boolean>("has", { path, device: device ?? null });
	}

	/** Which of `paths` were deleted, in order: one call for a whole list. */
	which(paths: readonly string[], device?: string): boolean[] {
		return paths.length === 0 ? [] : this.#call<boolean[]>("which", { paths, device: device ?? null });
	}

	/** When the session at `path` was deleted (epoch ms); undefined while no tombstone names it. */
	at(path: string, device?: string): number | undefined {
		return this.#call<number | null>("at", { path, device: device ?? null }) ?? undefined;
	}

	/**
	 * When the saved session `id` was deleted, on any device (stock names a session file `<time>_<session id>.jsonl`);
	 * undefined while no tombstone names it.
	 */
	atOfId(id: string): number | undefined {
		return this.#call<number | null>("atOfId", { id }) ?? undefined;
	}

	/** Every tombstone, oldest first: what the agent-control service reads of them. */
	list(): { path: string; device?: string; at: number }[] {
		return this.#call("list");
	}

	add(path: string, device?: string, now?: number): void {
		this.#call("add", { path, device: device ?? null, at: now ?? null });
	}

	/**
	 * Records that this computer's session at `path` is being handed to the paired computer `host` under the transfer
	 * `id`, saved before anything crosses (throws when it could not be saved: the hand-over must not start). Until it
	 * settles the session reads as deleted to every revival path, and its file stays.
	 */
	beginHandoff(path: string, id: string, host: string): void {
		this.#call("handoffBegin", { path, id, host });
	}

	/** Ends the pending transfer `id`: `to` is where the other computer keeps the session it took; absent, it refused. */
	settleHandoff(path: string, id: string, to?: string): boolean {
		return this.#call<boolean>("handoffSettle", { path, id, to: to ?? null });
	}

	/** The transfers still pending, oldest first. */
	pendingHandoffs(): PendingHandoff[] {
		return this.#call("handoffsPending");
	}
}

/** A session of this computer on its way to the paired computer `device` (`handOffSession`). */
export interface PendingHandoff {
	path: string;
	id: string;
	device: string;
}

let record = new DeletedSessions(null);

/** The record every restore path consults; `initDeletedSessions` points it at the profile's file at startup. */
export function deletedSessions(): DeletedSessions {
	return record;
}

export function initDeletedSessions(file: string | null): DeletedSessions {
	current = file;
	record = new DeletedSessions(file);
	// The core's checks (pool, layout, resume) read the profile's record: name it now, and again after a lost hub.
	if (instanceId !== null) hub().close(instanceId);
	instanceId = null;
	instance();
	return record;
}
