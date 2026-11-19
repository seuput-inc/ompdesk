/**
 * A black console window appeared on Windows and nothing said whose it was. OMPdesk starts every program without a
 * window (`windowsHide`, `CREATE_NO_WINDOW`; spawn-hidden.test.ts holds main's starts to it), so a console window on
 * the desktop is a start that missed that, something a tool started by itself, or not OMPdesk's at all. Each new one
 * leaves a `gui-runtime.jsonl` line (source `console-window`): the window, its process and command line, that
 * process's ancestors up to OMPdesk's own, and for a window OMPdesk's processes did not open what they started just
 * before (Windows Terminal shows the console of another program, so its window's own process says nothing of who
 * opened it). Observation only.
 *
 * The core lists the windows (`procs.consoles`, native/ompdesk/crates/core/src/procs); this file decides what is new,
 * whose it is and how many lines an hour that is worth.
 */
import { basename } from "node:path";
import { LineBudget } from "./line-budget";

type Details = Record<string, string | number | boolean>;

// shortcut: looked at once a second, so a window that closes sooner can be missed; hook EVENT_OBJECT_SHOW in the core
// once a report names a window that flashed and left no line.
export const CONSOLE_POLL_MS = 1_000;
/** A process OMPdesk started this long before a window was seen is named beside it. */
export const CONSOLE_RECENT_MS = 30_000;
/** Lines an hour; the windows past it are counted on the next line written (`dropped`). */
export const CONSOLE_LINES_PER_HOUR = 30;
const TITLE_CHARS = 200;
const COMMAND_CHARS = 600;
const RECENT_COMMAND_CHARS = 200;

/** One process beside a window, as `procs.consoles` answers it. */
export interface ConsoleProcess {
	pid: number;
	name: string;
	/** When it started, ms since the epoch; absent when Windows did not say. */
	startedMs?: number;
	commandLine?: string;
}

/** One visible console window, as `procs.consoles` answers it. A window the caller named as known comes bare. */
export interface ConsoleWindow {
	window: number;
	/** The program a conhost window's console belongs to; for a Windows Terminal window the terminal itself. */
	pid: number;
	class: string;
	title: string;
	/** That process and its ancestors, nearest first. */
	chain?: ConsoleProcess[];
	/** The session tag in that process's environment (`SESSION_TAG_ENV`). */
	tag?: string;
	/** What OMPdesk's own processes started since `sinceMs`, the newest first. */
	recent?: ConsoleProcess[];
}

/** One of OMPdesk's own processes and what it is: `main`, `host` (the window's shell) or `core`. */
export interface OwnProcess {
	pid: number;
	role: string;
}

export interface ConsoleWindowDeps {
	list(known: number[], roots: number[], sinceMs: number): Promise<ConsoleWindow[]>;
	own(): OwnProcess[];
	/** The session file of the tab that holds a process tag. */
	sessionOf(tag: string): string | undefined;
	log(message: string, details: Details): void;
	now?: () => number;
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export class ConsoleWindowWatch {
	readonly #deps: ConsoleWindowDeps;
	readonly #now: () => number;
	readonly #budget = new LineBudget(CONSOLE_LINES_PER_HOUR);
	/** The windows on the desktop at the last look: one that goes and comes back under the same handle is new. */
	#known = new Set<number>();
	#looked = false;
	#looking = false;

	constructor(deps: ConsoleWindowDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
	}

	/** One look at the desktop (each `CONSOLE_POLL_MS`): a line for every console window that was not there before. */
	async poll(): Promise<void> {
		// An answer that takes longer than the pace is not asked for twice.
		if (this.#looking) return;
		this.#looking = true;
		try {
			const own = this.#deps.own();
			const now = this.#now();
			const windows = await this.#deps.list(
				[...this.#known],
				own.map(process => process.pid),
				now - CONSOLE_RECENT_MS,
			);
			const first = !this.#looked;
			this.#looked = true;
			const shown = new Set<number>();
			for (const win of windows) {
				shown.add(win.window);
				if (this.#known.has(win.window)) continue;
				const { ours, details } = this.#describe(win, own, now);
				// What stood on the desktop before OMPdesk looked is the person's own, unless OMPdesk's processes opened it.
				if (first && !ours) continue;
				const dropped = this.#budget.take(now);
				if (dropped === null) continue;
				this.#deps.log(
					ours
						? "console window opened by a process OMPdesk started"
						: "console window opened, not by a process OMPdesk started",
					{ ...details, ...(dropped > 0 ? { dropped } : {}) },
				);
			}
			this.#known = shown;
		} catch {
			// The core cannot answer now (it starts, rests, or the app quits): the next look asks again.
		} finally {
			this.#looking = false;
		}
	}

	#describe(win: ConsoleWindow, own: readonly OwnProcess[], now: number): { ours: boolean; details: Details } {
		const chain = win.chain ?? [];
		const self = chain[0];
		const parent = chain[1];
		// The nearest of OMPdesk's own processes above the window's: the one whose start, or whose child's, it was.
		const via = chain
			.map(process => own.find(mine => mine.pid === process.pid)?.role)
			.find(role => role !== undefined);
		// A tag alone says it too: a process keeps its session's tag after the parent that started it is gone.
		const ours = via !== undefined || win.tag !== undefined;
		const session = win.tag === undefined ? undefined : this.#deps.sessionOf(win.tag);
		const recent = ours ? [] : (win.recent ?? []);
		return {
			ours,
			details: {
				class: win.class,
				title: clip(win.title, TITLE_CHARS),
				pid: win.pid,
				...(self ? { exe: self.name } : {}),
				...(self?.commandLine ? { cmd: clip(self.commandLine, COMMAND_CHARS) } : {}),
				...(self?.startedMs !== undefined ? { ageMs: now - self.startedMs } : {}),
				ours,
				...(via !== undefined ? { via } : {}),
				...(win.tag !== undefined ? { session: session ? basename(session) : `tag ${win.tag}` } : {}),
				...(chain.length > 0 ? { chain: chain.map(process => `${process.name}(${process.pid})`).join(" < ") } : {}),
				...(parent?.commandLine ? { parentCmd: clip(parent.commandLine, COMMAND_CHARS) } : {}),
				...(recent.length > 0
					? {
							recent: recent
								.map(process => {
									const age = process.startedMs === undefined ? "" : ` ${now - process.startedMs}ms ago`;
									const line = process.commandLine
										? `: ${clip(process.commandLine, RECENT_COMMAND_CHARS)}`
										: "";
									return `${process.name}(${process.pid})${age}${line}`;
								})
								.join(" | "),
						}
					: {}),
			},
		};
	}
}
