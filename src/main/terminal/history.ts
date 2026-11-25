/**
 * Side-panel terminals across a restart (D92, after Orca's PTY checkpoints). A PTY does not outlive the terminals
 * worker (its stdin closing ends every shell), so what survives is each terminal's output tail and folder. Main asks
 * the worker for the terminals that changed (`terminal.checkpoints`, held there until one changes, so an idle terminal
 * costs nothing) at most every `CHECKPOINT_MS` and once more at quit; the worker hands its folders and end states to
 * the core's reader of its output, which writes each history file from the scrollback it keeps
 * (`crates/core/src/stock/scrollback.rs`, `termhistory.rs`). The first request of a tab's terminals after a launch
 * asks the core for that session's saved terminals and has the worker bring them back (`terminal.restore`): the old
 * output, a dimmed line, a new shell in the saved folder. A terminal the person closes, or that goes with its closed
 * tab, loses its file in the same reader; a quit keeps them all.
 */
import type { TerminalCheckpoint } from "../../shared/terminal-types";
import { core } from "../core/process";
import { stockHelperRequest } from "../stock-helper";
import { detectShells } from "./shells";

/** Rest between two checkpoint passes while terminals keep writing. */
export const CHECKPOINT_MS = 5_000;
/** How long one pass waits in the worker for a terminal to change before it asks again. */
export const HOLD_MS = 50_000;
/** The quit's last pass, bounded so a stuck worker never holds the exit. */
export const QUIT_SAVE_MS = 3_000;

export interface TerminalHistoryConfig {
	userData: string;
	/** The line between saved output and the new shell, in the app's language. */
	notice: () => string;
}

let config: TerminalHistoryConfig | null = null;
let running = false;
let quitting = false;

/** Turns history on (null: off, as before `index.ts` configures it, and between tests). */
export function configureTerminalHistory(next: TerminalHistoryConfig | null): void {
	config = next;
	running = false;
	quitting = false;
}

/** A quit is saving the terminals: they end with the worker and their history stays for the next launch. */
export function terminalsQuitting(): boolean {
	return quitting;
}

/**
 * Runs the checkpoint passes while the terminals worker lives. Called with every terminal request of a tab on a
 * session file; a failed pass (the worker ended: an omp update, the quit) stops it until the next request.
 */
export function watchTerminalHistory(): void {
	if (!config || running || quitting) return;
	running = true;
	const { userData } = config;
	void (async () => {
		try {
			while (!quitting) {
				await stockHelperRequest(
					"terminal.checkpoints",
					{ userData, waitMs: HOLD_MS },
					{ timeoutMs: HOLD_MS + 10_000 },
				);
				if (quitting) return;
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, CHECKPOINT_MS);
				await promise;
			}
		} catch {
			// The worker is gone; its terminals with it.
		} finally {
			running = false;
		}
	})();
}

/** The quit's last pass over every terminal, written before the core is stopped. */
export async function saveTerminalsForQuit(): Promise<void> {
	if (quitting) return;
	quitting = true;
	// No pass ever ran: no worker holds a terminal of a session, and none is started now.
	if (!config || !running) return;
	const { promise: late, resolve } = Promise.withResolvers<void>();
	const bound = setTimeout(resolve, QUIT_SAVE_MS);
	await Promise.race([
		stockHelperRequest("terminal.checkpoints", { userData: config.userData, all: true }, { timeoutMs: QUIT_SAVE_MS })
			.then(() => undefined)
			.catch(() => {}),
		late,
	]);
	clearTimeout(bound);
}

/**
 * `session`'s saved terminals back in `owner`'s worker (each in its folder, `cwd` when that is gone, with its shell
 * when this computer still lists it). Never fails the request it runs before: without history the panel starts fresh.
 */
export async function restoreTerminals(
	owner: string,
	cwd: string,
	env: Record<string, string>,
	session: string,
): Promise<void> {
	if (!config || quitting) return;
	try {
		const { userData, notice } = config;
		const saved = (await core().call<TerminalCheckpoint[]>("terminalHistory.list", { userData, session })).result;
		if (saved.length === 0) return;
		const shells = await detectShells();
		await stockHelperRequest("terminal.restore", {
			owner,
			cwd,
			env,
			session,
			userData,
			notice: notice(),
			terminals: saved.map(({ session: _session, shell, ...terminal }) => ({
				...terminal,
				shell: shells.find(item => item.path === shell),
			})),
		});
	} catch (error) {
		console.warn(`[terminal] couldn't restore terminal history: ${String(error)}`);
	}
}
