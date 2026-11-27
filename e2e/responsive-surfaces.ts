import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, type Locator, type Page } from "@playwright/test";
import { STRESS_PROMPT } from "../src/renderer/dev-harness/fixture";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import type { RpcCommand } from "../src/shared/rpc-types";
import {
	availableSummary,
	availableVersion,
	installedSummary,
	installedVersion,
} from "./fixture/version-summary-release";
import { type Look, touchLook } from "./responsive-audit";
import { selectInspectorView } from "./select-inspector-view";

/** A control's words in the look's language, so a Korean look finds by name what an English one does. */
const say = (look: Look, key: string): string => {
	const words = (look.lang === "ko" ? ko : en)[key];
	if (!words) throw new Error(`no ${look.lang} text for ${key}`);
	return words;
};

// The surfaces the responsive audit opens, split by owner (A: sidebar, transcript, composer and its popovers, side
// panels; B: Settings, Stats/Usage, Agents, Autopilot, Schedules, remote devices, model compare, Mobile web, every
// dialog, sheet, toast and banner). A surface opens through the stores a click would set (`window.__stores`,
// src/renderer/dev-harness/boot.ts) or a click on the real control, then waits for `ready` (a selector) or a beat.

export interface Surface {
	id: string;
	area: "A" | "B";
	/** What it is, for the report. */
	title: string;
	open(page: Page, look: Look, parityView?: "local" | "remote" | "phone"): Promise<void>;
	/** A selector that must be visible before measuring (the surface failed to open when it never is). */
	ready?: string;
	/** Extra query for the harness page (`&pwa=push`); surfaces sharing a page need the same query. */
	query?: string;
	/** Milliseconds to wait after `open` for data and motion to settle. */
	settle?: number;
	/** Measure the density figures (chrome share, gutter) too. */
	density?: boolean;
	/** Whether the surface exists at this look (a phone folds some controls behind ⋯); skipped otherwise. */
	when?: (look: Look) => boolean;
	/**
	 * The parity sheet (`bun run parity`, e2e/parity.e2e.ts) can capture this surface: every view first shows this
	 * session of the host (`work`: a session with one answered turn, `reply`: a session whose turns
	 * show what an agent presents in a reply, e2e/fixture/rpc-ui.ts `replyImages` and `REPLY_SHOWCASE`), then `open` runs. Only for a
	 * surface whose `open` and `ready` work on a real window (a click on a real control or nothing), never through
	 * `window.__stores`, which only the dev harness has.
	 */
	parity?: {
		session: ParitySession;
		/** B's work session leaves a child running on A, which also runs a session of its own (e2e/parity.e2e.ts). */
		remoteChild?: boolean;
		/**
		 * B also uses A as a computer before it is captured, so B's own window and its phone page list a paired computer
		 * (A's window lists B already; e2e/parity.e2e.ts).
		 */
		pairedBack?: boolean;
		/**
		 * Before it is captured, B runs a second session, "Parity roster", that every view opened once and then left for
		 * the shown session, so each holds a tab of it it does not show; its turn then starts two subagents
		 * (e2e/parity.e2e.ts). Its row must count them with no click.
		 */
		hiddenRoster?: boolean;
		/**
		 * Before it is captured, B's work session opens "Parity cross-project" in another folder of B's (`seuoffice`) and
		 * leaves its turn running, so it is a row under its opener and of its own project (e2e/parity.e2e.ts).
		 */
		crossProject?: boolean;
		/**
		 * Before it is captured, B has a session, "Parity folder gone", whose folder (`moda-office`) was deleted after
		 * its one answered turn (e2e/parity.e2e.ts).
		 */
		folderMissing?: boolean;
		/**
		 * Before it is captured, B's project `parity-sleep` holds "Parity older", "Parity newer" and "Parity sleeping",
		 * the last untouched for two hours (e2e/parity.e2e.ts).
		 */
		sleepingRow?: boolean;
		/**
		 * Before it is captured, each computer has three stored sessions, "Parity stored 1" to "3": B's in the work
		 * session's folder, A's in its own project, one answered turn each and no tab (e2e/parity.e2e.ts).
		 */
		storedRows?: boolean;
		/**
		 * Runs in each view after its capture (also when the capture failed): puts back what `open` changed beyond the
		 * page (the host's settings, a take waiting on the fake omp) or left open in the window beyond what Escape and
		 * opening the next session close (the side panel), so the next surface starts from the same host and window.
		 */
		after?(page: Page): Promise<void>;
		/**
		 * A part of the surface each view must have mounted and inside its transcript's visible box before the sheet
		 * measures it (the sideways-scroll check measures only what is mounted, and a capture of the transcript's end
		 * shows nothing of it).
		 */
		inView?: string;
		/**
		 * False while the fake omp was not started with the data this surface shows (a flag of e2e/fixture/rpc-ui.ts),
		 * or on a computer that has no such surface (macOS's permission rows): the sheet then has no such surface, and
		 * `--both-orders` leaves it out.
		 */
		available?(): boolean;
	};
}

export type ParitySession =
	| "start"
	| "work"
	| "firstRun"
	| "routing-bot"
	| "routing-worker"
	| "reply"
	| "steer"
	| "advisor"
	| "ci"
	| "a2ui"
	| "a2uiForm"
	| "limit"
	| "turns"
	| "long"
	| "cut"
	| "stress"
	| "schedule"
	| "connector"
	| "board";

/** The fake omp's voice script (`voiceScript`, e2e/fixture/rpc-ui.ts); e2e/parity.e2e.ts names the file. */
async function scriptVoice(script: Record<string, unknown>): Promise<void> {
	const file = process.env.OMP_GUI_TEST_VOICE_FILE;
	if (!file) throw new Error("the dictation surfaces need OMP_GUI_TEST_VOICE_FILE (e2e/parity.e2e.ts sets it)");
	await fs.writeFile(file, JSON.stringify(script));
}

/** A fake microphone's tone: silent for `silentMs`, then sounding for `toneMs`. */
interface Tone {
	silentMs: number;
	toneMs: number;
}

/**
 * The page's microphone is an oscillator through a gain that follows `tone` from the moment the page asks for it
 * (`getUserMedia`: a dictation take's start), so the app hears it as a person speaking.
 */
async function fakeMicrophone(page: Page, tone: Tone): Promise<void> {
	await page.evaluate(tone => {
		const getUserMedia = async () => {
			const context = new AudioContext();
			await context.resume().catch(() => undefined);
			const oscillator = context.createOscillator();
			oscillator.frequency.value = 180;
			const gain = context.createGain();
			gain.gain.value = 0;
			const destination = context.createMediaStreamDestination();
			oscillator.connect(gain).connect(destination);
			oscillator.start();
			gain.gain.setValueAtTime(0.3, context.currentTime + tone.silentMs / 1000);
			gain.gain.setValueAtTime(0, context.currentTime + (tone.silentMs + tone.toneMs) / 1000);
			return destination.stream;
		};
		// A phone page on plain http has no `navigator.mediaDevices` at all.
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: Object.assign(navigator.mediaDevices ?? {}, { getUserMedia }),
		});
	}, tone);
}

/** The fake omp's start script (`startFile`, e2e/fixture/rpc-ui.ts); e2e/parity.e2e.ts names the file. */
async function scriptStart(script: Record<string, unknown>): Promise<void> {
	const file = process.env.OMP_GUI_TEST_START_FILE;
	if (!file) throw new Error("the slow start surface needs OMP_GUI_TEST_START_FILE (e2e/parity.e2e.ts sets it)");
	await fs.writeFile(file, JSON.stringify(script));
}

/** The tab the view shows: its id and status as the view's own `window.omp` lists them. */
async function shownTab(page: Page): Promise<{ tabId: string; status: string } | undefined> {
	const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.active);
	return tab ? { tabId: tab.tabId, status: String(tab.status) } : undefined;
}

/** Sends the view's shown tab a prompt through the view's own rpc (a paired computer's and the phone's reach the host). */
async function promptShownTab(page: Page, message: string): Promise<void> {
	const tab = await shownTab(page);
	if (!tab) throw new Error("the view shows no session to prompt");
	const reply = await page.evaluate(
		([tabId, text]) => window.omp.rpc.commandForTab(tabId, { type: "prompt", message: text }),
		[tab.tabId, message] as const,
	);
	// A refused prompt (a turn still running, a link not up) says so here, not as a later wait that times out.
	if (!reply.success)
		throw new Error(`the prompt was refused on tab ${tab.tabId} (${tab.status}): ${JSON.stringify(reply)}`);
}

/**
 * Restarts the host's omp for the session the view shows. No control restarts a ready session (the banner and Settings
 * offer Restart only on a session that is not), so it is `window.omp.sidecar.restart`, the call that Restart makes,
 * with the view's own tab (a paired computer's and the phone's go to the host through the link).
 */
async function restartShownTab(page: Page): Promise<void> {
	const tab = await shownTab(page);
	if (!tab) throw new Error("the view shows no session to restart");
	await page.evaluate(tabId => window.omp.sidecar.restart({ tabId }), tab.tabId);
}

/**
 * Restarts the omp while its fake holds `get_state` (the host's `OMP_GUI_START_SLOW_MS` is 1.5 s): the banner shows
 * once the omp has not answered for that long.
 */
async function restartSlowStart(page: Page): Promise<void> {
	await scriptStart({ holdGetState: true });
	await restartShownTab(page);
	await page.getByText("omp is taking long to start", { exact: true }).first().waitFor({ timeout: 30_000 });
	await page.getByText("fixture: loading models (held by the test)").first().waitFor({ timeout: 15_000 });
}

/** The title bar's status as the tab reads while it waits for its turn to start (the words are its accessible name on a phone). */
const WAITING_TO_START = '.omp-titlebar-status[aria-label="Waiting to start"]';

/**
 * Restarts the omp while its fake ignores the stop (`holdExit`): the replacement waits for the old omp to exit, which
 * main ends with SIGKILL after 5 s, so the tab reads "Waiting to start" for that long.
 */
async function restartQueuedStart(page: Page): Promise<void> {
	await scriptStart({ holdExit: true });
	await restartShownTab(page);
}

/** Lets the held omp answer and waits until the view's session is ready again (an `error` on the way fails the surface). */
async function endStartHold(page: Page): Promise<void> {
	await scriptStart({});
	const until = Date.now() + 60_000;
	for (;;) {
		const status = (await shownTab(page))?.status;
		if (status === "error") throw new Error("the session went to error while it started slowly");
		if (status === "ready") break;
		if (Date.now() > until) throw new Error(`the session is still ${status} 60 s after the omp may answer`);
		await page.waitForTimeout(250);
	}
	await page
		.getByText("omp is taking long to start", { exact: true })
		.first()
		.waitFor({ state: "detached", timeout: 15_000 });
}

/** Write omp's `stt.enabled` the way the Settings row does (`set_setting`; the composer reads it back on `config_update`). */
async function setDictation(page: Page, enabled: boolean): Promise<void> {
	const reply = await page.evaluate(enabled => window.omp.rpc.setSetting("stt.enabled", enabled), enabled);
	if (!reply.success) throw new Error(`stt.enabled was not written: ${reply.error}`);
}

/**
 * A composer dictation take in Korean, its first wait on the Korean speech model's download (held at 42 %): sound at
 * once, a click on the composer's mic (the toolbar's `Start dictation` on the desktop and a paired computer's view of it,
 * the empty Send slot on the phone), and once the take's clock reads 0:01 (a second of audio, which the take needs
 * before it transcribes anything) the toolbar's stop, which on the phone too is the one that ends a running take.
 */
async function startKoreanDictationTake(page: Page): Promise<void> {
	await scriptVoice({ prepare: { language: "ko", percent: 42 } });
	await fakeMicrophone(page, { silentMs: 0, toneMs: 60_000 });
	await setDictation(page, true);
	await page.locator('button[aria-label="Start dictation"]').first().click({ timeout: 15_000 });
	await page.locator('[data-dictation="recording"]', { hasText: "0:01" }).waitFor({ timeout: 15_000 });
	await page.locator('button[aria-label="Stop recording and insert text"]').first().click({ timeout: 15_000 });
}

/** Ends a dictation surface on the host: Esc discards a take still recording, a dropped script answers a held one with no text. */
async function endDictationTake(page: Page): Promise<void> {
	if ((await page.locator('[data-dictation="recording"]').count()) > 0) await page.keyboard.press("Escape");
	await scriptVoice({});
	await page.locator("[data-dictation]").waitFor({ state: "detached", timeout: 10_000 });
	await setDictation(page, false);
}

/** Put one extension-UI request (a card) in front of the focused session. */
async function request(page: Page, payload: Record<string, unknown>): Promise<void> {
	await page.evaluate(request => {
		const store = window.__stores?.extensionUi?.getState() as { pushRequest(value: unknown): void } | undefined;
		store?.pushRequest({ type: "extension_ui_request", ...request });
	}, payload);
}

/** Call a ui-store action by name. */
async function ui(page: Page, action: string, ...args: unknown[]): Promise<void> {
	await page.evaluate(
		({ action, args }) => {
			const state = window.__stores?.ui?.getState() as Record<string, (...rest: unknown[]) => void> | undefined;
			const run = state?.[action];
			if (!run) throw new Error(`ui store has no ${action}`);
			run(...args);
		},
		{ action, args },
	);
}

/**
 * Show the side panel's `view` by clicks a person makes, on a real window as on the harness: the title bar's Side
 * panel button when the panel is closed, then the view's button (the panel's top bar; a phone's tab bar at its foot).
 */
async function openPanelView(page: Page, look: Look, view: "diff" | "files" | "terminal" | "preview"): Promise<void> {
	if (!(await page.locator("[data-panel-close]:visible").first().isVisible()))
		await page
			.getByRole("button", { name: say(look, "titlebar.sidePanel"), exact: true })
			.first()
			.click();
	await selectInspectorView(page, view);
}

/**
 * Closes the side panel a surface opened, by the panel's own close button. The open panel takes the place the work
 * board docks in, so the board of the surface after it folds into its strip.
 */
async function closePanelView(page: Page): Promise<void> {
	const close = page.locator("[data-panel-close]:visible").first();
	if (await close.isVisible().catch(() => false)) await close.click();
}

/** The Files view on Sidebar.tsx: by search, unless a surface before left the viewer open on it. */
async function openSidebarFile(page: Page, look: Look): Promise<void> {
	await openPanelView(page, look, "files");
	const search = page.getByLabel(say(look, "filesPanel.search"), { exact: true }).first();
	const viewer = page.locator("[data-file-viewer-head]:visible").first();
	await search.or(viewer).first().waitFor();
	if ((await viewer.isVisible()) && (await viewer.textContent())?.includes("Sidebar.tsx")) return;
	if (!(await search.isVisible()))
		await viewer.getByRole("button", { name: say(look, "filesPanel.back"), exact: true }).click();
	await search.fill("Sidebar.tsx");
	await page
		.getByRole("treeitem", { name: /Sidebar\.tsx/ })
		.first()
		.click();
}

/** Turns Blame off again (`panel-blame` left it on), then closes the panel as `closePanelView`. */
async function closeBlame(page: Page): Promise<void> {
	if (
		await page
			.locator("[data-code-view] [data-blame-line]:visible")
			.first()
			.isVisible()
			.catch(() => false)
	)
		await page.locator("[data-blame-toggle]:visible").first().click();
	await closePanelView(page);
}

/** Deletes the notes `panel-notes` left (each card's Delete), then closes the panel as `closePanelView`. */
async function clearNotesAndClose(page: Page): Promise<void> {
	const remove = page.locator("[data-notes-shelf]:visible [data-review-note] button[aria-label='Delete note']");
	while ((await remove.count()) > 0) await remove.first().click();
	await closePanelView(page);
}

/** Puts the Changes panel back on its changed-files source (`panel-graph` left it on Commits), then closes it. */
async function closeCommitHistory(page: Page): Promise<void> {
	const source = page.locator("[data-commit-history]:visible select:not([data-history-branch])").first();
	if (await source.isVisible().catch(() => false)) await source.selectOption("repository");
	await closePanelView(page);
}

/**
 * Open the command palette by clicks: the sidebar's search button (Command palette), behind the phone's Open menu
 * drawer where the sidebar is one.
 */
async function clickCommandPalette(page: Page, look: Look): Promise<void> {
	const entry = page.locator("[data-command-center-entry]:visible").first();
	if (!(await entry.isVisible().catch(() => false)))
		await page
			.getByRole("button", { name: say(look, "shell.openMenu"), exact: true })
			.first()
			.click();
	await entry.click();
}

async function openWorkspaceDialog(page: Page, look: Look): Promise<void> {
	await clickCommandPalette(page, look);
	const palette = page.locator('[role="dialog"]:has([data-palette-index])');
	await palette.getByRole("combobox").fill("switch-project");
	await palette.locator('[data-command-name="switch-project"]').click();
}

/** The new task sheet through the command palette's "New task…" command (a real control on every view). */
async function openNewTaskSheet(page: Page, look: Look): Promise<void> {
	await clickCommandPalette(page, look);
	const palette = page.locator('[role="dialog"]:has([data-palette-index])');
	await palette.getByRole("combobox").fill("new-worktree-tab");
	await palette.locator('[data-command-name="new-worktree-tab"]').click();
}

/**
 * A new task that fails at its worktree's create, from the sheet (worktree on, a typed name, a base ref no repository
 * has): its sidebar row stays, failed, with Retry and Close, and nothing was made (no fetch, no name step, no session).
 */
async function failNewTask(page: Page, look: Look): Promise<void> {
	await openNewTaskSheet(page, look);
	const sheet = page.locator("[role=dialog]:has([data-new-task-sheet])");
	await sheet.locator("[data-new-task-project]").waitFor({ timeout: 15_000 });
	await sheet.locator("input[maxlength='41']").fill("parity missing base");
	await sheet.locator("[data-worktree-base] label").nth(2).click();
	await sheet.locator("[data-worktree-base] input[list]").fill("no-such-base");
	await sheet.locator("button[type=submit]").click();
	await sheet.waitFor({ state: "detached", timeout: 15_000 });
	// A phone's palette opened from its drawer, which stays open behind the sheet.
	if (!(await page.locator("[data-drawer]").isVisible())) await openDrawer(page, look);
}

/** Closes every failed new task row `failNewTask` left (each row's Close; a phone's drawer is still open). */
async function dismissNewTasks(page: Page): Promise<void> {
	for (const close of await page.locator("[data-new-task-close]:visible").all()) await close.click();
	await page.locator("[data-new-task]").first().waitFor({ state: "detached", timeout: 10_000 });
}

/** Agents › GitHub › Issues with the parity sheet's one issue open (B's `gh`, e2e/parity.e2e.ts `writeParityGh`). */
async function openIssueDetail(page: Page): Promise<void> {
	await openPageTab(page, "agents", "github");
	await page
		.locator("[data-github-center] li")
		.filter({ hasText: "Closed PRs keep their session row" })
		.locator("button")
		.first()
		.click({ timeout: 15_000 });
	await page.locator("[data-github-issue-start]").waitFor({ state: "visible", timeout: 15_000 });
}

/** Put a prompt of the web host's sheet layer (`?host=1` pages) in front of the person. */
async function hostPrompt(page: Page, prompt: Record<string, unknown>): Promise<void> {
	await page.evaluate(prompt => {
		const store = window.__stores?.hostUi?.getState() as { push(value: unknown): void } | undefined;
		store?.push({ ...prompt, host: window.__hostActions, resolve: () => {} });
	}, prompt);
}

/** Set the updater's status, as main's `updater:status` push does. */
async function updater(page: Page, status: Record<string, unknown>): Promise<void> {
	await page.evaluate(status => window.__stores?.updater?.setState({ status }), status);
}

const isPhone = (look: Look): boolean => look.width < 600;
/**
 * Where the work board is its strip, not docked beside the transcript (`workBoardDocks`, work-board.ts): every phone,
 * tablet in portrait and the 1024 px tablet sideways keep the strip; an iPad from 1133 sideways and every desktop
 * window from 1100 dock it beside a column narrowed for it.
 */
const boardIsStrip = (look: Look): boolean => look.width < 1100;
/**
 * The busy board a board surface waits for, as a strip (`chip`) or docked. The harness's `?board=busy` lands its
 * turn, question and goal together 1.5 s after boot (dev-harness/boot.ts), so there both wait for the question; the
 * parity sheet's `board` session asks none (the Escape each view presses before it shows a session would answer it),
 * so there they wait for its running work.
 */
function busyBoard(page: Page): { chip: Locator; docked: Locator } {
	const harness = page.url().includes("board=busy");
	return {
		chip: page.locator(harness ? "[data-work-chip][data-state='waiting']" : "[data-work-chip]").first(),
		docked: page.locator(`.omp-work-board-slot [data-board-section='${harness ? "needs" : "now"}']`).first(),
	};
}
/** The host's sheets are the paired web page's (`WebHostUi` renders nothing in the desktop app). */
const webPage = (look: Look): boolean => look.device !== "electron";

/**
 * The soft keyboard comes up the way Chrome on Android shows it (`interactive-widget=resizes-content`): the layout
 * viewport loses the keyboard's height while a field has focus (lib/keyboard-inset.ts `layoutKeyboardOpen`), about 40 %
 * of a phone and a third of a tablet. iOS only shrinks the visual viewport, which a browser test cannot do; the
 * shell's `--kb-inset` answers both the same way. Portrait only: a sideways tablet this short reads as a phone.
 */
async function keyboardUp(page: Page, look: Look, focus: string): Promise<void> {
	await page.locator(focus).first().click();
	const height = Math.round(look.height * (isPhone(look) ? 0.6 : 0.67));
	await page.setViewportSize({ width: look.width, height });
	await page.waitForFunction(() => document.documentElement.dataset.kb === "open", undefined, { timeout: 5_000 });
}
const keyboardLook = (look: Look): boolean => (look.device ?? "touch") === "touch" && look.orientation === "portrait";
/**
 * A portrait tablet at least 800 px wide docks the session list; a phone and the narrower tablet use the drawer. A phone
 * held sideways (844×390) is wider than 800 px but still a phone (`use-shell-mode.ts`: shorter than 500 px), drawer and
 * all: read as docked, the audit waited for a list it never opened.
 */
const sidebarDocked = (look: Look): boolean => look.width >= 800 && look.height >= 500;

async function openDrawer(page: Page, look: Look): Promise<void> {
	if (sidebarDocked(look) || (await page.locator("[data-drawer]").isVisible())) return;
	await page.locator("button:visible:has(svg.lucide-menu)").first().click();
	await page.locator("[data-drawer]").waitFor({ state: "visible", timeout: 10_000 });
}

/** The view's own computer has a bot to show: "Parity bot", made through the app's own bots API when it has none. */
async function ensureParityBot(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const state = await window.omp.bots.command({ action: "get" });
		if (state.bots.length === 0)
			await window.omp.bots.command({
				action: "create",
				name: "Parity bot",
				purpose: "Keeps an eye on the parity sheet.",
			});
	});
}

/** Checks `ready` every 250 ms until it holds, for `timeoutMs`; throws `what` when it never does. */
async function until(ready: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
	for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
		if (await ready()) return;
		await sleep(250);
	}
	throw new Error(what);
}

/**
 * The parity bot has items to show (bot-items, bot-item): a chat opened in its folder adds two the way a bot does,
 * `ompdesk_item add` through the fake omp's host tool (e2e/fixture/rpc-ui.ts), then closes again.
 */
async function ensureParityItems(page: Page): Promise<void> {
	await ensureParityBot(page);
	const folder = await page.evaluate(async () => {
		const state = await window.omp.bots.command({ action: "get" });
		return state.items.length > 0 ? null : (state.bots[0]?.folder ?? null);
	});
	if (!folder) return;
	const tabId = (await page.evaluate(cwd => window.omp.tabs.spawn({ cwd }), folder))?.tabId;
	if (!tabId) throw new Error("no chat opened in the parity bot's folder");
	const tool = (args: Record<string, unknown>) =>
		page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
			tabId,
			`fixture:host-tool:ompdesk_item ${JSON.stringify(args)}`,
		] as const);
	try {
		await until(
			async () =>
				(await page.evaluate(() => window.omp.tabs.list())).some(
					tab => tab.tabId === tabId && tab.status === "ready",
				),
			"the parity bot's chat never became ready",
		);
		await tool({
			action: "add",
			title: "Compare the parity sheet",
			description: "Read the three views side by side and note what differs.",
			done_means: "Every surface agrees.",
			status: "working",
		});
		await tool({ action: "add", title: "Plan the next surface" });
		await until(
			async () => (await page.evaluate(() => window.omp.bots.command({ action: "get" }))).items.length >= 2,
			"the parity bot's items never arrived",
		);
	} finally {
		await page.evaluate(id => window.omp.tabs.close(id), tabId);
	}
}

/**
 * The parity bot has suggestions to show (bot-suggestions): a chat opened in its folder lists two the way a look does,
 * `ompdesk_bot suggest` through the fake omp's host tool, then closes again.
 */
async function ensureParitySuggestions(page: Page): Promise<void> {
	await ensureParityBot(page);
	const folder = await page.evaluate(async () => {
		const state = await window.omp.bots.command({ action: "get" });
		return (state.looks ?? []).some(look => look.items.length > 0) ? null : (state.bots[0]?.folder ?? null);
	});
	if (!folder) return;
	const tabId = (await page.evaluate(cwd => window.omp.tabs.spawn({ cwd }), folder))?.tabId;
	if (!tabId) throw new Error("no chat opened in the parity bot's folder");
	const suggestions = [
		{
			title: "Review the parity sheet",
			why: "Three views changed since it was last read.",
			ask: "Read the parity sheet and tell me what differs",
		},
		{ title: "Answer the open question", why: "It has waited a day.", ask: "Draft my answer to the open question" },
	];
	try {
		await until(
			async () =>
				(await page.evaluate(() => window.omp.tabs.list())).some(
					tab => tab.tabId === tabId && tab.status === "ready",
				),
			"the parity bot's chat never became ready",
		);
		await page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
			tabId,
			`fixture:host-tool:ompdesk_bot ${JSON.stringify({ action: "suggest", suggestions })}`,
		] as const);
		await until(
			async () =>
				((await page.evaluate(() => window.omp.bots.command({ action: "get" }))).looks ?? []).some(
					look => look.items.length >= 2,
				),
			"the parity bot's suggestions never arrived",
		);
	} finally {
		await page.evaluate(id => window.omp.tabs.close(id), tabId);
	}
}

/** The Bots page on the parity bot's page, its Items tab chosen and its list shown (not an item another surface opened). */
async function openParityItems(page: Page, look: Look): Promise<void> {
	await ensureParityItems(page);
	await openDrawer(page, look);
	await page.locator("[data-sidebar-bots-open]:visible").first().click();
	// A phone shows the list first, and a group's room may be the page: the bot's row opens its page.
	if ((await page.locator("[data-bot-pane]:visible").count()) === 0)
		await page.locator("[data-bots-page-row]:visible").first().click();
	await page.locator('[data-bot-pane-tabs] [data-tab-id="items"]:visible').first().click();
	await closeParityItem(page);
}

/** Back from an open item page to the Items list; nothing when the list shows. */
async function closeParityItem(page: Page): Promise<void> {
	const back = page.locator("[data-bot-item-back]:visible").first();
	if ((await back.count()) > 0) await back.click();
}

/** What bot-items and bot-item opened, closed: the item page back to the list, the bot page back on Activity. */
async function closeParityItems(page: Page): Promise<void> {
	await closeParityItem(page);
	const activity = page.locator('[data-bot-pane-tabs] [data-tab-id="activity"]:visible').first();
	if ((await activity.count()) > 0) await activity.click();
}

/**
 * The usage block: a desktop window's opens over its status bar from the usage summary (the owner's decision, 25 Nov
 * 2026); a phone or tablet page keeps it in the sidebar footer.
 */
async function openUsage(page: Page, look: Look): Promise<void> {
	if ((await page.locator("[data-status-bar]").count()) === 0) return openDrawer(page, look);
	await page.locator("[data-status-usage]").click({ timeout: 15_000 });
}

/** A session row's menu: the shown session's row where the list marks one, so every parity view opens the work
 *  session's menu (a paired computer's window lists its own sessions above the host's), else the first row. */
async function openRowMenu(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	const rows = page.locator(".omp-list-row:has([data-sidebar-row-menu])");
	await rows.first().waitFor({ state: "attached", timeout: 15_000 });
	const shown = rows.and(page.locator("[data-active='true']")).first();
	const row = (await shown.count()) > 0 ? shown : rows.first();
	// A mouse shows the row's ⋯ on hover; a finger always has it.
	if ((look.device ?? "touch") !== "touch") await row.hover();
	await row.locator("[data-sidebar-row-menu]").first().click();
}

/**
 * The menu of the project header the view's open session sits under: this computer's list, or the paired computer's
 * section for the host. A mouse right-clicks the header; a finger has no right click, so it taps the header's ⋯.
 */
async function openProjectMenu(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	const cwd = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.cwd;
	if (!cwd) throw new Error("no open session to find its project by");
	const folder = JSON.stringify(cwd);
	const header = page.locator(`[data-workspace-group=${folder}], [data-device-group=${folder}] .group\\/head`).first();
	if ((look.device ?? "touch") === "touch") await header.locator(".omp-sidebar-project-menu").click();
	else await header.click({ button: "right" });
}

/** Closes the menu or dialog a surface left open (Escape), so the next starts from the same window. */
async function closeOverlay(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
}

/** An item of the sidebar footer's Help menu, as a person picks it (a phone's drawer first; a finger's action sheet). */
async function openHelpItem(page: Page, look: Look, name: string): Promise<void> {
	await openDrawer(page, look);
	await page.locator("button[aria-label='Help']:visible").first().click();
	await page.locator(":is([role=menuitem], button):visible", { hasText: name }).first().click();
}

/** The changelog opens on its newest release: its body is not scrolled (its first focus once scrolled to a link). */
async function changelogAtTop(page: Page): Promise<void> {
	const notes = page.locator("[role=dialog] [data-changelog-notes]").first();
	await notes.waitFor({ state: "visible", timeout: 15_000 });
	const top = await notes.evaluate(element => element.closest("[data-dialog-body]")?.scrollTop ?? 0);
	if (top > 0) throw new Error(`the changelog opened scrolled ${Math.round(top)} px down`);
}

/**
 * The release before the newest in the shipped changelog: what `whatsNewSeenVersion` holds after an update by one
 * version (read as e2e/starter-guide.e2e.ts reads it).
 */
const PREVIOUS_RELEASE =
	readFileSync("CHANGELOG.md", "utf8")
		.match(/^## \[([^\]]+)\]/gm)?.[1]
		?.slice(4, -1) ?? "0.0.1";

/**
 * The update card as an update brings it: the view's `whatsNewSeenVersion` (on the phone the host's, whose prefs its
 * page reads) names the release before, and the page loads again as the relaunch after an update does, so
 * `WhatsNewNotice` decides afresh. The harness page keeps its store call: its prefs live in the page and a load drops them.
 */
async function showWhatsNewCard(page: Page): Promise<void> {
	if (await page.evaluate(() => Boolean(window.__stores))) return ui(page, "showWhatsNewCard", "0.36.1", "0.35.0");
	await page.evaluate(seen => window.omp.prefs.set("whatsNewSeenVersion", seen), PREVIOUS_RELEASE);
	await page.reload();
	await page.locator("[data-whats-new-card]").first().waitFor({ state: "visible", timeout: 60_000 });
}

/** Dismisses the update card with Escape from inside it, as its own keys do, so the next surface's window has none. */
async function dismissWhatsNewCard(page: Page): Promise<void> {
	const card = page.locator("[data-whats-new-card]").first();
	if (await card.isVisible().catch(() => false)) {
		await card.focus();
		await page.keyboard.press("Escape");
	}
	await card.waitFor({ state: "hidden", timeout: 10_000 });
}

/** One of the view's own computer's stored rows (`[data-pickable]`: a paired computer's rows are not), by its title. */
const storedRow = (page: Page, n: number): Locator =>
	page.locator(`.omp-sidebar-session-row[data-pickable]:has-text("Parity stored ${n}")`).first();

/**
 * A finger's swipe left on a stored row (`SwipeActions`; Orca mobile/src/components/list/SwipeRowActions.tsx:69):
 * CDP touch events, which the page gets as touch pointer events, in steps past half the action's width, so the row
 * settles open on Archive. A mouse has no swipe (the row's menu holds the same actions), so a window shows the row.
 */
async function swipeStoredRow(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	const row = storedRow(page, 1);
	await row.waitFor({ state: "visible", timeout: 30_000 });
	if (!touchLook(look)) return row.hover();
	const box = await row.boundingBox();
	if (!box) throw new Error("the stored row has no box");
	const x = Math.round(box.x + box.width * 0.6);
	const y = Math.round(box.y + box.height / 2);
	const cdp = await page.context().newCDPSession(page);
	try {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
		for (let step = 1; step <= 8; step++)
			await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - step * 12, y }] });
		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	} finally {
		await cdp.detach().catch(() => undefined);
	}
	await page
		.locator('[data-swipe-open] [data-swipe-action="session-archive"]')
		.first()
		.waitFor({ state: "visible", timeout: 5_000 });
}

/**
 * Stored rows picked as a person picks them (Orca worktree-list/navigation/use-selection.ts:66): ⌘/Ctrl-click two,
 * Shift-click a third (the run from the last pick), then the ⋯ of a picked row opens the one menu for them all
 * (Orca use-worktree-context-menu-model.tsx:141). Each view picks its own computer's rows: only those can be picked.
 */
async function pickStoredRows(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	await storedRow(page, 1).waitFor({ state: "visible", timeout: 30_000 });
	const press = (n: number, modifier: "ControlOrMeta" | "Shift") =>
		storedRow(page, n)
			.locator("button")
			.first()
			.click({ modifiers: [modifier] });
	await press(3, "ControlOrMeta");
	await press(2, "ControlOrMeta");
	await press(1, "Shift");
	await page.locator(".omp-sidebar-session-row[data-picked]").nth(1).waitFor({ timeout: 5_000 });
	const picked = storedRow(page, 1);
	if (!touchLook(look)) await picked.hover();
	await picked.locator("[data-sidebar-row-menu]").first().click();
}

/** Closes the picked rows' menu, then lets go of the picks with Escape in the list (Sidebar.tsx `onListKeyDown`). */
async function clearPicks(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	const picked = page.locator(".omp-sidebar-session-row[data-picked]");
	if ((await picked.count()) > 0) {
		await picked.first().locator("button").first().focus();
		await page.keyboard.press("Escape");
	}
	await picked.first().waitFor({ state: "detached", timeout: 10_000 });
}

/** Closes the queue popover, drops both lanes and stops the turn `composer-queue` started, so the session is idle again. */
async function endQueuedTurn(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	const tab = await shownTab(page);
	if (!tab) return;
	await page.evaluate(async tabId => {
		await window.omp.rpc.commandForTab(tabId, { type: "queue_clear" });
		await window.omp.rpc.commandForTab(tabId, { type: "abort" });
	}, tab.tabId);
	await page.locator(".omp-composer-toolbar[data-turn-running]").first().waitFor({ state: "hidden", timeout: 30_000 });
}

/** One op of the fake omp's `fixture flow` run in the tab the view shows (e2e/fixture/rpc-ui.ts `startFlow`). */
async function flowOp(page: Page, tabId: string, spec: Record<string, unknown>) {
	return page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
		tabId,
		`fixture:flow:${JSON.stringify(spec)}`,
	] as const);
}

/** Ends the compaction `turn-compacting` holds the way stock skips one (no entry, nothing said) and answers its turn. */
async function endCompactingTurn(page: Page): Promise<void> {
	const tab = await shownTab(page);
	if (!tab) return;
	await flowOp(page, tab.tabId, { op: "compact-end", skipped: true });
	await flowOp(page, tab.tabId, { op: "reply", text: "Compaction shown." });
	await page.locator("[data-compaction-status]").first().waitFor({ state: "hidden", timeout: 30_000 });
}

/** The work session's family open, with every other computer's section folded to its count. */
async function openRemoteFamily(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	const selector = ':is(.omp-sidebar-session-row, [data-device-session]):has-text("Parity work")';
	const row = page.locator(selector).first();
	await row.waitFor({ state: "visible", timeout: 30_000 });
	const chip = row.locator("[data-sidebar-subagents-toggle][aria-expanded='false']");
	if ((await chip.count()) > 0) await chip.click();
	await page
		.locator('[data-sidebar-family] [data-sidebar-opened-session]:has-text("Parity remote child")')
		.first()
		.waitFor({ state: "visible", timeout: 30_000 });
	const section = page.locator(`[data-sidebar-device]:has(${selector})`).first();
	const kept = (await section.count()) > 0 ? await section.getAttribute("data-sidebar-device") : "local";
	const toggles = page.locator("[data-sidebar-device-toggle][aria-expanded='true']");
	const open = await toggles.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-sidebar-device-toggle")));
	for (const id of open)
		if (id !== kept) await page.locator(`[data-sidebar-device-toggle="${id}"][aria-expanded='true']`).click();
}

/**
 * Keeps open only the sidebar section holding the project group whose folder ends with `folder` (this computer's, or
 * the paired computer's), expands that group and waits for `row`. A group with no open tab of the view's starts
 * folded, and one can fold again when what main says of its folder arrives (a folder found gone), so it is expanded
 * again until the row shows.
 */
async function showProjectRows(page: Page, look: Look, folder: string, row: string): Promise<void> {
	await openDrawer(page, look);
	const group = `:is([data-workspace-group$="${folder}"], [data-device-group$="${folder}"])`;
	await page.locator(group).first().waitFor({ state: "attached", timeout: 30_000 });
	const section = page.locator(`[data-sidebar-device]:has([data-device-group$="${folder}"])`).first();
	const kept = (await section.count()) > 0 ? await section.getAttribute("data-sidebar-device") : "local";
	const toggles = page.locator("[data-sidebar-device-toggle][aria-expanded='true']");
	const open = await toggles.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-sidebar-device-toggle")));
	for (const id of open)
		if (id !== kept) await page.locator(`[data-sidebar-device-toggle="${id}"][aria-expanded='true']`).click();
	const header = page
		.locator(
			`[data-workspace-group$="${folder}"] button[aria-expanded='false'], [data-device-group$="${folder}"] > .group\\/head button[aria-expanded='false']`,
		)
		.first();
	const target = page.locator(row).first();
	const until = Date.now() + 30_000;
	while (!(await target.isVisible())) {
		if (Date.now() > until) throw new Error(`no ${row} in the ${folder} group`);
		if ((await header.count()) > 0) await header.click();
		await page.waitForTimeout(250);
	}
	// Settled: the row has stayed put for a moment, so a click lands on it.
	await page.waitForTimeout(500);
	await target.waitFor({ state: "visible", timeout: 5_000 });
}

/** The work session's family open, and the project of the session it opened in another folder expanded. */
async function openOwnProject(page: Page, look: Look): Promise<void> {
	await showProjectRows(
		page,
		look,
		"seuoffice",
		':is([data-session-group$="seuoffice"] .omp-sidebar-session-row, [data-device-group$="seuoffice"] [data-device-session]):has-text("Parity cross-project")',
	);
	const chip = page
		.locator(
			':is(.omp-sidebar-session-row, [data-device-session]):has-text("Parity work") [data-sidebar-subagents-toggle][aria-expanded="false"]',
		)
		.first();
	if ((await chip.count()) > 0) await chip.click();
	await page
		.locator('[data-sidebar-opened-session]:has-text("Parity cross-project")')
		.first()
		.waitFor({ state: "visible", timeout: 30_000 });
}

/** The row of the session whose folder was deleted, marked missing, in its expanded project. */
async function openFolderMissing(page: Page, look: Look): Promise<void> {
	await showProjectRows(
		page,
		look,
		"moda-office",
		':is(.omp-sidebar-session-row, [data-device-session])[data-folder-missing]:has-text("Parity folder gone")',
	);
}

/** One item of the sidebar header's options, chosen unless it already is (a mouse's menu, a finger's sheet). */
async function pickSidebarOption(page: Page, name: RegExp, on: boolean): Promise<void> {
	await page.locator("[data-sidebar-options] button:visible").first().click();
	const item = page.getByRole("menuitemcheckbox", { name }).first();
	await item.waitFor({ state: "visible", timeout: 10_000 });
	if ((await item.getAttribute("aria-checked")) === String(on)) await page.keyboard.press("Escape");
	else await item.click();
	await page.locator('[role="menu"]').first().waitFor({ state: "hidden", timeout: 10_000 });
}

/** The `parity-sleep` project sorted by Recent with Hide sleeping on: the newer session first, the old one folded. */
async function openSidebarSorted(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	await pickSidebarOption(page, /^Recent$/, true);
	await pickSidebarOption(page, /^Hide sleeping/, true);
	await showProjectRows(
		page,
		look,
		"parity-sleep",
		':is([data-session-group$="parity-sleep"], [data-device-group$="parity-sleep"]) [data-sidebar-sleeping]',
	);
}

/** The options back to the default: Manual, sleeping rows shown (a phone's drawer opened again if it closed). */
async function resetSidebarOptions(page: Page): Promise<void> {
	if ((await page.locator("[data-sidebar-options] button:visible").count()) === 0)
		await page.locator("button:visible:has(svg.lucide-menu)").first().click();
	await pickSidebarOption(page, /^Manual/, true);
	await pickSidebarOption(page, /^Hide sleeping/, false);
}

/** Settings › Models & accounts through the sidebar's Settings row and the section's own nav entry, as a person does; the local engine switch under Custom endpoints in view. */
async function openSettingsModels(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	await page.locator('[data-destination="settings"]').first().click();
	const nav = page.locator('[data-settings-section="models"]');
	await nav.waitFor({ state: "visible", timeout: 15_000 });
	await nav.click();
	const row = page.locator("[data-settings-page] [data-local-engine-detect]");
	await row.waitFor({ state: "visible", timeout: 30_000 });
	await row.scrollIntoViewIfNeeded();
}

async function openSettingsAgent(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	await page.locator('[data-destination="settings"]').first().click();
	const nav = page.locator('[data-settings-section="agent"]');
	await nav.waitFor({ state: "visible", timeout: 15_000 });
	await nav.click();
}

/** Settings › Agent behavior, scrolled to Computer use engine and the two macOS permission rows under it. */
async function openSettingsComputerUse(page: Page, look: Look): Promise<void> {
	await openSettingsAgent(page, look);
	const row = page.locator("[data-settings-page] #setting-gui-macPermission-screen");
	await row.waitFor({ state: "visible", timeout: 30_000 });
	await page.locator("[data-settings-page] #setting-gui-computerUse").scrollIntoViewIfNeeded();
	await row.scrollIntoViewIfNeeded();
}

/** Settings › Updates & about through the sidebar's Settings entry and the section's own nav entry, as a person opens it. */
async function openSettingsUpdates(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	await page.locator('[data-destination="settings"]').first().click();
	const nav = page.locator('[data-settings-section="updates"]');
	await nav.waitFor({ state: "visible", timeout: 15_000 });
	await nav.click();
}

/**
 * Settings › Updates & about at the omp row naming the omp its release was tested with (the fake omp runs the minimum
 * omp, older than the tested one): This computer's machine-setup row, or, where the shown tab is on a paired host (the
 * paired computer's view), the host's omp row, which names the host's tested omp.
 */
async function openSettingsOmpTested(page: Page, look: Look): Promise<void> {
	await openSettingsUpdates(page, look);
	const own = page.locator("[data-settings-page] [data-setup-item='omp']");
	await own.waitFor({ state: "visible", timeout: 30_000 });
	const host = page.locator("[data-settings-page] #setting-host-omp");
	await ((await host.count()) > 0 ? host : own).scrollIntoViewIfNeeded();
}

/**
 * Settings › Updates & about, the Disk row with its breakdown open. A test launch cleans only on request, so the row
 * is measured first with its own Clean up button: the breakdown then lists every part.
 */
async function openSettingsDiskCare(page: Page, look: Look): Promise<void> {
	await openSettingsUpdates(page, look);
	const row = page.locator("[data-settings-page] #setting-disk-care");
	await row.waitFor({ state: "visible", timeout: 30_000 });
	await row.scrollIntoViewIfNeeded();
	const measured = row.locator("[data-testid='disk-care-status']").filter({ hasText: "in use" });
	if ((await measured.count()) === 0) await row.locator("[data-testid='disk-care-clean']").click();
	await measured.waitFor({ state: "visible", timeout: 180_000 });
	await row.locator("[data-testid='disk-care-clean']:not([disabled])").waitFor({ timeout: 180_000 });
	// A pointer opens the row's (i) by resting on it, a finger by tapping it. Never a mouse click on touch: its move
	// in starts the hover timer (at once while a tooltip closed lately is warm) and the click then toggles the bubble
	// shut (reverse parity, run 44634794678, phone). A pointer rests again when the page moved the row from under it
	// (a banner landing above it scrolled the page: forward parity, run 44643884130, paired computer).
	const info = row.locator("[data-setting-info]");
	if (touchLook(look)) {
		await info.tap();
		return;
	}
	const shown = page.locator("[role='tooltip']").first();
	for (let rest = 1; ; rest++) {
		await page.mouse.move(0, 0);
		await info.hover();
		const open = await shown.waitFor({ state: "visible", timeout: 2_000 }).then(
			() => true,
			() => false,
		);
		if (open || rest === 3) return;
	}
}

/**
 * The notice's and the row's account: saved through the page on whichever computer the view is of (the host's, the
 * paired computer's own, the phone's host), and read back as "needs its password again" because the parity launch
 * has `OMP_GUI_TEST_KEYCHAIN_WOULD_ASK=1` (src/main/index.ts). `unseedMailReentry` removes it, so no other surface
 * carries the notice.
 */
async function seedMailReentry(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const { accounts } = await window.omp.mailAccounts.command({ action: "list" });
		if (accounts.some(account => account.label === "Parity mail")) return;
		await window.omp.mailAccounts.command({
			action: "save",
			draft: {
				label: "Parity mail",
				host: "imap.example.com",
				port: 993,
				username: "parity@example.com",
				mailbox: "INBOX",
				password: "parity-secret",
			},
		});
	});
}

async function unseedMailReentry(page: Page): Promise<void> {
	// The page's notice holds the list it read: closing it first (a click even where the session view is hidden behind
	// Settings) keeps it off every later surface of this page; the phone's page loads afresh and finds no account.
	await page
		.locator("[data-mail-reentry-notice] button[aria-label]")
		.last()
		.evaluate(button => (button as HTMLElement).click(), undefined, { timeout: 2_000 })
		.catch(() => undefined);
	await page.evaluate(async () => {
		const { accounts } = await window.omp.mailAccounts.command({ action: "list" });
		for (const account of accounts)
			if (account.label === "Parity mail")
				await window.omp.mailAccounts.command({ action: "remove", id: account.id });
	});
}

/** The session view with the one re-entry notice above it: the account is seeded, and the page loads again to read it. */
async function openMailReentryNotice(page: Page): Promise<void> {
	await seedMailReentry(page);
	await page.reload();
	await page.locator("[data-mail-reentry-notice]").waitFor({ state: "visible", timeout: 60_000 });
}

/** Settings › Schedules › Email accounts with the account's "enter the password again" line. */
async function openSettingsMailReentry(page: Page, look: Look): Promise<void> {
	await seedMailReentry(page);
	await openDrawer(page, look);
	await page.locator('[data-destination="settings"]').first().click();
	const nav = page.locator('[data-settings-section="schedules"]');
	await nav.waitFor({ state: "visible", timeout: 15_000 });
	await nav.click();
	await page
		.locator("[data-settings-page] #settings-mail-accounts")
		.first()
		.waitFor({ state: "visible", timeout: 30_000 });
	// A paired computer's view says the accounts are set on that computer itself: only this computer's own has the line.
	const line = page.locator("[data-settings-page] [data-mail-needs-reentry]").first();
	if ((await page.locator("[data-settings-page] [data-mail-elsewhere]").count()) === 0) {
		await line.waitFor({ state: "visible", timeout: 30_000 });
		await line.scrollIntoViewIfNeeded();
	}
}

/** Settings › Schedules through the sidebar's Settings entry and the section's nav entry, as a person opens it. */
async function openSettingsSchedules(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	await page.locator('[data-destination="settings"]').first().click();
	const nav = page.locator('[data-settings-section="schedules"]');
	await nav.waitFor({ state: "visible", timeout: 15_000 });
	await nav.click();
	await page
		.locator("[data-settings-page] [data-schedule-new]")
		.first()
		.waitFor({ state: "visible", timeout: 30_000 });
}

/** The row of the schedule named `name` in the shown Settings › Schedules (the host's, in every view). */
function scheduleRow(page: Page, name: string): Locator {
	return page.locator("[data-settings-page] [data-schedule]").filter({ hasText: name }).first();
}

/**
 * The schedule `name` on the shown session's computer, made through New schedule when it is not there yet: in the
 * shown session's folder (the dialog's default), the trigger picked in its When select (`kind`), the prompt the fake
 * omp's print mode answers at once.
 */
async function ensureSchedule(page: Page, name: string, kind: "interval" | "webhook"): Promise<Locator> {
	const row = scheduleRow(page, name);
	if ((await row.count()) > 0) return row;
	await page.locator("[data-settings-page] [data-schedule-new]").first().click();
	const dialog = page.getByRole("dialog");
	await dialog.locator("[data-schedule-form]").waitFor({ state: "visible", timeout: 15_000 });
	await dialog.locator("[data-schedule-form] input").first().fill(name);
	await dialog.locator("textarea").fill("fixture hello");
	await dialog.locator("[data-schedule-repeat]").selectOption(kind);
	await dialog.locator("button[type=submit]").click();
	await dialog.waitFor({ state: "hidden", timeout: 15_000 });
	await row.waitFor({ state: "visible", timeout: 15_000 });
	return row;
}

/** Deletes the schedule `name` through its row's ⋯ › Delete (and its runs with it), so the next surface finds none. */
async function deleteSchedule(page: Page, name: string): Promise<void> {
	const schedulesTab = page.locator("[data-settings-page] [data-schedules-view] [role='tab']").first();
	if ((await schedulesTab.count()) > 0) await schedulesTab.click();
	const row = scheduleRow(page, name);
	if ((await row.count()) === 0) return;
	await row.locator("button[aria-haspopup='menu']").click();
	await page.locator("[role='menuitem']").last().click();
	const words = `^(${en["schedules.delete"]}|${ko["schedules.delete"]})$`;
	await page
		.getByRole("dialog")
		.getByRole("button", { name: new RegExp(words) })
		.click();
	await row.waitFor({ state: "detached", timeout: 15_000 });
}

/**
 * Settings › Schedules with a webhook routine open: its URL and key rows, its actions and Recent calls, where a Send
 * test call left one call when there was none yet.
 */
async function openSettingsSchedulesWebhook(page: Page, look: Look): Promise<void> {
	await openSettingsSchedules(page, look);
	const row = await ensureSchedule(page, "Parity webhook", "webhook");
	const toggle = row.locator("[data-schedule-webhook-toggle]");
	if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
	const panel = row.locator("[data-webhook-panel]");
	await panel.waitFor({ state: "visible", timeout: 15_000 });
	if ((await panel.locator("[data-webhook-call]").count()) === 0) await panel.locator("[data-webhook-sample]").click();
	await panel.locator("[data-webhook-call]").first().waitFor({ state: "visible", timeout: 30_000 });
	await panel.scrollIntoViewIfNeeded();
}

/** Settings › Schedules › All runs, holding a finished run of a schedule run once through its Run now. */
async function openScheduleRuns(page: Page, look: Look): Promise<void> {
	await openSettingsSchedules(page, look);
	const row = await ensureSchedule(page, "Parity run", "interval");
	const runs = page.locator("[data-settings-page] [data-schedule-run-row]").filter({ hasText: "Parity run" });
	if ((await runs.count()) === 0) await row.locator("[data-schedule-run]").click();
	await page.locator("[data-settings-page] [data-schedules-view] [role='tab']").last().click();
	await page
		.locator("[data-settings-page] [data-schedule-runs-table] [data-schedule-table-run]")
		.filter({ hasText: "Parity run" })
		.filter({ hasText: "Succeeded" })
		.first()
		.waitFor({ state: "visible", timeout: 60_000 });
}

/** Settings › Updates & about with the token row saying why the saved token was removed. */
async function openSettingsUpdatesDropped(page: Page, look: Look): Promise<void> {
	await openSettingsUpdates(page, look);
	const row = page.locator("[data-settings-page] #settings-updates-auth");
	await row.waitFor({ state: "visible", timeout: 30_000 });
	await row.scrollIntoViewIfNeeded();
}

async function openSettingsGeneral(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	await page.locator('[data-destination="settings"]').first().click();
	const nav = page.locator('[data-settings-section="general"]');
	await nav.waitFor({ state: "visible", timeout: 15_000 });
	await nav.click();
	await page.locator("[data-settings-page] #setting-gui-language").waitFor({ state: "visible", timeout: 30_000 });
}

/** Settings › Appearance through the sidebar's Settings entry and the section's own nav entry: the five theme sets and the light or dark choice under them. */
async function openSettingsAppearance(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	await page.locator('[data-destination="settings"]').first().click();
	const nav = page.locator('[data-settings-section="appearance"]');
	await nav.waitFor({ state: "visible", timeout: 15_000 });
	await nav.click();
	await page.locator("[data-settings-page] #setting-gui-themeMode").waitFor({ state: "visible", timeout: 30_000 });
}

/** The model setup dialog through Settings › Models & accounts and its "Set up automatically" button, as a person opens it. */
async function openModelSetup(page: Page, look: Look): Promise<void> {
	await openSettingsModels(page, look);
	await page.locator("#settings-models-setup [data-model-setup-open]").click();
	await page
		.locator("[role=dialog] [data-model-setup-evidence] [aria-haspopup=listbox]")
		.waitFor({ state: "visible", timeout: 30_000 });
}

/** Press `shortcut` until `target` shows: the first press can land before the page's key handler is in place. */
async function pressUntilVisible(page: Page, shortcut: string, target: Locator): Promise<void> {
	for (let attempt = 0; attempt < 3 && !(await target.isVisible()); attempt++) {
		await page.keyboard.press(shortcut);
		await target.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
	}
	await target.waitFor({ state: "visible", timeout: 1_000 });
}

/**
 * A page through the palette's command (`stats` opens Stats › All sessions, `agents` Agents › Definitions; command
 * names are the same in every UI language), then the page's own tab by its id when one is named, so a Korean look
 * clicks the same tab. ⌥A for Agents missed now and then on a freshly loaded harness page; the palette did not.
 */
async function openPageTab(
	page: Page,
	command: "stats" | "agents",
	tab: "session" | "usage" | "live" | "prs" | "github" | null,
): Promise<void> {
	// The palette's own field: another dialog a harness page left open has a combobox too.
	const search = page.locator('[role="dialog"]:has([data-palette-index]) [role="combobox"]');
	await pressUntilVisible(page, "ControlOrMeta+k", search);
	await search.fill(command);
	await search.press("Enter");
	const section = page.locator(`section[data-destination="${command === "stats" ? "insights" : "agents"}"]`);
	await section.waitFor({ state: "visible", timeout: 15_000 });
	if (!tab) return;
	await section.locator(`[role="tab"][data-tab-id="${tab}"]`).click();
}

async function openSettings(page: Page, section: string): Promise<void> {
	await ui(page, "openSettings", section);
	const nav = page.locator(`[data-settings-section="${section.split(":")[0]}"]`);
	// A phone lists the sections first and pushes the chosen one; a tablet already shows it.
	if (await nav.isVisible().catch(() => false)) await nav.click();
	// A sub-target (`memory:pages`): the click above landed on the section's first view, so go to the sub-view.
	if (section.includes(":")) await ui(page, "setSettingsSection", section);
}

/** Every Settings section of `SETTINGS_NAV` (settings-catalog.ts). */
export const SETTINGS_SECTIONS = [
	"general",
	"appearance",
	"keyboard",
	"models",
	"agent",
	"memory",
	"tools",
	"permissions",
	"workspace",
	"schedules",
	"bots",
	"connections",
	"updates",
	"advanced",
] as const;

/** The side panel's views (`PANEL_TABS`); the other session views open as sheets (`VIEW_SHEETS`, stores/ui.ts). */
const PANELS = ["terminal", "diff", "preview", "files"] as const;
const VIEW_SHEETS = ["jobs", "logs", "tree", "work"] as const;

const DIALOG_FLAGS: ReadonlyArray<{ id: string; action: string; args?: unknown[]; title: string }> = [
	{ id: "dialog-rename", action: "openRenameDialog", title: "Rename session" },
	{ id: "dialog-changelog", action: "openChangelog", title: "Changelog" },
	{ id: "dialog-whats-new", action: "openWhatsNew", args: ["0.36.1", "0.35.0"], title: "What's new" },
	{ id: "dialog-feedback", action: "openFeedback", title: "Feedback" },
	{ id: "dialog-command-palette", action: "openCommandPalette", title: "Command palette" },
	{ id: "dialog-workspace", action: "openProjectPicker", title: "Projects" },
	{ id: "dialog-theme-picker", action: "openThemePicker", title: "Theme picker" },
	{ id: "dialog-quick-open", action: "openQuickOpen", title: "Quick open" },
	{ id: "dialog-share-session", action: "openShareSession", title: "Share session" },
	{ id: "dialog-active-tools", action: "openActiveTools", title: "Active tools" },
	{ id: "dialog-force-tool", action: "openForceTool", title: "Force tool" },
	{ id: "dialog-import", action: "openImportDialog", title: "Import foreign sessions" },
	{ id: "dialog-copy-selector", action: "openCopySelector", title: "Copy selector" },
	{ id: "dialog-benchmark", action: "openBenchmark", title: "Model benchmark" },
	{ id: "dialog-model-setup", action: "openModelSetup", title: "Model setup assistant" },
	{ id: "dialog-debug", action: "openDebug", title: "Debug console" },
	{ id: "dialog-worktree", action: "openWorktreeDialog", title: "New task" },
];

/**
 * Scrolls `target` to the top of its transcript until it stays there. The rows around it are measured in the frames
 * after they mount and each measurement moves the view, so a place read right after the scroll says nothing: the
 * target is where the scroll put it only once it has not moved for ten frames (10 Nov 2026: a phone's view of the
 * showcase reply slid 759 px past its section after one scroll).
 */
async function holdAtTop(target: Locator): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt++) {
		const stayed = await target.evaluate(async element => {
			const frames = async (count: number) => {
				for (let frame = 0; frame < count; frame++) await new Promise(done => requestAnimationFrame(done));
			};
			element.scrollIntoView({ block: "start" });
			await frames(2);
			const placed = element.getBoundingClientRect().top;
			await frames(10);
			return element.isConnected && Math.abs(element.getBoundingClientRect().top - placed) <= 1;
		});
		if (stayed) return;
	}
}

/**
 * Brings the turn a person started with `prompt` to the top of its transcript, as a reader looking for it does: an
 * upward wheel first (a programmatic scroll alone leaves the transcript following its end, ChatStream's `pinned`,
 * released only by a wheel, touch, key or scrollbar gesture), then a view's height at a time, from where the view is
 * to the transcript's start and on to its end, until the turn is in the page.
 *
 * The transcript is virtualized: only the rows around the view are mounted (8 beyond it), so a part of a turn far
 * from the view is not there to wait for, click or scroll to. Every surface of the `reply` session names its turn
 * here first: once the session had seven turns, the surfaces of its first four waited 15 to 30 s each for a row that
 * never mounted, in the window and in the paired view (10 Nov 2026: 10 of the 48 parity surfaces, 482 of a capture's
 * 800 s).
 */
async function showTurn(page: Page, prompt: string): Promise<void> {
	const bubble = page.locator(".omp-user-bubble").getByText(prompt, { exact: true }).last();
	const scroller = page.locator(".omp-transcript-scroll").first();
	await scroller.evaluate(element =>
		element.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true })),
	);
	for (const direction of [-1, 1]) {
		while ((await bubble.count()) === 0) {
			const moved = await scroller.evaluate(async (element, by) => {
				const from = element.scrollTop;
				element.scrollTop = from + by * element.clientHeight;
				// The rows of the new view mount in the frames after the scroll.
				await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
				return element.scrollTop !== from;
			}, direction);
			if (!moved) break;
		}
	}
	await holdAtTop(bubble);
}

/**
 * Brings `target` of a reply whose turn is shown (`showTurn`) to the top of its transcript, once each of `drawn` (the
 * reply's math, its mermaid chart) is visible in the target's own row and every picture of a figure row has its
 * read's answer (the picture, or the failed chip with its reason).
 */
async function showInReply(page: Page, target: Locator, drawn: readonly string[] = []): Promise<void> {
	const row = page.locator(".omp-transcript-scroll [data-index]").filter({ has: target }).first();
	for (const selector of drawn) await row.locator(selector).last().waitFor({ state: "visible", timeout: 15_000 });
	await page
		.locator("[data-figure-row] figure:not(:has(img)):not(:has(> span[title]))")
		.first()
		.waitFor({ state: "detached", timeout: 15_000 });
	await holdAtTop(target);
}

/** The transcript's first row at the top of its view, reached the way `showTurn` reaches a turn (a wheel, then scrolls). */
async function showTranscriptStart(page: Page): Promise<void> {
	const scroller = page.locator(".omp-transcript-scroll").first();
	const first = scroller.locator('[data-index="0"]');
	await scroller.evaluate(element =>
		element.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true })),
	);
	for (let attempt = 0; attempt < 30 && (await first.count()) === 0; attempt++)
		await scroller.evaluate(async element => {
			element.scrollTop = 0;
			const mounted = Promise.withResolvers<void>();
			requestAnimationFrame(() => requestAnimationFrame(() => mounted.resolve()));
			await mounted.promise;
		});
	await holdAtTop(first);
}

/**
 * Brings the transcript back to its end the way a reader does, with "Jump to latest": a surface before may have
 * scrolled this same session up, and a window keeps its view of a session between surfaces (only the phone's page
 * loads afresh). A scroll of our own would leave the pill over the transcript and the view unpinned. The pill stays
 * in the page while the view follows its end, hidden from the pointer and the accessibility tree.
 */
async function showTranscriptEnd(page: Page): Promise<void> {
	const latest = page.locator("[data-jump-to-latest]:not([aria-hidden])").first();
	if ((await latest.count()) > 0) await latest.click();
	await latest.waitFor({ state: "detached", timeout: 15_000 });
}

/**
 * Reads the `long` session back to its first turn. A transcript opens on its newest page and asks for the page before
 * each time the reader's view comes to the top of what is loaded (ChatStream `handleScroll`), so the view goes to the
 * top again and again, seven pages of the fake omp's 250 turns, until the first turn is mounted. A window's reader
 * turns a wheel first (see `showTurn`); a phone's flicks, and its view scrolls on after the finger lifted. The
 * newest page is on screen before either: a view sent to the top of an empty transcript scrolls nothing afterwards.
 * It ends on the first turn's row at the top, the session's start: the bubble's text there instead (what
 * `holdAtTop` of the text does) cuts the bubble by its own 10 px of padding.
 */
async function showSessionStart(page: Page, look: Look): Promise<void> {
	const scroller = page.locator(".omp-transcript-scroll").first();
	const first = page.locator(".omp-user-bubble").getByText("Long session turn 000", { exact: true });
	await scroller.getByText("Long session answer 249", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
	// The reader's gesture, taken in by the page (two frames) before the view moves: a wheel, or a finger's move.
	const touch = touchLook(look);
	await scroller.evaluate(async (element, finger) => {
		element.dispatchEvent(
			finger
				? new TouchEvent("touchmove", { bubbles: true })
				: new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }),
		);
		const taken = Promise.withResolvers<void>();
		requestAnimationFrame(() => requestAnimationFrame(() => taken.resolve()));
		await taken.promise;
	}, touch);
	// A flick: the finger lifts as the view starts to move, so every scroll event comes after it.
	if (touch)
		await scroller.evaluate(element => {
			element.scrollTop = 0;
			element.dispatchEvent(new TouchEvent("touchend", { bubbles: true }));
		});
	const until = Date.now() + 30_000;
	while ((await first.count()) === 0 && Date.now() < until)
		await scroller.evaluate(async element => {
			element.scrollTop = 0;
			const mounted = Promise.withResolvers<void>();
			requestAnimationFrame(() => requestAnimationFrame(() => mounted.resolve()));
			await mounted.promise;
		});
	await holdAtTop(scroller.locator("[data-index]").filter({ has: first }).first());
}

/** What the turn rail draws: its ticks, the number of the first one, the ticks marked as the turn in view, the earlier item's name. */
interface TurnRailReading {
	ticks: number;
	first: number;
	current: number;
	earlier: string | null;
}

/**
 * Waits until the turn rail draws 20 ticks (`TURN_RAIL_LIMIT`), the first of them turn number `first` (exactly, or at
 * most `atMost`: a phone's page reads another turn as the one in view than a window does), the turn in view among
 * them, and an "N earlier" item that names the turns above the first tick (none when the first tick is turn 1). Fails
 * with what it read.
 */
async function expectTurnRail(page: Page, want: { first: number | { atMost: number } }): Promise<void> {
	const read = (): Promise<TurnRailReading> =>
		page.evaluate(() => {
			const markers = [...document.querySelectorAll(".omp-conversation-nav-marker")];
			const first = Number(/turn (\d+) of/.exec(markers[0]?.getAttribute("aria-label") ?? "")?.[1]);
			return {
				ticks: markers.length,
				first,
				current: markers.filter(marker => marker.getAttribute("aria-current") === "location").length,
				earlier: document.querySelector(".omp-conversation-nav-earlier")?.getAttribute("aria-label") ?? null,
			};
		});
	const fits = (seen: TurnRailReading) =>
		seen.ticks === 20 &&
		seen.current === 1 &&
		(typeof want.first === "number" ? seen.first === want.first : seen.first <= want.first.atMost) &&
		seen.earlier === (seen.first > 1 ? `${seen.first - 1} earlier` : null);
	let seen = await read();
	for (let attempt = 0; attempt < 40 && !fits(seen); attempt++) {
		await page.waitForTimeout(250);
		seen = await read();
	}
	if (!fits(seen)) throw new Error(`the turn rail draws ${JSON.stringify(seen)}, not ${JSON.stringify(want)}`);
}

/** The parity work session's one prompt (parity.e2e.ts); `transcript-find` looks for it. */
export const PARITY_WORK_PROMPT = "Show this session the same way everywhere";
/** The bot of an away computer both parity computers kept a copy of (`bot-pane-offline`, parity.e2e.ts `seedAwayHostBots`). */
export const AWAY_HOST_BOT = "bot-away-courier";

export const SURFACES: readonly Surface[] = [
	// ── Area A: sidebar, transcript, composer, panels ─────────────────────────────────────────
	{
		id: "session-idle",
		area: "A",
		title: "Session: header, transcript, dock and composer at rest (with density figures)",
		density: true,
		open: async page => {
			await page.waitForSelector("[data-transcript-kind]", { timeout: 15_000 });
		},
		ready: "[data-composer-input]",
		parity: { session: "work" },
	},
	{
		id: "reply-images",
		area: "A",
		title: "A reply showing the changed look: a before/after pair and a gallery of three screenshots, by absolute path",
		open: async page => {
			await showTurn(page, "fixture reply images");
			await showInReply(page, page.locator("[data-zoomable-image]").first());
		},
		ready: "[data-zoomable-image] img",
		settle: 900,
		// The audits' harness page has no such reply; the parity sheet asks the fake omp for it.
		when: () => false,
		parity: { session: "reply" },
	},
	{
		id: "reply-images-zoom",
		area: "A",
		title: "The reply's after picture opened full size from its pair, its partner one step away",
		open: async page => {
			await showTurn(page, "fixture reply images");
			await page
				.getByRole("button", { name: /After: one project open/ })
				.first()
				.click();
		},
		ready: "[role='dialog'] [data-image-viewer] img",
		settle: 900,
		when: () => false,
		parity: { session: "reply" },
	},
	{
		id: "reply-media",
		area: "A",
		title: "A reply's files and figures: an svg figure, a video and a sound in their players, a table file's card",
		open: async page => {
			await showTurn(page, "fixture reply media");
			await page.locator(".markdown-body [data-file-card]").first().waitFor({ timeout: 15_000 });
			await showInReply(
				page,
				page
					.locator(".markdown-body h2")
					.filter({ hasText: /^\s*Media\s*$/ })
					.first(),
			);
		},
		ready: ".markdown-body video",
		settle: 900,
		when: () => false,
		parity: { session: "reply" },
	},
	{
		id: "reply-media-zoom",
		area: "A",
		title: "The reply's svg figure enlarged from its header",
		open: async page => {
			await showTurn(page, "fixture reply media");
			await page.locator(".markdown-body [data-figure='svg'] [data-figure-expand]").first().click();
		},
		ready: "[role='dialog'] [data-image-viewer] img",
		settle: 900,
		when: () => false,
		parity: { session: "reply" },
	},
	// Every other way a reply presents something, one heading of src/renderer/dev-harness/reply-showcase.ts each.
	...(
		[
			[
				"reply-text",
				"Text",
				"Prose with inline marks, a key-value list, numbered steps, a task list and a row of pictures whose files are gone",
			],
			["reply-tables", "Tables", "A comparison table with status marks, and a seven-column table"],
			["reply-code", "Code", "A long typed code line, a diff and a JSON fence"],
			["reply-callouts", "Callouts", "Alerts, a plain quote, a folded log and a rule"],
			["reply-math", "Math and diagrams", "Inline and block math, a mermaid chart and a footnote"],
		] as const
	).map(
		([id, heading, what]): Surface => ({
			id,
			area: "A",
			title: `A reply's ${heading.toLowerCase()}: ${what}`,
			open: async page => {
				await showTurn(page, "fixture reply components");
				await showInReply(
					page,
					page
						.locator(".markdown-body h2")
						.filter({ hasText: new RegExp(`^\\s*${heading}\\s*$`) })
						.first(),
					[".markdown-body .katex-display", ".markdown-body [data-figure] img"],
				);
			},
			ready: `.markdown-body h2:text-is("${heading}")`,
			settle: 900,
			// Each view shows its section; the Text one, the row whose chips spilled their paths sideways.
			parity: {
				session: "reply",
				inView:
					heading === "Text"
						? '.markdown-body [data-figure-row]:has-text("Before: one word per line")'
						: `.markdown-body h2:text-is("${heading}")`,
			},
		}),
	),
	{
		id: "reply-narration",
		area: "A",
		title: "A run whose reply writes to the person beside its tool call: the text stays under the card holding the call",
		open: async page => {
			await showTurn(page, "fixture narrated");
			await page.getByText("Narrated run finished.", { exact: true }).last().waitFor({ timeout: 15_000 });
		},
		ready: "[data-transcript-kind='process']",
		settle: 900,
		when: () => false,
		parity: { session: "reply" },
	},
	{
		id: "reply-steer",
		area: "A",
		title: "A steer the person sent while the run worked: their message in the chat between the run's two cards",
		open: async page => {
			await showTurn(page, "fixture steered");
			await page.getByText("Steered run finished.", { exact: true }).last().waitFor({ timeout: 15_000 });
		},
		ready: "[data-transcript-kind='process']",
		settle: 900,
		when: () => false,
		parity: { session: "steer" },
	},
	{
		id: "reply-advisor-note",
		area: "A",
		title: "An advisor note with prices, a bare URL and one long formula: money stays text, every line stays inside the card",
		open: async page => {
			await showTurn(page, "fixture advisor note");
			await page.getByText("Advisor note delivered.", { exact: true }).last().waitFor({ timeout: 15_000 });
		},
		ready: "[data-card]:has-text('결론을 정정하세요')",
		settle: 900,
		when: () => false,
		parity: { session: "advisor", inView: "[data-card]:has-text('결론을 정정하세요')" },
	},
	{
		id: "reply-ci-note",
		area: "A",
		title: "The CI lines a session's push brings between turns: one passed, one failed with its jobs and the run link",
		open: async page => {
			await showTurn(page, "fixture ci note");
			await page.getByText("Pushed main.", { exact: true }).last().waitFor({ timeout: 15_000 });
		},
		ready: '[data-ci-note="failure"]',
		settle: 900,
		when: () => false,
		parity: { session: "ci", inView: '[data-ci-note="failure"]' },
	},
	{
		id: "reply-a2ui",
		area: "A",
		title: "An A2UI surface the agent drew in the chat: a card with a heading, a bar chart and a caption",
		open: async page => {
			await showTurn(page, "fixture a2ui show");
			await page.getByText("A2UI surface shown.", { exact: true }).last().waitFor({ timeout: 15_000 });
		},
		ready: "[data-a2ui-card] [data-a2ui-chart] canvas",
		settle: 900,
		// The audits' harness page has no such turn; the parity sheet asks the fake omp for it.
		when: () => false,
		parity: { session: "a2ui", inView: '[data-a2ui-surface="weekly"]' },
	},
	{
		id: "card-a2ui-form",
		area: "A",
		title: "An A2UI form the agent waits on: the card's inputs and Send live in the chat, the dock's waiting row with Jump and Skip",
		// The host's fake omp raises it (e2e/fixture/rpc-ui.ts "fixture a2ui form") as the bridge's `a2ui` tool waits on the
		// person, with a new request id each time, since each view asks afresh; `after` skips it from the dock.
		open: async page => {
			await promptShownTab(page, "fixture a2ui form");
			await page.locator("[data-a2ui-waiting]").first().waitFor({ timeout: 15_000 });
		},
		ready: '[data-a2ui-card][data-a2ui-live] [data-a2ui-surface^="contact-"]',
		settle: 900,
		// The audits' harness page has no such turn; the parity sheet asks the fake omp for it.
		when: () => false,
		parity: {
			session: "a2uiForm",
			inView: '[data-a2ui-card][data-a2ui-live] [data-a2ui-surface^="contact-"]',
			// The dismissal ends the turn, so the session is idle for the next view's prompt.
			after: async page => {
				const skip = page.locator("[data-a2ui-dock-skip]");
				if (await skip.count()) await skip.first().click();
				await page.locator("[data-a2ui-waiting]").first().waitFor({ state: "detached", timeout: 15_000 });
				await page
					.locator(".omp-composer-toolbar[data-turn-running]")
					.first()
					.waitFor({ state: "detached", timeout: 15_000 });
			},
		},
	},
	...(
		[
			[
				"work-turn-recovered",
				"fixture turn recovered",
				"The tests pass now.",
				"a failed test a later card's rerun fixed",
			],
			[
				"work-turn-unfixed",
				"fixture turn unfixed",
				"One test still fails.",
				"a failed test that was the turn's last",
			],
		] as const
	).map(
		([id, prompt, answer, what]): Surface => ({
			id,
			area: "A",
			title: `A turn's two work cards around a reply's narration: ${what}, and a note for an error gone past`,
			open: async page => {
				await showTurn(page, prompt);
				await page.getByText(answer, { exact: true }).last().waitFor({ timeout: 15_000 });
			},
			ready: "[data-transcript-kind='process']",
			settle: 900,
			when: () => false,
			parity: { session: "reply" },
		}),
	),
	{
		id: "tool-agent-desktop",
		area: "A",
		title: "agent-desktop's tool calls: the snapshot tree unfolded, the typed line and the screenshot",
		open: async page => {
			await showTurn(page, "fixture agent-desktop");
			await page.getByText("agent-desktop run finished.", { exact: true }).last().waitFor({ timeout: 15_000 });
			const card = page.locator(".omp-execution-group").last();
			const head = card.locator(".omp-execution-group-header").first();
			if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
			// The snapshot's tree is what the surface is about; the typed line and the picture open beside it.
			for (const command of ["screenshot", "type", "snapshot"]) {
				const row = card
					.locator(".omp-tool-card")
					.filter({ hasText: new RegExp(`Desktop · ${command}`) })
					.first()
					.locator("button[aria-expanded]")
					.first();
				if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
			}
			// The picture and the lazy tree settle the rows' heights (the transcript is virtualized): scroll again after
			// each, as a reader would, until the tree stays at the top.
			await card.locator("[data-zoomable-image] img").first().waitFor({ state: "visible", timeout: 15_000 });
			const tree = card.locator('[data-tool-agent-desktop="tree"]').first();
			for (let attempt = 0; attempt < 3; attempt++) {
				// An upward wheel first, as `showInReply` does: a programmatic scroll leaves the transcript pinned to its end.
				await page
					.locator(".omp-transcript-scroll")
					.first()
					.evaluate(scroller =>
						scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true })),
					);
				await tree.evaluate(element => element.scrollIntoView({ block: "start" }));
				await page.waitForTimeout(300);
			}
		},
		ready: '[data-tool-agent-desktop="tree"] [role="tree"] [data-tree-id]',
		settle: 900,
		// The audits' harness page has no such run; the parity sheet asks the fake omp for it.
		when: () => false,
		parity: { session: "reply", inView: '[data-tool-agent-desktop="tree"]' },
	},
	{
		id: "reply-schedule-card",
		area: "A",
		title: "An agent's ompdesk_schedule create of a webhook routine: the saved line and the webhook card with Copy URL",
		open: async page => {
			await showTurn(page, "fixture schedule card");
			await page.getByText("Webhook routine saved.", { exact: true }).last().waitFor({ timeout: 15_000 });
			const card = page.locator(".omp-execution-group").last();
			const head = card.locator(".omp-execution-group-header").first();
			if ((await head.count()) > 0 && (await head.getAttribute("aria-expanded")) !== "true") await head.click();
			const step = card
				.locator(".omp-tool-card")
				.filter({ hasText: "Deploy hook" })
				.first()
				.locator("button[aria-expanded]")
				.first();
			if ((await step.getAttribute("aria-expanded")) !== "true") await step.click();
			const webhook = card.locator("[data-tool-schedule-webhook]").first();
			await webhook.waitFor({ state: "visible", timeout: 15_000 });
			await page
				.locator(".omp-transcript-scroll")
				.first()
				.evaluate(scroller =>
					scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true })),
				);
			await webhook.evaluate(element => element.scrollIntoView({ block: "center" }));
		},
		ready: "[data-tool-schedule-webhook]",
		settle: 900,
		// The audits' harness page has no such turn; the parity sheet asks the fake omp for it.
		when: () => false,
		parity: { session: "schedule", inView: "[data-tool-schedule-webhook]" },
	},
	{
		id: "reply-usage",
		area: "A",
		title: "The usage row under a reply: model, tokens, cache, cost, duration, first token, speed and time on one line",
		// The fake omp's agent-desktop run (`tool-agent-desktop`) ends on a reply carrying every segment.
		open: async page => {
			// A surface before may have scrolled the transcript up: back to its end, where this reply is.
			await showTranscriptEnd(page);
			await page.getByText("agent-desktop run finished.", { exact: true }).last().waitFor({ timeout: 15_000 });
		},
		ready: ".omp-usage-row",
		settle: 900,
		// The audits' harness page shows usage rows only with the preference on; the parity sheet asks the fake omp.
		when: () => false,
		parity: { session: "reply", inView: ".omp-usage-row" },
	},
	{
		id: "composer-dictation-preparing",
		area: "A",
		title: "Composer dictation in Korean, its first take waiting for the Korean speech model's download, with its progress",
		open: startKoreanDictationTake,
		ready: '[data-dictation="transcribing"] [data-dictation-download]',
		when: () => false,
		parity: { session: "work", after: endDictationTake },
	},
	{
		id: "composer-dictation-downloaded",
		area: "A",
		title: "Composer dictation in Korean after the Korean speech model's download: the take being transcribed on it",
		open: async page => {
			await startKoreanDictationTake(page);
			await page.locator('[data-dictation="transcribing"] [data-dictation-download]').waitFor({ timeout: 15_000 });
			// The download is done; the fake omp keeps the transcription running.
			await scriptVoice({ holdTranscribe: true });
		},
		ready: '[data-dictation="transcribing"]:not(:has([data-dictation-download]))',
		when: () => false,
		parity: { session: "work", after: endDictationTake },
	},
	{
		id: "session-slow-start",
		area: "A",
		title: "A session whose omp has not answered its first state for a while: the amber banner with omp's stderr line and Restart, nothing failed",
		open: restartSlowStart,
		ready: "text=omp is taking long to start",
		// The fake omp's start script exists only in the parity sheet's two apps; the audits' harness page has no omp.
		when: () => false,
		parity: { session: "work", after: endStartHold },
	},
	{
		id: "session-queued-start",
		area: "A",
		title: 'A session whose replacement omp waits for the one it stopped to exit: the title bar reads "Waiting to start", no banner',
		open: restartQueuedStart,
		ready: WAITING_TO_START,
		// The fake omp's start script exists only in the parity sheet's two apps; the audits' harness page has no omp.
		when: () => false,
		parity: { session: "work", after: endStartHold },
	},
	{
		id: "board-strip",
		area: "A",
		title: "Work board strip (busy session, ?board=busy), expanded: under the header on a phone, above the composer elsewhere, where the pane cannot dock the board (docked: board-strip-open)",
		query: "&board=busy",
		when: boardIsStrip,
		open: async (page, look) => {
			const { chip, docked } = busyBoard(page);
			await chip.or(docked).first().waitFor({ state: "visible", timeout: 15_000 });
			// A window wide enough docks the board (the parity sheet's): the side panel takes its place, so the strip shows.
			if ((await chip.count()) === 0) {
				await openPanelView(page, look, "diff");
				await chip.waitFor({ state: "visible", timeout: 15_000 });
			}
			if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
		},
		ready: "[data-work-strip-panel]",
		settle: 600,
		parity: { session: "board", after: closePanelView },
	},
	{
		id: "board-strip-open",
		area: "A",
		title: "Work board strip with every zone opened from its summary line: the rows a phone reaches with a tap more",
		query: "&board=busy",
		open: async page => {
			const { chip, docked } = busyBoard(page);
			await chip.or(docked).first().waitFor({ state: "visible", timeout: 15_000 });
			if ((await chip.count()) === 0) return;
			if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
			// Current work's rows are a lazy chunk: its line arrives last, after the others.
			const lines = page.locator("[data-work-strip-panel] [data-board-summary]");
			await page.locator("[data-work-strip-panel] [data-board-section='current']").waitFor({ timeout: 15_000 });
			for (let left = await lines.count(); left > 0; left = await lines.count()) await lines.first().click();
		},
		ready: "[data-work-board-panel]",
		settle: 600,
		parity: { session: "board" },
	},
	{
		id: "sidebar",
		area: "A",
		title: "Session list: the drawer on a phone, docked beside the page from 800 px",
		open: openDrawer,
		ready: "[data-tour='sessions'], [data-drawer]",
		parity: { session: "work" },
	},
	{
		id: "sidebar-usage",
		area: "A",
		title: "The usage block (a desktop window's status bar popover, a phone's sidebar footer) listing four Claude and four ChatGPT accounts, the session's own marked",
		open: openUsage,
		ready: "[data-rail-pin='usage'] [data-usage-account]",
		// Parity only, and only over a host whose fake omp reports those accounts (`OMP_GUI_TEST_USAGE_ACCOUNTS=many`).
		when: () => false,
		parity: {
			session: "work",
			available: () => ["many", "blocked"].includes(process.env.OMP_GUI_TEST_USAGE_ACCOUNTS ?? ""),
		},
	},
	{
		id: "sidebar-usage-end",
		area: "A",
		title: "The same usage block scrolled to its last account: the block scrolls inside its cap, the sidebar does not",
		open: async (page, look) => {
			await openUsage(page, look);
			await page.locator("[data-sidebar-usage-scroll]").evaluate(list => {
				list.scrollTop = list.scrollHeight;
			});
		},
		ready: "[data-rail-pin='usage'] [data-usage-account]",
		when: () => false,
		parity: {
			session: "work",
			available: () => ["many", "blocked"].includes(process.env.OMP_GUI_TEST_USAGE_ACCOUNTS ?? ""),
		},
	},
	{
		id: "first-run",
		area: "A",
		title: "First run's provider step on the start tab of a fresh profile",
		open: async page => {
			await page.locator('[data-first-run-step="connect"] [data-provider-connect="anthropic"]').waitFor();
		},
		ready: '[data-first-run-step="connect"] [role="progressbar"]',
		when: () => false,
		parity: { session: "start" },
	},
	{
		id: "sidebar-family",
		area: "A",
		title: "Session list with the work session's child running on the paired computer and the other computer's section folded to its count",
		open: openRemoteFamily,
		ready: '[data-sidebar-family] [data-sidebar-opened-session]:has-text("Parity remote child")',
		when: () => false,
		parity: { session: "work", remoteChild: true },
	},
	{
		id: "sidebar-roster",
		area: "A",
		title: "Session list with a session this view holds but does not show running two subagents: its row counts them with no click",
		open: openDrawer,
		ready: ':is(.omp-sidebar-session-row, [data-device-session]):has-text("Parity roster") [data-family-running="2"]',
		// Two paired apps only: the parity sheet sets it up (`hiddenRoster`); the audits' harness page has no such session.
		when: () => false,
		parity: { session: "work", hiddenRoster: true },
	},
	{
		id: "sidebar-own-project",
		area: "A",
		title: "Session list with a session the work session opened in another folder: under its opener and in its own project",
		open: openOwnProject,
		ready: ':is([data-session-group$="seuoffice"] .omp-sidebar-session-row, [data-device-group$="seuoffice"] [data-device-session]):has-text("Parity cross-project")',
		// Two paired apps only: the parity sheet sets it up (`crossProject`); the audits' harness page has no such session.
		when: () => false,
		parity: { session: "work", crossProject: true },
	},
	{
		id: "sidebar-folder-missing",
		area: "A",
		title: "Session list with a session whose folder was deleted: its row says the folder is missing",
		open: openFolderMissing,
		ready: ':is(.omp-sidebar-session-row, [data-device-session]):has-text("Parity folder gone") [data-folder-missing], :is(.omp-sidebar-session-row, [data-device-session])[data-folder-missing]:has-text("Parity folder gone")',
		when: () => false,
		parity: { session: "work", folderMissing: true },
	},
	{
		id: "sidebar-sorted",
		area: "A",
		title: "Session list sorted by Recent with Hide sleeping: a project's newer session first, its idle one folded under the sleeping line",
		open: openSidebarSorted,
		ready: ':is([data-session-group$="parity-sleep"], [data-device-group$="parity-sleep"]) [data-sidebar-sleeping="1"]',
		when: () => false,
		parity: { session: "work", sleepingRow: true, after: resetSidebarOptions },
	},
	{
		id: "missing-folder-sheet",
		area: "A",
		title: "A session whose folder was deleted, selected: its transcript read-only, with Archive (nothing saved to restore)",
		open: async (page, look) => {
			await openFolderMissing(page, look);
			await page
				.locator(
					':is(.omp-sidebar-session-row, [data-device-session])[data-folder-missing]:has-text("Parity folder gone") button',
				)
				.first()
				.click();
			// The sheet's body holds the stored transcript (read with no omp); its footer the action.
			await page
				.locator("[data-missing-folder-sheet] .omp-transcript-row")
				.first()
				.waitFor({ state: "visible", timeout: 15_000 });
		},
		ready: "[data-missing-folder-archive]",
		settle: 800,
		when: () => false,
		parity: { session: "work", folderMissing: true, after: closeOverlay },
	},
	{
		id: "transcript-top",
		area: "A",
		title: "Transcript scrolled to its first turn",
		open: showTranscriptStart,
		ready: '.omp-transcript-scroll [data-index="0"]',
		// A 44-turn session: its first turn is a scroll away from where it opens.
		parity: { session: "turns" },
	},
	{
		id: "transcript-stress",
		area: "A",
		title: "Transcript at the stress turns: long URL, wide table, long code line, diff, mermaid, long tool paths",
		open: page => showTurn(page, STRESS_PROMPT),
		ready: `.omp-user-bubble:has-text("${STRESS_PROMPT}")`,
		settle: 900,
		// B's "Parity stress" session, whose one turn the fake omp answers with the harness's stress reply.
		parity: { session: "stress" },
	},
	// Find in the conversation (⌘F, chat/TranscriptFind.tsx): the bar over the transcript, its count, the marked match.
	{
		id: "transcript-find",
		area: "A",
		title: "Find in the conversation: the bar at the transcript's top right with its count",
		// Words only the work session's first prompt holds: surfaces earlier in the order add answered turns to the
		// session, so "fixture reply" counted 1 to 7 and started wherever the reader was (ui-parity.md › transcript-find).
		open: async page => {
			const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
			await page.keyboard.press(mac ? "Meta+f" : "Control+f");
			await page.locator("[data-transcript-find] input").fill(PARITY_WORK_PROMPT);
		},
		ready: '[data-transcript-find] [data-find-status]:text-matches("^1/1$")',
		settle: 400,
		// Parity only: a real window's ⌘F over the work session. The find left the window at the first turn: `after`
		// closes the bar and goes back to the end, where the surfaces after it expect the work session.
		when: () => false,
		parity: {
			session: "work",
			after: async page => {
				await closeOverlay(page);
				await showTranscriptEnd(page);
			},
		},
	},
	// The turn rail in the transcript's left gutter (ConversationNavigator). A phone's page does not draw it (its CSS
	// hides it below a wide workspace), so there the capture is the transcript alone; the ticks are mounted all the same.
	{
		id: "transcript-turn-rail",
		area: "A",
		title: "Transcript of a 44-turn session at its newest turn, with the turn rail in the left gutter",
		// `transcript-turn-rail-scrolled` leaves this session at its third turn: captured after it, the rail's window
		// stayed on turns 1 to 20 in the two views that keep their tab.
		open: async page => {
			await showTranscriptEnd(page);
			await expectTurnRail(page, { first: 25 });
		},
		ready: ".omp-transcript-scroll",
		settle: 600,
		when: () => false,
		parity: { session: "turns" },
	},
	{
		id: "transcript-turn-rail-scrolled",
		area: "A",
		title: "The same session scrolled up to its third turn: the turn rail follows it",
		open: async page => {
			await showTurn(page, "Parity turn 3");
			await expectTurnRail(page, { first: { atMost: 5 } });
		},
		ready: ".omp-transcript-scroll",
		settle: 900,
		when: () => false,
		parity: { session: "turns" },
	},
	// A session longer than the page a transcript opens with: the pages before it load as the reader comes to the top.
	{
		id: "transcript-older-history",
		area: "A",
		title: "A 250-turn session read back to its first turn: every page before its newest loaded on the way up",
		open: showSessionStart,
		ready: '.omp-transcript-scroll .omp-user-bubble:has-text("Long session turn 000")',
		settle: 900,
		when: () => false,
		parity: { session: "long", inView: '.omp-user-bubble:has-text("Long session turn 000")' },
	},
	{
		id: "image-viewer",
		area: "A",
		title: "A picture full size (the stress turns' mermaid diagram) under its own bar",
		open: async page => {
			await page.evaluate(() => {
				const row = document.querySelector("[data-transcript-kind]");
				let node = row?.parentElement ?? null;
				while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
				if (node) node.scrollTop = node.scrollHeight;
			});
			const picture = page.locator("[data-zoomable-image]").last();
			await picture.waitFor({ state: "visible", timeout: 15_000 });
			await picture.click();
		},
		ready: "[data-image-viewer-head]",
		settle: 600,
	},
	{
		id: "composer-mode-goal",
		area: "A",
		title: "Mode popover › Goal",
		open: async page => {
			await page.locator("[data-run-settings-trigger]").first().click();
			await page.locator('[data-tab-id="goal"]').click();
		},
		ready: '[data-tab-id="goal"][aria-selected="true"]',
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "model-picker",
		area: "A",
		title: "Model picker: each model its provider's mark and compact name, opened from the composer's model chip",
		open: page => page.locator("[data-model-chip]").first().click(),
		ready: "[data-model-option]",
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "composer-slash-menu",
		area: "A",
		title: "Slash command menu",
		open: async page => {
			const input = page.locator("[data-composer-input]");
			await input.fill("");
			await input.pressSequentially("/", { delay: 30 });
		},
		ready: '.omp-composer-anchor [role="listbox"]',
	},
	{
		id: "composer-at-menu",
		area: "A",
		title: "@ menu: files, then this session's opened sessions and this project's others",
		open: async page => {
			const input = page.locator("[data-composer-input]:visible").first();
			await input.fill("");
			await input.pressSequentially("@", { delay: 30 });
		},
		ready: '.omp-composer-anchor [role="listbox"]',
		parity: {
			session: "work",
			after: async page => {
				await page.keyboard.press("Escape");
				await page.locator("[data-composer-input]:visible").first().fill("");
			},
		},
	},
	{
		id: "composer-long-draft",
		area: "A",
		title: "Composer holding a long multi-line draft",
		open: async page => {
			const input = page.locator("[data-composer-input]:visible").first();
			await input.click();
			await input.fill(
				Array.from(
					{ length: 8 },
					(_, line) => `Line ${line + 1} of a long draft that wraps past the width of a narrow phone screen`,
				).join("\n"),
			);
		},
		// The draft is typed into the shown session's composer; `after` empties it again for the next surface.
		parity: {
			session: "work",
			after: async page => {
				await page.locator("[data-composer-input]:visible").first().fill("");
			},
		},
	},
	{
		id: "composer-keyboard",
		area: "A",
		title: "Composer with the soft keyboard up and a draft typed",
		query: "&kb=1",
		when: keyboardLook,
		open: async (page, look) => {
			await keyboardUp(page, look, "[data-composer-input]");
			await page.locator("[data-composer-input]").fill("A short draft typed with the keyboard up");
		},
		ready: "[data-composer-input]",
	},
	{
		id: "composer-keyboard-slash",
		area: "A",
		title: "Slash command menu with the soft keyboard up",
		query: "&kb=1",
		when: keyboardLook,
		open: async (page, look) => {
			await keyboardUp(page, look, "[data-composer-input]");
			await page.locator("[data-composer-input]").pressSequentially("/", { delay: 30 });
		},
	},
	{
		id: "dialog-rename-keyboard",
		area: "B",
		title: "Rename dialog with the soft keyboard up on its field",
		query: "&kb=1",
		when: keyboardLook,
		open: async (page, look) => {
			await ui(page, "openRenameDialog");
			await keyboardUp(page, look, "[role='dialog'] input");
		},
		settle: 700,
	},
	...PANELS.map(
		(panel): Surface => ({
			id: `panel-${panel}`,
			area: "A",
			title: `Side panel › ${panel}`,
			open: async (page, look) => {
				if (panel === "files") return ui(page, "setPanelTab", panel);
				await openPanelView(page, look, panel);
				await page
					.locator(
						panel === "diff"
							? "[data-scm-bar]:visible"
							: panel === "preview"
								? "[data-preview-panel]:visible"
								: "[data-terminal-head]:visible",
					)
					.first()
					.waitFor({ timeout: 20_000 });
			},
			// The terminal's sheet is ready once its first shell's tab shows (with the phone's key bar under it). The
			// Preview's empty tab shows its start page (servers, forwards, devices, recent sites).
			ready:
				panel === "diff"
					? "[data-scm-bar]:visible"
					: panel === "terminal"
						? "[data-terminal-tab]:visible"
						: panel === "preview"
							? "[data-preview-panel]:visible"
							: "[data-sheet-panel], [data-panel-tabbar], .omp-panel-topbar",
			...(panel === "diff" || panel === "terminal" || panel === "preview"
				? { parity: { session: "work" as const, after: closePanelView } }
				: {}),
			settle: 900,
		}),
	),
	{
		// The Preview's start page with every source filled (`OMP_GUI_TEST_PREVIEW_START=1`): the work session's dev server
		// (the fake omp's child, `procs.ports`; on a paired computer it opens through the host), an Android emulator
		// (e2e/parity.e2e.ts `fakeAndroidDevice`) and two recent sites (`seedPreviewHistory`).
		id: "preview-start",
		area: "A",
		title: "Preview start page: the session's dev server, a running device, recent sites",
		open: async (page, look) => {
			await openPanelView(page, look, "preview");
			for (const section of ["servers", "devices", "recent"])
				await page.locator(`[data-preview-start-${section}]:visible`).first().waitFor({ timeout: 30_000 });
			// The address keeps a readable width beside the row's buttons, a phone's too (Orca's floor: 120 px).
			const field = page.locator("[data-preview-panel] input[inputmode='url']:visible").first();
			const width = (await field.boundingBox())?.width ?? 0;
			if (width < 120) throw new Error(`the Preview's address field is ${Math.round(width)} px wide`);
		},
		ready: "[data-preview-start]:visible",
		// The audits' harness page has no session processes, devices or history; the parity sheet starts them.
		when: () => false,
		parity: {
			session: "work",
			after: closePanelView,
			available: () => process.env.OMP_GUI_TEST_PREVIEW_START === "1",
		},
		settle: 900,
	},
	{
		// The emulator pane (Orca's FT71): the start page's device opened, its screen read by `adb exec-out screencap`.
		id: "preview-device",
		area: "A",
		title: "Preview device screen: an Android emulator with its keys",
		open: async (page, look) => {
			await openPanelView(page, look, "preview");
			const devices = page.locator("[data-preview-start-devices]:visible").first();
			await devices.waitFor({ timeout: 30_000 });
			await devices.getByRole("button").first().click();
			await page
				.locator("[data-preview-device] img:visible")
				.first()
				.evaluate(
					(image: HTMLImageElement) =>
						image.complete && image.naturalWidth > 0
							? undefined
							: new Promise(resolve => image.addEventListener("load", resolve, { once: true })),
					undefined,
					{ timeout: 20_000 },
				);
		},
		ready: "[data-preview-device]:visible",
		when: () => false,
		parity: {
			session: "work",
			after: async page => {
				// The device's head row ends with its close button.
				const close = page.locator("[data-preview-device]:visible > div").first().getByRole("button").last();
				if (await close.isVisible().catch(() => false)) await close.click();
				await closePanelView(page);
			},
			available: () => process.env.OMP_GUI_TEST_PREVIEW_START === "1",
		},
		settle: 900,
	},
	{
		// A link tapped on the phone opens there; the toast after it offers the computer and the computer's Preview
		// (Orca's FM51). A computer's window opens a link in the system browser and has no such toast, so its views show
		// the reply with the link.
		id: "phone-link-toast",
		area: "B",
		title: "Phone link toast: Open on computer and Open in Preview",
		open: async (page, look) => {
			await showTurn(page, "fixture reply components");
			const link = page.locator('.markdown-body a[href="https://example.com/docs"]').first();
			await showInReply(page, link);
			if (!touchLook(look)) return;
			const opened = page
				.context()
				.waitForEvent("page", { timeout: 10_000 })
				.catch(() => undefined);
			await link.click();
			await (await opened)?.close();
			await page
				.getByRole("button", { name: say(look, "hostUi.link.inPreview"), exact: true })
				.first()
				.waitFor({ timeout: 10_000 });
		},
		// The audits' harness page is not a paired phone's (no host to offer); the parity sheet's phone is.
		when: () => false,
		parity: { session: "reply" },
		settle: 300,
	},
	{
		// The quick terminal (Orca's floating terminal): opened from the palette, its first shell's tab ready.
		id: "quick-terminal",
		area: "A",
		title: "Quick terminal",
		open: async (page, look) => {
			await clickCommandPalette(page, look);
			const palette = page.locator('[role="dialog"]:has([data-palette-index])');
			await palette.getByRole("combobox").fill("quick-terminal");
			await palette.locator('[data-command-name="quick-terminal"]').click();
		},
		ready: '[data-sheet-kind="quick-terminal"] [data-terminal-tab]',
		// The shell takes Escape (xterm keeps it), so the sheet closes by its own ✕.
		parity: {
			session: "work",
			after: async page => {
				const close = page.locator('[data-sheet-kind="quick-terminal"] button[aria-label="Close"]').first();
				if (await close.isVisible().catch(() => false)) await close.click();
			},
		},
		settle: 900,
	},
	...VIEW_SHEETS.map(
		(view): Surface => ({
			id: `sheet-${view}`,
			area: "A",
			title: `View sheet › ${view}`,
			open: async page => {
				await ui(page, "openViewSheet", view);
			},
			ready: `[data-view-sheet="${view}"]`,
			settle: 900,
		}),
	),
	{
		id: "panel-files-viewer",
		area: "A",
		title: "Files viewer on a changed file",
		open: async (page, look) => {
			await openSidebarFile(page, look);
		},
		ready: "[data-file-viewer-head]",
		parity: { session: "work", after: closePanelView },
		settle: 1200,
	},
	{
		id: "panel-notes",
		area: "A",
		title: "Changes › a review note on a diff line, in the notes shelf",
		open: async (page, look) => {
			await openPanelView(page, look, "diff");
			await page.locator("[data-scm-bar]:visible").first().waitFor({ timeout: 20_000 });
			await page
				.locator(".omp-changes-list:visible")
				.getByRole("button", { name: /^Sidebar\.tsx/ })
				.first()
				.click();
			await page.locator("[data-note-add]:visible").first().click();
			await page.locator("[data-note-editor] textarea:visible").first().fill("Keep the gap at 4.");
			await page
				.getByRole("button", { name: say(look, "reviewNotes.save"), exact: true })
				.first()
				.click();
			await page.locator("[data-notes-shelf]:visible button[aria-expanded='false']").first().click();
		},
		ready: "[data-notes-shelf] [data-notes-list] [data-review-note]",
		parity: { session: "work", after: clearNotesAndClose },
		// The harness page has no git checkout to note on: parity only.
		when: () => false,
		settle: 900,
	},
	{
		id: "panel-graph",
		area: "A",
		title: "Changes › Commits with All branches: graph lanes beside the rows",
		open: async (page, look) => {
			await openPanelView(page, look, "diff");
			await page.locator("[data-scm-bar]:visible").first().waitFor({ timeout: 20_000 });
			await page
				.getByRole("combobox", { name: say(look, "diffPanel.title"), exact: true })
				.first()
				.selectOption("commits");
			await page.locator("[data-history-branch]:visible").first().selectOption("--all");
		},
		ready: "[data-commit-history] [data-graph-lanes]",
		parity: { session: "work", after: closeCommitHistory },
		settle: 900,
	},
	{
		id: "panel-blame",
		area: "A",
		title: "Files viewer with Blame on: the commit that last changed each run of lines",
		open: async (page, look) => {
			await openSidebarFile(page, look);
			if (!(await page.locator("[data-code-view] [data-blame-line]").first().isVisible()))
				await page.locator("[data-blame-toggle]:visible").first().click();
		},
		ready: "[data-code-view] [data-blame-line]",
		parity: { session: "work", after: closeBlame },
		settle: 1200,
	},

	// ── Area B: Settings, centers, dialogs ────────────────────────────────────────────────────
	...SETTINGS_SECTIONS.filter(section => section !== "models").map(
		(section): Surface => ({
			id: `settings-${section}`,
			area: "B",
			title: `Settings › ${section}`,
			// General and Appearance open through real controls (the sidebar's Settings, then the section), so the parity sheet takes them.
			open:
				section === "general"
					? openSettingsGeneral
					: section === "appearance"
						? openSettingsAppearance
						: page => openSettings(page, section),
			ready: "[data-settings-page]",
			settle: 900,
			...(section === "general" || section === "appearance" ? { parity: { session: "work" } } : {}),
		}),
	),
	{
		id: "settings-models",
		area: "B",
		title: "Settings › Models & accounts, scrolled to the local engine switch under Custom endpoints",
		open: openSettingsModels,
		ready: "[data-settings-page] [data-local-engine-detect]",
		settle: 900,
		parity: { session: "work" },
	},
	{
		id: "settings-model-role-picker",
		area: "B",
		title: "Settings › Model roles with the Default role's picker open: mark and compact name per model",
		open: async (page, look) => {
			await openSettingsModels(page, look);
			const trigger = page.locator("[data-settings-page] #model-role-default [aria-haspopup='listbox']");
			await trigger.waitFor({ state: "visible", timeout: 30_000 });
			await trigger.scrollIntoViewIfNeeded();
			await trigger.click();
		},
		ready: "[role='listbox'] [role='option']",
		settle: 600,
		// Parity only: the audits measure the model picker through the composer's chip above.
		when: () => false,
		parity: { session: "work", after: closeOverlay },
	},
	...(["connection", "key"] as const).map(
		(step): Surface => ({
			id: `settings-claude-${step}`,
			area: "B",
			title: step === "key" ? "Claude API key entry" : "Choose a Claude subscription or an official API key",
			open: async (page, look) => {
				await openSettingsModels(page, look);
				await page.locator('[data-settings-page] [data-provider-add="anthropic"]').click();
				const key = page
					.getByRole("dialog")
					.getByRole("button", { name: say(look, "providers.featured.apiKey"), exact: true });
				if (step === "key") await key.click();
				else await key.waitFor();
			},
			ready: step === "key" ? '[data-claude-key] input[type="password"]' : "[data-claude-connect]",
			when: () => false,
			parity: {
				session: "work",
				after: closeOverlay,
				available: () => process.env.OMP_GUI_TEST_LOGIN === "1" && process.env.OMP_GUI_TEST_MODELS === "1",
			},
		}),
	),
	{
		id: "settings-reset-tickets",
		area: "B",
		title: "Settings › Models & accounts, the reset pass dialog of an account that holds two kinds of pass",
		open: async (page, look) => {
			await openSettingsModels(page, look);
			const ticket = page.locator("[data-settings-page] [data-reset-passes] button").first();
			await ticket.waitFor({ state: "visible", timeout: 30_000 });
			await ticket.scrollIntoViewIfNeeded();
			await ticket.click();
		},
		ready: "[role='dialog'] [data-reset-ticket]",
		settle: 600,
		// Parity only, and only over a host whose fake omp has such an account.
		when: () => false,
		parity: {
			session: "work",
			after: closeOverlay,
			available: () =>
				process.env.OMP_GUI_TEST_LOGIN === "1" &&
				process.env.OMP_GUI_TEST_MODELS === "1" &&
				process.env.OMP_GUI_TEST_RESET_TICKETS === "1",
		},
	},
	{
		id: "settings-credit-use",
		area: "B",
		title: "Settings › Models & accounts at the Credit use row: the switch, and the auto top-up line with its two links",
		open: async (page, look) => {
			await openSettingsModels(page, look);
			const row = page.locator("[data-settings-page] [data-credit-spend]");
			await row.waitFor({ state: "visible", timeout: 30_000 });
			await row.scrollIntoViewIfNeeded();
		},
		ready: "[data-settings-page] [data-credit-spend] [data-credit-top-up-link]",
		settle: 600,
		// Parity only, and only over a host with a signed-in subscription: the row stands under account rotation.
		when: () => false,
		parity: {
			session: "work",
			available: () => process.env.OMP_GUI_TEST_LOGIN === "1" && process.env.OMP_GUI_TEST_MODELS === "1",
		},
	},
	{
		id: "settings-disk-care",
		area: "B",
		title: "Settings › Updates & about, the Disk row after a cleanup with its breakdown open",
		open: openSettingsDiskCare,
		ready: "[role='tooltip']",
		settle: 600,
		// Parity only: the audits' harness page has no disk care to run.
		when: () => false,
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "mail-reentry-notice",
		area: "B",
		title: "The one notice above a session naming the email accounts that need their password again (the macOS keychain would ask)",
		open: openMailReentryNotice,
		ready: "[data-mail-reentry-notice]",
		settle: 600,
		// Parity only: the audits' harness page has no mail account in that state, and the notice would sit over every other surface.
		when: () => false,
		parity: { session: "work", after: unseedMailReentry },
	},
	{
		id: "settings-mail-reentry",
		area: "B",
		title: "Settings › Schedules › Email accounts, an account marked to enter its password again",
		open: openSettingsMailReentry,
		ready: "[data-settings-page] #settings-mail-accounts",
		settle: 600,
		when: () => false,
		parity: {
			session: "work",
			after: async page => {
				await unseedMailReentry(page);
				await closeOverlay(page);
			},
		},
	},
	{
		id: "settings-schedules",
		area: "B",
		title: "Settings › Schedules with a webhook routine open: URL and masked key, its actions and Recent calls",
		open: openSettingsSchedulesWebhook,
		ready: "[data-settings-page] [data-webhook-panel] [data-webhook-call]",
		settle: 600,
		// Parity only: the audits' harness page runs no schedules service.
		when: () => false,
		parity: { session: "work", after: page => deleteSchedule(page, "Parity webhook") },
	},
	{
		id: "schedule-runs",
		area: "B",
		title: "Settings › Schedules › All runs: one table of every run with its trigger, status, start, length and use",
		open: openScheduleRuns,
		ready: "[data-settings-page] [data-schedule-runs-table] [data-schedule-table-run]",
		settle: 600,
		when: () => false,
		parity: { session: "work", after: page => deleteSchedule(page, "Parity run") },
	},
	{
		id: "settings-updates-token-dropped",
		area: "B",
		title: "Settings › Updates & about, the GitHub token row saying the saved token was removed (the keychain would ask)",
		open: openSettingsUpdatesDropped,
		ready: "[data-settings-page] [data-updates-auth-dropped]",
		settle: 600,
		// The marker is in the parity launch's profile only (e2e/parity.e2e.ts).
		when: () => false,
		parity: { session: "work" },
	},
	{
		id: "settings-version-summaries",
		area: "B",
		title: "Settings › Updates & about with the changes for the installed release and the newer release",
		open: async (page, look, parityView) => {
			await openSettingsUpdates(page, look);
			const installed = page.locator("[data-about-brand] [data-version-summary='installed']");
			const available = page.locator("[data-settings-page] [data-version-summary='available']").first();
			const installedSentence = await installedSummary(look.lang);
			const rows: [Locator, string, string][] = [
				[installed, `v${installedVersion}`, installedSentence],
				[available, availableVersion, availableSummary[look.lang]],
			];
			if (parityView === "remote") {
				const host = page.locator("[data-host-desktop-version]");
				rows.push(
					[host.locator("[data-version-summary='host-installed']"), installedVersion, installedSentence],
					[host.locator("[data-version-summary='host-latest']"), availableVersion, availableSummary[look.lang]],
				);
			}
			for (const [summary, version, sentence] of rows) {
				await expect(summary).toHaveText(`· ${sentence}`, { timeout: 30_000 });
				await expect(summary.locator("..").getByText(version, { exact: true })).toBeVisible();
			}
			await page.locator("[data-about-brand]").evaluate(brand => brand.scrollIntoView({ block: "start" }));
			for (const [summary] of rows) await expect(summary).toBeInViewport({ ratio: 1 });
		},
		ready: "[data-settings-page] [data-version-summary='available']",
		when: () => false,
		parity: { session: "work" },
	},
	{
		id: "settings-omp-tested",
		area: "B",
		title: "Settings › Updates & about, the omp row (This computer's, or a paired host's) naming the omp its release was tested with",
		open: openSettingsOmpTested,
		// DOM order puts a paired host's row first, so the paired computer's view waits for the host's line.
		ready: "[data-settings-page] #setting-host-omp [data-testid='omp-tested'], [data-settings-page] [data-setup-item='omp'] [data-testid='omp-tested']",
		settle: 600,
		// Parity only, like settings-disk-care: the row reads the computer's machine setup from main.
		when: () => false,
		parity: { session: "work" },
	},
	{
		id: "settings-default-browser",
		area: "B",
		title: "Settings › Agent behavior, the automatic browser selection",
		open: async (page, look) => {
			await openSettingsAgent(page, look);
			await page.locator("#setting-gui-defaultBrowser").scrollIntoViewIfNeeded();
		},
		ready: "#setting-gui-defaultBrowser select:has(option[value='auto']:text('Automatic ·')):enabled",
		when: () => false,
		parity: { session: "work" },
	},
	{
		id: "settings-appearance",
		area: "B",
		title: "Settings › Appearance & input: the theme sets, the OMPdesk pair's near-monochrome previews and the fields",
		open: async (page, look) => {
			await openDrawer(page, look);
			await page.locator('[data-destination="settings"]').first().click();
			const nav = page.locator('[data-settings-section="appearance"]');
			await nav.waitFor({ state: "visible", timeout: 15_000 });
			await nav.click();
		},
		ready: "[data-settings-page] #setting-gui-theme",
		// Parity only: the audits reach Settings through the harness's own surfaces.
		when: () => false,
		parity: { session: "work" },
	},
	{
		id: "palette-option",
		area: "A",
		title: "Command palette from the sidebar's search button, its first command the active option (wash and ring)",
		open: async (page, look) => {
			await openDrawer(page, look);
			await page.locator("[data-command-center-entry]:visible").first().click();
		},
		ready: "[data-palette-index][data-active='true']",
		// Parity only: the audits open the palette through the harness (`dialog-command-palette`).
		when: () => false,
		parity: { session: "work", after: closeOverlay },
	},
	// Bots (orca-bots-ui): each view reads the bots of its own computer (a bot lives where its folder is), so `open`
	// first makes "Parity bot" there when it has none; the sections and their order are what must agree.
	{
		id: "sidebar-bots",
		area: "A",
		title: "The sidebar's Bots section: the header with its options and +, a bot's row with its second line",
		open: async (page, look) => {
			await ensureParityBot(page);
			await openDrawer(page, look);
			const toggle = page.locator("[data-sidebar-bots-toggle]:visible").first();
			if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
		},
		ready: "[data-sidebar-bots] [data-bot-row]",
		when: () => false,
		parity: { session: "work" },
	},
	{
		id: "bot-pane",
		area: "B",
		title: "The Bots page: the bots' list and a bot's page (header, Activity, Chats, Settings tabs)",
		open: async (page, look) => {
			await ensureParityBot(page);
			await openDrawer(page, look);
			await page.locator("[data-sidebar-bots-open]:visible").first().click();
			// A phone shows the list first: the bot's row opens its page.
			const row = page.locator("[data-bots-page-row]:visible").first();
			if ((await page.locator("[data-bot-pane]:visible").count()) === 0) await row.click();
			// The page keeps the tab it was last on (bot-items leaves it on Items).
			await page.locator('[data-bot-pane-tabs] [data-tab-id="activity"]:visible').first().click();
		},
		ready: "[data-bot-pane] [data-bot-activity]",
		settle: 600,
		when: () => false,
		parity: { session: "work" },
	},
	// The setup sheets need no home chat: a missing one shows as the dialog's warning banner.
	...(
		[
			["bot-connectors", "The bot page's Settings › Connectors: the empty row and its Add button", null, null],
			[
				"bot-connector-add",
				"Add to <bot>: the catalog of Slack, GitHub, Linear and Google",
				"add",
				"[data-connector-catalog]",
			],
			[
				"bot-connector-slack",
				"Connect Slack: Socket Mode or request URL, the manifest, credential import and who can ask",
				"slack",
				"[data-connector-setup='slack']",
			],
			[
				"bot-connector-github",
				"Connect GitHub: repository and who can ask",
				"github",
				"[data-connector-setup='github']",
			],
			[
				"bot-connector-linear",
				"Connect Linear: workspace and who can ask",
				"linear",
				"[data-connector-setup='linear']",
			],
			[
				"bot-connector-google",
				"Connect Google: the Google Cloud steps, the client file and Sign in with Google",
				"google",
				"[data-connector-setup='google']",
			],
		] as const
	).map(
		([id, title, step, ready]): Surface => ({
			id,
			area: "B",
			title,
			open: async (page, look) => {
				await ensureParityBot(page);
				await openDrawer(page, look);
				await page.locator('[data-sidebar-nav-row="bots"]:visible').first().click();
				if ((await page.locator("[data-bot-pane]:visible").count()) === 0)
					await page.locator("[data-bots-page-row]:visible").first().click();
				await page.locator('[data-bot-pane-tabs] [data-tab-id="settings"]:visible').first().click();
				const section = page.locator("[data-bot-connectors]:visible").first();
				await section.scrollIntoViewIfNeeded();
				if (step === null) return;
				await section.locator("[data-bot-connectors-add]").first().click();
				if (step !== "add") await page.locator(`[data-connector-pick="${step}"]:visible`).first().click();
			},
			ready: ready ?? "[data-bot-pane] [data-bot-connectors]",
			settle: 600,
			when: () => false,
			parity: { session: "work", ...(step === null ? {} : { after: closeOverlay }) },
		}),
	),
	{
		id: "bot-connector-offer",
		area: "A",
		title: "A bot offers a Slack connection in its chat; only its own computer manages credentials",
		open: async page => {
			await showTurn(page, "fixture connector offer");
			const card = page.locator(".omp-execution-group").last();
			const head = card.locator(".omp-execution-group-header").first();
			if ((await head.count()) > 0 && (await head.getAttribute("aria-expanded")) !== "true") await head.click();
			const step = card.locator(".omp-tool-card button[aria-expanded]").first();
			if ((await step.getAttribute("aria-expanded")) !== "true") await step.click();
			await page.locator("[data-connector-offer='slack']").scrollIntoViewIfNeeded();
		},
		ready: "[data-connector-offer='slack']",
		when: () => false,
		parity: { session: "connector", inView: "[data-connector-offer='slack']" },
	},
	{
		id: "bot-pane-offline",
		area: "B",
		title: "A paired computer's bot while that computer is away: greyed in the list with its owner offline, its page's notice",
		// parity.e2e.ts seeds both computers' last copy of PC-C's bots (`seedAwayHostBots`); PC-C never comes back.
		open: async (page, look) => {
			await openDrawer(page, look);
			await page.locator("[data-sidebar-bots-open]:visible").first().click();
			await page.locator(`[data-bots-page-row="${AWAY_HOST_BOT}"]:visible`).first().click();
			await page.locator('[data-bot-pane-tabs] [data-tab-id="items"]:visible').first().click();
		},
		ready: `[data-bot-pane="${AWAY_HOST_BOT}"] [data-bot-offline-banner]`,
		settle: 600,
		when: () => false,
		parity: { session: "work", after: closeParityItems },
	},
	{
		id: "bot-first-run-chat",
		area: "B",
		title: "The new bot's home chat before its owner has typed: a greeting and one question",
		open: async page => {
			await page.getByText("Hi! What should I start on?", { exact: true }).first().waitFor();
		},
		when: () => false,
		parity: { session: "firstRun", inView: '.markdown-body :text-is("Hi! What should I start on?")' },
	},
	{
		id: "bot-suggestions",
		area: "B",
		title: "A bot's Suggestions on its Activity: its looks' next steps with Start, Dismiss and Look now, apart from its items",
		open: async (page, look) => {
			await ensureParitySuggestions(page);
			await openDrawer(page, look);
			await page.locator("[data-sidebar-bots-open]:visible").first().click();
			if ((await page.locator("[data-bot-pane]:visible").count()) === 0)
				await page.locator("[data-bots-page-row]:visible").first().click();
			await page.locator('[data-bot-pane-tabs] [data-tab-id="activity"]:visible').first().click();
		},
		ready: "[data-bot-pane] [data-bot-suggestions] [data-bot-suggestion]",
		settle: 600,
		when: () => false,
		parity: { session: "work" },
	},
	{
		id: "bot-items",
		area: "B",
		title: "A bot's Items tab: the filter, its items in groups (Working, Planned) with their rows",
		open: openParityItems,
		ready: "[data-bot-pane] [data-bot-items] [data-bot-item]",
		settle: 600,
		when: () => false,
		parity: { session: "work", after: closeParityItems },
	},
	{
		id: "bot-item",
		area: "B",
		title: "A bot's item page: back and step, status and links, its description, Done means, activity and the comment box",
		open: async (page, look) => {
			await openParityItems(page, look);
			await page.locator("[data-bot-item-open]:visible").first().click();
		},
		ready: "[data-bot-item-page] [data-bot-item-activity]",
		settle: 600,
		when: () => false,
		parity: { session: "work", after: closeParityItems },
	},
	{
		id: "bot-room",
		area: "B",
		title: "A bot group's room: its faces and menu, the Room and Items tabs, the posts and the post box",
		open: async (page, look) => {
			await ensureParityBot(page);
			await page.evaluate(async () => {
				const state = await window.omp.bots.command({ action: "get" });
				if ((state.rooms ?? []).length === 0 && state.bots[0])
					await window.omp.bots.command({ action: "roomCreate", name: "Parity group", bots: [state.bots[0].id] });
			});
			await openDrawer(page, look);
			await page.locator("[data-sidebar-bots-open]:visible").first().click();
			await page.locator("[data-bots-page-room]:visible").first().click();
		},
		ready: "[data-bot-room] [data-bot-room-box]",
		settle: 600,
		when: () => false,
		parity: { session: "work" },
	},
	{
		id: "bot-routed-ask",
		area: "A",
		title: "The bot receives the badge question from its worker",
		open: async page => {
			await page
				.locator("[data-agent-mail='question']")
				.filter({ hasText: "Which color should the badge be?" })
				.waitFor();
		},
		ready: "[data-agent-mail='question']",
		when: () => false,
		parity: { session: "routing-bot" },
	},
	{
		id: "bot-owner-dock-empty",
		area: "A",
		title: "The worker waits for its bot without asking the owner",
		open: async page => {
			await page.getByText("Choose the badge color fixture:bot-form", { exact: false }).last().waitFor();
			if (await page.locator("[data-prompt-card]").count()) throw new Error("The routed form reached the owner");
		},
		when: () => false,
		parity: { session: "routing-worker" },
	},
	{
		id: "bot-cards",
		area: "A",
		title: "Bot cards in a chat: a new bot offer with Create bot, an ask to a bot and a tool a bot added with Sign in and Remove; both bots wear their face at rest",
		// The host's fake omp answers "fixture bot cards" with the three calls ended (e2e/fixture/rpc-ui.ts).
		open: async page => {
			await ensureParityBot(page);
			await promptShownTab(page, "fixture bot cards");
			// The offer's new bot and the asked bot wear BotFace (no picture), drawn at rest: a test run's `botFaces` is "rest".
			for (const card of ["botOffers", "botRequests"])
				await page
					.locator(`[data-bot-card='${card}'] [data-bot-face] [data-face-part='body']`)
					.first()
					.waitFor({ state: "attached", timeout: 15_000 });
		},
		ready: "[data-bot-card='toolsAdded']",
		settle: 600,
		when: () => false,
		parity: { session: "work" },
	},
	{
		id: "settings-bots",
		area: "B",
		title: "Settings › Bots: the sidebar switch and this computer's bots",
		open: async (page, look) => {
			await ensureParityBot(page);
			await openDrawer(page, look);
			await page.locator('[data-destination="settings"]').first().click();
			const nav = page.locator('[data-settings-section="bots"]');
			await nav.waitFor({ state: "visible", timeout: 15_000 });
			await nav.click();
		},
		ready: "[data-settings-page] [data-settings-bots]",
		when: () => false,
		parity: { session: "work" },
	},
	{
		id: "bot-new",
		area: "B",
		title: "New bot from Settings › Bots: name, purpose, picture, model, where it runs and Create",
		open: async (page, look) => {
			await ensureParityBot(page);
			await openDrawer(page, look);
			await page.locator('[data-destination="settings"]').first().click();
			const nav = page.locator('[data-settings-section="bots"]');
			await nav.waitFor({ state: "visible", timeout: 15_000 });
			await nav.click();
			await page.locator("[data-settings-page] [data-settings-bots-new]:visible").first().click();
		},
		ready: "[data-new-bot]",
		settle: 600,
		when: () => false,
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "schedule-new",
		area: "B",
		title: "The automation editor: Settings › Schedules › New schedule, its prompt, folder, when and options",
		open: async (page, look) => {
			await openSettingsSchedules(page, look);
			await page.locator("[data-settings-page] [data-schedule-new]:visible").first().click();
		},
		ready: "[data-schedule-form]",
		settle: 600,
		when: () => false,
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "board-all",
		area: "B",
		title: "All sessions: the sidebar's All sessions row opens the board of every session in four lanes",
		open: async (page, look) => {
			await openDrawer(page, look);
			await page.locator('[data-sidebar-nav-row="board"]:visible').first().click();
		},
		ready: "[data-board-lanes] [data-board-lane='idle']",
		// Parity only: the board reads a computer's session lists, which the audits' harness page does not run.
		when: () => false,
		// Esc on a page goes back to the session, so the next surface starts on it.
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "settings-computer-use",
		area: "B",
		title: "Settings › Agent behavior, scrolled to Computer use engine and the macOS permission rows under it",
		open: openSettingsComputerUse,
		ready: "[data-settings-page] [data-mac-permission]",
		settle: 900,
		// The rows read the computer's macOS permissions from main: the audits' harness page has no such computer, and a
		// host that is no Mac has no such rows (the order check failed on them on Windows, 12 Nov 2026).
		when: () => false,
		parity: { session: "work", available: () => process.platform === "darwin" },
	},
	// Settings › Memory: every tab, and the list → detail states of Pages, Handoffs and Sessions.
	...(["overview", "search", "pages", "handoffs", "sessions", "profile", "maintenance"] as const).map(
		(tab): Surface => ({
			id: `settings-memory-${tab}`,
			area: "B",
			title: `Settings › Memory › ${tab}`,
			open: async page => {
				await openSettings(page, `memory:${tab}`);
				if (tab === "search") {
					const box = page.locator("[data-memory-search] input[type=search], [data-memory-search] input").first();
					await box.fill("sqlite");
					await box.press("Enter");
					await page.locator("[data-memory-hit]").first().waitFor({ timeout: 10_000 });
				}
				if (tab === "maintenance") {
					await page.locator("[data-memory-lint-run]").click();
					await page.locator("[data-memory-sweep-preview]").click();
					await page.locator("[data-memory-sweep-result]").waitFor({ timeout: 10_000 });
				}
			},
			ready: "[data-settings-page] [data-memory-tab]",
			settle: 900,
		}),
	),
	...(
		[
			["pages", "[data-memory-page]", "[data-memory-reader]"],
			["handoffs", "[data-memory-handoff]", "[data-memory-handoff-detail]"],
			["sessions", "[data-memory-session]", "[data-memory-observations]"],
		] as const
	).map(
		([tab, row, detail]): Surface => ({
			id: `settings-memory-${tab}-detail`,
			area: "B",
			title: `Settings › Memory › ${tab}, one open (a phone shows the detail alone)`,
			open: async page => {
				await openSettings(page, `memory:${tab}`);
				await page.locator(row).first().click();
				await page.locator(detail).first().waitFor({ timeout: 10_000 });
			},
			ready: "[data-settings-page] [data-memory-tab]",
			settle: 900,
		}),
	),
	{
		id: "settings-device-switch",
		area: "B",
		title: "Settings with the device pills on top: this device and the paired computer, the shown one highlighted",
		open: openSettingsGeneral,
		ready: "[data-settings-device-switch]",
		settle: 900,
		// Parity only: the audits' harness page pairs no computer, so it draws no pills.
		when: () => false,
		parity: { session: "work", pairedBack: true },
	},
	{
		id: "settings-list",
		area: "B",
		title: "Settings section list (a phone's first page)",
		open: async (page, look) => {
			// The harness opens it through its store; a real window or page through the sidebar's Settings entry.
			if (await page.evaluate(() => Boolean(window.__stores))) await ui(page, "openSettings");
			else {
				await openDrawer(page, look);
				await page.locator('[data-destination="settings"]').first().click();
			}
		},
		ready: "[data-settings-page]",
		parity: { session: "work" },
	},
	{
		id: "settings-connections-pwa",
		area: "B",
		title: "Settings › Devices & connections with the installed-app notification row",
		query: "&pwa=push",
		open: async page => {
			await openSettings(page, "connections");
			await page.locator("[data-settings-page] [data-web-push-state]").first().scrollIntoViewIfNeeded();
		},
		ready: "[data-settings-page] [data-web-push-state]",
		settle: 900,
	},
	...(["live", "definitions", "prs", "github"] as const).map(
		(tab): Surface => ({
			id: `agents-${tab}`,
			area: "B",
			title: `Agents › ${tab}`,
			// Live, Pull requests and GitHub open through the palette and their tab (real controls), so the parity sheet
			// takes them.
			open:
				tab === "definitions"
					? page => ui(page, "openAgents", tab)
					: async page => {
							await openPageTab(page, "agents", tab);
							// The source bar keeps the last source a person chose; a source surface may have run first.
							if (tab === "github") await page.locator('[data-work-source="github"]').click();
						},
			settle: 900,
			...(tab === "definitions" ? {} : { parity: { session: "work" as const } }),
		}),
	),
	// Agents › GitHub's work-source bar: GitLab without glab (its install card), Linear and Jira with no account yet
	// (their connect cards); each is the surface a person meets first.
	...(["gitlab", "linear", "jira"] as const).map(
		(source): Surface => ({
			id: `agents-source-${source}`,
			area: "B",
			title: `Agents › GitHub › the ${source} source (its first card)`,
			open: async page => {
				await openPageTab(page, "agents", "github");
				await page.locator(`[data-work-source="${source}"]`).click();
			},
			ready: `[data-work-sources="${source}"]`,
			settle: 1200,
			parity: { session: "work" },
		}),
	),
	{
		id: "agents-github-projects",
		area: "B",
		title: "Agents › GitHub › Projects (the account's projects)",
		open: async page => {
			await openPageTab(page, "agents", "github");
			await page.locator('[data-work-source="github"]').click();
			await page.locator('[data-github-center] [role="tab"][data-tab-id="projects"]').click();
		},
		ready: "[data-project-list]",
		settle: 1200,
		parity: { session: "work" },
	},
	{
		id: "agents-pr-detail",
		area: "B",
		title: "Agents › Pull requests › a PR's detail (state, people, checks, files, review threads)",
		// The list's first row, clicked as a person does (MasterDetail's list is the `nav`).
		open: async page => {
			await openPageTab(page, "agents", "prs");
			await page.locator('section[data-destination="agents"] nav > ul > li button').first().click();
		},
		ready: "[data-pr-detail]",
		settle: 1200,
		parity: { session: "work" },
	},
	{
		id: "agents-issue-detail",
		area: "B",
		title: "Agents › GitHub › an issue's detail, its Start a task button first",
		open: openIssueDetail,
		ready: "[data-github-issue] [data-github-issue-start]",
		settle: 900,
		// Parity only: the issue comes from B's `gh`, which the harness page has not.
		when: () => false,
		parity: { session: "work" },
	},
	{
		id: "agents-issue-start",
		area: "B",
		title: "The new task sheet an issue's Start a task opens: its branch name and prompt filled from the issue",
		open: async page => {
			await openIssueDetail(page);
			await page.locator("[data-github-issue-start]").click();
		},
		ready: "[role=dialog] [data-new-task-sheet] [data-new-task-project]",
		settle: 700,
		when: () => false,
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "stats",
		area: "B",
		title: "Insights › Stats (this session)",
		open: page => openPageTab(page, "stats", "session"),
		settle: 900,
		parity: { session: "work" },
	},
	{
		id: "stats-all",
		area: "B",
		title: "Insights › Stats (all sessions)",
		open: page => openPageTab(page, "stats", null),
		settle: 1200,
		parity: { session: "work" },
	},
	{
		id: "usage",
		area: "B",
		title: "Insights › Usage",
		open: page => openPageTab(page, "stats", "usage"),
		settle: 900,
		parity: { session: "work" },
	},
	{
		id: "autopilot-start",
		area: "B",
		title: "Mode popover › Autopilot (start sheet)",
		open: page => ui(page, "openModes", "autopilot"),
	},
	{
		id: "autopilot-board",
		area: "B",
		title: "Work board › an Autopilot run (docked, or the strip expanded)",
		open: async page => {
			await page.evaluate(() => {
				const now = Date.now();
				const store = window.__stores?.autopilot?.getState() as { apply: (status: unknown) => void } | undefined;
				store?.apply({
					active: true,
					state: "running",
					cycle: 3,
					branch: "autopilot/2026-10-21",
					baseBranch: "main",
					now: {
						n: 3,
						area: "performance",
						title: "Cache the session list's first read",
						startedAt: now - 60_000,
					},
					activeMs: 1_800_000,
					cycles: [1, 2].map(n => ({
						n,
						area: n === 1 ? "bugs" : "docs",
						title: n === 1 ? "Fix the stale draft after a tab switch" : "Explain the release cadence",
						summary: "",
						verify: n === 1 ? "green" : "red",
						commit: n === 1 ? "1a9f1c2deadbeef" : undefined,
						followups: [],
						children: [],
						startedAt: now - (4 - n) * 600_000,
						durationMs: 252_000,
						tokens: 212_000,
						usd: 0.42,
						compactions: 0,
					})),
					redStreak: 2,
					followups: ["Retry the flaky resize test once the drawer settles", "Keyboard access in settings"],
					totals: { tokens: 424_000, usd: 0.84 },
					ship: {
						policy: {
							autoPush: false,
							autoRelease: { on: false, cadence: { kind: "agent" } },
							remote: "origin",
							land: true,
						},
						queue: [],
					},
				});
			});
			await ui(page, "revealWorkBoard", null);
		},
		settle: 900,
	},
	...DIALOG_FLAGS.map(
		(dialog): Surface => ({
			id: dialog.id,
			area: "B",
			title: dialog.title,
			open: (page, look) =>
				dialog.id === "dialog-command-palette"
					? clickCommandPalette(page, look)
					: dialog.id === "dialog-workspace"
						? openWorkspaceDialog(page, look)
						: dialog.id === "dialog-model-setup"
							? openModelSetup(page, look)
							: dialog.id === "dialog-worktree"
								? openNewTaskSheet(page, look)
								: dialog.id === "dialog-feedback"
									? openHelpItem(page, look, "Send feedback")
									: dialog.id === "dialog-changelog"
										? openHelpItem(page, look, say(look, "help.whatsNew")).then(() => changelogAtTop(page))
										: dialog.id === "dialog-whats-new"
											? // The card's See details: the one control that opens a version's notes.
												showWhatsNewCard(page).then(() =>
													page.locator("[data-whats-new-details]").first().click(),
												)
											: ui(page, dialog.action, ...(dialog.args ?? [])),
			...(dialog.id === "dialog-command-palette"
				? { ready: "[role=dialog] [role=listbox]", parity: { session: "work" as const } }
				: dialog.id === "dialog-workspace"
					? {
							ready: "[role=dialog] [role=listbox]",
							parity: { session: "work" as const, after: closeOverlay },
						}
					: dialog.id === "dialog-model-setup"
						? {
								// Ready at the research model selector beside "Find more evidence".
								ready: "[role=dialog] [data-model-setup-evidence] [aria-haspopup=listbox]",
								parity: { session: "work" as const, after: closeOverlay },
							}
						: dialog.id === "dialog-worktree"
							? {
									// The new task sheet over the work session's project, opened from the palette's command.
									ready: "[role=dialog] [data-new-task-sheet] [data-new-task-project]",
									parity: { session: "work" as const, after: closeOverlay },
								}
							: dialog.id === "dialog-feedback"
								? {
										// Opened from the Help menu; ready with its picture field (Orca FB5).
										ready: "[role=dialog] [data-feedback-picture]",
										parity: { session: "work" as const, after: closeOverlay },
									}
								: dialog.id === "dialog-changelog" || dialog.id === "dialog-whats-new"
									? {
											// Help › What's new opens every release; the update card's See details this version's notes.
											ready: "[role=dialog] [data-changelog-notes]",
											parity: { session: "work" as const, after: closeOverlay },
										}
									: {}),
			settle: 700,
		}),
	),
	{
		id: "capabilities-sheet",
		area: "B",
		title: "Help › What OMPdesk can do: what the app adds, each with Open or Show me",
		open: (page, look) => openHelpItem(page, look, "What OMPdesk can do"),
		ready: "[data-capabilities] [data-capability='board']",
		settle: 700,
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "toasts",
		area: "B",
		title: "Toast stack: every variant, one with an action and one long message",
		open: async page => {
			await page.evaluate(() => {
				const toast = window.__stores?.toast?.getState() as { push(input: unknown): void } | undefined;
				const long =
					"A long message that runs well past one line on a phone, with /Users/dev/projects/ompdesk/src/renderer/components/layout/sidebar/Sidebar.tsx in it";
				toast?.push({
					variant: "info",
					title: "Info",
					message: "Copied the link",
					durationMs: Number.POSITIVE_INFINITY,
				});
				toast?.push({ variant: "success", message: long, durationMs: Number.POSITIVE_INFINITY });
				toast?.push({
					variant: "warning",
					title: "Warning",
					message: long,
					action: { label: "Undo", run: () => {} },
					durationMs: Number.POSITIVE_INFINITY,
				});
				toast?.push({
					variant: "error",
					title: "Error",
					message: long,
					detail: `Error: ${long}`,
					durationMs: Number.POSITIVE_INFINITY,
				});
			});
		},
		settle: 600,
	},
	{
		id: "composer-run-settings",
		area: "A",
		title: "Run settings (mode, thinking, approval, delegation): a popover, a bottom sheet on a phone",
		open: page => page.locator("[data-run-settings-trigger]").first().click(),
		ready: '[data-tab-id="goal"]',
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "composer-context-usage",
		area: "A",
		title: "Context usage: a popover, a bottom sheet on a phone",
		open: page => page.locator(".omp-context-usage-trigger").first().click(),
		parity: { session: "work" },
	},
	{
		id: "composer-attach-menu",
		area: "A",
		title: "Attach and more menu (the composer's +)",
		open: page =>
			page
				.locator(".omp-composer-toolbar > button, .omp-composer-toolbar > .omp-composer-scroll > button")
				.first()
				.click(),
	},
	{
		id: "sidebar-row-menu",
		area: "A",
		title: "A session row's action menu",
		open: openRowMenu,
		ready: "[role='menu'] [role='menuitem']",
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "sidebar-row-swipe",
		area: "A",
		title: "A stored session's row swiped left on a phone, open on Archive (a window shows the row: no swipe there)",
		open: swipeStoredRow,
		ready: ".omp-sidebar-session-row[data-pickable]:has-text('Parity stored 1')",
		// Parity only: the harness page lists no stored session of its own.
		when: () => false,
		parity: { session: "work", storedRows: true },
	},
	{
		id: "sidebar-multi-select",
		area: "A",
		title: "Stored rows picked with ⌘/Ctrl-click and Shift-click, and the menu for every picked row",
		open: pickStoredRows,
		ready: "[role='menu'] [role='menuitem']",
		when: () => false,
		parity: { session: "work", storedRows: true, after: clearPicks },
	},
	{
		id: "sidebar-new-task-row",
		area: "A",
		title: "A new task's sidebar row after its worktree's create failed: the reason, Retry and Close",
		open: failNewTask,
		ready: "[data-new-task][data-new-task-state='failed']",
		// Parity only: the harness page has no repository to cut a worktree from.
		when: () => false,
		parity: { session: "work", after: dismissNewTasks },
	},
	{
		id: "sidebar-session-menu",
		area: "A",
		title: "The shown session's row menu: Move to <computer> on this computer's rows while a paired computer is connected",
		open: openRowMenu,
		ready: "[role='menu'] [role='menuitem']",
		// Parity only: B also uses A, so B's own rows (its window, its phone) offer Move to PC-A; A's view of B's row is
		// a host's, which has no such item. The audits' harness page pairs no computer.
		when: () => false,
		parity: { session: "work", pairedBack: true, after: closeOverlay },
	},
	{
		id: "sidebar-project-menu",
		area: "A",
		title: "A project header's action menu: its one Delete last",
		open: openProjectMenu,
		ready: "[role='menu'] [role='menuitem']",
		// The shown session's project, in this computer's list or the paired computer's section for the host: the parity
		// sheet's views all show a session of the host's project; the audits' harness page has no such session.
		when: () => false,
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "sidebar-project-delete",
		area: "A",
		title: "A project's Delete confirm: its opt-in box to also delete the saved sessions, off as it opens",
		open: async (page, look) => {
			await openProjectMenu(page, look);
			await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
		},
		ready: "[role='dialog']",
		when: () => false,
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "card-ask",
		area: "A",
		title: "Ask card: a question with options, a multi-select and a recommendation",
		open: page =>
			request(page, {
				id: "audit-ask",
				method: "ask",
				questions: [
					{
						id: "q1",
						header: "Where should the fix go?",
						question:
							"The flaky row can be fixed in the test, in the component, or in both places. Which do you prefer?",
						options: [
							{
								label: "In the test only",
								description: "Wait for the row before asserting; no product change.",
							},
							{ label: "In the component", description: "Paint the rows synchronously on mount." },
							{ label: "Both", description: "Belt and braces, at the cost of a larger diff." },
						],
						recommended: 0,
					},
					{
						id: "q2",
						question: "Which checks should run afterwards?",
						multi: true,
						options: [{ label: "Unit tests" }, { label: "Type check" }, { label: "Biome" }],
					},
				],
			}),
	},
	{
		id: "card-ask-pictures",
		area: "A",
		title: "Ask card of an ask form with pictures: the drafts side by side above the question, before anything is picked",
		// The host's fake omp asks it (e2e/fixture/rpc-ui.ts "fixture ask pictures"), as the bridge's ask form sends a
		// form of pictures; Escape answers it, which ends that turn.
		open: async page => {
			const tab = await shownTab(page);
			if (!tab) throw new Error("the view shows no session to ask in");
			await page.evaluate(
				tabId => window.omp.rpc.commandForTab(tabId, { type: "prompt", message: "fixture ask pictures" }),
				tab.tabId,
			);
		},
		ready: "[data-ask-context] [data-figure-row] figure:nth-child(3) img",
		when: () => false,
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "todo-behind",
		area: "A",
		title: "Instructions since a todo list last changed: the plan zone, the strip or the dock's todo card counts them first and says when the list last changed",
		// The host's fake omp lists three items and reports the bridge's reading (e2e/fixture/rpc-ui.ts "fixture todo
		// behind", as resources/gui-bridge/todo-drift.ts pushes it): changed 12 minutes ago, two instructions since.
		open: page => promptShownTab(page, "fixture todo behind"),
		ready: "[data-todo-freshness='received']",
		when: () => false,
		parity: {
			session: "work",
			after: async page => {
				await promptShownTab(page, "fixture todo clear");
				await page.locator("[data-todo-freshness]").first().waitFor({ state: "detached", timeout: 15_000 });
			},
		},
	},
	{
		id: "composer-queue",
		area: "A",
		title: "Queue popover with a steer and a follow-up waiting behind a running turn: lane headings in the agent's real delivery modes and the policy line",
		// The host's fake omp runs `fixture running` until stopped. The prompt and the steer are typed and sent with Send,
		// as a person does; a follow-up has no chord on a phone, so it goes through the view's own rpc, as the
		// composer's follow-up mode sends it.
		open: async page => {
			const tab = await shownTab(page);
			if (!tab) throw new Error("the view shows no session to queue in");
			const input = page.locator("[data-composer-input]").first();
			const send = page.getByRole("button", { name: "Send", exact: true }).first();
			const type = async (text: string) => {
				await input.fill(text);
				await send.click({ timeout: 15_000 });
				await page.waitForFunction(
					field => (document.querySelector(field) as HTMLTextAreaElement | null)?.value === "",
					"[data-composer-input]",
					{ timeout: 15_000 },
				);
			};
			await type("fixture running");
			await page
				.locator(".omp-composer-toolbar[data-turn-running]")
				.first()
				.waitFor({ state: "visible", timeout: 30_000 });
			await type("Check the failing test first");
			const queued = await page.evaluate(([tabId, body]) => window.omp.rpc.commandForTab(tabId, body), [
				tab.tabId,
				{ type: "follow_up", message: "Then write the release note" } satisfies RpcCommand,
			] as const);
			if (!queued.success) throw new Error(`the follow-up was refused: ${queued.error}`);
			const pill = page.locator("[data-queue-pill]").first();
			await pill.filter({ hasText: "2" }).waitFor({ state: "visible", timeout: 15_000 });
			await pill.click();
		},
		ready: "[data-queue-policy]",
		when: () => false,
		parity: { session: "work", after: endQueuedTurn },
	},
	{
		id: "turn-compacting",
		area: "A",
		title: "Status row of a running compaction: what happens to the conversation in plain words, the time it has run and its (i)",
		// The host's fake omp starts a `fixture flow` turn and holds its mid-turn compaction open (`compact-start`), as
		// stock's automatic one runs; ready once the row counts its first second.
		open: async page => {
			const tab = await shownTab(page);
			if (!tab) throw new Error("the view shows no session to compact");
			await page.evaluate(
				tabId => window.omp.rpc.commandForTab(tabId, { type: "prompt", message: "fixture flow" }),
				tab.tabId,
			);
			const started = await flowOp(page, tab.tabId, { op: "compact-start" });
			if (!started.success) throw new Error(`the compaction did not start: ${started.error}`);
		},
		ready: "[data-compaction-status] [data-compaction-elapsed]",
		// The audits' harness page has no such turn.
		when: () => false,
		parity: { session: "work", after: endCompactingTurn, inView: "[data-compaction-status]" },
	},
	{
		id: "turn-limit-wait",
		area: "A",
		title: "Error card of a turn a provider's limit ended: when main tries it again by itself, with Retry now and Cancel",
		// The host's fake omp ended the session's turn at a limit (e2e/fixture/rpc-ui.ts "fixture rate limit") and the
		// host's resume rules wait for it (e2e/parity.e2e.ts `limitSession`): every view only shows that session.
		open: async page => {
			await page.waitForSelector("[data-transcript-kind]", { timeout: 15_000 });
		},
		ready: ".omp-message-error [data-limit-wait]",
		// The wait is main's: the audits' harness page has no resume rules behind it.
		when: () => false,
		parity: { session: "limit", inView: "[data-limit-wait]" },
	},
	{
		id: "turn-cut-off",
		area: "A",
		title: "Status row of a turn whose omp kept dying: why it did not go on by itself, with Continue and Dismiss",
		// The host's fake omp died under four turns of the session in a row (e2e/fixture/rpc-ui.ts "fixture crash"); the
		// host's resume rules continued three and offer the fourth (e2e/parity.e2e.ts `cutSession`). Nothing is pressed.
		open: async page => {
			await page.waitForSelector("[data-transcript-kind]", { timeout: 15_000 });
		},
		ready: '[data-cut-off="crash-loop"]',
		// The offer is main's: the audits' harness page has no resume rules behind it.
		when: () => false,
		parity: { session: "cut", inView: "[data-cut-off]" },
	},
	{
		id: "card-approval",
		area: "A",
		title: "Tool approval card with a long command, docked above the composer (an Autopilot run's card once its approver's 3 s have passed)",
		open: page =>
			request(page, {
				id: "audit-approval",
				method: "select",
				title: "Allow tool: bash\nbunx vitest run src/renderer/components/layout/sidebar src/renderer/components/layout/composer --repeat 10 --reporter=verbose",
				options: ["Approve", "Deny"],
			}),
		ready: ".omp-ask-dock [data-prompt-card]",
	},
	{
		id: "card-input",
		area: "A",
		title: "Input and confirm cards",
		open: async page => {
			await request(page, {
				id: "audit-input",
				method: "input",
				title: "What should the branch be called?",
				placeholder: "feature/short-name",
			});
			await request(page, {
				id: "audit-confirm",
				method: "confirm",
				title: "Overwrite the file?",
				message: "src/renderer/components/layout/sidebar/Sidebar.tsx already exists.",
			});
		},
	},
	{
		id: "dialog-schedule-new",
		area: "B",
		title: "Settings › Schedules › New schedule dialog",
		open: async page => {
			await openSettings(page, "schedules");
			await page.locator("[data-schedule-new]").first().click();
		},
		settle: 700,
	},
	{
		id: "settings-mobile-web-devices",
		area: "B",
		title: "Settings › Connections scrolled to Mobile web's devices and the device's push row",
		query: "&pwa=push",
		open: async page => {
			await openSettings(page, "connections");
			await page.locator("[data-web-device-section]").first().scrollIntoViewIfNeeded();
		},
		settle: 700,
	},
	{
		id: "card-whats-new",
		area: "B",
		title: "What's new card under the title bar after an update",
		open: showWhatsNewCard,
		ready: "[data-whats-new-card]",
		parity: { session: "work", after: dismissWhatsNewCard },
	},
	{
		id: "banner-update-error",
		area: "B",
		title: "Update banner: the updater failed",
		open: page =>
			updater(page, {
				state: "error",
				message: "Could not reach the update server. Check the connection and try again.",
				detail: "getaddrinfo ENOTFOUND github.com",
			}),
	},
	{
		id: "banner-update-ready",
		area: "B",
		title: "Update banner: an update is downloaded",
		open: page => updater(page, { state: "downloaded", version: "0.37.0", mode: "relaunch" }),
	},
	{
		id: "host-path-actions",
		area: "B",
		title: "Host sheet: a file the agent named (open / reveal / download)",
		query: "&host=1",
		when: webPage,
		open: page =>
			hostPrompt(page, {
				kind: "openPath",
				path: "/Users/dev/projects/ompdesk/src/renderer/components/layout/sidebar/Sidebar.tsx",
			}),
		ready: '[data-host-sheet="openPath"]',
	},
	{
		id: "host-browser-folder",
		area: "B",
		title: "Host sheet: the computer's folder browser",
		query: "&host=1",
		when: webPage,
		open: page =>
			hostPrompt(page, {
				kind: "browse",
				mode: "folder",
				title: "Open a project folder",
				defaultPath: "/Users/dev/projects",
			}),
		settle: 700,
	},
	{
		id: "host-browser-file",
		area: "B",
		title: "Host sheet: the computer's file browser",
		query: "&host=1",
		when: webPage,
		open: page =>
			hostPrompt(page, { kind: "browse", mode: "file", title: "Attach a file", defaultPath: "/Users/dev/projects" }),
		settle: 700,
	},
	{
		id: "host-editor",
		area: "B",
		title: "Host sheet: edit on the computer",
		query: "&host=1",
		when: webPage,
		open: page =>
			hostPrompt(page, {
				kind: "editor",
				content: "A long line of text to edit on the computer, past the width of a phone screen.\nSecond line.",
			}),
	},
	{
		id: "host-save-image",
		area: "B",
		title: "Host sheet: save an image (phone or computer)",
		query: "&host=1",
		when: webPage,
		open: page =>
			hostPrompt(page, { kind: "saveImage", name: "diagram.png", mime: "image/png", base64: "iVBORw0KGgo=" }),
	},
	{
		id: "host-models-config",
		area: "B",
		title: "Host sheet: the agent's models file",
		query: "&host=1",
		when: webPage,
		open: page => hostPrompt(page, { kind: "models" }),
		settle: 700,
	},
	{
		id: "host-quit",
		area: "B",
		title: "Host sheet: quit confirmation",
		query: "&host=1",
		when: webPage,
		open: page => hostPrompt(page, { kind: "quit" }),
	},
	{
		id: "host-update",
		area: "B",
		title: "Host sheet: update confirmation",
		query: "&host=1",
		when: webPage,
		open: page => hostPrompt(page, { kind: "update" }),
	},
	// No sheet for `prompt`: a browser that offers its own install prompt gets that prompt (install-ui.ts), the sheet
	// only lists the menu steps of one that does not. Those browsers are a phone's or a tablet's.
	...(["ios-share", "samsung-menu", "firefox-menu"] as const).map(
		(guidance): Surface => ({
			id: `host-install-${guidance}`,
			area: "B",
			title: `PWA install sheet (${guidance})`,
			query: "&host=1",
			when: touchLook,
			open: page => hostPrompt(page, { kind: "install", guidance }),
			ready: `[data-install-steps="${guidance}"]`,
		}),
	),
];

export function surfacesFor(filter: { area?: string; only?: RegExp }): Surface[] {
	return SURFACES.filter(
		surface => (!filter.area || surface.area === filter.area) && (!filter.only || filter.only.test(surface.id)),
	);
}

export { isPhone };
