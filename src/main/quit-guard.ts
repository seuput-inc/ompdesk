/**
 * The "sessions are still working" inventory behind the ⌘Q confirmation. A Dock click's rule and the last window's
 * close are the shell's (`tauri-shell/src/entry.rs`, `last_close.rs`).
 *
 * Deliberately electron-free: the main process can only be unit-tested through
 * pure modules like this one, so the risk assessment (what counts as in-flight
 * work, which windows to name in the message) lives here while
 * `app-quit.ts` keeps just the dialog and the quit's effects.
 */

import { type BackgroundWork, hasBackgroundWork } from "./background-work";

export interface WindowTabFact {
	windowId: number;
	tabId: string;
	/** A run or an automatic compaction is in flight on this tab. */
	inFlight: boolean;
}

export interface QuitRisk {
	workingTabs: number;
	totalTabs: number;
	/** Windows holding at least one working tab — the dialog names the count. */
	workingWindows: number;
}

export function assessQuitRisk(facts: readonly WindowTabFact[]): QuitRisk {
	const workingWindows = new Set<number>();
	let workingTabs = 0;
	for (const fact of facts) {
		if (!fact.inFlight) continue;
		workingTabs++;
		workingWindows.add(fact.windowId);
	}
	return { workingTabs, totalTabs: facts.length, workingWindows: workingWindows.size };
}

/**
 * Idle tabs die quietly. Live agent runs ask first only when quitting stops them: with
 * Settings › General › Continue interrupted work on (`resumes`), a quit, an update restart or a
 * crash leaves their markers and the next launch continues them (turn-resume.ts), so nothing asks.
 */
export function quitNeedsConfirmation(risk: QuitRisk, resumes: boolean): boolean {
	return risk.workingTabs > 0 && !resumes;
}

/**
 * What a user-initiated update restart ("Restart & install", the countdown's "Now", a paired device's apply) asks
 * first. Setting off: the quit confirm for running turns (`quitNeedsConfirmation`; background work only exists
 * while a run is on, so it is covered). Setting on: running turns continue after the relaunch and ask nothing, but
 * background subagents and jobs start over from the beginning, so a restart over them is named first.
 * The scheduler's own automatic install never asks: it restarts at once and the relaunch starts them again
 * (app-auto-update.ts).
 */
export function updateRestartConfirmation(
	risk: QuitRisk,
	resumes: boolean,
	work: BackgroundWork,
): "running work" | "background work" | null {
	if (!resumes) return quitNeedsConfirmation(risk, resumes) ? "running work" : null;
	return hasBackgroundWork(work) ? "background work" : null;
}
