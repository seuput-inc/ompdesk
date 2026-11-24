/**
 * Main's side of the quit (app-quit.ts): who asked is logged, an approved quit freezes before the shell hears of it,
 * the confirm asks only while running work would stop, and the effects the shell calls (confirm, finalize, teardown,
 * settle) freeze the run's state, arm the force exit and report how the last stops went.
 */
import type { MessageBoxOptions } from "electron";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { fillText } from "../shared/fill-text";
import type * as AppQuit from "./app-quit";
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";
import { QUIT_EXIT_TIMEOUT_MS } from "./quit-watchdog";
import type { QuitEffects } from "./shell-host/electron/app";

const electron = vi.hoisted(() => ({
	beforeQuit: [] as Array<() => void>,
	effects: null as QuitEffects | null,
	quit: vi.fn<(intent: string) => void>(),
	exit: vi.fn<(code: number) => void>(),
	log: vi.fn(),
	showMessageBox: vi.fn<(options: MessageBoxOptions) => Promise<{ response: number }>>(),
}));

vi.mock("electron", () => ({
	app: {
		on: (name: string, listener: () => void) => {
			if (name === "before-quit") electron.beforeQuit.push(listener);
		},
		quit: electron.quit,
		exit: electron.exit,
		setQuitEffects: (effects: QuitEffects) => {
			electron.effects = effects;
		},
	},
	BrowserWindow: { getFocusedWindow: () => null },
	dialog: { showMessageBox: electron.showMessageBox },
}));
vi.mock("./runtime-log", () => ({ writeRuntimeLog: electron.log }));
// The real ./i18n opens the prefs store at load; the text table is what matters here.
vi.mock("./i18n", () => ({
	getMainLanguage: () => "en",
	mainT: (key: MainTextKey, _language: string, params?: Record<string, number>) => fillText(MAIN_TEXT[key].en, params),
}));

let working: boolean;
let quit: typeof AppQuit;
let effects: QuitEffects;
let teardown: Mock<() => void>;
let finalize: Mock<() => Promise<void>>;
let ompsExited: PromiseWithResolvers<void>;

/** A fresh module (a dynamic import after `resetModules`): its quit state starts unfrozen in every test. */
beforeEach(async () => {
	vi.resetModules();
	electron.beforeQuit.length = 0;
	electron.effects = null;
	electron.quit.mockReset();
	electron.exit.mockReset();
	electron.log.mockReset();
	electron.showMessageBox.mockReset();
	working = true;
	teardown = vi.fn<() => void>();
	finalize = vi.fn(async () => {});
	ompsExited = Promise.withResolvers<void>();
	quit = await import("./app-quit");
	quit.installQuitGuard(
		() => [
			{ windowId: 1, tabId: "a", inFlight: working },
			{ windowId: 1, tabId: "b", inFlight: false },
		],
		teardown,
		finalize,
		() => ompsExited.promise,
	);
	quit.setQuitResumes(() => false);
	if (!electron.effects) throw new Error("installQuitGuard registered no quit effects");
	effects = electron.effects;
});

afterEach(() => {
	vi.useRealTimers();
});

const fireBeforeQuit = () => {
	for (const listener of electron.beforeQuit) listener();
};

describe("who asked to quit, in gui-runtime.jsonl", () => {
	it("a quit main asks for is logged with its asker before the shell hears it, and only once", () => {
		quit.askQuit("tray");
		expect(electron.quit).toHaveBeenCalledWith("ask");
		expect(electron.log).toHaveBeenCalledTimes(1);
		expect(electron.log).toHaveBeenCalledWith(
			expect.objectContaining({ source: "app-quit", message: "Quit asked by the tray menu's Quit" }),
		);
		expect(electron.log.mock.invocationCallOrder[0]).toBeLessThan(electron.quit.mock.invocationCallOrder[0] ?? 0);
		fireBeforeQuit();
		expect(electron.log).toHaveBeenCalledTimes(1);
	});

	it("a quit nobody in main asked for is the shell's (the Dock's Quit, a logout)", () => {
		fireBeforeQuit();
		expect(electron.log).toHaveBeenCalledTimes(1);
		expect(electron.log).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "app-quit",
				message: "Quit asked by the shell (Dock Quit, logout or the system)",
				details: { asker: "shell", relaunch: false },
			}),
		);
	});
});

describe("the quit's freeze", () => {
	it("an approved quit is frozen before the shell hears of it; an ask is not", () => {
		quit.askQuit("tray");
		expect(quit.quitApproved()).toBe(false);
		const seenFrozen: boolean[] = [];
		electron.quit.mockImplementation(() => seenFrozen.push(quit.quitApproved()));
		quit.requestQuit("command");
		expect(electron.quit).toHaveBeenLastCalledWith("approved");
		expect(seenFrozen).toEqual([true]);
	});

	it("a restart prompt the shell approved itself is logged and frozen, and main asks the shell for no second quit", () => {
		quit.approveQuit("crash-recovery", { relaunch: true });
		expect(quit.quitApproved()).toBe(true);
		expect(electron.quit).not.toHaveBeenCalled();
		expect(electron.log).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Relaunch asked by the window crash prompt",
				details: { asker: "crash-recovery", relaunch: true },
			}),
		);
		fireBeforeQuit();
		expect(electron.log).toHaveBeenCalledTimes(1);
	});

	it("the shell's confirm freezes only when the person quits anyway", async () => {
		electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
		expect(await effects.confirm()).toBe(false);
		expect(quit.quitApproved()).toBe(false);
		electron.showMessageBox.mockResolvedValueOnce({ response: 0 });
		expect(await effects.confirm()).toBe(true);
		expect(quit.quitApproved()).toBe(true);
	});

	it("finalize freezes at once and waits for the worktree finalizer; a failure is a warning with its error", async () => {
		const done = Promise.withResolvers<void>();
		finalize.mockReturnValueOnce(done.promise);
		let finished = false;
		const finalizing = effects.finalize().then(() => {
			finished = true;
		});
		expect(quit.quitApproved()).toBe(true);
		await Promise.resolve();
		expect(finished).toBe(false);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		done.reject(new Error("worktree busy"));
		await finalizing;
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("worktree busy"));
		warning.mockRestore();
	});
});

describe("confirmQuit", () => {
	it("asks while a turn runs and the setting is off, and only 'Quit anyway' quits", async () => {
		electron.showMessageBox.mockResolvedValueOnce({ response: 0 });
		expect(await quit.confirmQuit()).toBe(true);
		expect(electron.showMessageBox.mock.calls[0]?.[0]).toMatchObject({
			type: "warning",
			buttons: ["Quit anyway", "Keep working"],
			defaultId: 1,
			cancelId: 1,
			message: "Sessions are still running",
			detail: "Still working: 1 of 2 sessions, in 1 window. Quitting stops them and their agents.",
		});
		electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
		expect(await quit.confirmQuit()).toBe(false);
	});

	it("asks nothing when no turn runs, or when the running turns continue after the next launch", async () => {
		working = false;
		expect(await quit.confirmQuit()).toBe(true);
		working = true;
		quit.setQuitResumes(() => true);
		expect(await quit.confirmQuit()).toBe(true);
		expect(electron.showMessageBox).not.toHaveBeenCalled();
	});

	it("a second quit while the prompt is open queues no second prompt", async () => {
		const answer = Promise.withResolvers<{ response: number }>();
		electron.showMessageBox.mockReturnValueOnce(answer.promise);
		const first = quit.confirmQuit();
		expect(await quit.confirmQuit()).toBe(false);
		answer.resolve({ response: 1 });
		expect(await first).toBe(false);
		expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
	});
});

describe("confirmUpdateRestart", () => {
	const none = { subagents: 0, jobs: 0, subagentLabels: [], jobLabels: [] };
	const work = {
		subagents: 2,
		jobs: 1,
		subagentLabels: ["LayoutSplit", "StreamFast"],
		jobLabels: ["dev server"],
	};

	it("with Continue interrupted work on names the background work it would start over, and Restart goes ahead", async () => {
		quit.setQuitResumes(() => true);
		electron.showMessageBox.mockResolvedValueOnce({ response: 0 });
		expect(await quit.confirmUpdateRestart(async () => work)).toBe(true);
		expect(electron.showMessageBox.mock.calls[0]?.[0]).toMatchObject({
			type: "warning",
			buttons: ["Restart", "Cancel"],
			defaultId: 1,
			cancelId: 1,
			message: "Background work is still running",
			detail:
				"2 subagents (LayoutSplit, StreamFast) and 1 background job (dev server) will be interrupted and started again after the restart.",
		});
		electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
		expect(await quit.confirmUpdateRestart(async () => work)).toBe(false);
	});

	it("with it on asks nothing for a running turn alone", async () => {
		quit.setQuitResumes(() => true);
		expect(await quit.confirmUpdateRestart(async () => none)).toBe(true);
		expect(electron.showMessageBox).not.toHaveBeenCalled();
	});

	it("with it off keeps the quit prompt for running work and never reads the omps", async () => {
		const read = vi.fn(async () => work);
		electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
		expect(await quit.confirmUpdateRestart(read)).toBe(false);
		expect(electron.showMessageBox.mock.calls[0]?.[0]).toMatchObject({ buttons: ["Quit anyway", "Keep working"] });
		expect(read).not.toHaveBeenCalled();
		working = false;
		expect(await quit.confirmUpdateRestart(read)).toBe(true);
		expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
	});

	it("a second click while the prompt is open queues no second prompt", async () => {
		quit.setQuitResumes(() => true);
		const answer = Promise.withResolvers<{ response: number }>();
		electron.showMessageBox.mockReturnValueOnce(answer.promise);
		const first = quit.confirmUpdateRestart(async () => work);
		await vi.waitFor(() => expect(electron.showMessageBox).toHaveBeenCalledTimes(1));
		expect(await quit.confirmUpdateRestart(async () => work)).toBe(false);
		answer.resolve({ response: 0 });
		expect(await first).toBe(true);
		expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
	});
});

describe("the teardown commits the quit", () => {
	it.each([
		["a quit", false, "quit"],
		["an installer's quit", true, "update"],
	] as const)("%s freezes, tears down, and is forced out once the deadline passes", (_name, update, reason) => {
		vi.useFakeTimers();
		const forced = vi.fn();
		quit.onQuitForcedExit(forced);
		effects.teardown(update);
		expect(quit.quitApproved()).toBe(true);
		expect(teardown).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(QUIT_EXIT_TIMEOUT_MS - 1);
		expect(electron.exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(forced.mock.invocationCallOrder[0]).toBeLessThan(electron.exit.mock.invocationCallOrder[0] ?? 0);
		expect(electron.exit).toHaveBeenCalledWith(0);
		expect(electron.log).toHaveBeenCalledWith(
			expect.objectContaining({ source: "background-task", details: expect.objectContaining({ reason }) }),
		);
	});
});

describe("settle", () => {
	it("answers only once every omp has exited, with a clean code", async () => {
		let code: number | undefined;
		const settling = effects.settle().then(answer => {
			code = answer;
		});
		await Promise.resolve();
		expect(code).toBeUndefined();
		ompsExited.resolve();
		await settling;
		expect(code).toBe(0);
		expect(electron.exit).not.toHaveBeenCalled();
	});
});
