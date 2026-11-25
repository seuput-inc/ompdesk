/**
 * Main's side of the quit. The shell owns the quit's order (ask, confirm, finalize, teardown, window closes,
 * `will-quit`, settle, exit) and calls the effects registered here through `app.quitHook`. Every quit main starts goes
 * through `requestQuit()` (already approved); the quits a person asks for in the shell (⌘Q, the app menu, the tray, the
 * last window) reach the shell's `confirm` first and are logged here (`logQuitAsked`). Without the ask, ⌘Q SIGTERMs
 * every in-flight agent run with no word to the user; with Continue interrupted work on, those runs continue after the
 * next launch and the quit asks nothing.
 */
import { app, BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import { type BackgroundWork, backgroundWorkSentence } from "./background-work";
import { markMainStep } from "./hang-watchdog";
import { getMainLanguage, mainT } from "./i18n";
import {
	assessQuitRisk,
	type QuitRisk,
	quitNeedsConfirmation,
	updateRestartConfirmation,
	type WindowTabFact,
} from "./quit-guard";
import { exitReport, type QuitAsk, type QuitAsker, quitAskedReport } from "./quit-log";
import { QuitWatchdog, type QuitWatchdogReason } from "./quit-watchdog";
import { writeRuntimeLog } from "./runtime-log";
import type { RuntimeLogReport } from "./runtime-log-core";
import type { App as ShellApp } from "./shell-host/electron/app";

const shellApp = app as unknown as ShellApp;
/** The quit is committed: markers and saved state stop changing, windows close instead of hiding. */
let frozen = false;
let asking = false;
let inventory: () => WindowTabFact[] = () => [];
const forcedExitHooks: Array<() => void> = [];

const quitWatchdog = new QuitWatchdog({
	setTimer: (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref();
		return timer;
	},
	clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
	log: report => writeRuntimeLog(report),
	exit: () => {
		// `app.exit` skips `will-quit`, so whatever hangs off it (the relaunch swap) runs here first.
		for (const hook of forcedExitHooks) {
			try {
				hook();
			} catch (err) {
				console.warn(`[quit] forced-exit hook failed: ${String(err)}`);
			}
		}
		app.exit(0);
	},
});

/** Run `hook` right before the watchdog force-exits, for work a `will-quit` handler would have done. */
export function onQuitForcedExit(hook: () => void): void {
	forcedExitHooks.push(hook);
}

/** The quit was cancelled after it committed (a failed install keeps the app running): stop the force exit. */
export function disarmQuitWatchdog(reason?: QuitWatchdogReason): void {
	quitWatchdog.disarm(reason);
}

/**
 * A named ask is logged and its `before-quit` is still to come: that one is not the shell's. Every quit main starts
 * names itself, so a `before-quit` that starts a quit without one came from the shell (⌘Q, the Dock, a logout).
 */
let askPending = false;

/** Write who asked to end the app, before the quit work starts; for an end that never reaches `before-quit` too. */
export function logQuitAsked(asker: QuitAsker, ask?: QuitAsk): void {
	askPending = true;
	writeRuntimeLog(quitAskedReport(asker, ask));
}

/** Quit without asking about running work: the asker already did, or nobody can answer. A relaunch calls `app.relaunch()` first. */
export function requestQuit(asker: QuitAsker, ask?: QuitAsk): void {
	approveQuit(asker, ask);
	shellApp.quit("approved");
}

/** An approved quit is logged and freezes the run's state; the shell approves a window's restart prompt itself. */
export function approveQuit(asker: QuitAsker, ask?: QuitAsk): void {
	logQuitAsked(asker, ask);
	frozen = true;
}

/**
 * At start: the line for a previous run that left no end line, this run's end line on `quit` (every exit goes through
 * `app.exit`, which emits it), and the signals a script or a terminal sends, which quit as Electron quit on them.
 */
export function startQuitLog(previousEnd: Promise<RuntimeLogReport | null>): void {
	void previousEnd.then(report => {
		if (report) writeRuntimeLog(report);
	});
	app.on("quit", (_event, code) => writeRuntimeLog(exitReport(code)));
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => requestQuit("signal", { detail: signal }));
	}
}

/** A quit is underway (approved): windows must close, not hide to the tray. */
export function quitApproved(): boolean {
	return frozen;
}

/** What a quit right now would cost. The resource-change restart quotes it. */
export function quitRisk(): QuitRisk {
	return assessQuitRisk(inventory());
}

let resumesInterrupted: () => boolean = () => false;

/** Whether a quit's running turns continue after the next launch (Settings › General): then nothing asks. */
export function setQuitResumes(resumes: () => boolean): void {
	resumesInterrupted = resumes;
}

/**
 * Ask before a quit (⌘Q, the tray, an update restart) that would stop running
 * work. True when nothing would stop (no run, or the runs continue after the
 * next launch) or the user chose to quit anyway; false when they keep working
 * or a prompt is already open (⌘Q pressed again must not queue a second modal).
 */
export async function confirmQuit(): Promise<boolean> {
	const risk = quitRisk();
	if (!quitNeedsConfirmation(risk, resumesInterrupted())) return true;
	const language = getMainLanguage();
	return askOnce({
		type: "warning",
		buttons: [mainT("quit.quitAnyway", language), mainT("quit.keepWorking", language)],
		defaultId: 1,
		cancelId: 1,
		message: mainT("quit.workingTitle", language),
		detail: mainT("quit.workingBody", language, {
			working: risk.workingTabs,
			total: risk.totalTabs,
			windows: risk.workingWindows,
		}),
	});
}

/**
 * Ask before an update restart a person started ("Restart & install", the countdown's "Now", a paired device's
 * apply). Running turns continue after the relaunch, so with Continue interrupted work on this asks only when
 * background subagents or jobs run: it names them (`readWork` asks the omps now) and says they start again after the
 * restart. With the setting off it is the quit confirm. True = go ahead.
 */
export async function confirmUpdateRestart(readWork: () => Promise<BackgroundWork>): Promise<boolean> {
	const resumes = resumesInterrupted();
	if (!resumes) return confirmQuit();
	const work = await readWork();
	if (updateRestartConfirmation(quitRisk(), resumes, work) !== "background work") return true;
	const language = getMainLanguage();
	const what = backgroundWorkSentence(work, (key, params) => mainT(key, language, params));
	return askOnce({
		type: "warning",
		buttons: [mainT("updates.restartWork.restart", language), mainT("updates.restartWork.cancel", language)],
		defaultId: 1,
		cancelId: 1,
		message: mainT("updates.restartWork.title", language),
		detail: mainT("updates.restartWork.body", language, { work: what }),
	});
}

/**
 * One native confirm at a time (⌘Q pressed again, or a second restart click, must not queue a second modal):
 * true when the first button was chosen; false for the second, a dismissal, a failure or a prompt already open.
 */
async function askOnce(options: MessageBoxOptions): Promise<boolean> {
	if (asking) return false;
	asking = true;
	const owner = BrowserWindow.getFocusedWindow();
	try {
		const result = await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options));
		return result.response === 0;
	} catch {
		return false;
	} finally {
		asking = false;
	}
}

/**
 * Register the quit's effects with the shell, which runs each once in its own order. `tabInventory` reports what the
 * sidecars are doing; `finalize` runs with the windows still up (worktree-lifecycle.ts asks there), and an update's
 * quit skips it (the saved tabs come back after the update); `teardown` stops the app's services, ⌘Q and an update
 * alike. `settled` (what the teardown started and the exit must not cut off) holds the exit until every omp has exited,
 * so a stuck one is killed by its stop instead of outliving the app (8 Nov 2026: seven did, for minutes, after an
 * update's relaunch), and until the core wrote the schedules' journal, which main's exit would cut off on Windows.
 * Each part bounds itself.
 */
export function installQuitGuard(
	tabInventory: () => WindowTabFact[],
	teardown: () => void,
	finalize: () => Promise<void>,
	settled: () => Promise<void>,
): void {
	inventory = tabInventory;
	app.on("before-quit", () => {
		if (!askPending && !frozen) writeRuntimeLog(quitAskedReport("shell"));
		askPending = false;
	});
	shellApp.setQuitEffects({
		async confirm() {
			const ok = await confirmQuit();
			if (ok) frozen = true;
			return ok;
		},
		async finalize() {
			frozen = true;
			await finalize().catch((err: unknown) => console.warn(`[quit] finalize failed: ${String(err)}`));
		},
		teardown(update) {
			frozen = true;
			markMainStep(update ? "update" : "quit", update ? "installer started: teardown" : "teardown");
			teardown();
			if (update) markMainStep("update", "teardown-done: closing windows for the installer");
			// The quit is committed: nothing may keep the process alive past the deadline.
			quitWatchdog.arm(update ? "update" : "quit");
		},
		async settle() {
			markMainStep("quit", "will-quit: waiting for omps, schedules and core");
			try {
				await settled();
				markMainStep("quit", "omps exited, schedules saved, core stopped");
				return 0;
			} catch (err) {
				console.warn(`[quit] the last stops failed: ${String(err)}`);
				markMainStep("quit", "last stops failed");
				return 1;
			}
		},
	});
}
