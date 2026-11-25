/** The core owns desktop-slot policy. Main delivers its confirmed effects to the bridge and clocks its next deadline. */
import {
	DESKTOP_SLOT_LEASE_MS,
	type DesktopSlotReason,
	type DesktopSlotState,
} from "../../resources/gui-bridge/desktop-slot-contracts";
import { hub } from "./core/hub";
import { isCoreShutdown } from "./core/process";

/** A revoke with no answer after this long counts as failed (not as done): the slot is held, never handed on. */
export const DESKTOP_SLOT_REVOKE_TIMEOUT_MS = 10_000;
/** A revoke-failed holder is revoked again this often until it is confirmed, its process is gone or it is killed. */
export const DESKTOP_SLOT_REVOKE_RETRY_MS = 5_000;

export interface DesktopSlotTimers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export interface DesktopSlotDeps {
	/** Abort the tab's in-flight input run and await `revokeControl()` on every controller; a rejection is a failure. */
	revoke(tabId: string, reason: DesktopSlotReason): Promise<void>;
	/**
	 * Let one acting run of `tabId` go on. `waited` is true when the run sat in the queue (it then returns the
	 * stale notice instead of running), false when the slot was free or the tab already held it.
	 */
	grant(tabId: string, requestId: string, waited: boolean): void;
	/** The slot's whole state changed. */
	onChange(state: DesktopSlotState): void;
	/** The session title the indicator shows for a tab. */
	titleOf(tabId: string): string;
	/**
	 * The user's "stop that session": abort it and end its omp process if needed. True only when the process is
	 * confirmed gone (exited), the one thing besides a confirmed revoke that frees a revoke-failed slot.
	 */
	kill(tabId: string): Promise<boolean>;
	now?: () => number;
	timers?: DesktopSlotTimers;
	leaseMs?: number;
	revokeTimeoutMs?: number;
	retryMs?: number;
}

type Step =
	| { op: "acquire"; tabId: string; requestId: string }
	| { op: "touch" | "release" | "closed" | "stop" | "crashed"; tabId: string }
	| { op: "retry" | "tick" }
	| { op: "answered"; lease: number; attempt: number; ok: boolean }
	| { op: "killed"; lease: number };

type Effect =
	| { kind: "grant"; tabId: string; requestId: string; waited: boolean }
	| { kind: "revoke"; tabId: string; reason: DesktopSlotReason; lease: number; attempt: number }
	| { kind: "stopWaiter"; tabId: string };

interface Reply {
	checkpoint: unknown;
	holder: { tabId: string; since: number; lease: number; failed: boolean } | null;
	queue: string[];
	deadline: number | null;
	pending: number | null;
	changed: boolean;
	effects: Effect[];
}

type Done = (wait?: Promise<void>) => void;
const HUB_RECONNECT_MS = 5_000;

const SYSTEM_TIMERS: DesktopSlotTimers = {
	set: (callback, ms) => {
		const timer = setTimeout(callback, ms);
		timer.unref();
		return timer;
	},
	clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

export class DesktopSlot {
	readonly #deps: DesktopSlotDeps;
	readonly #now: () => number;
	readonly #wall: () => number;
	readonly #timers: DesktopSlotTimers;
	#id: number | null = null;
	#disposed = false;
	#last: Reply | null = null;
	#attempt: PromiseWithResolvers<void> | null = null;
	#timer: { deadline: number; handle: unknown } | null = null;
	#sending = false;
	#waitingForHub = false;
	readonly #unsent: { step: Step; done: Done | undefined }[] = [];

	constructor(deps: DesktopSlotDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? (() => performance.now());
		this.#wall = deps.now ?? Date.now;
		this.#timers = deps.timers ?? SYSTEM_TIMERS;
	}

	state(): DesktopSlotState {
		const snapshot = this.#last;
		const holder = snapshot?.holder;
		return {
			holder: holder
				? {
						tabId: holder.tabId,
						title: this.#deps.titleOf(holder.tabId),
						since: holder.since,
						...(holder.failed ? { revokeFailed: true as const } : {}),
					}
				: null,
			queue: snapshot?.queue.map(tabId => ({ tabId, title: this.#deps.titleOf(tabId) })) ?? [],
		};
	}

	acquire(tabId: string, requestId: string): void {
		this.#send({ op: "acquire", tabId, requestId });
	}

	touch(tabId: string): void {
		this.#send({ op: "touch", tabId });
	}

	release(tabId: string): void {
		this.#send({ op: "release", tabId });
	}

	retry(): void {
		this.#send({ op: "retry" });
	}

	async killHolder(): Promise<boolean> {
		const holder = this.#last?.holder;
		if (!holder) return true;
		try {
			if (!(await this.#deps.kill(holder.tabId))) return false;
		} catch {
			return false;
		}
		await this.#sendAndWait({ op: "killed", lease: holder.lease });
		return true;
	}

	stop(tabId: string): Promise<void> {
		return this.#sendAndWait({ op: "stop", tabId });
	}

	closed(tabId: string): Promise<void> {
		return this.#sendAndWait({ op: "closed", tabId });
	}

	crashed(tabId: string): Promise<void> {
		return this.#sendAndWait({ op: "crashed", tabId });
	}

	dispose(): void {
		this.#disposed = true;
		this.#schedule(null);
		this.#attempt?.resolve();
		this.#attempt = null;
		for (const event of this.#unsent) event.done?.();
		this.#unsent.length = 0;
		this.#last = null;
		if (this.#id !== null) hub().close(this.#id);
		this.#id = null;
	}

	#instance(): number {
		if (this.#id !== null) return this.#id;
		const id = hub().nextId();
		hub().open(
			id,
			"desktopSlot",
			{
				leaseMs: this.#deps.leaseMs ?? DESKTOP_SLOT_LEASE_MS,
				revokeTimeoutMs: this.#deps.revokeTimeoutMs ?? DESKTOP_SLOT_REVOKE_TIMEOUT_MS,
				retryMs: this.#deps.retryMs ?? DESKTOP_SLOT_REVOKE_RETRY_MS,
				checkpoint: this.#last?.checkpoint ?? null,
			},
			{
				item: () => {},
				ask: q => {
					throw new Error(`desktopSlot has no question ${q}`);
				},
				lost: () => {
					if (this.#id === id) this.#id = null;
				},
			},
		);
		if (this.#disposed) {
			hub().close(id);
			throw new Error("desktopSlot was disposed while opening");
		}
		this.#id = id;
		return id;
	}

	#sendAndWait(step: Step): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#send(step, resolve);
		return promise;
	}

	#send(step: Step, done?: Done): void {
		if (this.#disposed || (!this.#last && !this.#unsent.length && step.op !== "acquire")) return done?.();
		this.#unsent.push({ step, done });
		this.#drain();
	}

	#drain(): void {
		if (this.#sending) return;
		while (!this.#waitingForHub) {
			const next = this.#unsent[0];
			if (!next) return;
			this.#sending = true;
			let reply: Reply;
			try {
				reply = hub().callOnce<Reply>(
					() => this.#instance(),
					"step",
					() => ({ ...next.step, now: Math.max(0, Math.floor(this.#now())), wall: Math.floor(this.#wall()) }),
				);
			} catch (error) {
				if (isCoreShutdown(error)) this.dispose();
				else if (!this.#disposed) {
					// Even a confirmed exit or revoke must not get lost if the replacement core is unavailable too.
					console.warn("Desktop slot is waiting for the core", error);
					this.#waitingForHub = true;
					this.#schedule(this.#now() + HUB_RECONNECT_MS);
				}
				return;
			} finally {
				this.#sending = false;
			}
			if (this.#disposed) return;
			// Commit before any callback can re-enter. A lost core is reseeded here, never by replaying an effect.
			this.#unsent.shift();
			const prior = this.#last;
			this.#last = reply;
			if (reply.pending !== prior?.pending) {
				this.#attempt?.resolve();
				this.#attempt = reply.pending === null ? null : Promise.withResolvers<void>();
			}
			this.#schedule(reply.deadline);
			const waiting =
				(next.step.op === "stop" || next.step.op === "closed") && next.step.tabId === reply.holder?.tabId
					? this.#attempt?.promise
					: undefined;
			const waiter = this.#effects(reply);
			next.done?.(waiter ?? waiting);
		}
	}

	#effects(reply: Reply): Promise<void> | undefined {
		let waiter: Promise<void> | undefined;
		for (const effect of reply.effects) {
			if (effect.kind === "stopWaiter") {
				// Send the stop before broadcasting: a listener can already request another lease for this tab.
				waiter = this.#revoke(effect.tabId, "stop").then(() => {});
			} else if (effect.kind === "revoke") {
				const { lease, attempt } = effect;
				void this.#revoke(effect.tabId, effect.reason).then(ok =>
					this.#send({ op: "answered", lease, attempt, ok }),
				);
			}
		}
		try {
			if (reply.changed && !this.#disposed) this.#deps.onChange(this.state());
			for (const effect of reply.effects) {
				if (effect.kind !== "grant") continue;
				// Broadcasting, or a preceding grant in this batch, can synchronously stop or replace this lease.
				const current = this.#last;
				if (
					!current?.holder ||
					current.holder.lease !== reply.holder?.lease ||
					current.pending !== null ||
					current.holder.failed ||
					this.#waitingForHub ||
					this.#id === null
				)
					break;
				this.#deps.grant(effect.tabId, effect.requestId, effect.waited);
			}
		} catch (error) {
			// A failed broadcast or bridge send neither confirms a revoke nor rolls back an accepted checkpoint.
			console.warn("Desktop slot could not deliver its update", error);
		}
		return waiter;
	}

	async #revoke(tabId: string, reason: DesktopSlotReason): Promise<boolean> {
		try {
			await this.#deps.revoke(tabId, reason);
			return true;
		} catch {
			return false;
		}
	}

	#schedule(deadline: number | null): void {
		if (this.#timer?.deadline === deadline) return;
		if (this.#timer) this.#timers.clear(this.#timer.handle);
		this.#timer = null;
		if (deadline === null) return;
		const timer = {
			deadline,
			handle: this.#timers.set(
				() => {
					if (this.#timer !== timer) return;
					this.#timer = null;
					if (this.#waitingForHub) {
						this.#waitingForHub = false;
						this.#drain();
					} else this.#send({ op: "tick" });
				},
				Math.max(0, deadline - Math.floor(this.#now())),
			),
		};
		this.#timer = timer;
	}
}
