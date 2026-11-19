/**
 * electron-updater's NSIS updater with the installer started off the main thread (installer-spawn.ts says why).
 * Its `quitAndInstall()` starts the installer and quits in the same turn; here the installer starts on a worker
 * thread and the quit waits until that attempt ends: a process that ends first takes the worker, and the
 * installer it was still starting, with it. The quit itself is electron-updater's own, the
 * `before-quit-for-update` that app-quit.ts tears down on, then `app.quit()`.
 */
import type { StdioOptions } from "node:child_process";
import { autoUpdater as nativeAutoUpdater, session } from "electron";
import { NsisUpdater } from "electron-updater";
import { spawnDetachedOffThread } from "./installer-spawn";

export class OmpNsisUpdater extends NsisUpdater {
	constructor(...args: ConstructorParameters<typeof NsisUpdater>) {
		super(...args);
		// electron-updater downloads on `session.fromPartition("electron-updater")`. Under the Tauri shell a partition that
		// is neither `app` nor `persist:` is a Preview (Brave) context the shell registers only once Brave has launched,
		// so the download's first `net.fetch` failed with "session electron-updater does not exist" (Windows,
		// 0.132.0-0.134.1). The app session is the one the update check and the macOS download already use.
		// `httpExecutor.cachedSession` is not in electron-updater's typings; nsis-updater.test.ts pins it.
		const executor: unknown = Reflect.get(this, "httpExecutor");
		if (executor && typeof executor === "object" && "cachedSession" in executor)
			executor.cachedSession = session.defaultSession;
	}

	/** Only the spawn `quitAndInstall()` makes leaves the thread: the one at app quit (`autoInstallOnAppQuit`) must finish before the process does. */
	#offThread = false;
	#installerStart: Promise<unknown> | undefined;

	override quitAndInstall(isSilent = false, isForceRunAfter = false): void {
		this._logger.info("Install on explicit quitAndInstall");
		this.#installerStart = undefined;
		this.#offThread = true;
		let installing = false;
		try {
			installing = this.install(isSilent, isSilent ? isForceRunAfter : this.autoRunAppAfterInstall);
		} finally {
			this.#offThread = false;
		}
		if (!installing) {
			this.quitAndInstallCalled = false;
			return;
		}
		// Quit whether the installer started or not, as electron-updater does: its own `.catch` has the failure.
		const quit = (): void => {
			nativeAutoUpdater.emit("before-quit-for-update");
			this.app.quit();
		};
		void (this.#installerStart ?? Promise.resolve()).then(quit, quit);
	}

	protected override spawnLog(
		command: string,
		args: string[] = [],
		env?: unknown,
		stdio?: StdioOptions,
	): Promise<boolean> {
		if (!this.#offThread) return super.spawnLog(command, args, env, stdio);
		const start = spawnDetachedOffThread(command, args).then(() => true);
		this.#installerStart = start;
		return start;
	}
}
