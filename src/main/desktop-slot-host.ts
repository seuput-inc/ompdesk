/** Routes the native slot's effects to a captured local omp spawn, never to its tab's replacement. */
import { basename } from "node:path";
import type { DesktopSlotSession, DesktopSlotState } from "../../resources/gui-bridge/desktop-slot-contracts";
import { DesktopSlot } from "./desktop-slot";
import { DESKTOP_SLOT_BRIDGE_METHODS } from "./local/desktop-slot";
import type { TabActivity } from "./sidecar-pool";
import type { DesktopSlotProcess, SidecarLike } from "./sidecar-types";
import { recordTurnStop } from "./turn-stop-log";

/** What the host reads of the pool. */
export interface DesktopSlotPool {
	tabFacts(tabId: string): { title: string } | null;
	noteStopped(tabId: string): void;
}

export interface DesktopSlotHostDeps {
	pool: DesktopSlotPool;
	/** Every window hears the slot's new state. */
	broadcast(state: DesktopSlotState): void;
	/** Tests shorten the wait for a killed process to exit. */
	killConfirmMs?: number;
}

/** A revoke waits for stock's `revokeControl()` on every controller; the slot gives up on it first (10 s). */
const REVOKE_COMMAND_TIMEOUT_MS = 15_000;
const GRANT_COMMAND_TIMEOUT_MS = 10_000;
/** A killed omp that has not exited by now is not confirmed gone (SIGTERM only: the slot stays held). */
const KILL_CONFIRM_MS = 5_000;

interface Execution {
	key: string;
	tabId: string;
	title: string;
	process: DesktopSlotProcess;
	sidecar: SidecarLike;
	exited: boolean;
}

export class DesktopSlotHost {
	readonly #slot: DesktopSlot;
	readonly #deps: DesktopSlotHostDeps;
	readonly #tabIds = new WeakMap<SidecarLike, string>();
	readonly #closed = new WeakSet<SidecarLike>();
	readonly #tabs = new Map<string, SidecarLike>();
	readonly #keys = new WeakMap<DesktopSlotProcess, string>();
	readonly #executions = new Map<string, Execution>();
	#sequence = 0;
	readonly #killConfirmMs: number;

	constructor(deps: DesktopSlotHostDeps) {
		this.#deps = deps;
		this.#killConfirmMs = deps.killConfirmMs ?? KILL_CONFIRM_MS;
		this.#slot = new DesktopSlot({
			titleOf: key => this.#title(key),
			revoke: (id, reason) =>
				this.#call(id, DESKTOP_SLOT_BRIDGE_METHODS.revoke, { reason }, REVOKE_COMMAND_TIMEOUT_MS),
			kill: id => this.#kill(id),
			grant: (id, requestId, waited) => {
				// A grant that does not arrive proves nothing about the process, so the slot stays with that session:
				// its lease runs out and the revoke path (confirmed, or revoke-failed) decides.
				this.#call(id, DESKTOP_SLOT_BRIDGE_METHODS.grant, { requestId, waited }, GRANT_COMMAND_TIMEOUT_MS).catch(
					() => undefined,
				);
			},
			onChange: state => deps.broadcast(this.#view(state)),
		});
	}

	state(): DesktopSlotState {
		return this.#view(this.#slot.state());
	}

	/** A pool tab's sidecar exists (pool acquire); tabs on a paired host are that host's slot. */
	attachSidecar(tabId: string, sidecar: SidecarLike): void {
		if (sidecar.device) return;
		this.#tabIds.set(sidecar, tabId);
		this.#tabs.set(tabId, sidecar);
	}

	/** The pool's tab activity: a released tab hands the slot on (revoking it first when it held it). */
	observeActivity(activity: TabActivity): void {
		if (activity.type !== "released") return;
		const sidecar = this.#tabs.get(activity.tabId);
		if (!sidecar) return;
		this.#closed.add(sidecar);
		this.#tabs.delete(activity.tabId);
		for (const entry of this.#executions.values()) {
			if (entry.sidecar === sidecar) void this.#slot.closed(entry.key);
		}
	}

	/** The sidecar factory's hook: the bridge's slot frames of one omp process. */
	frame(sidecar: SidecarLike, frame: Record<string, unknown>): void {
		if (sidecar.device) return;
		const acquire = frame.type === "desktop_slot_acquire";
		if (acquire && (this.#closed.has(sidecar) || typeof frame.requestId !== "string")) return;
		const pid = frame.processId;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return;
		const process = sidecar.desktopSlotProcess?.(pid, acquire);
		if (!process || process.absentAtAcquire) return;
		let id = this.#keys.get(process);
		if (!id) {
			if (!acquire) return;
			id = `omp:${++this.#sequence}`;
			const tabId = this.#tabIds.get(sidecar) ?? `host:${this.#sequence}`;
			this.#tabIds.set(sidecar, tabId);
			const entry = { key: id, tabId, sidecar, process, title: basename(sidecar.cwd) || sidecar.cwd, exited: false };
			this.#keys.set(process, id);
			this.#executions.set(id, entry);
			void process.exited.then(gone => {
				if (gone) this.#exited(entry);
			});
		}
		if (this.#executions.get(id)?.exited !== false) return;
		switch (frame.type) {
			case "desktop_slot_acquire":
				if (typeof frame.requestId === "string") this.#slot.acquire(id, frame.requestId);
				break;
			case "desktop_slot_touch":
				this.#slot.touch(id);
				break;
			case "desktop_slot_release":
				this.#slot.release(id);
				break;
		}
	}

	/** The user's Stop on the session using the screen: its run is aborted, its screen use revoked, the next one granted. */
	async stop(): Promise<void> {
		const holder = this.#slot.state().holder;
		if (!holder) return;
		const entry = this.#executions.get(holder.tabId);
		if (!entry) return;
		this.#stopProcess(entry, false);
		await this.#slot.stop(entry.key);
	}

	/** The user's "try again" on a revoke-failed holder. */
	retry(): void {
		this.#slot.retry();
	}

	/** The user's "stop that session" on a revoke-failed holder: abort it and end its omp; frees the slot once it exited. */
	async killHolder(): Promise<boolean> {
		return this.#slot.killHolder();
	}

	/** Abort the session and end its omp process; true only once that process has exited. */
	async #kill(id: string): Promise<boolean> {
		const entry = this.#executions.get(id);
		if (!entry) return false;
		if (entry.process.gone()) {
			this.#exited(entry);
			return true;
		}
		this.#stopProcess(entry, true);
		let timer: NodeJS.Timeout | undefined;
		const gone = await Promise.race([
			entry.process.exited,
			new Promise<boolean>(resolve => {
				timer = setTimeout(() => resolve(false), this.#killConfirmMs);
			}),
		]);
		clearTimeout(timer);
		if (gone) this.#exited(entry);
		return gone;
	}

	dispose(): void {
		this.#slot.dispose();
	}

	#exited(entry: Execution): void {
		if (entry.exited) return;
		entry.exited = true;
		void this.#slot.crashed(entry.key).then(() => this.#executions.delete(entry.key));
	}

	#stopProcess(entry: Execution, restart: boolean): void {
		if (entry.sidecar.rpcClient !== entry.process.client) return;
		this.#deps.pool.noteStopped(entry.tabId);
		recordTurnStop({
			command: "abort",
			tab: entry.tabId,
			by: "desktop-slot",
			surface: restart ? "screen-kill" : "screen-stop",
		});
		entry.process.stop(restart);
	}

	#title(key: string): string {
		const entry = this.#executions.get(key);
		if (!entry) return "";
		entry.title = this.#deps.pool.tabFacts(entry.tabId)?.title ?? entry.title;
		return entry.title;
	}

	#view(state: DesktopSlotState): DesktopSlotState {
		const session = <T extends DesktopSlotSession>(row: T): T => ({
			...row,
			tabId: this.#executions.get(row.tabId)?.tabId ?? row.tabId,
		});
		return { holder: state.holder && session(state.holder), queue: state.queue.map(session) };
	}

	async #call(id: string, method: string, params: unknown, timeoutMs: number): Promise<void> {
		const entry = this.#executions.get(id);
		if (!entry) throw new Error("That session's process is gone.");
		if (entry.process.gone()) {
			this.#exited(entry);
			throw new Error("That session's process exited.");
		}
		const response = await entry.process.client.command({ type: "desktop_slot_bridge", method, params }, timeoutMs);
		if (!response.success) throw new Error(response.error ?? `${method} failed`);
	}
}
