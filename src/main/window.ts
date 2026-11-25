/**
 * Multi-window management for ompdesk: the record of each app window that the tabs, menus and entry points read.
 * The window itself is the shell's (`tauri-shell/src/app_window.rs`): where it opens and its saved geometry, its
 * chrome and Mica backdrop, its slot, how it first shows, its run progress, what closing the last one does
 * (`last_close.rs`) and what happens when its page crashes or stops answering. Main answers the shell's questions about
 * that last part here (`serveWindows`): the runtime log line with the window's cwd, and the text of the notice and the
 * two restart dialogs, in the app's language.
 */

import { join } from "node:path";
import { BrowserWindow, Menu, Notification, shell } from "electron";
import type { SessionKind } from "../shared/ipc-types";
import { approveQuit, logQuitAsked, quitRisk } from "./app-quit";
import { diskFull } from "./disk-full";
import { editableContextMenuTemplate } from "./editable-context-menu";
import { editLabels, getMainLanguage, mainT } from "./i18n";
import { runtimeLogPath, writeRuntimeLog } from "./runtime-log";
import { serveWindows, type WindowNotice } from "./shell-host/electron/index";
import type { WindowPresence } from "./update-log-core";
import type { ClientWindow } from "./web/client-window";

export interface WindowRecord {
	win: BrowserWindow;
	/** Stable id for routing/logging; equals win.webContents.id. */
	id: number;
	cwd: string;
}

/**
 * Spawn a window with its own sidecar (index.ts's pool-backed helper). With no
 * target it restores the saved session, else opens the GUI-owned workspace; an
 * explicit but empty cwd falls back to resolveInitialCwd. Neither path can land
 * on a bare process.cwd(), which is "/" for Finder-launched apps. `kind` is the
 * target session file's stamped kind (OPEN_NEW_WINDOW resolves it from the
 * session index); omitted = agent. `device` opens the window's tab on a paired
 * host, where `cwd` and `pendingSessionPath` are that host's paths. A session's window starts its tab on that file.
 */
export type SpawnWindow = (
	cwd?: string,
	pendingSessionPath?: string,
	kind?: SessionKind,
	device?: string,
) => Promise<BrowserWindow | null>;

export class WindowManager {
	#records = new Map<number, WindowRecord>();
	#windowClosedListeners = new Set<(record: WindowRecord) => void>();
	/** How windows created now first show (an update's relaunch restoring its windows); null: in front, as always. */
	launchPresence: WindowPresence | null = null;
	/**
	 * Subscribe to window teardown (tray aggregates, tab-layout persistence).
	 * A listener set rather than one slot because more than one consumer needs
	 * it — returns the unsubscribe function.
	 */
	subscribeWindowClosed(listener: (record: WindowRecord) => void): () => void {
		this.#windowClosedListeners.add(listener);
		return () => this.#windowClosedListeners.delete(listener);
	}

	constructor() {
		serveWindows({
			log: (wcId, entry) => writeRuntimeLog(entry, { windowId: wcId, cwd: this.#records.get(wcId)?.cwd }),
			notice: kind => this.#notice(kind),
			quitAsked: (asker, ask, approved) => (approved ? approveQuit(asker, ask) : logQuitAsked(asker, ask)),
			saves: (file, waiting) => (waiting ? diskFull.report(file) : diskFull.clear(file)),
		});
	}

	createWindow(opts: { cwd: string }): BrowserWindow {
		const cwd = opts.cwd;
		// The shell places, sizes and draws the window, and shows it on its first paint as `presence` says.
		const win = new BrowserWindow({
			show: false,
			...(this.launchPresence ? { presence: this.launchPresence } : {}),
			// The shell injects `window.omp` (out/preload/shell.js) into every window of this session itself.
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				spellcheck: true,
			},
		});

		win.webContents.on("context-menu", (_event, params) => {
			const template = editableContextMenuTemplate(params, editLabels(), {
				replaceMisspelling: suggestion => win.webContents.replaceMisspelling(suggestion),
				addToDictionary: word => win.webContents.session.addWordToSpellCheckerDictionary(word),
				copyImageAt: (x, y) => win.webContents.copyImageAt(x, y),
			});
			if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: win });
		});

		const record: WindowRecord = { win, id: win.webContents.id, cwd };
		this.#records.set(record.id, record);

		// OMP_GUI_STYLEGUIDE=1 opens the internal design style guide instead of the app.
		const hash = process.env.OMP_GUI_STYLEGUIDE === "1" ? "/styleguide" : undefined;
		if (process.env.ELECTRON_RENDERER_URL) {
			const url = new URL(process.env.ELECTRON_RENDERER_URL);
			if (hash) url.hash = hash;
			void win.loadURL(url.toString());
		} else {
			void win.loadFile(join(__dirname, "../renderer/index.html"), { hash });
		}

		// Open external links in browser. Scheme-checked: renderer surfaces
		// (OSC 8 anchors, target=_blank) must not be able to launch arbitrary
		// protocols via middle-click / new-window activation.
		win.webContents.setWindowOpenHandler(({ url }) => {
			if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
			return { action: "deny" };
		});
		// Keep the privileged preload attached only to the desktop shell. Links
		// and dropped documents must not replace it with arbitrary page content.
		win.webContents.on("will-navigate", event => event.preventDefault());

		win.on("closed", () => {
			this.#records.delete(record.id);
			for (const listener of this.#windowClosedListeners) listener(record);
		});

		return win;
	}

	/** The shell's notice about a stuck page (shown here), or the text of a restart dialog it shows. */
	#notice(kind: WindowNotice): { message: string; detail: string; buttons: string[] } | null {
		const language = getMainLanguage();
		if (kind === "hang") {
			new Notification({ title: mainT("rendererHang.title"), body: mainT("rendererHang.body") }).show();
			return null;
		}
		if (kind === "resources") {
			const risk = quitRisk();
			return {
				message: mainT("restart.title", language),
				detail: mainT("restart.body", language, { working: risk.workingTabs, total: risk.totalTabs }),
				buttons: [mainT("restart.now", language), mainT("restart.later", language)],
			};
		}
		return {
			message: mainT("crash.title", language),
			detail: mainT("crash.body", language, { logPath: runtimeLogPath() }),
			buttons: [mainT("restart.now", language), mainT("crash.close", language)],
		};
	}

	recordFor(win: ClientWindow): WindowRecord | undefined {
		return this.#records.get(win.webContents.id);
	}

	/**
	 * Show+focus a window by its webContents id (the F-OWN focus pattern:
	 * opening an already-attached session foregrounds its owner window
	 * instead of spawning a duplicate). False when unknown or destroyed.
	 */
	focusWindowById(id: number): boolean {
		const record = this.#records.get(id);
		if (!record || record.win.isDestroyed()) return false;
		if (record.win.isMinimized()) record.win.restore();
		record.win.show();
		record.win.focus();
		return true;
	}

	/** Update a window's project dir (called when its sidecar switches project). */
	setRecordCwd(win: ClientWindow, cwd: string): void {
		const record = this.#records.get(win.webContents.id);
		if (record) record.cwd = cwd;
	}

	getMainWindow(): BrowserWindow | null {
		for (const record of this.#records.values()) {
			if (!record.win.isDestroyed()) return record.win;
		}
		return null;
	}

	/**
	 * Window that should receive user-initiated actions (menu/tray): the
	 * focused window when it's one of ours, else the first live window.
	 */
	getTargetWindow(): BrowserWindow | null {
		const focused = BrowserWindow.getFocusedWindow();
		if (focused && !focused.isDestroyed() && this.#records.has(focused.webContents.id)) return focused;
		return this.getMainWindow();
	}

	getAllWindows(): BrowserWindow[] {
		return [...this.#records.values()].map(r => r.win).filter(w => !w.isDestroyed());
	}
}
