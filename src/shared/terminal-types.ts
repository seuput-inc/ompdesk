export interface TerminalSnapshot {
	id: string;
	output: string;
	/** Where `output` ends in the session's stream: the next `list` names it. With a `budget` this can be short of the end. */
	offset: number;
	exited: boolean;
	exitCode?: number;
	error?: string;
	/** The PTY's current size; absent from a host that predates the viewer lease. */
	cols?: number;
	rows?: number;
	/** Who may size this PTY for the asking viewer: it did (`you`), another viewer did (`other`), or nobody. */
	lease?: TerminalLeaseState;
}
/**
 * What a restart keeps of one side-panel terminal (`crates/core/src/termhistory.rs`): its tab's session file, its
 * order among the tab's terminals, the folder its shell was in, the shell, how it ended, and the tail of its output.
 */
export interface TerminalCheckpoint {
	session: string;
	id: string;
	order: number;
	cwd: string;
	shell?: string;
	exited: boolean;
	exitCode?: number;
	error?: string;
	history: string;
}
/** A viewer's standing on a PTY's size. */
export type TerminalLeaseState = "you" | "other" | "free";
/** The selected terminal number as the tool prints it, and the number of trailing lines to read. */
export interface TerminalRead {
	pick: string;
	lines: number;
}
/** A shell the Terminal panel can start (main/terminal/shells.ts); `path` names it. */
export interface TerminalShell {
	path: string;
	name: string;
	args: string[];
}
/** Pref holding the shell path new terminals start with; unset or unknown = the first detected shell. */
export const TERMINAL_SHELL_PREF = "terminalShell";
/** A web viewer's `list` is held at most this long when nothing new has been written. */
export const TERMINAL_POLL_MAX_WAIT_MS = 1000;
/** The most output (UTF-16 units) one reply carries to a web viewer: the viewer acknowledges it by asking again. */
export const TERMINAL_OUTPUT_BUDGET = 64 * 1024;
export type TerminalOperation =
	/**
	 * `waitMs`: hold the answer until some listed session has output past its offset, any session changed (exit, size,
	 * restart, close, clear, claim), or this long (a viewport's long poll; at most `TERMINAL_POLL_MAX_WAIT_MS`). `budget`: cut each session's `output` to this many units.
	 */
	| { action: "list"; offsets?: Record<string, number>; waitMs?: number; budget?: number }
	/** `shell`: a detected shell's path; omitted = this computer's default. */
	| { action: "create"; cols: number; rows: number; shell?: string }
	| { action: "write"; id: string; data: string }
	| { action: "resize"; id: string; cols: number; rows: number }
	/** Take the PTY's size from whoever has it (the viewer's next `resize` is then applied). */
	| { action: "claim"; id: string }
	| { action: "close" | "restart" | "clear"; id: string };
export interface TerminalApi {
	request(tabId: string, operation: TerminalOperation): Promise<TerminalSnapshot[]>;
	/** Shells the tab's computer can start (a paired host's for its tabs), the default first. */
	shells(tabId?: string): Promise<TerminalShell[]>;
}
