/** Windows' explicit restart waits for the first worker launch receipt. Stock owns verification and fallbacks. */
import type { StdioOptions } from "node:child_process";
import { session } from "electron";
import { NsisUpdater } from "electron-updater";
import { spawnDetachedOffThread } from "./installer-spawn";
import { type InstallerStartReceipt, installerQuitPending, installerQuitReceipt } from "./shell-host/shell-calls";

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

	override quitAndInstall(isSilent = false, isForceRunAfter = false): void {
		this._logger.info("Install on explicit quitAndInstall");
		this.#offThread = true;
		try {
			if (!this.install(isSilent, isSilent ? isForceRunAfter : this.autoRunAppAfterInstall)) {
				this.quitAndInstallCalled = false;
			}
		} finally {
			this.#offThread = false;
		}
	}

	protected override spawnLog(
		command: string,
		args: string[] = [],
		env?: unknown,
		stdio?: StdioOptions,
	): Promise<boolean> {
		if (!this.#offThread) return super.spawnLog(command, args, env, stdio);
		const start = spawnDetachedOffThread(command, args);
		const accepted = start.then(() => true);
		installerQuitPending();
		void start
			.then<InstallerStartReceipt, InstallerStartReceipt>(
				pid => ({ kind: "started", pid }),
				(error: unknown) => ({
					kind: "failed",
					message: error instanceof Error ? error.message : String(error),
					...(error instanceof Error && "code" in error && typeof error.code === "string"
						? { code: error.code }
						: {}),
				}),
			)
			.then(installerQuitReceipt);
		return accepted;
	}
}
