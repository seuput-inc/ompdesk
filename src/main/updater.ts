/**
 * GitHub release updates. A release carries two assets, `ompdesk-mac-arm64.dmg`
 * and `ompdesk-windows-setup.exe`, and their version, size and SHA-512 in an
 * HTML comment in its notes. The core reads the release (`lookupRelease`,
 * src/main/update-release.ts) and downloads the installer, checking its SHA-512
 * and continuing an interrupted `.partial` (`downloadInstaller`). Install paths:
 *
 * - Windows downloads the NSIS setup in the background to
 *   `%LOCALAPPDATA%\ompdesk-updater\pending` and starts it on restart (off the
 *   main thread, the shell's quit chain waiting for that start) or at any approved
 *   quit (silent, no relaunch);
 * - macOS builds in a writable location ("relaunch") download the DMG in the
 *   background, copy the app out of the mounted image,
 *   verify its signature/identity, and swap the bundle in place from a
 *   detached helper once the app exits — on "Restart" (then relaunch) or on
 *   any approved quit (no relaunch);
 * - builds the app cannot replace (read-only volume, translocated) fall back
 *   to the verified DMG opened in Finder ("manual").
 *
 * Transfers report progress through one shared renderer state machine; an
 * interrupted transfer keeps its `.partial` and continues from that offset.
 * Only one transfer runs at a time (a check or download request meanwhile
 * just returns its status), and one that receives nothing for 30 s fails as
 * retryable.
 *
 * The release repo is public, so a check and a download carry no credentials
 * by default. A configured GitHub token (src/main/update-auth.ts) is added to
 * every request as a rate-limit raise, and keeps updates working if the repo
 * is private again; only when the repo answers an anonymous request with
 * "not found" does the state become `auth-required`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import type { UpdateAuthTestResult, UpdateInstallMode, UpdateReleaseInfo, UpdateStatus } from "../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS } from "../shared/ipc-types";
import { publishedReleaseSummary } from "../shared/release-summary";
import { compareVersions } from "../shared/version";
import { AutoInstallScheduler, type InstallTrigger } from "./app-auto-update";
import { confirmUpdateRestart, logQuitAsked, onQuitForcedExit, requestQuit } from "./app-quit";
import { writeFileAtomicSync } from "./atomic-file";
import { type BackgroundWork, NO_BACKGROUND_WORK } from "./background-work";
import { CoreError } from "./core/process";
import { markMainStep } from "./hang-watchdog";
import { mainT } from "./i18n";
import type { MainTextKey } from "./i18n-text";
import { spawnDetachedOffThread } from "./installer-spawn";
import { writeRuntimeLog } from "./runtime-log";
import {
	type InstallerStartReceipt,
	installerQuitPending,
	installerQuitReceipt,
	systemIdleSeconds,
	updateHost,
} from "./shell-host/shell-calls";
import {
	checkRepoAccess,
	clearUpdateToken,
	GITHUB_API_REPO,
	resolveUpdateToken,
	storeUpdateToken,
	updateAuthInfo,
} from "./update-auth";
import {
	type InstallHelperMode,
	lastSwapEntry,
	type PendingInstall,
	parsePendingInstall,
	parseStartFailure,
	previousInstallDetails,
	relaunchPresence,
	START_FAILED_FILE,
	START_MARK_FILE,
	type StartFailure,
	type SwapLogEntry,
	scrubUpdateText,
	startFailureOf,
	startMarkJson,
	type UpdateLogDetails,
	type WindowPresence,
	windowPresenceOf,
} from "./update-log-core";
import {
	downloadInstaller,
	lookupRelease,
	type PlatformRelease,
	ReleaseFeedError,
	setUpdateNetwork,
	UPDATE_ASSETS,
	UPDATE_METADATA_ERROR,
	UPDATE_PLATFORM_ERROR,
} from "./update-release";
import {
	isSwappableBundleLocation,
	macBundlePath,
	SingleTransfer,
	StageBundleError,
	SWAP_SCRIPT,
	settleFailedUpdateCheck,
	settleIncompleteUpdateCheck,
	stageBundleFromDmg,
} from "./updater-state";
import type { IpcRegistry } from "./web/ipc-registry";

// Five minutes: a release reaches users within one interval. One GitHub API
// call per check is 12 an hour, under the 60/h anonymous limit.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * App version for the updates row. `app.getVersion()` reads the HOST
 * package.json — the Electron binary's own when unpacked (dev shows
 * "36.9.5"), so dev resolves the project's package.json from the bundle
 * location instead. Packaged builds keep app.getVersion().
 */
export function appVersion(): string {
	if (app.isPackaged) return app.getVersion();
	try {
		// out/main/index.js → ../../package.json (dev bundle layout).
		const raw = fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string") {
			return parsed.version;
		}
	} catch {}
	return app.getVersion();
}

/** Current status, replayed to any window that asks (renderer boot/refresh). */
let current: UpdateStatus = { state: "idle" };
let installMode: UpdateInstallMode = "automatic";
type OfferedRelease = { readonly installer: PlatformRelease; readonly info: UpdateReleaseInfo };
/** The update the last check found (its installer is what a download fetches). */
let release: OfferedRelease | undefined;
/** The verified installer: the Windows setup in electron-updater's old cache folder, or the manual DMG in Downloads. */
let downloadedInstallerPath: string | undefined;
/** Running bundle the relaunch mode replaces (`/Applications/OMPdesk.app`). */
let ownBundle: string | undefined;
/** Verified new bundle waiting for the swap (relaunch mode), and the version it must report once it starts. */
let staged: { app: string; version: string } | undefined;
/** The approved quit came from "Restart & install": reopen after the swap. */
let relaunchAfterSwap = false;
/** The relaunch swap helper was started; a forced exit after `will-quit` must not start a second one. */
let swapLaunched = false;
/** Dev/test seam (`OMP_DEV_UPDATE_STAGED` on Windows, unpackaged): a pretend NSIS update whose install only quits. */
let devDryInstall = false;
/** Token the last check authenticated with, if any; the macOS asset download reuses it. */
let updateToken: string | undefined;
/**
 * The check under way. A second request (Check for Updates during the background poll) joins it instead of running
 * beside it on the one shared status; a check's failure is classified by `checkOnce`, so the updater's own error event
 * stays quiet while it runs.
 */
let checkRun: Promise<void> | null = null;
/** Someone asked for the check under way: its outcome is shown, a failure or "no result" included. */
let checkAsked = false;
/** The installer download; a second one would append to the same `.partial`. */
const transfer = new SingleTransfer();
/** Installs a downloaded update by itself at a quiet moment (Settings › Updates & about); null before `setupUpdater`. */
let autoInstall: AutoInstallScheduler | null = null;
/**
 * Seconds without keyboard or mouse input, read from the shell just before each look (`tickAutoInstall`): the answer
 * comes from another process, so the scheduler's synchronous facts hold the last one. It can only be older than the
 * moment of the decision, never ahead of it, so a person who just touched the computer is never taken for idle.
 */
let idleSeconds = 0;

/** Samples the idle time, then lets the scheduler decide; a failed sample counts as "not idle". */
async function tickAutoInstall(): Promise<void> {
	idleSeconds = await systemIdleSeconds().catch(() => 0);
	autoInstall?.tick();
}

/** The probe's background-work ask, for a click on "Restart & install"; null before `setupUpdater`. */
let askBackgroundWork: (() => Promise<BackgroundWork>) | null = null;
/** Each tick's look at the facts; a dev run shortens the countdown with OMP_DEV_UPDATE_AUTO_COUNTDOWN_MS. */
const AUTO_INSTALL_TICK_MS = 1000;

/** What the auto-install decision reads from the app (index.ts owns prefs and the tab pool). */
export interface AutoInstallProbe {
	/** Pref `appAutoUpdate`. */
	enabled: () => boolean;
	/** Continue interrupted work after relaunch is on. */
	resumes: () => boolean;
	/** A tab runs a turn or compacts, or an ask is open (this computer's tabs and the ones it hosts). */
	busy: () => boolean;
	/** An ask or an approval waits on the person (a subset of `busy`; the log names it as the reason). */
	asking: () => boolean;
	/** A tab compacts its context: a resume-on restart waits for it (a cut compaction does not resume). */
	compacting: () => boolean;
	/** An agent is opening a session that has not taken its first message yet: a restart now would lose the message. */
	opening: () => boolean;
	/** Running background subagents and jobs of every tab on this computer, asked fresh (`background-work.ts`). */
	backgroundWork: () => Promise<BackgroundWork>;
	/** The proxy `proxy.resolve` picks; the release lookup and the installer download go through it. */
	proxy: () => Promise<string | undefined>;
}

/** The trigger of the install in progress; unset until one starts, so an approved quit with an update staged counts as `quit`. */
let installTrigger: InstallTrigger | undefined;

/**
 * One decision line in `gui-runtime.jsonl` (source `app-update`, info level). The caller never passes a token or
 * a URL: raw error text goes through `failureReason`.
 */
function logUpdate(message: "check" | "download" | "scheduler" | "swap", details: UpdateLogDetails): void {
	writeRuntimeLog({ source: "app-update", message, details: { level: "info", ...details } });
}

/** A failure's raw text for the log: without the update token or any URL (a signed asset URL carries credentials). */
function failureReason(error: unknown): string {
	return scrubUpdateText(error instanceof Error ? error.message : String(error), [updateToken]);
}

/** What the next launch reports an install from: the version before and after, written when the helper starts. */
function pendingInstallPath(): string {
	return path.join(app.getPath("userData"), "update-install.json");
}

/** How the windows sat when the install began (read before the quit tears them down). */
let presenceAtInstall: WindowPresence | undefined;

function currentWindowPresence(): WindowPresence | undefined {
	return windowPresenceOf(
		BrowserWindow.getAllWindows()
			.filter(win => !win.isDestroyed())
			.map(win => ({ visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() })),
	);
}

/**
 * How the relaunch an update made should show its windows: as they sat when the install began (hidden in the tray,
 * minimized, behind another app), read from the install marker before the first window opens. Null for any other
 * launch, and for an install the person started in front of the app.
 */
export function readRelaunchPresence(): WindowPresence | null {
	try {
		return relaunchPresence(parsePendingInstall(fs.readFileSync(pendingInstallPath(), "utf8")), Date.now()) ?? null;
	} catch {
		return null;
	}
}

/** The install's helper starts (macOS swap script or Windows NSIS installer): one line, and the marker the next launch reads. */
function noteInstallHelper(mode: InstallHelperMode, trigger: InstallTrigger, extra: UpdateLogDetails = {}): void {
	const presence = presenceAtInstall ?? currentWindowPresence();
	const pending: PendingInstall = {
		from: appVersion(),
		to: current.state === "downloaded" ? current.version : "unknown",
		mode,
		trigger,
		at: Date.now(),
		...(presence ? { presence } : {}),
	};
	try {
		fs.writeFileSync(pendingInstallPath(), JSON.stringify(pending));
	} catch {}
	logUpdate("swap", {
		event: "helper",
		mode,
		from: pending.from,
		to: pending.to,
		trigger,
		...(presence ? { presence } : {}),
		...extra,
	});
}

/**
 * An install starts: remember who asked, and tell the window. Starting the installer and quitting take seconds
 * the window cannot speak in (and a second click meanwhile started the install twice), so the status says
 * "installing" first. The scheduler logs it once, whoever started it, and decides nothing more (12 Nov 2026: a click
 * left it deciding, and it logged a safe point and a countdown one second after the click).
 */
function beginInstall(trigger: InstallTrigger): void {
	installTrigger = trigger;
	presenceAtInstall = currentWindowPresence();
	autoInstall?.installStarted(trigger);
	if (current.state === "downloaded") {
		const { restartAt: _restartAt, ...download } = current;
		broadcast({ ...download, installing: true });
	}
}

/** An approved quit with an update staged installs it, though nothing asked: the quit is the trigger. */
function quitInstallTrigger(): InstallTrigger {
	if (installTrigger === undefined) beginInstall("quit");
	return installTrigger ?? "quit";
}

/** The start mark a macOS swap helper waits for after it reopened the new app (`SWAP_SCRIPT`). */
function startMarkPath(): string {
	return path.join(app.getPath("userData"), START_MARK_FILE);
}

let startNoted = false;

/**
 * The app's first window has loaded its page: say so, once per launch. Writes the start mark, then reports the
 * previous install. In this order a new app that dies before its first page leaves `update-install.json` unread,
 * and the old app the swap helper restored reports `rolled back` from it.
 */
export function noteAppStarted(): void {
	if (startNoted) return;
	startNoted = true;
	try {
		writeFileAtomicSync(startMarkPath(), startMarkJson(appVersion(), process.pid, Date.now()));
	} catch (error) {
		logUpdate("swap", { event: "start-mark-failed", reason: failureReason(error) });
	}
	reportPreviousInstall();
	// This version started: a failure recorded for it earlier (a person installed it anyway) no longer holds.
	if (startFailure?.version === appVersion()) clearStartFailure();
}

/** The first launch after an install says how it ended: the version before and after (macOS adds `swap.log`'s last entry). */
function reportPreviousInstall(): void {
	let raw: string;
	try {
		raw = fs.readFileSync(pendingInstallPath(), "utf8");
		fs.rmSync(pendingInstallPath(), { force: true });
	} catch {
		return;
	}
	const pending = parsePendingInstall(raw);
	if (!pending) return;
	let swap: SwapLogEntry | undefined;
	if (pending.mode === "relaunch") {
		try {
			swap = lastSwapEntry(fs.readFileSync(path.join(updatesDirectory(), "swap.log"), "utf8").slice(-16 * 1024));
		} catch {}
	}
	logUpdate("swap", previousInstallDetails(pending, appVersion(), swap));
	const failure = startFailureOf(pending, appVersion(), swap, Date.now(), startFailure);
	if (failure) rememberStartFailure(failure);
}

/**
 * The version whose start failed after an install (`update-start-failed.json`), read once at setup. The automatic
 * install leaves that version alone, or it would install, fail and roll back again at every safe point; a person's
 * "Restart & install" still installs it, and any other version clears it.
 */
let startFailure: StartFailure | undefined;

function startFailedPath(): string {
	return path.join(app.getPath("userData"), START_FAILED_FILE);
}

function rememberStartFailure(failure: StartFailure): void {
	startFailure = failure;
	try {
		writeFileAtomicSync(startFailedPath(), JSON.stringify(failure));
	} catch (error) {
		logUpdate("swap", { event: "start-failure-not-saved", reason: failureReason(error) });
	}
}

/** What is downloaded is the version whose start failed, and nobody started its install: only a person's click installs it. */
function heldStartFailed(): boolean {
	return (
		startFailure !== undefined &&
		current.state === "downloaded" &&
		!current.installing &&
		current.version === startFailure.version
	);
}

/** The downloaded version is the one that failed to start; a different one (a newer release) clears the record. */
function startFailedBefore(): boolean {
	if (!startFailure) return false;
	if (current.state !== "downloaded") return false;
	if (current.version === startFailure.version) return true;
	clearStartFailure();
	return false;
}

function clearStartFailure(): void {
	startFailure = undefined;
	fs.rmSync(startFailedPath(), { force: true });
}

/** Where the Windows setup is kept: electron-updater's cache folder, so a setup the last Electron build fetched is reused. */
function windowsInstallerFile(): string {
	const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
	return path.join(local, "ompdesk-updater", "pending", UPDATE_ASSETS.windows);
}

/**
 * Starts the downloaded Windows setup with `args`, once. A failed start is retried as electron-updater's NSIS updater
 * did: through `elevate.exe` beside the app when Windows refused it (`EACCES`, `UNKNOWN`), opened by the shell when
 * the file is gone (`ENOENT`); those retries report nothing more. Answers the first attempt.
 */
function startInstaller(args: string[], start: (command: string, args: string[]) => Promise<number>): Promise<number> {
	const installer = downloadedInstallerPath ?? windowsInstallerFile();
	const first = start(installer, args);
	first.catch((error: unknown) => {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		logUpdate("swap", { event: "installer-start-failed", code: String(code), reason: failureReason(error) });
		if (code === "EACCES" || code === "UNKNOWN") {
			spawnDetached(path.join(process.resourcesPath, "elevate.exe"), [installer, ...args]).catch(() => {});
		} else if (code === "ENOENT") {
			void shell.openPath(installer).catch(() => {});
		}
	});
	return first;
}

/** A detached start on this thread (the install at quit must exist before the process ends). */
function spawnDetached(command: string, args: string[]): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => resolve(child.pid ?? 0));
		child.unref();
	} catch (error) {
		reject(error);
	}
	return promise;
}

/**
 * "Restart & install" on Windows: the setup starts on a worker thread (Defender scans a fresh unsigned file inside
 * `CreateProcess`, which froze the main thread for seconds), and the shell's quit chain holds the quit until that
 * attempt reports, started or not (`installerQuitPending`, `installerQuitReceipt`; `quit_chain.rs`).
 */
function startInstallerForRestart(): void {
	installerQuitPending();
	void startInstaller(["--updated", "--force-run"], spawnDetachedOffThread)
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
}

/**
 * Windows: an approved quit (exit code 0) installs a downloaded update silently and starts nothing after it. Only a
 * quit that is the install's own trigger does (`will-quit` made it so): never after a restart already started the
 * setup, and never for a version whose start failed before, which only "Restart & install" installs, with its start
 * check.
 */
function installAtQuit(exitCode: number): void {
	if (installMode !== "automatic" || devDryInstall || exitCode !== 0) return;
	if (installTrigger !== "quit" || !downloadedInstallerPath) return;
	void startInstaller(["--updated", "/S"], spawnDetached).catch(() => {});
}

function isWritable(target: string): boolean {
	try {
		fs.accessSync(target, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** Relaunch needs a bundle we may replace; anything else gets the Finder DMG. */
function swappableBundle(bundle: string | undefined): string | undefined {
	if (bundle && isSwappableBundleLocation(bundle) && isWritable(bundle) && isWritable(path.dirname(bundle))) {
		return bundle;
	}
	return undefined;
}

function detectInstallMode(): UpdateInstallMode {
	if (process.platform !== "darwin") return "automatic";

	// Test seams for unpackaged preview builds; never override a release bundle.
	// Relaunch needs a writable stand-in bundle to replace (OMP_DEV_UPDATE_BUNDLE).
	if (!app.isPackaged) {
		const override = process.env.OMP_DEV_UPDATE_MODE;
		if (override === "relaunch") {
			ownBundle = swappableBundle(process.env.OMP_DEV_UPDATE_BUNDLE);
			return ownBundle ? "relaunch" : "manual";
		}
		if (override === "manual") return "manual";
	}

	// Ad-hoc or certificate-signed alike: the release ships a DMG, not the ZIP Squirrel needs.
	ownBundle = swappableBundle(app.isPackaged ? macBundlePath(app.getPath("exe")) : undefined);
	return ownBundle ? "relaunch" : "manual";
}

function updatesDirectory(): string {
	return path.join(app.getPath("userData"), "updates");
}

/** Copy the app out of the verified DMG and prove it is this app at `version`, intact. */
async function stageBundle(dmgPath: string, version: string): Promise<string> {
	if (!ownBundle) throw new Error(mainT("updates.installerMissing"));
	try {
		return await stageBundleFromDmg({ dmgPath, version, ownBundle }, request =>
			updateHost().stageUpdateBundle(request),
		);
	} catch (error) {
		if (!(error instanceof StageBundleError)) throw error;
		if (error.reason === "missing") throw new Error(mainT("updates.installerMissing"));
		if (error.reason === "verify") throw new Error(mainT("updates.hashMismatch"));
		throw new Error(`${mainT("updates.downloadFailed")} (${error.reason})`);
	}
}

/** Hand the swap to a detached helper that outlives this process (never launchd). */
function launchSwap(
	update: { app: string; version: string },
	destination: string,
	relaunch: boolean,
	trigger: InstallTrigger,
): void {
	const log = path.join(updatesDirectory(), "swap.log");
	const child = spawn(
		"/bin/bash",
		[
			"-c",
			SWAP_SCRIPT,
			"ompdesk-swap",
			String(process.pid),
			update.app,
			destination,
			relaunch ? "1" : "0",
			log,
			startMarkPath(),
			update.version,
			// What the reopened app is launched with: the shell's own arguments (argv[0] is node, argv[1] the bundle).
			...process.argv.slice(2),
		],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
	noteInstallHelper("relaunch", trigger, { relaunch });
}

async function openManualInstaller(filePath: string): Promise<void> {
	shell.showItemInFolder(filePath);
	const openError = await shell.openPath(filePath);
	if (openError) throw new Error(mainT("updates.openInstallerFailed"));
}

/** A failed download in the words a person reads; anything else keeps the core's text (shown as the detail). */
function downloadError(error: unknown): unknown {
	if (!(error instanceof CoreError)) return error;
	if (error.code === "update_status") return new Error(`${mainT("updates.downloadFailed")} (${error.message})`);
	if (error.code === "update_hash") return new Error(mainT("updates.hashMismatch"));
	return new Error(error.message);
}

/** The file the installer is downloaded to, after the files a superseded release left are gone. */
async function installerDestination(update: PlatformRelease, mode: UpdateInstallMode): Promise<string> {
	if (mode === "automatic") {
		const file = windowsInstallerFile();
		// The setup's name carries no version: a partial another release left would fail its hash at the end.
		const marker = `${file}.version`;
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		const kept = await fs.promises.readFile(marker, "utf8").catch(() => "");
		if (kept !== update.version) {
			await fs.promises.rm(`${file}.partial`, { force: true });
			await fs.promises.writeFile(marker, update.version);
		}
		return file;
	}
	if (update.minimumSystemVersion === undefined) throw new Error(mainT("updates.installerMissing"));
	// Manual installers land in Downloads for Finder; relaunch DMGs are private staging.
	if (mode === "relaunch") await fs.promises.mkdir(updatesDirectory(), { recursive: true });
	const destination =
		mode === "manual"
			? await updateHost().updateDestination(update.macDownloadName)
			: path.join(updatesDirectory(), update.macDownloadName);
	// Partials of releases this one superseded can never be continued.
	await updateHost().sweepUpdateFiles({
		area: mode === "manual" ? "downloads" : "updates",
		asset: path.basename(destination),
	});
	return destination;
}

async function downloadAsset({ installer, info }: OfferedRelease, token: string | undefined): Promise<void> {
	const { version, mode } = info;
	const asset = installer.file;
	const destination = await installerDestination(installer, mode);
	try {
		await downloadInstaller({
			url: installer.assetUrl,
			...(token ? { token } : {}),
			file: destination,
			size: asset.size,
			sha512: asset.sha512,
			onProgress: received =>
				broadcast({
					state: "downloading",
					...info,
					percent: asset.size > 0 ? Math.min(100, Math.round((received / asset.size) * 100)) : 0,
				}),
		});
	} catch (error) {
		throw downloadError(error);
	}
	if (mode === "relaunch") {
		staged = { app: await stageBundle(destination, version), version };
		await fs.promises.rm(destination, { force: true });
		broadcast({ state: "downloaded", ...info });
		return;
	}
	downloadedInstallerPath = destination;
	// e2e/headless runs verify the download but never put Finder on screen.
	if (mode === "manual" && process.env.OMP_GUI_HEADLESS !== "1") await openManualInstaller(destination);
	broadcast({ state: "downloaded", ...info });
}

/** The one installer download; callers return early while `transfer.running`. */
function startDownload(update: OfferedRelease, token: string | undefined): Promise<void> {
	const { version, mode } = update.info;
	const { file } = update.installer;
	// The update log names the Windows path as electron-updater's NSIS flow, as before.
	const logMode = mode === "automatic" ? "nsis" : mode;
	return transfer.start(async () => {
		broadcast({ state: "downloading", ...update.info, percent: 0 });
		const startedAt = Date.now();
		logUpdate("download", { event: "started", version, mode: logMode, bytes: file.size });
		try {
			await downloadAsset(update, token);
		} catch (error) {
			logUpdate("download", { event: "failed", version, mode: logMode, reason: failureReason(error) });
			throw error;
		}
		// The SHA-512 matched and, for the relaunch mode, the bundle is staged and verified.
		logUpdate("download", {
			event: "verified",
			version,
			mode: logMode,
			bytes: file.size,
			ms: Date.now() - startedAt,
		});
	});
}

const statusListeners = new Set<(status: UpdateStatus) => void>();

/** Main-process subscribers to every status change (the tray menu); returns the unsubscribe. */
export function onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
	statusListeners.add(listener);
	return () => statusListeners.delete(listener);
}

function broadcast(status: UpdateStatus): void {
	current = status.state === "downloaded" && !status.installing ? withNotice(status) : status;
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(IPC_EVENTS.UPDATER_STATUS, current);
	}
	for (const listener of statusListeners) listener(current);
}

/**
 * A downloaded update with the countdown the scheduler shows now (`restartAt`). Any status that reaches the windows
 * goes through here, so a re-broadcast of the staged update (a manual re-check) keeps the countdown and one that went
 * never lingers.
 */
function withNotice(status: Extract<UpdateStatus, { state: "downloaded" }>): UpdateStatus {
	const { restartAt: _restartAt, ...plain } = status;
	const restartAt = autoInstall?.restartAt;
	return restartAt === undefined ? plain : { ...plain, restartAt };
}

/**
 * "Restart & install" (the app's button, `updates.apply`, the tray): the one install path. `from` is where the person
 * pressed it: a paired page already asked on its own screen (its confirm sheet names the running work), so nobody
 * would answer a dialog here.
 */
export async function applyUpdate(from: "here" | "device" = "here"): Promise<void> {
	if (current.state !== "downloaded" || current.installing) return;
	if (current.mode === "manual") {
		if (!downloadedInstallerPath) {
			broadcast({ state: "error", message: mainT("updates.installerMissing"), showInBanner: true });
			return;
		}
		try {
			await openManualInstaller(downloadedInstallerPath);
		} catch (error) {
			broadcast(failureStatus(error, "updates.openInstallerFailed", true));
		}
		return;
	}
	if (!restartableUpdate()) {
		broadcast({ state: "error", message: mainT("updates.installerMissing"), showInBanner: true });
		return;
	}
	// ⌘Q's rule: running turns continue after the restart (turn-resume.ts), so this asks only with that setting off, or
	// when background subagents or jobs would start over (the scheduler's own install never asks).
	if (
		from === "here" &&
		!(await confirmUpdateRestart(() => (askBackgroundWork ?? (async () => NO_BACKGROUND_WORK))()))
	)
		return;
	restartIntoUpdate("user click");
}

/** Failure copy this module already localized when it threw (installer download/verify/open). */
const OWN_FAILURE_KEYS: readonly MainTextKey[] = [
	"updates.downloadFailed",
	"updates.hashMismatch",
	"updates.installerMissing",
	"updates.openInstallerFailed",
];

/**
 * Error status for an updater failure. Our own throws already carry localized
 * copy; anything else (electron-updater, network stack) becomes the localized
 * `fallback` headline with the raw text kept as `detail`.
 */
function failureStatus(error: unknown, fallback: MainTextKey, showInBanner: boolean): UpdateStatus {
	const raw = error instanceof Error ? error.message : String(error);
	if (OWN_FAILURE_KEYS.some(key => raw.startsWith(mainT(key)))) return { state: "error", message: raw, showInBanner };
	return { state: "error", message: mainT(fallback), detail: raw, showInBanner };
}

/**
 * One update check at a time, anonymous unless a token is configured. A check someone asked for surfaces its
 * failures in the banner; background polls only update Settings. Asked during a background poll, the poll is the
 * check and settles as asked.
 */
function runCheck(manual: boolean): Promise<void> {
	if (manual) checkAsked = true;
	checkRun ??= checkOnce().finally(() => {
		checkRun = null;
		checkAsked = false;
	});
	return checkRun;
}

async function checkOnce(): Promise<void> {
	let token = (await resolveUpdateToken())?.token;
	const configuredToken = token;
	let rejected = false;
	updateToken = token;
	let failure = await attemptCheck(token);
	// GitHub answers 401 to a bad token even for public data (an expired
	// GH_TOKEN, a stale `gh` login). The repo is public, so ask again
	// without it instead of blocking updates on the stale credential.
	if (failure && token && (await checkRepoAccess(token)) === "invalid") {
		rejected = true;
		token = undefined;
		updateToken = undefined;
		failure = await attemptCheck(undefined);
	}
	if (!failure) {
		const settled = settleIncompleteUpdateCheck(current, checkAsked, mainT("updates.noResult"));
		if (settled !== current) {
			logUpdate("check", { event: "error", kind: "no-result", manual: checkAsked });
			broadcast(settled);
		}
		return;
	}
	const error = failure.error;
	const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
	const detail = error instanceof Error ? error.message : String(error);
	// A newer release this Mac's macOS cannot run is no failure: this version keeps working, and the macOS notice
	// says what the next one needs (Orca main/updater/releases/updater-system-requirement.ts:22).
	const unsupported = error instanceof ReleaseFeedError ? error.unsupportedSystem : undefined;
	let settled: UpdateStatus;
	if (unsupported && (compareVersions(unsupported.version, appVersion()) ?? -1) > 0) {
		settled = { state: "not-available", version: appVersion(), unsupportedSystem: unsupported };
	} else {
		let access = await checkRepoAccess(token);
		// An anonymous request GitHub answers "not found" means the repo is
		// private again: a token is needed (or the one tried was rejected).
		if (access === "denied" && !token) access = rejected ? "invalid" : "missing";
		// A release without usable metadata is no update, but never a silent one.
		const message =
			code === UPDATE_METADATA_ERROR
				? mainT("updates.releaseInvalid")
				: code === UPDATE_PLATFORM_ERROR
					? mainT("updates.installerMissing")
					: mainT("updates.checkFailed");
		settled = settleFailedUpdateCheck(access, code, message, appVersion(), checkAsked, detail);
	}
	// A held download is still the answer when the look for a newer one fails (an error would drop it, and with it the hold).
	if (heldStartFailed()) {
		logUpdate("check", {
			event: "error",
			kind: "held",
			manual: checkAsked,
			reason: scrubUpdateText(detail, [configuredToken, updateToken]),
		});
		return;
	}
	// A repo with no release yet is the same answer as "no update"; the rest is an error with its kind.
	if (settled.state === "not-available" && !settled.unsupportedSystem) {
		logUpdate("check", {
			event: "no-update",
			current: appVersion(),
			manual: checkAsked,
			note: "no release published",
		});
	} else {
		logUpdate("check", {
			event: "error",
			kind: settled.state === "auth-required" ? `auth-required:${settled.reason}` : (code ?? "check-failed"),
			manual: checkAsked,
			reason: scrubUpdateText(detail, [configuredToken, updateToken]),
		});
	}
	broadcast(settled);
}

/**
 * Looks once with `token` (none = anonymous) and acts on what it found. An unpackaged app checks only when
 * `OMP_DEV_UPDATE_CHECK=1` asks it to (the test harness), as electron-updater did: otherwise nothing is looked up and
 * the check settles without a result.
 */
async function attemptCheck(token: string | undefined): Promise<{ error: unknown } | undefined> {
	if (!app.isPackaged && process.env.OMP_DEV_UPDATE_CHECK !== "1") return undefined;
	if (!heldStartFailed() && current.state !== "checking") broadcast({ state: "checking" });
	let found: PlatformRelease;
	try {
		found = await lookupRelease({
			apiRepo: GITHUB_API_REPO,
			platform: process.platform === "win32" ? "windows" : "mac",
			// A pre-release only exists for the updater test harness; never in a release bundle.
			allowPrerelease: !app.isPackaged && process.env.OMP_DEV_UPDATE_PRERELEASE === "1",
			...(token ? { token } : {}),
		});
	} catch (error) {
		return { error };
	}
	if ((compareVersions(found.version, appVersion()) ?? -1) > 0) foundUpdate(found);
	else {
		logUpdate("check", { event: "no-update", current: appVersion() });
		if (!heldStartFailed()) broadcast({ state: "not-available", version: appVersion() });
	}
	return undefined;
}

/** A check found a newer release: say so, and fetch its installer unless only a click may (the manual DMG). */
function foundUpdate(found: PlatformRelease): void {
	logUpdate("check", { event: "found", version: found.version, current: appVersion(), mode: installMode });
	// A transfer keeps its own offer. A held installer from this run already has its verified notes.
	const sameHeld = heldStartFailed() && current.state === "downloaded" && current.version === found.version;
	if (transfer.running || (sameHeld && release?.info.version === found.version)) return;
	const summary = publishedReleaseSummary(found.notes);
	const info: UpdateReleaseInfo = {
		version: found.version,
		mode: installMode,
		...(summary.en || summary.ko ? { summary } : {}),
	};
	const offer = { installer: found, info };
	if (sameHeld || (installMode === "relaunch" && staged?.version === found.version)) {
		release = offer;
		broadcast({ state: "downloaded", ...info });
		return;
	}
	release = undefined;
	downloadedInstallerPath = undefined;
	staged = undefined;
	// Only Apple Silicon builds ship; an Intel Mac has no installer to fetch.
	if (installMode !== "automatic" && process.arch !== "arm64") {
		broadcast({ state: "error", message: mainT("updates.unsupportedArchitecture") });
		return;
	}
	release = offer;
	broadcast({ state: "available", ...info });
	if (installMode !== "manual") {
		void startDownload(offer, updateToken).catch(error =>
			broadcast(failureStatus(error, "updates.downloadFailed", false)),
		);
	}
}

async function testAuth(token: string | undefined): Promise<UpdateAuthTestResult> {
	if (token?.trim()) return { access: await checkRepoAccess(token.trim()), source: null };
	const resolved = await resolveUpdateToken();
	const access = await checkRepoAccess(resolved?.token);
	// Anonymous and refused: the repo is private, so a token is what is missing.
	if (!resolved) return { access: access === "denied" ? "missing" : access, source: null };
	return { access, source: resolved.source };
}

/** The updater's current state (also what a paired device sees for this computer). */
export function updateStatus(): UpdateStatus {
	return current;
}

/**
 * A user-started check; a macOS transfer in flight keeps its state, and so does a downloaded update: it is the answer.
 * Settings › Updates checks as it opens, and a "checking" status in between made the automatic install give up its
 * round (the countdown or the waiting notice went, the max wait started over).
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
	if (transfer.running || (current.state === "downloaded" && !heldStartFailed())) return current;
	// A downloaded version held as start-failed is looked past: a newer release replaces it, and the card keeps it meanwhile.
	if (!heldStartFailed()) broadcast({ state: "checking" });
	await runCheck(true);
	return current;
}

/** Start the download of the update a check found. */
export async function downloadUpdate(): Promise<UpdateStatus> {
	if (current.state !== "available" || transfer.running) return current;
	try {
		if (!release) throw new Error(mainT("updates.installerMissing"));
		await startDownload(release, updateToken);
	} catch (error) {
		broadcast(failureStatus(error, "updates.downloadFailed", true));
	}
	return current;
}

/**
 * Whether `restartIntoUpdate` can install what is downloaded: relaunch or
 * automatic mode with its files in place. The manual DMG needs someone at the
 * Mac to drag the app, so it never qualifies.
 */
export function restartableUpdate(): boolean {
	if (current.state !== "downloaded") return false;
	if (current.mode === "relaunch") return staged !== undefined && ownBundle !== undefined;
	return current.mode === "automatic";
}

/**
 * Quit into the downloaded update and reopen (relaunch: the swap helper;
 * automatic: the NSIS setup). Callers have already confirmed
 * the quit; it stops every tab this computer runs.
 */
export function restartIntoUpdate(trigger: InstallTrigger): void {
	if (current.state !== "downloaded" || current.installing) return;
	if (current.mode === "relaunch") {
		if (!staged || !ownBundle) {
			broadcast({ state: "error", message: mainT("updates.installerMissing"), showInBanner: true });
			return;
		}
		markMainStep("update", "relaunch-swap: quit");
		beginInstall(trigger);
		relaunchAfterSwap = true;
		requestQuit("update", { relaunch: true, detail: trigger });
		return;
	}
	// The setup starts off the main thread and holds the quit until that start reports; its receipt lets the shell run
	// the update teardown and the quit (quit_chain.rs).
	if (current.mode === "automatic") {
		markMainStep("update", "quit-and-install");
		beginInstall(trigger);
		if (devDryInstall) {
			requestQuit("update", { detail: `${trigger}, dry run` });
			return;
		}
		noteInstallHelper("nsis", trigger);
		logQuitAsked("update", { relaunch: true, detail: `${trigger}, installer` });
		startInstallerForRestart();
	}
}

/** Which install path this copy runs; Settings explains why the automatic switch is unavailable in `manual`. */
export function updateInstallMode(): UpdateInstallMode {
	return installMode;
}

/** Pref `appAutoUpdate` changed: look at once instead of at the next tick; settles once the scheduler looked. */
export function appAutoUpdatePrefChanged(): Promise<void> {
	return tickAutoInstall();
}

/** The automatic install's "Later" (the notice here, a paired page's or a paired computer's). */
export function postponeUpdate(): void {
	autoInstall?.postpone();
}

export function setupUpdater(ipc: IpcRegistry, probe: AutoInstallProbe): void {
	installMode = detectInstallMode();
	askBackgroundWork = probe.backgroundWork;
	try {
		startFailure = parseStartFailure(fs.readFileSync(startFailedPath(), "utf8"));
	} catch {}
	setUpdateNetwork({
		proxy: probe.proxy,
		// A test's stand-in for GitHub (`http://127.0.0.1:<port>`, every host's path under it: `setup::net::routed`).
		...(process.env.OMP_GUI_TEST_UPDATE_MIRROR ? { mirror: process.env.OMP_GUI_TEST_UPDATE_MIRROR } : {}),
	});
	autoInstall = new AutoInstallScheduler({
		now: Date.now,
		facts: () => {
			const enabled = probe.enabled();
			const installable = restartableUpdate();
			const resumes = probe.resumes();
			return {
				enabled,
				installable,
				startFailedBefore: startFailedBefore(),
				resumes,
				busy: probe.busy(),
				asking: probe.asking(),
				compacting: probe.compacting(),
				opening: probe.opening(),
				focused: BrowserWindow.getAllWindows().some(win => win.isFocused()),
				idleMs: idleSeconds * 1000,
			};
		},
		countdownMs: Number(process.env.OMP_DEV_UPDATE_AUTO_COUNTDOWN_MS) || undefined,
		// Dev/test seam (unpackaged only): a short max wait, to reach the forced restart after "Later" in a test.
		maxWaitMs: (!app.isPackaged && Number(process.env.OMP_DEV_UPDATE_AUTO_MAX_WAIT_MS)) || undefined,
		log: (event, details) => logUpdate("scheduler", { event, ...details }),
		effects: {
			announce: () => broadcast(current),
			withdraw: () => broadcast(current),
			install: () => restartIntoUpdate("auto"),
		},
	});
	setInterval(() => void tickAutoInstall(), AUTO_INSTALL_TICK_MS).unref();
	// Installs interrupted by older builds keyed the partial by process id, which
	// nothing could ever continue — those orphans are the only debris a startup
	// sweep can identify for sure.
	if (process.platform === "darwin") {
		void updateHost()
			.sweepUpdateFiles({ area: "downloads" })
			.catch(error => {
				logUpdate("download", { event: "cleanup-failed", reason: failureReason(error) });
			});
	}
	// Updates download in the background as soon as a check finds one (Claude/Codex
	// style); the only prompt is "Restart & install". Manual DMGs still wait for a click.
	// Relaunch mode: any approved quit installs the staged bundle; "Restart"
	// additionally reopens it. `will-quit` only fires once the quit guard agreed; the quit watchdog's
	// forced `app.exit` skips it, so it starts the swap through the same once-only call.
	if (installMode === "relaunch") {
		const launchStagedSwap = (): void => {
			if (swapLaunched || !staged || !ownBundle) return;
			// An ordinary quit never installs a version whose start failed: with no relaunch the helper would remove
			// the previous app at once and nothing would check the start. Only "Restart & install" (relaunch) does.
			if (!relaunchAfterSwap && startFailure?.version === staged.version) {
				swapLaunched = true;
				logUpdate("swap", { event: "skipped", reason: "start failed before", version: staged.version });
				return;
			}
			swapLaunched = true;
			launchSwap(staged, ownBundle, relaunchAfterSwap, quitInstallTrigger());
		};
		app.on("will-quit", launchStagedSwap);
		onQuitForcedExit(launchStagedSwap);
	}
	// Windows: an approved quit installs a downloaded update silently (`installAtQuit`, at the process's `quit`, after
	// `will-quit` wrote the install marker).
	if (installMode === "automatic") {
		app.on("will-quit", () => {
			if (installTrigger === undefined && current.state === "downloaded" && !heldStartFailed())
				noteInstallHelper("nsis", quitInstallTrigger());
		});
		app.on("quit", (_event: unknown, exitCode: number) => installAtQuit(exitCode));
	}

	ipc.handle(IPC_COMMANDS.UPDATER_CHECK, () => checkForUpdate());
	ipc.handle(IPC_COMMANDS.UPDATER_DOWNLOAD, () => downloadUpdate());
	// A paired page's click was confirmed on its own screen (src/renderer/web/shim.ts); a window's asks here.
	ipc.handle(IPC_COMMANDS.UPDATER_APPLY, caller => applyUpdate(caller.connId ? "device" : "here"));
	ipc.handle(IPC_COMMANDS.UPDATER_POSTPONE, () => postponeUpdate());
	ipc.handle(IPC_COMMANDS.UPDATER_INSTALL_MODE, () => installMode);
	// Dev/test seam (unpackaged only): pretend this staged bundle was downloaded and verified, so the
	// automatic install can be exercised without a release (relaunch mode with OMP_DEV_UPDATE_BUNDLE). On Windows the
	// update is a pretend NSIS one whose install only quits (`devDryInstall`): the decisions before it run as shipped.
	const devStaged = app.isPackaged ? undefined : process.env.OMP_DEV_UPDATE_STAGED;
	const devVersion = process.env.OMP_DEV_UPDATE_STAGED_VERSION ?? "0.0.0-dev";
	if (devStaged && installMode === "relaunch" && ownBundle) {
		staged = { app: devStaged, version: devVersion };
		broadcast({ state: "downloaded", version: devVersion, mode: "relaunch" });
	} else if (devStaged && installMode === "automatic") {
		devDryInstall = true;
		broadcast({ state: "downloaded", version: devVersion, mode: "automatic" });
	}
	ipc.handle(IPC_COMMANDS.UPDATER_GET_STATUS, () => current);
	ipc.handle(IPC_COMMANDS.UPDATER_AUTH_INFO, () => updateAuthInfo());
	ipc.handle(IPC_COMMANDS.UPDATER_AUTH_TEST, (_caller, token?: string) => testAuth(token));
	ipc.handle(IPC_COMMANDS.UPDATER_AUTH_SAVE, async (_caller, token: string): Promise<UpdateAuthTestResult> => {
		const trimmed = token.trim();
		if (!trimmed) return { access: "missing", source: null };
		const access = await checkRepoAccess(trimmed);
		if (access === "ok") await storeUpdateToken(trimmed);
		return { access, source: access === "ok" ? "stored" : null };
	});
	ipc.handle(IPC_COMMANDS.UPDATER_AUTH_CLEAR, async () => {
		await clearUpdateToken();
		return updateAuthInfo();
	});

	// First check once the app settles; then every five minutes. A downloaded or
	// in-flight update is never replaced by a background re-check, except one held as start-failed: a newer
	// release is what the rolled-back app is waiting for.
	const backgroundCheck = () => {
		if (current.state === "downloading" || (current.state === "downloaded" && !heldStartFailed())) return;
		void runCheck(false);
	};
	setTimeout(backgroundCheck, 3000);
	setInterval(backgroundCheck, CHECK_INTERVAL_MS);
}
