import { randomUUID } from "node:crypto";
import type { TerminalCheckpoint, TerminalOperation, TerminalSnapshot } from "../../../src/shared/terminal-types";

export interface PtyOptions {
	application: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	cols: number;
	rows: number;
}
export interface Pty {
	startArgv(
		options: PtyOptions,
		onChunk: (error: Error | null, chunk: string) => void,
	): Promise<{ exitCode?: number }>;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
	/** The shell's process id once it runs (stock `PtySession.pid`). */
	pid?(): number | null;
}
interface Entry {
	owner: string;
	pty: Pty;
	options: PtyOptions;
	pending: string;
	offset: number;
	exited: boolean;
	exitCode?: number;
	error?: string;
	/** When it was first opened (ms): the order a restored tab lists its terminals in. */
	order: number;
	/** The session file its tab is on (main says so with each request); null: not kept across a restart. */
	session: string | null;
	/** Counts changes a checkpoint carries; `saved` is the count the last checkpoint took. */
	version: number;
	saved: number;
	/** Input written before the shell's first output, held until then or `SHELL_READY_MS` (D90). */
	queued: string[] | null;
	/** The redraw nudge waiting to give the shell its rows back (H137). */
	nudge?: ReturnType<typeof setTimeout>;
}
/** What a restored terminal is started from (a saved `TerminalCheckpoint` with main's options). */
export interface RestoredTerminal {
	id: string;
	order: number;
	history: string;
	exited: boolean;
	exitCode?: number;
	error?: string;
	options: PtyOptions;
}
/** A checkpoint as the worker hands it to the core, which adds the history from its scrollback. */
export type CheckpointFacts = Omit<TerminalCheckpoint, "history">;
const SCROLLBACK_CHARS = 1_000_000;
/** Startup input waits at most this long for the shell's first output. */
export const SHELL_READY_MS = 15_000;
/** How long a redraw nudge keeps the PTY one row shorter, so the program sees two different sizes. */
export const NUDGE_MS = 250;

/**
 * The line between a restored terminal's saved output and its new shell: the old program's modes ended (main
 * screen, visible cursor, plain pen), then `notice` dimmed on its own line.
 */
export function restoredSeparator(notice: string): string {
	return `\x1b[0m\x1b[?1049l\x1b[?25h\r\n\x1b[2m── ${notice} ──\x1b[0m\r\n`;
}

/** The worker hands off unread PTY chunks, never a second copy of the retained history. */
interface TerminalRow extends Omit<TerminalSnapshot, "output"> {
	delta?: string | { utf16: string };
	from?: number;
}
export class TerminalService {
	readonly #entries = new Map<string, Entry>();
	/** Long polls (`list` with `waitMs`) waiting for the next output or change of any session. */
	readonly #waiters = new Set<() => void>();
	/**
	 * What a viewer shows besides output, changed so far: exits and failures, a resize, a restart, a close, a clear, a
	 * claim of the size. A poll that began earlier answers when this moved, so another window showing the same PTY
	 * follows at once.
	 */
	#changed = 0;
	constructor(
		readonly factory: () => Pty,
		/** The folder a running shell is in now, by its pid; null where the OS cannot say (Windows). */
		readonly cwdOf: (pid: number) => Promise<string | null> = async () => null,
	) {}

	#wake(changed = false): void {
		if (changed) this.#changed += 1;
		for (const wake of [...this.#waiters]) wake();
	}

	/** Holds until `ready()` or `waitMs` passes; any output or change looks again. */
	async #hold(waitMs: number, ready: () => boolean): Promise<void> {
		const deadline = Date.now() + waitMs;
		while (waitMs > 0 && !ready() && Date.now() < deadline) {
			const { promise, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, deadline - Date.now());
			this.#waiters.add(resolve);
			await promise.finally(() => {
				clearTimeout(timer);
				this.#waiters.delete(resolve);
			});
		}
	}

	#start(entry: Entry): void {
		entry.exited = false;
		entry.exitCode = undefined;
		entry.error = undefined;
		const pty = entry.pty;
		// A shell can drop what is typed before it reads its terminal: hold it until the shell first writes.
		entry.queued = [];
		const release = () => {
			clearTimeout(ready);
			const queued = entry.queued;
			entry.queued = null;
			if (entry.pty !== pty || entry.exited || !queued) return;
			for (const data of queued) pty.write(data);
		};
		const ready = setTimeout(release, SHELL_READY_MS);
		const ended = () => {
			clearTimeout(ready);
			entry.queued = null;
			entry.exited = true;
			entry.version += 1;
			this.#wake(true);
		};
		const append = (text: string) => {
			entry.offset += text.length;
			entry.pending += text;
			if (entry.pending.length > SCROLLBACK_CHARS) entry.pending = entry.pending.slice(-SCROLLBACK_CHARS);
			entry.version += 1;
			this.#wake();
		};
		try {
			void pty
				.startArgv(entry.options, (error, chunk) => {
					if (entry.pty !== pty) return;
					if (error) entry.error = error.message;
					else append(chunk);
					if (entry.queued) release();
					if (error) this.#wake(true);
				})
				.then(
					result => {
						if (entry.pty !== pty) return;
						entry.exitCode = result.exitCode;
						ended();
					},
					error => {
						if (entry.pty !== pty) return;
						entry.error = error instanceof Error ? error.message : String(error);
						ended();
					},
				);
		} catch (error) {
			entry.error = error instanceof Error ? error.message : String(error);
			clearTimeout(ready);
			entry.queued = null;
			entry.exited = true;
		}
	}

	/**
	 * Resizes the PTY one row shorter and back `NUDGE_MS` later, so a full-screen program redraws without any input
	 * (`redraw`, H137): asked by a viewer whose screen stayed blank after a replay that started past the cut.
	 */
	#nudge(entry: Entry): void {
		if (entry.exited || entry.nudge || entry.options.rows < 2) return;
		const pty = entry.pty;
		pty.resize(entry.options.cols, entry.options.rows - 1);
		entry.nudge = setTimeout(() => {
			entry.nudge = undefined;
			// A real resize since then already gave the program its size; this one repeats it.
			if (entry.pty === pty && !entry.exited) pty.resize(entry.options.cols, entry.options.rows);
		}, NUDGE_MS);
	}

	/** `entry` as a viewer sees it; its unread output goes with it when `drain` (the core keeps the scrollback). */
	#row(id: string, entry: Entry, from: number | undefined, drain: boolean): TerminalRow {
		const delta = drain && entry.pending ? entry.pending : undefined;
		if (delta !== undefined) entry.pending = "";
		return {
			id,
			from,
			// Rust strings cannot carry lone UTF-16 units, including one left by scrollback truncation.
			delta: delta && !delta.isWellFormed() ? { utf16: Buffer.from(delta, "utf16le").toString("base64") } : delta,
			offset: entry.offset,
			exited: entry.exited,
			exitCode: entry.exitCode,
			error: entry.error,
			cols: entry.options.cols,
			rows: entry.options.rows,
		};
	}

	request(
		owner: string,
		operation: TerminalOperation,
		options: PtyOptions,
		/** The tab's session file now, "" for none (undefined: not said, as by the agent's read or a paired device). */
		session?: string,
	): TerminalRow[] {
		if (session !== undefined)
			for (const entry of this.#entries.values())
				if (entry.owner === owner && entry.session !== (session || null)) {
					entry.session = session || null;
					entry.version += 1;
				}
		if (operation.action === "create") {
			const entry: Entry = {
				owner,
				pty: this.factory(),
				options: { ...options, cols: operation.cols, rows: operation.rows },
				pending: "",
				offset: 0,
				exited: false,
				order: Date.now(),
				session: session || null,
				version: 1,
				saved: 0,
				queued: null,
			};
			this.#entries.set(randomUUID(), entry);
			this.#start(entry);
		} else if (operation.action === "claim") {
			// Wake other viewers so their pending polls report the new size holder.
			this.#wake(true);
		} else if (operation.action !== "list") {
			const entry = this.#entries.get(operation.id);
			if (!entry || entry.owner !== owner) throw new Error("Terminal not found");
			switch (operation.action) {
				case "write":
					if (entry.exited) break;
					if (entry.queued) entry.queued.push(operation.data);
					else entry.pty.write(operation.data);
					break;
				case "resize":
					entry.options.cols = operation.cols;
					entry.options.rows = operation.rows;
					if (!entry.exited) entry.pty.resize(operation.cols, operation.rows);
					this.#wake(true);
					break;
				case "close":
					if (!entry.exited) entry.pty.kill();
					clearTimeout(entry.nudge);
					this.#entries.delete(operation.id);
					this.#wake(true);
					break;
				case "restart":
					if (!entry.exited) entry.pty.kill();
					entry.pty = this.factory();
					entry.version += 1;
					this.#start(entry);
					this.#wake(true);
					break;
				case "clear":
					entry.pending = "";
					entry.version += 1;
					this.#wake(true);
					break;
				case "redraw":
					this.#nudge(entry);
					break;
			}
		}
		return [...this.#entries]
			.filter(([, entry]) => entry.owner === owner)
			.map(([id, entry]) => {
				const from = operation.action !== "list" ? undefined : operation.offsets ? operation.offsets[id] : 0;
				return this.#row(id, entry, from, from !== undefined);
			});
	}

	/**
	 * A `list` that holds until one of the owner's sessions has output past its offset, or any session has changed
	 * otherwise since (exit, failure, size, restart, close, clear, claim), or `waitMs` has passed (a viewer's long poll:
	 * nothing is sent while nothing happens). Output already waiting answers at once, so a viewer behind a `budget`
	 * keeps reading without pause.
	 */
	async wait(owner: string, operation: Extract<TerminalOperation, { action: "list" }>): Promise<void> {
		const pending = () =>
			[...this.#entries].some(
				([id, entry]) =>
					entry.owner === owner &&
					operation.offsets?.[id] !== undefined &&
					entry.offset > (operation.offsets[id] ?? 0),
			);
		const changed = this.#changed;
		// Any session's output wakes every poll; each looks again and sleeps on unless it was its own news.
		await this.#hold(operation.waitMs ?? 0, () => pending() || this.#changed !== changed);
	}

	/**
	 * Saved terminals of `owner`'s tab back after a restart, under their own ids: each shows its saved output, then a
	 * new shell in its folder below `notice`; one that had ended comes back ended, with nothing started (P107). An id
	 * already here is left as it is.
	 */
	restore(owner: string, session: string, terminals: RestoredTerminal[], notice: string): void {
		for (const saved of terminals) {
			if (this.#entries.has(saved.id)) continue;
			const output = saved.exited ? saved.history : saved.history + restoredSeparator(notice);
			const entry: Entry = {
				owner,
				pty: this.factory(),
				options: saved.options,
				pending: output,
				offset: output.length,
				exited: true,
				exitCode: saved.exitCode,
				error: saved.error,
				order: saved.order,
				session,
				version: 0,
				saved: 0,
				queued: null,
			};
			this.#entries.set(saved.id, entry);
			if (!saved.exited) this.#start(entry);
		}
		this.#wake(true);
	}

	/**
	 * What a restart keeps of every terminal whose tab is on a session file: those changed since the last checkpoint,
	 * or all with `all` (the quit's). Held until one has changed or `waitMs` passed, so an idle terminal costs nothing.
	 * Each row carries the terminal's unread output, so the core's scrollback, which writes the checkpoint, has all of it.
	 */
	async checkpoints(options: { all?: boolean; waitMs?: number }): Promise<{
		rows: TerminalRow[];
		save: CheckpointFacts[];
	}> {
		const due = () =>
			[...this.#entries].filter(
				([, entry]) => entry.session !== null && (options.all || entry.version !== entry.saved),
			);
		await this.#hold(options.waitMs ?? 0, () => due().length > 0);
		const folders = new Map(
			await Promise.all(
				due().map(async ([id, entry]) => {
					const pid = entry.exited ? null : (entry.pty.pid?.() ?? null);
					const cwd = pid !== null ? await this.cwdOf(pid).catch(() => null) : null;
					return [id, cwd ?? entry.options.cwd] as const;
				}),
			),
		);
		// Taken after the folder reads: a terminal closed meanwhile is not saved back, output since then goes along.
		const taken = due();
		return {
			rows: taken.map(([id, entry]) => this.#row(id, entry, undefined, true)),
			save: taken.map(([id, entry]) => {
				entry.saved = entry.version;
				return {
					session: entry.session as string,
					id,
					order: entry.order,
					cwd: folders.get(id) ?? entry.options.cwd,
					shell: entry.options.application,
					exited: entry.exited,
					...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
					...(entry.error !== undefined ? { error: entry.error } : {}),
				};
			}),
		};
	}

	/** Ends `owner`'s terminals (every one without an owner); their ids. */
	dispose(owner?: string): string[] {
		const removed: string[] = [];
		for (const [id, entry] of this.#entries) {
			if (owner !== undefined && entry.owner !== owner) continue;
			if (!entry.exited) entry.pty.kill();
			clearTimeout(entry.nudge);
			this.#entries.delete(id);
			removed.push(id);
		}
		return removed;
	}
}
