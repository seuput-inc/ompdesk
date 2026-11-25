/**
 * Main process entry point for ompdesk.
 * App lifecycle: ready → window, sidecar, session index, IPC, tray, menu, the shell's window commands, updater.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, release } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Notification,
	nativeImage,
	nativeTheme,
	net,
	powerMonitor,
	powerSaveBlocker,
	protocol,
	safeStorage,
	session,
	shell,
	systemPreferences,
} from "electron";
import {
	AUTO_TITLE_EVOLVE_PREF,
	AUTO_TITLE_PREF,
	autoTitleFromPrefs,
} from "../../resources/gui-bridge/modes/auto-title-contracts";
import { DELEGATION_PREF } from "../../resources/gui-bridge/modes/delegation-contracts";
import { JUDGE_ASSIST_PREF, judgeAssistEnabled } from "../../resources/gui-bridge/modes/judge-assist-contracts";
import { RECALL_TERMS_FILE } from "../../resources/gui-bridge/modes/memory-recall-contracts";
import {
	NEXT_PROMPT_INLINE_PREF,
	NEXT_PROMPT_PREF,
	nextPromptFromPrefs,
} from "../../resources/gui-bridge/modes/next-prompt-contracts";
import { USER_PROFILE_PREF } from "../../resources/gui-bridge/modes/user-profile-contracts";
import { OMPDESK_ROLES_FILE } from "../../resources/gui-bridge/ompdesk-role-contracts";
import { ACCOUNT_ROTATION_LEDGER_FILE, ACCOUNT_ROTATION_PREF } from "../shared/account-rotation";
import {
	AGENT_CLOSED_CHILDREN_PREF,
	AGENT_CONTROL_PREF,
	AGENT_HIDDEN_PREFS_KEY,
	agentHiddenPaths,
	parseClosedChildren,
	sidebarViewOf,
} from "../shared/agent-control";
import { AI_MEMORY_TERMINAL_PREF } from "../shared/ai-memory";
import { COMPUTER_USE_PREF } from "../shared/computer-use";
import { CREDIT_SPEND_PREF, creditSpendEnabled } from "../shared/credit-spend";
import { DEFAULT_BROWSER_PREF } from "../shared/default-browser";
import {
	APP_AUTO_UPDATE_PREF,
	CLOSE_TO_TRAY_NOTICE_PREF,
	CLOSE_TO_TRAY_PREF,
	END_SPINNING_ON_CLOSED_OUTPUT_PREF,
	KEEP_AWAKE_WORKING_PREF,
	OMP_FOLLOW_VERIFIED_PREF,
	RESUME_INTERRUPTED_PREF,
	TOOLS_AUTO_UPDATE_PREF,
} from "../shared/desktop-prefs";
import { ECC_PREF } from "../shared/ecc";
import { IPC_COMMANDS, IPC_EVENTS, type SessionKind } from "../shared/ipc-types";
import { KEYCHAIN_WOULD_ASK } from "../shared/keychain";
import { LOCAL_ENGINE_DETECT_PREF } from "../shared/local-engines";
import { MOBILE_WEB_COMMAND, MOBILE_WEB_GET_STATE, MOBILE_WEB_PORT, MOBILE_WEB_STATE } from "../shared/mobile-web";
import { MODEL_SETUP_RESEARCH_PICK_PREF } from "../shared/model-setup";
import type { OmpUpdateState } from "../shared/omp-update";
import { VISUAL_SCHEME } from "../shared/preview";
import { PSTACK_PREF } from "../shared/pstack";
import { REPLY_LANGUAGE_PREF } from "../shared/reply-language";
import { SCHEDULES_STATE } from "../shared/schedules";
import type { SetupState } from "../shared/setup";
import { readSidebarPrefs, SIDEBAR_PREFS_KEY } from "../shared/sidebar-prefs";
import {
	finishedWorktreeFolders,
	type IpcSidebarProjects,
	SIDEBAR_PROJECTS_PREF,
	SIDEBAR_PROJECTS_STATE,
	type SidebarProjectsState,
} from "../shared/sidebar-projects";
import { WORKTREE_BRANCH_PREFIX_PREF, worktreeBranchPrefix } from "../shared/worktree-branch";
import { accountRotationDeps } from "./account-rotation";
import { agentDesktopToRun } from "./agent-desktop";
import { agentDir } from "./agent-paths";
import { MemoryCare } from "./ai-memory/care";
import { AiMemoryClient } from "./ai-memory/client";
import { configureModelRuns, ompLaunch } from "./ai-memory/core-asks";
import { registerAiMemoryIpc } from "./ai-memory/ipc";
import { AiMemoryService, pidFileControl } from "./ai-memory/service";
import { MemorySync, serveConclusionPull, serveConclusionPush, servePull, servePush } from "./ai-memory/sync";
import { MemoryUpkeep } from "./ai-memory/upkeep";
import { installQuitGuard, quitApproved, quitRisk, requestQuit, setQuitResumes, startQuitLog } from "./app-quit";
import type { Autopilot } from "./autopilot";
import { askBackgroundWork } from "./background-work";
import { type BridgeConnectResult, BridgeHealth } from "./bridge-health";
import { answersWithin, ConnectivityMonitor, PROBE_TIMEOUT_MS, probeTarget, reaches } from "./connectivity";
import { CONSOLE_POLL_MS, ConsoleWindowWatch, listConsoleWindows } from "./console-window-watch";
import { installCliLaunchers } from "./control-socket/cli-install";
import { takeHubMinute } from "./core/hub";
import { core, shutdownCore } from "./core/process";
import { routeCoreSaves } from "./core-saves";
import { defaultWorkspace } from "./default-workspace";
import { initDeletedSessions } from "./deleted-sessions";
import type { DesktopSlotHost } from "./desktop-slot-host";
import { poolTabFor, registerDiagnosticBundleIpc } from "./diagnostic-bundle";
import { currentDiagnosticsReport, type DiagnosticsDeps, registerDiagnosticsIpc } from "./diagnostics";
import { systemCacheTools } from "./disk/caches";
import { DiskCare, registerDiskCareIpc } from "./disk/care";
import { SavedWorktreeStore, setSavedWorktreeStore } from "./disk/saved-worktrees";
import { ScratchCare } from "./disk/scratch";
import { diskFull } from "./disk-full";
import { bindDiskFullNotice, describeFiles } from "./disk-full-notice";
import { EMPTY_APPLY_PLAN } from "./extension-reload";
import { createGithubAuthService, registerGithubAuthIpc } from "./github-auth/ipc";
import type { GithubAuthService } from "./github-auth/service";
import { applyLaunchDecision, type LaunchDecision, softwareCompositing } from "./gpu-fallback";
import { installHangWatchdog, markMainStep } from "./hang-watchdog";
import { getMainLanguage, mainT } from "./i18n";
import { startupCwd } from "./initial-cwd";
import { type IpcDeps, registerIpcHandlers } from "./ipc";
import { stockWorktreeLocation, tablessWorktreeBridge } from "./local/git/worktree";
import { renameStoredSession } from "./local/session-files";
import { LocalEngines, localEngineSettings } from "./local-engines";
import { LogWatcher } from "./log-watcher";
import { MacPermissions } from "./mac-permissions";
import { LocalMachine } from "./machine-services";
import { MachineState } from "./machine-state";
import { MailAccounts } from "./mail-accounts";
import { installMainFailureLogging } from "./main-failures";
import { McpHub } from "./mcp-hub";
import { onMcpChange } from "./mcp-live";
import { MEDIA_SCHEME, MediaStreams } from "./media-stream";
import { listProcesses, readMemory, SAMPLE_TIMEOUT_MS, testMemoryReading } from "./memory-sampler";
import { startMemoryWatch } from "./memory-watch";
import { configureNativeBin, nativeBinPath } from "./native-bin";
import { followSetupState } from "./omp-availability";
import { creditSpendRun } from "./omp-launch";
import { OMP_PIDS_FILE, OmpProcesses } from "./omp-processes";
import { ompPackageRoot, ompPathEnv, refreshSystemOmp, systemOmp, TESTED_OMP_VERSION } from "./omp-runtime";
import { openLocalPath } from "./open-path";
import type { LidAwake } from "./power/lid-awake";
import { createLidAwake } from "./power/lid-awake-runtime";
import { type PrefsStore, prefsFile } from "./prefs-store";
import { decodeBinaryRead, HOST_FS_READ_BINARY_TIMEOUT_MS, SidebarProjectsStateSchema } from "./remote/app-protocol";
import { RemoteDevices } from "./remote/devices";
import { HOST_TAB_GRACE_MS, LocalHostServices } from "./remote/host-services";
import { type Identity, loadIdentity } from "./remote/identity";
import { KeepAwakePolicy } from "./remote/keep-awake";
import { readoptHostTabs } from "./remote/readopt";
import { routinePorts } from "./routines/ports";
import { writeRuntimeLog } from "./runtime-log";
import { layoutsToSave } from "./saved-layouts";
import { ompRunLauncher, ScheduleService } from "./schedules";
import { whenSessionFree } from "./session-free";
import { SessionIndex } from "./session-index";
import { SessionKindStore } from "./session-kinds";
import { onSessionDeleted, setSessionDeleteLog } from "./session-mutations";
import { listTaggedProcesses, SESSION_PROCESSES_FILE, SessionProcesses } from "./session-processes";
import { defaultScratchRoot, SESSION_SCRATCH_FILE, SessionScratch } from "./session-scratch";
import { SessionSummaries, type SummarySource } from "./session-summaries";
import { SettleWatch } from "./settle-watch";
import { applyManagedToolEnv, bunInstallDir, managedToolsDir, refreshPath, setupPlatform } from "./setup/paths";
import { findBun } from "./setup/supervisor";
import { shellSpawnEnv, spawnPath } from "./shell-env";
import {
	admitNotification,
	appIconPath,
	clipboard,
	consumeHangReports,
	diagnosticBundleFileName,
	onPairedPagePush,
	openPageExternal,
	postWatchdog,
	publishDiskFull,
	publishLanguage,
	readDiagnosticLog,
	readPreviousRunEnd,
	serveCloseToTray,
	serveSessions,
	serveTray,
	app as shellApp,
	shellIpc,
} from "./shell-host/electron/index";
import {
	accessibilityTrusted,
	defaultSessionCachePath,
	safeStorageUnavailableReason,
	screenRecordingGranted,
} from "./shell-host/shell-calls";
import { SidebarProjects } from "./sidebar-projects";
import type { RecoveryStuck, SidecarManager } from "./sidecar";
import { deviceLanguage, localSidecarFactory } from "./sidecar-factory";
import { SidecarPool } from "./sidecar-pool";
import { installSlowSteps, loopMaxMs } from "./slow-steps";
import { nextSnowflake } from "./snowflake";
import { markStartup } from "./startup-timing";
import { StatsServerManager } from "./stats-server";
import { stockHelperRequest, stopStockHelper } from "./stock-helper";
import { seedSpellchecker } from "./system-languages";
import { shellEngine, systemVersion } from "./system-version";
import { type PersistedTabLayout, sanitizePersistedTabLayouts, type TabLayoutDrop } from "./tab-layout";
import { startTailscaleApp } from "./tailscale/cli";
import { locateTailscale } from "./tailscale/locate";
import { MobileWebService } from "./tailscale/service";
import { Tailnet } from "./tailscale/tailnet";
import { exitWithLauncher } from "./test-launcher-exit";
import { ToolsClient } from "./tools/client";
import { registerToolsIpc } from "./tools/ipc";
import { InterruptedTurnStore, limitLook, retryDelays, TurnResume } from "./turn-resume";
import { recordTurnStop, setTurnStopLog } from "./turn-stop-log";
import { journalWait, TurnWaitWatch, WAIT_SWEEP_MS } from "./turn-wait-watch";
import {
	appAutoUpdatePrefChanged,
	applyUpdate,
	appVersion,
	checkForUpdate,
	downloadUpdate,
	noteAppStarted,
	onUpdateStatus,
	postponeUpdate,
	readRelaunchPresence,
	restartableUpdate,
	restartIntoUpdate,
	setupUpdater,
	updateStatus,
} from "./updater";
import { FileEditReports } from "./web/file-edit-reports";
import { IPC_POLICY } from "./web/ipc-policy";
import { IpcRegistry } from "./web/ipc-registry";
import { UploadStore } from "./web/uploads";
import { WebClientWindow } from "./web/web-client-window";
import { WebHost } from "./web/web-host";
import { WebTabLayouts } from "./web/web-tab-layouts";
import { WindowManager } from "./window";
import { nativeThemeSource } from "./window-chrome";
import { resolveWindowSpawnTarget } from "./window-spawn-target";
import {
	isWorktreeStartCandidate,
	readLiveLifecycleSettings,
	WorktreeLifecycle,
	WorktreePrompts,
	type WorktreeWindows,
} from "./worktree-lifecycle";
import { sessionOpenFolders, setOpenFoldersSource } from "./worktree-orphans";

// App identity: the dev run shows "Electron" in the dock otherwise; packaged
// builds get the name from the bundle via electron-builder. The name also picks
// the userData directory (~/Library/Application Support/ompdesk) and the
// "ompdesk Safe Storage" keychain item, so it stays lowercase and is set before
// anything resolves that path. People see the display name, OMPdesk.
app.setName("ompdesk");
// The Windows toast and taskbar group are keyed on this id: electron-builder gives the Start-menu shortcut the
// appId, so the same id there makes a toast wear the shortcut's name and icon (the dev run has no shortcut).
if (process.platform === "win32") app.setAppUserModelId("com.seuput.ompdesk");
app.setAboutPanelOptions({ applicationName: "OMPdesk", iconPath: appIconPath });

// Honor Electron's explicit profile before acquiring its instance lock.
const userDataDirectory = app.commandLine.getSwitchValue("user-data-dir");
if (userDataDirectory) {
	const directory = resolve(userDataDirectory);
	mkdirSync(directory, { recursive: true });
	app.setPath("userData", directory);
}

// Players stream audio/video through `omp-media://` (range requests); the agent's visuals load in the Preview
// through `omp-visual://` (main/preview/visuals.ts; handled on the preview's visual session only). Privileges
// must precede whenReady.
protocol.registerSchemesAsPrivileged([
	{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } },
	{ scheme: VISUAL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
// No page resolves host names it only hints at (`<link rel=dns-prefetch>`, in any frame, whatever
// `x-dns-prefetch-control` says): a visual's page could spell what it read into a name for the system resolver,
// which neither CSP nor the visual session's dead proxy stops (Security #3). Only a hint is lost; Blink applies
// this after each page's preferences, in every renderer. Any `--blink-settings` given at launch is kept.
const blinkSettings = app.commandLine.getSwitchValue("blink-settings");
app.commandLine.appendSwitch(
	"blink-settings",
	[blinkSettings, "dnsPrefetchingEnabled=false"].filter(Boolean).join(","),
);
const mediaStreams = new MediaStreams();
// Test seam (unpackaged only, the parity sheet's launch): the mail accounts read as if the macOS keychain would ask for
// the login password, so an account saved through the page shows the re-entry notice (e2e/responsive-surfaces.ts).
const keychainWouldAskForTests = !app.isPackaged && process.env.OMP_GUI_TEST_KEYCHAIN_WOULD_ASK === "1";

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
}
// Before anything else is logged: how the last run ended, and this run's end line when it exits.
if (gotLock) startQuitLog(readPreviousRunEnd());

// The instance lock and legacy-profile migration precede the host's first write.
const launch = shellApp.startLaunchProtection(gotLock);
void launch.then(
	({ logs }) => {
		for (const report of logs) writeRuntimeLog(report);
	},
	error => console.error("[launch-guard]", error),
);

// Test runs (OMP_GUI_HEADLESS=1, set by playwright.config.ts) must not cover
// or take focus from the desktop. Hidden windows would stop rendering
// (Chromium pauses animation frames), so windows stay "shown" but transparent,
// click-through, off the Dock/taskbar, and unable to grab focus. A transparent
// window — or any window on a locked/headless CI display — also counts as
// occluded, which throttles timers and frames just the same; opt out of that.
if (process.env.OMP_GUI_HEADLESS === "1") {
	app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
	app.commandLine.appendSwitch("disable-renderer-backgrounding");
	app.commandLine.appendSwitch("disable-background-timer-throttling");
	if (process.platform === "darwin") {
		app.setActivationPolicy("accessory");
		// Chromium's own storage encryption would open the "ompdesk Safe Storage"
		// login-keychain item. Tests must not touch the user's keychain, and in a
		// fresh security session (the self-hosted CI runner's LaunchAgent) that
		// access blocks the main process.
		app.commandLine.appendSwitch("use-mock-keychain");
	}
	app.on("browser-window-created", (_event, win) => {
		win.setOpacity(0);
		win.setIgnoreMouseEvents(true);
		win.setSkipTaskbar(true);
		win.setFocusable(false);
	});
}
// A test launch ends with the Playwright worker that launched it, even one that died running no handler.
exitWithLauncher(process.env, () => app.exit(0));

/**
 * Unpackaged runs keep resources in the source tree. Resolve them from the
 * bundle (out/main/index.js → ../..), not app.getAppPath(): that is the
 * project root under `electron-vite dev` but `out/main` when Electron is
 * launched on the bundle directly (e2e, `electron out/main/index.js`).
 * Packaged apps ship gui-bridge beside the app (`extraResources`) because
 * omp, a separate process, loads it with `-e`.
 */
const devResourcesDir = join(__dirname, "..", "..", "resources");

// Packaged builds get the dock icon from the bundle; the dev run shows the default atom icon otherwise.
{
	const dockIcon = join(devResourcesDir, "icon.png");
	if (process.platform === "darwin" && existsSync(dockIcon)) {
		app.dock?.setIcon(nativeImage.createFromPath(dockIcon));
	}
}

interface MainPrefs {
	lastProject?: string;
	proxyUrl?: string;
	/** One layout per live window, in window order. */
	tabLayouts?: PersistedTabLayout[];
	/** Pre-multi-window shape, migrated on the first persist. */
	tabLayout?: PersistedTabLayout;
	[key: string]: unknown;
}

let mainPrefsStore: PrefsStore<MainPrefs> | null = null;

function prefsStore(): PrefsStore<MainPrefs> {
	if (!mainPrefsStore) {
		mainPrefsStore = prefsFile<MainPrefs>("prefs");
		const powers = mainPrefsStore.migrateAgentPowers(agentDir());
		if (powers) {
			writeRuntimeLog({
				// A clean migration is no failure: only one that could not edit config.yml is a background-task error.
				source: powers.error ? "background-task" : "user-data-migration",
				message: "agent-powers-migrated",
				details: { prefs: powers.prefs.join(","), stock: powers.stock.join(","), error: powers.error ?? null },
			});
		}
	}
	return mainPrefsStore;
}

async function resolveInitialCwd(): Promise<string> {
	return (await startupCwd(prefsStore().get("lastProject"))).cwd;
}

// ──────────────────────────────────────────────────────────────────────────
// Sidecar proxy env
// ──────────────────────────────────────────────────────────────────────────
// The agent reads proxy config from env vars only (PI_PROXY_* → PI_PROXY →
// HTTPS_PROXY → ALL_PROXY). A Finder-launched app has no shell env, so a
// proxy-only network (codex's chatgpt.com backend behind a firewall) would
// silently hang every provider request. Resolution order per spawn, the core's
// (`proxy.resolve`, crates/core/src/proxy.rs): explicit GUI pref → inherited env
// (terminal launch) → the system proxy (PAC included), bounded.

/** How long the tabs of one core loss that have no omp are gathered before the one notification counts them. */
const STUCK_NOTICE_GATHER_MS = 10_000;
/** How long the stats server and setup's optional installs wait for a first ready tab before starting anyway. */
const FIRST_TAB_GRACE_MS = 30_000;

/**
 * The proxy the agent's requests go through and the variables a spawn adds. A system lookup past the core's bound
 * reads as none and is logged (source `omp-start-input`); a core that cannot answer reads as none.
 */
async function spawnProxy(): Promise<{ url: string | undefined; env: Record<string, string> }> {
	try {
		const { result } = await core().call<{ url: string | null; env: Record<string, string>; lateMs: number | null }>(
			"proxy.resolve",
			{ pref: prefsStore().get("proxyUrl") },
		);
		if (result.lateMs !== null)
			writeRuntimeLog({
				source: "omp-start-input",
				message: "proxyEnv",
				details: { ms: result.lateMs, reason: "the system proxy lookup did not answer" },
			});
		return { url: result.url ?? undefined, env: result.env };
	} catch {
		return { url: undefined, env: {} };
	}
}

async function resolveProxyEnvForSpawn(): Promise<Record<string, string>> {
	return (await spawnProxy()).env;
}

// Module-level instances (alive for app lifetime)
let windowManager: WindowManager;
let sidecarPool: SidecarPool;
let statsServer: StatsServerManager | null = null;
/** OMPdesk's MCP hub (src/main/mcp-hub.ts): the one process serving the built-in `ompdesk-memory` endpoint. */
let mcpHub: McpHub | null = null;
/** Every omp this app runs (src/main/omp-processes.ts): a quit waits for their exits, a launch reaps an earlier one's. */
let ompProcesses: OmpProcesses | null = null;
/** The startup omp resolution that creates `statsServer` has finished (with or without one). */
let statsLaunchSettled = false;
let sessionIndex: SessionIndex;
let logWatcher: LogWatcher;
let remoteDevices: RemoteDevices | null = null;
let worktreePrompts: WorktreePrompts | null = null;
let worktreeLifecycle: WorktreeLifecycle | null = null;
/** Machine setup and the omp, tool CLI and extension updaters: the core's `tools` instance (src/main/tools/). */
let tools: ToolsClient | null = null;
let webHost: WebHost | null = null;
/** The phones' upload folder, also where a paired computer's attached files land; WebHost's own store once it exists. */
let earlyUploads: UploadStore | null = null;
function hostUploads(): UploadStore {
	if (webHost) return webHost.uploads;
	earlyUploads ??= new UploadStore({ userData: app.getPath("userData") });
	return earlyUploads;
}
/** Paired web devices' tab layouts, by device (pref `webTabLayouts`). */
const webTabLayouts = new WebTabLayouts({
	get: () => prefsStore().get("webTabLayouts"),
	set: value => prefsStore().set("webTabLayouts", value),
});
let mobileWebService = null as MobileWebService | null;
let localEngines: LocalEngines | null = null;
let aiMemoryService: AiMemoryService | null = null;
let aiMemoryUpkeep: MemoryUpkeep | null = null;
let aiMemoryCare: MemoryCare | null = null;
let aiMemorySync: MemorySync | null = null;
let githubAuthService: GithubAuthService | null = null;
let scheduleService: ScheduleService | null = null;
/** Settles once the core wrote the schedules' journal at a quit, or its bound passed: the core's stop and the exit wait for it. */
let schedulesClosed: Promise<void> = Promise.resolve();
let logsClosed: Promise<void> = Promise.resolve();
/** The quit's stop of every omp (`sidecar.stopAll`), started with the tabs' disposal: the core ends only after it answered. */
let ompsStopped: Promise<void> = Promise.resolve();
/** The core and the processes it started, after the omps and schedule writes have settled. */
let coreStopped: Promise<void> = Promise.resolve();

/** Resolves once a window of the app has loaded its page (at once when one has). */
function firstWindowLoaded(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const loaded = (win: BrowserWindow) =>
		!win.isDestroyed() && !win.webContents.isLoading() && win.webContents.getURL() !== "";
	if (BrowserWindow.getAllWindows().some(loaded)) resolve();
	else
		app.on("browser-window-created", (_event, win) => {
			win.webContents.once("did-finish-load", () => resolve());
		});
	return promise;
}
/** The owner's mail accounts for email routines (Settings › Schedules › Email accounts). */
let mailAccounts: MailAccounts | null = null;
/** Keep-awake while this computer's own tabs run a turn (Settings › General › Window). */
let workAwakePolicy: KeepAwakePolicy | null = null;
/** A charging laptop's lid close never stops work a keep-awake blocker holds (src/main/power/lid-awake.ts). */
let lidAwake: LidAwake | null = null;
/** Disk care at launch and daily (src/main/disk/care.ts). */
let diskCare: DiskCare | null = null;
/** The link-state monitor (src/main/connectivity.ts): stopped at the quit, before the core it runs in ends. */
let connectivityMonitor: ConnectivityMonitor | null = null;
/** The 3 s link sampling of `connectivityMonitor`. */
let connectivityPoll: ReturnType<typeof setInterval> | null = null;

function installMainRuntimeLogging(): void {
	// A console line to a stdout/stderr whose reader is gone (the terminal or test runner that started this copy
	// closed) fails with EPIPE on the stream; with no listener that is an uncaught exception and a crash dialog.
	// Losing the line is fine: the runtime log keeps what matters.
	for (const stream of [process.stdout, process.stderr]) {
		stream.on("error", error => {
			if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
		});
	}
	installMainFailureLogging(process, report => writeRuntimeLog(report));
	app.on("child-process-gone", (event: Electron.Event & { launchDecision?: LaunchDecision }, details) => {
		writeRuntimeLog({
			source: "child-process",
			message: `${details.type} process exited: ${details.reason}`,
			details: {
				type: details.type,
				reason: details.reason,
				exitCode: details.exitCode,
				serviceName: details.serviceName ?? null,
				name: details.name ?? null,
			},
		});
		applyLaunchDecision(event.launchDecision ?? null);
	});
}

/**
 * The saved session: one tab layout per window. Reads tolerate both the current
 * array and the pre-multi-window single layout written by older builds.
 */
function readSavedTabLayouts(options: { log?: boolean } = {}): PersistedTabLayout[] {
	const store = prefsStore();
	const drops: TabLayoutDrop[] = [];
	const collect = options.log ? (drop: TabLayoutDrop) => drops.push(drop) : undefined;
	let layouts = sanitizePersistedTabLayouts(store.get("tabLayouts"), undefined, collect);
	if (layouts.length === 0) layouts = sanitizePersistedTabLayouts(store.get("tabLayout"), undefined, collect);
	if (options.log) logLayoutRestore(layouts, drops);
	return layouts;
}

/**
 * One `tab-layout` line per launch: how many saved tabs come back, and which were left out or start fresh and why
 * (`TabLayoutDrop`), so a tab "missing after a relaunch" is explained from the log, never guessed.
 */
function logLayoutRestore(layouts: readonly PersistedTabLayout[], drops: readonly TabLayoutDrop[]): void {
	const count = (reason: TabLayoutDrop["reason"]) => drops.filter(drop => drop.reason === reason).length;
	writeRuntimeLog({
		source: "tab-layout",
		message: drops.length > 0 ? "restored, some tabs left out or fresh" : "restored",
		details: {
			level: "info",
			windows: layouts.length,
			tabs: layouts.reduce((sum, layout) => sum + layout.tabs.length, 0),
			folderGone: count("folder"),
			deleted: count("deleted"),
			duplicate: count("duplicate"),
			fresh: count("fresh"),
			...(drops.length > 0
				? {
						dropped: drops
							.slice(0, 20)
							.map(
								drop => `${drop.reason}: ${drop.sessionPath ? basename(drop.sessionPath) : basename(drop.cwd)}`,
							)
							.join("; "),
					}
				: {}),
		},
	});
}

/**
 * A finished worktree's session (its OMPdesk worktree is gone: disk care removed it once its work landed) never comes
 * back through a tab nobody uses (the user's report, 29 Oct 2026: a device's restored tabs listed two such sessions the
 * host itself hid). Given that computer's project list, the tabs a relaunch restored on one, asleep since, close on
 * `device` (undefined: this computer) as a deleted session's do.
 */
function closeFinishedTabs(device: string | undefined, state: Pick<SidebarProjectsState, "gone">): void {
	const closed = sidecarPool.closeAsleepTabsIn(device, finishedWorktreeFolders(state));
	if (closed.length === 0) return;
	writeRuntimeLog({
		source: "tab-layout",
		message: "closed restored tabs of finished worktrees",
		details: { level: "info", device: device ?? "local", tabs: closed.length },
	});
}

/** Paired host `host` deleted these sessions: the tabs here on them close and the delete is remembered under that host. */
function closeHostDeletedTabs(host: string, paths: readonly string[]): void {
	const closed = sidecarPool.closeHostDeletedSessions(host, paths);
	if (closed.length === 0) return;
	writeRuntimeLog({
		source: "tab-layout",
		message: "closed tabs of sessions their host deleted",
		details: { level: "info", device: host, tabs: closed.length },
	});
}

/**
 * Rewrite the saved session from the live windows. Runs on every tab change and
 * every window close, so a window the user closed for good never comes back and
 * a secondary window's tabs are no longer dropped on the floor.
 */
function persistTabLayouts(): void {
	const live: PersistedTabLayout[] = [];
	for (const win of windowManager.getAllWindows()) {
		const layout = sidecarPool.tabLayoutForWindow(win);
		if (layout) live.push(layout);
	}
	const store = prefsStore();
	const layouts = layoutsToSave({ quitApproved: quitApproved(), live, stored: store.get("tabLayouts") });
	if (!layouts) return;
	store.set("tabLayouts", layouts);
	if (store.has("tabLayout")) store.delete("tabLayout");
}

/** Reopen one saved window: its tabs in order, at the layout's active cwd. */
async function spawnWindowWithLayout(layout: PersistedTabLayout): Promise<BrowserWindow | null> {
	if (quitApproved()) return null;
	const active = layout.tabs[layout.activeIndex] ?? layout.tabs[0];
	if (!active) return null;
	// The window record keeps a path on this machine; a paired host's cwd means nothing here.
	const cwd = active.device ? await resolveInitialCwd() : active.cwd;
	if (quitApproved()) return null;
	const win = windowManager.createWindow({ cwd });
	if (sidecarPool.restoreLayout(win, layout) > 0) return win;
	win.close();
	return null;
}

/** Spawn a window with its own sidecar (the pool's 1:1 owner). Null when the sidecar cannot be created.
 *  With no target, start a fresh agent in the default workspace; explicit
 *  workspace/session requests retain their selected/fallback cwd and requested
 *  session kind. `device` runs the window's tab on that paired host, at its `cwd`. */
async function spawnWindow(
	cwd?: string,
	pendingSessionPath?: string,
	kind?: SessionKind,
	device?: string,
): Promise<BrowserWindow | null> {
	// An approved quit has torn the services down (or is doing so): a window built now has nothing to run on, and
	// restoring the layout on it would drop what a disposed `RemoteDevices` cannot open from the saved session.
	if (quitApproved()) return null;
	if (device && cwd) {
		const localCwd = await resolveInitialCwd();
		if (quitApproved()) return null;
		const win = windowManager.createWindow({ cwd: localCwd });
		const fresh = pendingSessionPath === undefined;
		const sidecar = sidecarPool.acquire(
			cwd,
			win,
			undefined,
			pendingSessionPath,
			kind ?? "agent",
			undefined,
			fresh,
			false,
			false,
			undefined,
			device,
		);
		if (sidecar) return win;
		win.close();
		return null;
	}
	const restoreSavedLayout = cwd === undefined && pendingSessionPath === undefined && kind === undefined;
	if (restoreSavedLayout) {
		const [saved] = readSavedTabLayouts();
		if (saved) {
			const restored = await spawnWindowWithLayout(saved);
			if (restored) return restored;
		}
	}
	const [fallback, work] = await Promise.all([resolveInitialCwd(), defaultWorkspace()]);
	if (quitApproved()) return null;
	const target = resolveWindowSpawnTarget(cwd, pendingSessionPath, kind, fallback, work);
	// The tab's omp starts on the session file (`--session`), as a tab spawn's does: the renderer's boot switch it
	// used to wait for never ran in a window whose tab list had not named its tab yet.
	const win = windowManager.createWindow({ cwd: target.cwd });
	const sidecar = sidecarPool.acquire(
		target.cwd,
		win,
		undefined,
		pendingSessionPath,
		target.kind,
		undefined,
		target.fresh,
		target.placeholder,
	);
	if (!sidecar) {
		win.close();
		return null;
	}
	return win;
}

/**
 * The shell's `session.openPath` (a folder opened on the app, a second launch in a folder): the window already showing
 * this workspace, or a new one there. A relative path resolves against the launcher's cwd, which is never the
 * workspace the person pointed at, so it is refused rather than guessed.
 */
async function openPath(path: string): Promise<{ focus: number } | { spawned: number } | null> {
	if (!isAbsolute(path)) return null;
	const target = resolve(path);
	const shown = windowManager.getAllWindows().find(win => windowManager.recordFor(win)?.cwd === target);
	if (shown) return { focus: shown.id };
	const win = await spawnWindow(target);
	return win ? { spawned: win.id } : null;
}

app.whenReady().then(async () => {
	installMainRuntimeLogging();
	// Before the first core starts: the prefs below are main's first hub call, and the core it starts must be the
	// packaged binary (a core started before this looked in the checkout's layout and failed ENOENT in every packaged
	// app) and carry the left-behind file in its environment.
	configureNativeBin({
		packaged: app.isPackaged,
		resourcesPath: app.isPackaged ? process.resourcesPath : devResourcesDir,
	});
	core().leftBehindFile = join(app.getPath("userData"), "left-behind-worktrees.json");
	const { guard, safeMode, stableAfterMs } = await launch;
	// A full disk is told once, by one notification that goes when the files are saved; the writers retry on their own.
	bindDiskFullNotice(diskFull, {
		show: notice => {
			const shown = new Notification(notice);
			shown.show();
			return { close: () => shown.close() };
		},
		text: names => ({
			title: mainT("diskFull.title"),
			body: mainT("diskFull.body", undefined, { what: describeFiles(names) }),
		}),
	});
	// The same notice as a toast in every window and on the paired phone's page, closed when the files are saved.
	diskFull.onChange(files => {
		publishDiskFull(files);
		webHost?.router.publishDiskFull(files);
	});
	onPairedPagePush(({ connId, channel, payload }) => webHost?.router.deliverToConnection(connId, channel, payload));
	// The core's stores (web devices, paired computers, schedules, journals) join it.
	routeCoreSaves(core(), diskFull);
	markStartup("app-ready");
	// A stall says how the computer and OMPdesk's own processes stood around it (machine-state.ts).
	const machineState = new MachineState({
		log: (message, details) => writeRuntimeLog({ source: "machine-state", message, details }),
		read: () => Promise.all([readMemory(), listProcesses()]),
		timeoutMs: SAMPLE_TIMEOUT_MS,
		pids: () => {
			const corePid = core().pid;
			return {
				main: process.pid,
				// Under the window's shell main is its child (`OMPDESK_SHELL_SOCKET`, crates/shell/src/node.rs).
				...(process.env.OMPDESK_SHELL_SOCKET ? { host: process.ppid } : {}),
				...(corePid === null ? {} : { core: corePid }),
			};
		},
		loopMaxMs,
	});
	// A second instance quits at once: it must not take the running one's marker, nor watch anything.
	if (gotLock) {
		for (const report of await consumeHangReports()) writeRuntimeLog(report);
		installHangWatchdog(postWatchdog);
		// A slow step leaves a line (slow-steps.ts): main's blocked thread, a handler, a wait on the core, an omp's start.
		installSlowSteps({
			log: (message, details) => {
				writeRuntimeLog({ source: "slow-step", message, details });
				machineState.slowStep(details);
			},
		});
		// The measurement of main's blocked waits on the core's hub (native-rust ledger, H2): one line a minute.
		if (process.env.OMP_GUI_HUB_STATS === "1")
			setInterval(() => {
				const minute = takeHubMinute();
				if (minute) writeRuntimeLog({ source: "hub", message: "blocked waits", details: { ...minute } });
			}, 60_000).unref();
		void shellApp.launchEvent("identity").then(applyLaunchDecision);
		// Only a responsive Node main can confirm the trial. A forced GPU exit skips the clean-quit write.
		setTimeout(() => void shellApp.launchEvent("healthy").then(applyLaunchDecision), stableAfterMs).unref();
		if (guard) shellApp.stabilizeOnCleanQuit();
	}
	windowManager = new WindowManager();
	// Before any window exists: each one is created under the app's theme, not the OS's (window-chrome.ts).
	nativeTheme.themeSource = nativeThemeSource(prefsStore().get("themeName"), prefsStore().get("theme"));
	// The windows' spellchecker follows the system language, not the en-US the trimmed locales leave (system-languages.ts).
	seedSpellchecker(session.defaultSession, app.getPreferredSystemLanguages(), process.platform);

	// Tools setup installed into the managed dir (PortableGit, Node/gh archives)
	// reach every process spawned from here on, sidecars included.
	const platform = setupPlatform();
	const toolsDir = managedToolsDir(platform, process.env, homedir(), app.getPath("userData"));
	applyManagedToolEnv(toolsDir, platform);

	const bridgeDir = app.isPackaged ? join(process.resourcesPath, "gui-bridge") : join(devResourcesDir, "gui-bridge");
	// Memory's own model calls (the core's `omp -p`, the judge's host) follow the Credit use switch as a tab does.
	configureModelRuns(() => creditSpendRun(bridgeDir, creditSpendEnabled(prefsStore().get(CREDIT_SPEND_PREF))));
	// A core's loss and why, which otherwise only main's console hears (a packaged app keeps none of it).
	core().report = (step, details) => {
		writeRuntimeLog({ source: "core-loss", message: step, details });
		if (step === "abandoned") machineState.stalled("core-loss");
	};
	// The core keeps this computer's remote identity (its key never leaves it); the device id is read synchronously
	// from here on, so it is loaded now, beside the rest of the launch, and awaited where the devices are made.
	const remoteIdentity = loadIdentity(app.getPath("userData")).catch((error: unknown): Identity => {
		writeRuntimeLog({
			source: "remote",
			message: "identity-failed",
			details: { error: error instanceof Error ? error.message : String(error) },
		});
		return { deviceId: "", publicKey: "" };
	});
	// The CLI the app ships (bun run build:native stages it for an unpacked run).
	await installCliLaunchers({
		binary: nativeBinPath("ompdesk"),
		userData: app.getPath("userData"),
		platform,
		packaged: app.isPackaged,
		env: process.env,
		home: homedir(),
	});
	const builtinDir = app.isPackaged
		? join(process.resourcesPath, "omp-builtin")
		: join(devResourcesDir, "omp-builtin");
	// The agent-desktop the app ships (bun run build:agent-desktop); a dev run without it falls back to the managed copy.
	// OMP_GUI_TEST_AGENT_DESKTOP_BUNDLE (unpacked runs only) points a spec at its own, so it never depends on whether
	// the checkout ran the build.
	const agentDesktopBundle = app.isPackaged
		? join(process.resourcesPath, "agent-desktop-bin")
		: process.env.OMP_GUI_TEST_AGENT_DESKTOP_BUNDLE ||
			join(devResourcesDir, "agent-desktop-bin", `${process.platform}-${process.arch}`);
	const sessionKinds = new SessionKindStore(join(app.getPath("userData"), "session-kinds.json"));
	// gui-bridge compatibility warnings: once per omp version per launch, taken by whichever window asks first.
	const bridgeHealth = new BridgeHealth(
		() => {
			for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC_EVENTS.BRIDGE_HEALTH);
		},
		() => {
			// One attempt per omp version (BridgeHealth). An omp setup calls missing or broken (a compiled omp, a Bun
			// below its engines.bun) is repaired by setup, with the tested omp; a usable one by the omp updater's
			// repair pass, which runs under "Keep tools up to date" and stays within the tested major like the timer's.
			void tools?.ompRepair().catch(() => undefined);
		},
		// One gui-runtime line per omp version this computer runs, read back by `omp.bridge_health`.
		{ log: writeRuntimeLog },
	);
	// Every IPC handler registers once, here and in what this hands it to: on ipcMain for the app's windows,
	// and in the table a paired web device's calls are dispatched from (web/ipc-registry.ts).
	const ipc = new IpcRegistry(ipcMain);
	// Before any window opens: the shell serves a page only the channels it or main owns.
	await ipc.routeShell(shellIpc, IPC_POLICY);
	// The channels the core serves (none until the pool moves, 9d) register once the core took IPC_POLICY; a core that
	// cannot start leaves them unregistered and every channel main serves as it is.
	ipc.routeCore(core(), IPC_POLICY).catch((error: unknown) =>
		console.warn(
			`[ipc] the core's channels are not served: ${error instanceof Error ? error.message : String(error)}`,
		),
	);
	ipc.handle(IPC_COMMANDS.BRIDGE_HEALTH_TAKE, () => bridgeHealth.take());
	ipc.handle(IPC_COMMANDS.DISK_FULL_GET, () => ({ files: diskFull.names() }));
	// The first local tab boots alone: the stats server and machine setup's optional installs (gh, Node;
	// winget on Windows) wait until a tab's session is ready, or FIRST_TAB_GRACE_MS when none comes (only
	// paired-host tabs, an omp that cannot start). Measured by e2e/first-run-no-omp.e2e.ts.
	const firstTabReady = Promise.withResolvers<void>();
	const afterFirstTab = (): Promise<void> => {
		const grace = Promise.withResolvers<void>();
		setTimeout(grace.resolve, FIRST_TAB_GRACE_MS).unref();
		return Promise.race([firstTabReady.promise, grace.promise]);
	};
	// Autopilot's coordinator is built in ipc.ts (it needs the RPC dispatcher); the factory and TurnResume read it from here.
	const autopilotRef: { current: Autopilot | null } = { current: null };
	const webTabNotice: IpcDeps["webTabNotice"] = { current: null };
	const sessionWake: IpcDeps["sessionWake"] = { current: null };
	const tabReport: IpcDeps["tabReport"] = { current: null };
	const agentOpening: IpcDeps["agentOpening"] = { current: null };
	/** Tabs a lost core took that are still not ready, gathered for one notification (`recovery.stuck*`). */
	let stuckTabs: { count: number; minutes: number } | null = null;
	/**
	 * A tab the core's loss took is not ready `RECOVERY_NOTICE_MS` later (sidecar.ts `onRecoveryStuck`): its opener is told
	 * by a report of the tab's own, the person by one notification for every tab of the loss, and the tab's banner says
	 * it (the answer).
	 */
	function noteRecoveryStuck(sidecar: SidecarManager, stuck: RecoveryStuck): string {
		const minutes = Math.max(1, Math.round(stuck.waitedMs / 60_000));
		const tabId = sidecarPool.resumeFacts().find(fact => sidecarPool.sidecarOf(fact.tabId) === sidecar)?.tabId;
		if (tabId)
			tabReport.current?.(tabId, {
				kind: "blocked",
				// One report per loss of this tab, whoever asks twice.
				id: `core-loss-${stuck.lane}-${Date.now() - stuck.waitedMs}`,
				text: `[OMPdesk] This session's agent has not come back ${minutes} min after OMPdesk's core process restarted${stuck.sessionPath ? ` (session ${basename(stuck.sessionPath)})` : ""}; its work is stopped until the person presses Restart on its tab.`,
			});
		if (!stuckTabs) {
			const burst = { count: 0, minutes };
			stuckTabs = burst;
			// The tabs of one loss reach the bound within moments of each other: one notification counts them all.
			setTimeout(() => {
				stuckTabs = null;
				new Notification({
					title: mainT("recovery.stuckTitle"),
					body: mainT("recovery.stuckBody", undefined, { count: burst.count, minutes: burst.minutes }),
				}).show();
			}, STUCK_NOTICE_GATHER_MS).unref();
		}
		stuckTabs.count++;
		return mainT("recovery.stuckTab");
	}
	// The desktop slot's host is built in ipc.ts next to the pool's wiring; the factory reads it from here.
	const desktopSlotRef: { current: DesktopSlotHost | null } = { current: null };
	// The shared-checkout pass is built in ipc.ts too; the factory runs it when a bridge reports a new changed file.
	const checkoutFilesRef: { current: ((sidecar: object) => void) | null } = { current: null };
	// Memory's address for the bridge's recall in every omp this computer runs, written by the core's memory service.
	const memoryRecallFile = join(app.getPath("userData"), "ai-memory", "recall.json");
	const recallTermsFile = join(app.getPath("userData"), "ai-memory", RECALL_TERMS_FILE);
	mcpHub = new McpHub({
		memoryStateFile: memoryRecallFile,
		log: ({ message, details }) => console.log(`[mcp-hub] ${message}`, details),
	});
	void mcpHub.ompEnv();
	const hub = mcpHub;
	// The omps an earlier instance left running (a crash, a forced quit) stop before any tab's omp starts: the core holds
	// every lane's start (`sidecar.holdStarts`) until the reap has settled, and then starts them a few at a time.
	ompProcesses = new OmpProcesses(join(app.getPath("userData"), OMP_PIDS_FILE), bridgeDir, {
		log: (message, details) => writeRuntimeLog({ source: "omp-reap", message, details }),
	});
	const reaper = ompProcesses;
	void core()
		.call("sidecar.holdStarts", { hold: true })
		.catch(() => undefined)
		.then(() => reaper.reapLeftovers())
		.then(pids => {
			if (pids.length > 0)
				writeRuntimeLog({
					source: "omp-reap",
					message: "stopped omps an earlier launch left running",
					details: { pids: pids.join(",") },
				});
		})
		.finally(() => core().call("sidecar.holdStarts", { hold: false }))
		.catch(() => undefined);
	// Whose the processes a tab's omp starts are: they end once the tab is closed, and this launch ends what the
	// sessions the last one did not bring back left running (session-processes.ts).
	const diskCareLog = (message: string, details: Record<string, unknown>): void =>
		writeRuntimeLog({
			source: "disk-care",
			message,
			details: { level: message === "failed" ? "error" : "info", ...details },
		});
	// A scratch folder per tab for the files its agent makes only to do the work, named by the tab's tag
	// (session-scratch.ts). A launch on a profile of its own (a test, `--user-data-dir`) keeps them in that profile.
	const sessionScratch = new SessionScratch(
		join(app.getPath("userData"), SESSION_SCRATCH_FILE),
		userDataDirectory ? join(app.getPath("userData"), "scratch") : defaultScratchRoot(),
		{ log: (message, details) => diskCareLog("failed", { step: "scratch", reason: message, ...details }) },
	);
	const sessionProcesses = new SessionProcesses(join(app.getPath("userData"), SESSION_PROCESSES_FILE), {
		frozen: () => quitApproved(),
		log: (message, details) => writeRuntimeLog({ source: "session-processes", message, details }),
		scratch: sessionScratch,
		endSpinning: () => prefsStore().get(END_SPINNING_ON_CLOSED_OUTPUT_PREF) !== false,
	});
	const createLocalSidecar = localSidecarFactory({
		bridgeDir,
		builtinDir,
		sessionFree: async sessionPath => {
			const started = Date.now();
			const outcome = await whenSessionFree(sessionPath, {
				owned: path => sessionIndex.ownedElsewhere(path),
				// Fail-open: a stock helper that does not answer must not hold every start for a minute, so the start goes
				// on; the line says a second owner was not ruled out.
				unknown: error =>
					writeRuntimeLog({
						source: "session-owner",
						message: "ownership unknown; opened anyway",
						details: {
							level: "info",
							session: basename(sessionPath),
							error: error instanceof Error ? error.message : String(error),
						},
					}),
			});
			if (outcome === "owned" || Date.now() - started > 1_000)
				writeRuntimeLog({
					source: "session-owner",
					message:
						outcome === "owned" ? "session still owned elsewhere; not opened" : "waited for the session's owner",
					details: { level: "info", session: basename(sessionPath), waitedMs: Date.now() - started },
				});
			return outcome;
		},
		mcpHubEnv: () => hub.ompEnv(),
		agentControlPref: () => prefsStore().get(AGENT_CONTROL_PREF),
		pstackPref: () => prefsStore().get(PSTACK_PREF),
		eccPref: () => prefsStore().get(ECC_PREF),
		onReady: () => firstTabReady.resolve(),
		proxyEnv: resolveProxyEnvForSpawn,
		recoveryStuck: noteRecoveryStuck,
		bridgeHealth,
		sessionKinds,
		replyLanguagePref: () => prefsStore().get(REPLY_LANGUAGE_PREF),
		defaultBrowserPref: () => prefsStore().get(DEFAULT_BROWSER_PREF),
		computerUse: {
			pref: () => prefsStore().get(COMPUTER_USE_PREF),
			toolsDir,
			bundleDir: agentDesktopBundle,
			platform,
		},
		userProfilePref: () => prefsStore().get(USER_PROFILE_PREF),
		nextPromptPrefs: () =>
			nextPromptFromPrefs(prefsStore().get(NEXT_PROMPT_PREF), prefsStore().get(NEXT_PROMPT_INLINE_PREF)),
		autoTitlePrefs: () =>
			autoTitleFromPrefs(prefsStore().get(AUTO_TITLE_PREF), prefsStore().get(AUTO_TITLE_EVOLVE_PREF)),
		judgeAssistPref: () => judgeAssistEnabled(prefsStore().get(JUDGE_ASSIST_PREF)),
		delegationPref: () => prefsStore().get(DELEGATION_PREF),
		accountRotationPref: () => prefsStore().get(ACCOUNT_ROTATION_PREF),
		accountRotationLedger: join(app.getPath("userData"), ACCOUNT_ROTATION_LEDGER_FILE),
		creditSpendPref: () => prefsStore().get(CREDIT_SPEND_PREF),
		ompdeskRolesFile: join(app.getPath("userData"), OMPDESK_ROLES_FILE),
		launchFlags: cwd => prefsStore().launchFlags(cwd),
		// ai-memory's `session-end` (the handoff) needs omp's own shutdown, which only a closed stdin triggers.
		gracefulStopMs: () => (aiMemoryService?.state().phase === "ready" ? 4_000 : 0),
		aiMemoryExtensionArgs: cwd => aiMemoryService?.extensionArgs(cwd) ?? Promise.resolve([]),
		memoryStateFile: memoryRecallFile,
		autopilot: () => autopilotRef.current,
		desktopSlot: () => desktopSlotRef.current,
		checkoutFiles: sidecar => checkoutFilesRef.current?.(sidecar),
		startQueue: {},
		ledgerFile: ompProcesses.file,
		heldQueueFile: join(app.getPath("userData"), "held-queue.json"),
		sessionProcesses,
	});
	initDeletedSessions(join(app.getPath("userData"), "deleted-sessions.json"));
	const [startup, sidebarWorkspace] = await Promise.all([
		startupCwd(prefsStore().get("lastProject")),
		defaultWorkspace(false),
	]);
	const initialCwd = startup.cwd;
	const explicitStartupCwd = startup.explicit ? initialCwd : undefined;
	sessionIndex = new SessionIndex(undefined, initialCwd, sessionKinds.file, bridgeDir);
	const sidebarPrefsChanged = () => {
		for (const win of [...BrowserWindow.getAllWindows(), ...(webHost?.windows.all() ?? [])])
			if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.PREFS_CHANGED, { key: SIDEBAR_PREFS_KEY });
	};
	// The sidebar's project list: a folder the person opened outlives its last session (src/main/sidebar-projects.ts).
	const sidebarProjects = new SidebarProjects({
		read: () => prefsStore().get(SIDEBAR_PROJECTS_PREF),
		write: state => prefsStore().set(SIDEBAR_PROJECTS_PREF, state),
		sessions: () => sessionIndex.listKnown(),
		pinned: () => sidebarViewOf(prefsStore().get(AGENT_HIDDEN_PREFS_KEY)).pinnedProjects,
		layout: {
			read: () => readSidebarPrefs(prefsStore().get(SIDEBAR_PREFS_KEY)),
			write: change => {
				const { change: applied, log } = prefsStore().updateSidebar(change, "host");
				if (log) writeRuntimeLog(log);
				if (applied) sidebarPrefsChanged();
			},
		},
		defaultWorkspace: () => sidebarWorkspace,
		// A removed worktree's project, read off its `gui-<name>-<hash7>` folder name (stock's root and repo hash).
		worktreeLocation: project => stockWorktreeLocation(tablessWorktreeBridge, project),
		worktreeBindings: () => sidecarPool.worktreeBindings(),
		scratchSessions: folder => sessionScratch.sessionsOf(folder),
		onState: state => {
			const update: IpcSidebarProjects = { state };
			// Every window and paired phone page: a page that never heard a removal kept the project until a tap.
			for (const win of [...BrowserWindow.getAllWindows(), ...(webHost?.windows.all() ?? [])]) {
				if (!win.isDestroyed()) win.webContents.send(SIDEBAR_PROJECTS_STATE, update);
			}
			// Devices whose sidebar shows this computer's section follow.
			devices.hostSidebarProjectsChanged(state);
			// The same rule as on a device: a tab restored asleep on a finished worktree here closes.
			closeFinishedTabs(undefined, state);
		},
	});
	sidecarPool = new SidecarPool((cwd, kind, fresh, device, tabId, web) => {
		if (!device) return createLocalSidecar(cwd, kind, fresh, undefined, web);
		// The host runs its own health check, session-kind record and bridge probe; only the probe's verdict comes
		// back, for this machine's toast (no record and no repair here: the host keeps and repairs its own).
		const sc = devices.createSidecar(device, tabId, cwd, kind, fresh);
		sc.on("bridge", (result: BridgeConnectResult) => void bridgeHealth.observe(result));
		return sc;
	});
	// omp's `worktree.onStart` / `worktree.onExit` (omp 18.8.6+), which stock runs only in its TUI.
	const worktreeWindows: WorktreeWindows = {
		live: () => {
			const focused = BrowserWindow.getFocusedWindow();
			const all = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed());
			const ordered = focused && !focused.isDestroyed() ? [focused, ...all.filter(win => win !== focused)] : all;
			return ordered.map(win => win.webContents.id);
		},
		send: (winId, channel, payload) => {
			const win = BrowserWindow.getAllWindows().find(item => !item.isDestroyed() && item.webContents.id === winId);
			win?.webContents.send(channel, payload);
		},
	};
	const prompts = new WorktreePrompts(worktreeWindows);
	const lifecycle = new WorktreeLifecycle(
		{
			bind: (tabId, worktree) => {
				const bound = sidecarPool.bindWorktree(tabId, worktree);
				sidebarProjects.schedule();
				return bound;
			},
		},
		prompts,
		worktreeWindows,
		{ branchPrefix: () => worktreeBranchPrefix(prefsStore().get(WORKTREE_BRANCH_PREFIX_PREF)) },
	);
	worktreePrompts = prompts;
	worktreeLifecycle = lifecycle;
	sidecarPool.worktreeStartGate = (tabId, winId, facts) =>
		isWorktreeStartCandidate(facts) ? lifecycle.startGate(tabId, winId) : null;
	sidecarPool.onTabReleased = (tabId, exited) => lifecycle.released(tabId, exited);
	// This computer's models.yml, stats server and `omp bench`, for its own
	// windows and for the devices that use it as their host.
	// FreeToken and colibri on loopback are listed as providers by themselves (src/main/local-engines.ts). A test
	// launch never probes the developer's real ports unless its spec names a table (OMP_GUI_TEST_LOCAL_ENGINES).
	const hostModelsChanged = { current: () => {} };
	const detector = new LocalEngines({
		...localEngineSettings(process.env, app.isPackaged),
		start: app.isPackaged || process.env.OMP_GUI_TEST_LOCAL_ENGINES !== undefined,
		prefs: prefsStore().path,
		changed: () => {
			for (const win of BrowserWindow.getAllWindows())
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.MODELS_CONFIG_CHANGED);
			for (const win of webHost?.windows.all() ?? [])
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.MODELS_CONFIG_CHANGED);
			// Devices showing this computer's providers read them again (the detector is built before `devices`).
			hostModelsChanged.current();
		},
		failed: (error, engine) =>
			writeRuntimeLog({
				source: "background-task",
				message: "local-engine-failed",
				details: { engine, error },
			}),
	});
	localEngines = detector;
	detector.open();
	const machine = new LocalMachine({
		stats: (path, params) =>
			statsServer?.fetch(path, params) ?? Promise.resolve({ ready: false, exhausted: statsLaunchSettled }),
		statsText: mainT,
		benchmarkOmp: systemOmp,
		benchmarkEnv: async () => ({ ...process.env, ...(await shellSpawnEnv()), ...(await resolveProxyEnvForSpawn()) }),
		localEngines: {
			read: () => prefsStore().get(LOCAL_ENGINE_DETECT_PREF),
			// Stored first (committed by the core, read back at once here), then the core's detector follows it.
			set: enabled => {
				prefsStore().set(LOCAL_ENGINE_DETECT_PREF, enabled);
				return detector.setEnabled(enabled);
			},
		},
		modelSetupPick: {
			read: () => prefsStore().get(MODEL_SETUP_RESEARCH_PICK_PREF),
			write: pick =>
				pick === null
					? prefsStore().delete(MODEL_SETUP_RESEARCH_PICK_PREF)
					: prefsStore().set(MODEL_SETUP_RESEARCH_PICK_PREF, pick),
		},
		desktop: {
			version: appVersion,
			update: {
				status: updateStatus,
				check: checkForUpdate,
				download: downloadUpdate,
				restartable: restartableUpdate,
				restart: () => restartIntoUpdate("user click"),
				postpone: postponeUpdate,
			},
			appearance: () => ({ themeName: prefsStore().get("themeName"), language: prefsStore().get("language") }),
			// Device tabs this computer hosts count too; their own quit prompt never reaches anyone.
			busy: (): boolean => quitRisk().workingTabs > 0 || hostServices.runningPeers().length > 0,
		},
		ompUpdater: () => {
			const client = tools;
			if (!client) throw new Error("OMPdesk is still starting");
			return { state: () => client.state().omp, updateNow: () => client.ompNow() };
		},
		schedules: () => scheduleService,
		sidebarProjects: () => sidebarProjects,
		// With the omp update this computer holds back, for `ompdesk_app` `omp.bridge_health`.
		bridgeHealth: () => {
			const state = tools?.state().omp;
			const held = state?.held;
			return held
				? { ...bridgeHealth.report(), held: { ...held, installed: state?.installed ?? null } }
				: bridgeHealth.report();
		},
		accountRotation: accountRotationDeps({
			prefs: { get: key => prefsStore().get(key), set: (key, value) => prefsStore().set(key, value) },
			tabs: () => sidecarPool.allSidecars(),
			hostedTabsChanged: () => devices.hostAccountRotationChanged(),
			evenSupported: async () => {
				const omp = await systemOmp();
				return omp.ok ? bridgeHealth.supports(omp.runtime.version, "accountRotation") : null;
			},
		}),
		creditSpend: {
			read: () => prefsStore().get(CREDIT_SPEND_PREF),
			write: enabled => {
				prefsStore().set(CREDIT_SPEND_PREF, enabled);
				// When it changed: a usage read or a spent credit is judged by the switch at that time.
				writeRuntimeLog({ source: "credit-spend", message: enabled ? "on" : "off" });
				// Tabs on a paired host follow the host's own pref.
				for (const tab of sidecarPool.allSidecars()) if (!tab.device) tab.syncCreditSpend?.();
				devices.hostCreditSpendChanged();
			},
		},
	});
	// This computer as a host: paired devices' tabs run here through the same factory.
	const prefs = prefsStore();
	// One runtime-log line per stored-session delete, here or asked by a paired device (session-mutations.ts).
	setSessionDeleteLog((outcome, details) => writeRuntimeLog({ source: "session-delete", message: outcome, details }));
	// One runtime-log line per Stop that reaches an omp, naming who asked (turn-stop-log.ts).
	setTurnStopLog({
		write: details => writeRuntimeLog({ source: "turn-stop", message: String(details.by), details }),
		sessionOf: tab =>
			sidecarPool.sessionFileOf(tab) ?? hostServices.resumeFacts().find(fact => fact.tabId === tab)?.sessionFile,
	});
	// While this computer is short of memory a quiet hidden session gives its omp back (idle-release.ts). Unpackaged test
	// launches read memory from OMP_GUI_TEST_MEMORY (a JSON file: totalGb, availableGb, pressure) every
	// OMP_GUI_TEST_MEMORY_MS; a Playwright launch without one reads ample memory, so the machine running the suite never
	// releases its sessions.
	const testMemory = !app.isPackaged ? process.env.OMP_GUI_TEST_MEMORY : undefined;
	const ampleTestMemory = !app.isPackaged && !testMemory && process.env.OMP_GUI_TEST_LAUNCHER_PID !== undefined;
	startMemoryWatch({
		tabs: () => [...sidecarPool.memoryTabs(), ...hostServices.memoryTabs()],
		owners: () => sessionProcesses.owners(),
		log: (message, details) => writeRuntimeLog({ source: "memory", message, details }),
		sampled: (reading, rows, tabs, readAt) =>
			void machineState.sample(
				reading,
				rows,
				tabs.flatMap(tab => (tab.pid === undefined ? [] : [tab.pid])),
				readAt,
			),
		...(testMemory ? { testReading: () => testMemoryReading(testMemory) } : {}),
		...(ampleTestMemory
			? {
					testReading: () => ({
						totalBytes: 64 * 1024 ** 3,
						availableBytes: 48 * 1024 ** 3,
						pressure: "normal" as const,
					}),
				}
			: {}),
		...(process.env.OMP_GUI_TEST_MEMORY_MS && !app.isPackaged
			? { sampleMs: Number(process.env.OMP_GUI_TEST_MEMORY_MS) }
			: {}),
		// A quiet tab gives its omp back while memory is short (idle-release.ts); the pool checks again first.
		release: tabId =>
			void sidecarPool.releaseIdle(tabId).then(
				released => {
					if (!released)
						writeRuntimeLog({ source: "memory", message: "memory release kept", details: { tab: tabId } });
				},
				(error: unknown) =>
					writeRuntimeLog({
						source: "memory",
						message: "memory release failed",
						details: { tab: tabId, error: String(error) },
					}),
			),
		...(process.env.OMP_GUI_TEST_IDLE_RELEASE_MS && !app.isPackaged
			? { releaseQuietMs: Number(process.env.OMP_GUI_TEST_IDLE_RELEASE_MS) }
			: {}),
	});
	// The one builder of what every row shows of this computer's sessions, its windows' tabs and the ones it runs for
	// paired devices alike: this computer's windows and phone pages, every paired computer and `ompdesk_sessions` read it.
	const sessionSummaries: SessionSummaries = new SessionSummaries((): SummarySource[] => [
		...sidecarPool.summarySources(),
		...hostServices.summarySources(),
	]);
	sidecarPool.summaries = sessionSummaries;
	const hostServices = new LocalHostServices({
		createSidecar: createLocalSidecar,
		// A paired computer's attached files land in the phones' upload folder (24 h); `webHost` is made later.
		get uploads() {
			return hostUploads();
		},
		// `devices` is created below; a host tab only opens once it serves connections.
		hostName: (): string => devices.deviceName(),
		sessionIndex,
		agentHidden: () => agentHiddenPaths(prefs.get(AGENT_HIDDEN_PREFS_KEY)),
		sessionMoved: (from, to) => {
			if (prefs.moveSidebarPin(from, to)) {
				sidebarPrefsChanged();
				sidebarProjects.schedule();
			}
		},
		renameStoredSession: async (sessionPath, name) => {
			const omp = await systemOmp();
			if (!omp.ok) throw new Error(omp.error);
			await renameStoredSession(omp.runtime, sessionPath, name);
		},
		defaultWorkspace,
		launchProfiles: prefs,
		machine,
		localTabs: sidecarPool,
		summaries: sessionSummaries,
		windowRemoteOpened: () => sidecarPool.remoteOpenedTabs(),
		sessionOpeners: () => {
			// A record of a child main closed, for one on this computer; a tab that holds the session again wins.
			const openers = new Map(
				parseClosedChildren(prefs.get(AGENT_CLOSED_CHILDREN_PREF)).flatMap(row =>
					row.device ? [] : [[row.path, row.openedBySession] as const],
				),
			);
			for (const [child, opener] of sidecarPool.sessionOpeners()) openers.set(child, opener);
			return openers;
		},
		mobileWebUrl: () => mobileWebService?.state().url ?? null,
		trashItem: abs => shell.trashItem(abs),
		...(Number(process.env.OMP_GUI_TEST_HOST_WAIT_MS) > 0 && !app.isPackaged
			? { hostWaitNoticeMs: Number(process.env.OMP_GUI_TEST_HOST_WAIT_MS) }
			: {}),
		// One notification per wait: the turn of a paired device's session stands in a call only that device runs.
		hostWaiting: ({ device, title }) =>
			new Notification({
				title: mainT("remote.hostWait.title", undefined, { device }),
				body: title
					? mainT("remote.hostWait.body", undefined, { session: title, device })
					: mainT("remote.hostWait.bodyUntitled", undefined, { device }),
			}).show(),
		// Autopilot runs paired devices started here, charged to them until they end (remote/hosted-autopilot.ts).
		runChargesFile: join(app.getPath("userData"), "autopilot-device-runs.json"),
		// A device's session here keeps its reports and notices while the device is away, until it is back.
		keptCallsFile: join(app.getPath("userData"), "kept-host-calls.json"),
	});
	// Orphaned worktrees (worktree-orphans.ts): a folder is open when a tab of this computer or a tab it hosts for a
	// paired device runs in it (`hostServices.workspaceDirs()` is the cwd of every hosted tab, a superset of its `summarySources()`).
	setOpenFoldersSource(() => [...sidecarPool.workspaceDirs(), ...hostServices.workspaceDirs()]);
	let hostOmpVersion: string | null = null;
	void systemOmp().then(resolution => {
		if (resolution.ok) hostOmpVersion = resolution.runtime.version;
	});
	// Tailscale, read-only: computer sharing (src/main/remote/) works over the tailnet only and asks Tailscale who
	// connects. `OMP_GUI_TAILSCALE` (tests) names a fake CLI; Mobile web below locates the same way.
	const tailscaleOs = platform === "other" ? null : platform;
	const stringPref = (key: string): string | null => {
		const value = prefs.get(key);
		return typeof value === "string" && value.trim() ? value : null;
	};
	const locateTs = async () =>
		tailscaleOs
			? locateTailscale({
					platform: tailscaleOs,
					pref: stringPref("mobileWeb.tailscaleBin"),
					pathEnv: await spawnPath(),
					bundle: true,
				})
			: null;
	const tailnet = new Tailnet({ locate: locateTs });
	// A test launch never changes the machine's power settings (a killed test app would leave them changed), and a
	// second instance must not undo the running one's hold as a leftover.
	lidAwake =
		process.env.OMP_GUI_HEADLESS === "1" || !gotLock
			? null
			: createLidAwake({
					userData: app.getPath("userData"),
					onAc: !powerMonitor.isOnBatteryPower(),
					log: (message, details) => writeRuntimeLog({ source: "keep-awake", message, details }),
				});
	void lidAwake?.start();
	powerMonitor.on("on-ac", () => lidAwake?.setOnAc(true));
	powerMonitor.on("on-battery", () => lidAwake?.setOnAc(false));
	const keepAwakeBlocker = (label: string) => {
		const blocker = {
			start: () => powerSaveBlocker.start("prevent-app-suspension"),
			stop: (id: number) => powerSaveBlocker.stop(id),
		};
		return lidAwake ? lidAwake.wrap(blocker, label) : blocker;
	};
	const deviceOrderStore = prefsFile("sidebar-device-order");
	const devices = new RemoteDevices({
		userData: app.getPath("userData"),
		identity: await remoteIdentity,
		appVersion: app.getVersion(),
		prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
		deviceOrderStore,
		broadcast: (channel, data) => {
			for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, data);
			// A paired phone's page lists the hosts' sessions and projects too: what changed
			// in a host's list reaches it as it reaches a window, or a rename or delete made anywhere stayed until a reload.
			if (
				channel === IPC_EVENTS.REMOTE_STATE ||
				channel === IPC_EVENTS.SESSIONS_CHANGED ||
				channel === IPC_EVENTS.SESSION_SUMMARIES_CHANGED ||
				channel === IPC_EVENTS.MODELS_CONFIG_CHANGED ||
				channel === SIDEBAR_PROJECTS_STATE
			)
				for (const page of webHost?.windows.all() ?? [])
					if (!page.isDestroyed()) page.webContents.send(channel, data);
		},
		services: hostServices,
		modelWait: sidecarPool.modelWait,
		machineInfo: () => ({ platform: process.platform, ompVersion: hostOmpVersion, home: homedir(), sep }),
		offlineMessage: () => mainT("remote.offline"),
		unansweredMessage: device => mainT("remote.tabUnanswered", undefined, { device }),
		logTab: (step, details) => writeRuntimeLog({ source: "remote-tab", message: step, details }),
		signInRelay: {
			failure: device => ({
				title: mainT("remote.signInRelay.title"),
				message: mainT("remote.signInRelay.failed", undefined, { device }),
			}),
			// Test seam: two apps on one computer share its loopback, so e2e/sign-in-relay.e2e.ts gives the device another port.
			...(Number(process.env.OMP_GUI_TEST_SIGN_IN_RELAY_PORT) > 0
				? { port: Number(process.env.OMP_GUI_TEST_SIGN_IN_RELAY_PORT) }
				: {}),
		},
		// A quit (update restart included) leaves the turns a paired host runs for this computer running there, as it
		// leaves this computer's own to continue after the relaunch. With "Continue interrupted work" off the quit
		// dialog counted those turns and promised to stop them, so their host tabs close as before.
		keepHostTabsOnQuit: () => quitApproved() && prefs.get(RESUME_INTERRUPTED_PREF) !== false,
		powerSaveBlocker: keepAwakeBlocker("host"),
		tailnet,
		allowedUsers: () => mobileWebService?.allowedUsers() ?? [],
		adoptLogin: login => mobileWebService?.adoptLogin(login),
		blocks: () => webHost?.blocks ?? null,
		confirm: async details => {
			const confirmations = webHost?.confirmations;
			if (!confirmations) return false;
			const outcome = await confirmations.request({
				kind: "computer",
				name: details.name,
				userAgent: details.nodeName ?? "",
				tailscaleLogin: details.login,
				ip: details.ip,
			});
			return outcome.approved;
		},
		tailscaleAction: async action => {
			await mobileWebService?.request({ action });
		},
		loopback: !app.isPackaged && process.env.OMP_GUI_TEST_REMOTE_LOOPBACK === "1",
		log: (message, details) => writeRuntimeLog({ source: "remote", message, details }),
		logLink: (message, details) => writeRuntimeLog({ source: "remote-link", message, details }),
	});
	remoteDevices = devices;
	// The core's records are mirrored before anything asks for a host's tabs or the device lists.
	await devices
		.ready()
		.catch(error =>
			console.warn(`[remote] devices unavailable: ${error instanceof Error ? error.message : String(error)}`),
		);
	hostModelsChanged.current = () => devices.hostModelsChanged();
	// Devices that use this computer as their host say "n sessions wait together" from its own count (its account).
	let lastModelWaitLocal = "{}";
	sidecarPool.modelWait.onChange(({ local }) => {
		const signature = JSON.stringify(Object.entries(local).sort());
		if (signature === lastModelWaitLocal) return;
		lastModelWaitLocal = signature;
		devices.hostModelWaitChanged(local);
	});
	// A paired web device's window is filed under the device (its window id changes every launch); a quit tears
	// the tabs down, which must not read as the device closing them.
	sidecarPool.onWindowTabsChanged = (win, layout) => {
		// A window's tab took or let go of a session, or learned who opened it: paired devices may list it otherwise, and
		// a tab on a paired device that a session here opened is every other view's family row.
		hostServices.listingChanged();
		hostServices.workChanged();
		if (win instanceof WebClientWindow) {
			if (!quitApproved()) webTabLayouts.save(win.deviceId, layout);
			return;
		}
		persistTabLayouts();
	};
	// Every take or let-go of a session file, a session-id change too (it re-registers only at the next get_state):
	// the devices' "held on this host" follows each one, so no device's read in the gap can hide a later close.
	sidecarPool.onSessionFilesChanged = () => {
		hostServices.listingChanged();
		hostServices.workChanged();
	};
	// A closed window's tabs have to leave the saved session with it, or the next
	// launch resurrects a window the user deliberately shut.
	windowManager.subscribeWindowClosed(record => {
		worktreePrompts?.windowClosed(record.id);
		persistTabLayouts();
	});
	// Stats dashboard: omp's own dashboard API from the user's omp install. A
	// missing or too-old omp already surfaces on every tab; the dashboard just
	// stays unavailable until setup installs omp (launchStats runs again then).
	const launchStats = () =>
		afterFirstTab()
			.then(() => Promise.all([systemOmp(), spawnPath()]))
			.then(([resolution, basePath]) => {
				// A quit tears the stats server down: a launch that resolves after it must not start a new one.
				if (!resolution.ok || statsServer || quitApproved()) return;
				const packageRoot = ompPackageRoot(resolution.runtime.bin);
				if (!packageRoot) {
					console.warn(`[stats-server] cannot locate the omp package behind ${resolution.runtime.bin}`);
					return;
				}
				statsServer = new StatsServerManager({
					command: "bun",
					args: [join(bridgeDir, "stats-host.ts")],
					env: { PATH: ompPathEnv(resolution.runtime.bin, basePath), OMP_PACKAGE_ROOT: packageRoot },
				});
				return statsServer.start();
			})
			.finally(() => {
				statsLaunchSettled = true;
			});
	void launchStats().catch(error => console.warn("[stats-server] could not start", error));
	// Accessibility and Screen Recording cannot be granted by an app: macOS checks OMPdesk's grant for both engines.
	// After the first tab is up, a missing one OMPdesk never asked for gets macOS's own prompt; Settings › Agent
	// behavior › Computer use and a failed computer-use step keep the state and the button.
	const macPermissions = new MacPermissions({
		platform: process.platform,
		prefs: prefsStore(),
		// The copy sessions run (the bundled one, or a newer managed one): it runs under OMPdesk either way.
		agentDesktop: async () =>
			(await agentDesktopToRun({ toolsDir, bundleDir: agentDesktopBundle, platform }))?.path ?? null,
		run: async (executable, args) => (await promisify(execFile)(executable, [...args], { timeout: 30_000 })).stdout,
		accessibilityTrusted: prompt => accessibilityTrusted(prompt),
		screenGranted: () => screenRecordingGranted(),
		openPane: url => shell.openExternal(url),
	});
	// Only a packaged, non-headless app asks on its own: a dev or test launch must never raise a system prompt. After
	// the first tab, and again when a window gains focus: the person comes back from System Settings, and a permission
	// that had to wait for the other one's prompt is asked then.
	if (app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1") {
		const askMacPermissions = () =>
			macPermissions
				.askMissing()
				.then(asked => {
					if (asked.length > 0)
						writeRuntimeLog({ source: "background-task", message: "mac-permissions-asked", details: { asked } });
				})
				.catch(error =>
					writeRuntimeLog({
						source: "background-task",
						message: "mac-permissions-failed",
						details: { error: String(error) },
					}),
				);
		void afterFirstTab().then(() => {
			void askMacPermissions();
			app.on("browser-window-focus", () => void askMacPermissions());
		});
	}

	// This machine's setup and the omp, tool CLI and extension updaters: one instance of the core's `tools` kind
	// (src/main/tools/, crates/core/src/tools/) on one queue. Setup detects Bun/omp/Git/gh/Node and, in a packaged app,
	// installs what is missing on its own; tests opt in with a fake installer (OMP_GUI_TEST_INSTALLER); headless test
	// runs never install. omp, the vendor CLIs of connected accounts and omp's extensions keep current under "Keep
	// tools up to date": a packaged app checks on its own, a test launch only with the fake installer and its
	// OMP_GUI_TEST_*_UPDATES=1. With the hidden pref `ompFollowVerified` omp follows the verified list; a test launch
	// reads that list from the file OMP_GUI_TEST_OMP_COMPAT names, never from the network. OMPdesk's own update stays
	// manual.
	const testInstaller = process.env.OMP_GUI_TEST_INSTALLER || null;
	const scheduledUpdates = (testFlag: string) =>
		testInstaller ? process.env[testFlag] === "1" : app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1";
	const toolsClient = new ToolsClient({
		opts: {
			platform,
			arch: process.arch,
			toolsDir,
			userData: app.getPath("userData"),
			appVersion: appVersion(),
			testedOmp: TESTED_OMP_VERSION,
			// Safe mode pauses automatic installs; Retry still runs one.
			automatic: !safeMode && (testInstaller !== null || (app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1")),
			scheduled: {
				omp: scheduledUpdates("OMP_GUI_TEST_OMP_UPDATES"),
				cli: scheduledUpdates("OMP_GUI_TEST_CLI_UPDATES"),
				ext: scheduledUpdates("OMP_GUI_TEST_EXT_UPDATES"),
			},
			testInstaller,
			testDownload:
				testInstaller && process.env.OMP_GUI_TEST_DOWNLOAD
					? { url: process.env.OMP_GUI_TEST_DOWNLOAD, sha256: process.env.OMP_GUI_TEST_DOWNLOAD_SHA256 ?? "" }
					: null,
			testOmpCompat: app.isPackaged ? null : (process.env.OMP_GUI_TEST_OMP_COMPAT ?? null),
			systemRoot: process.env.SystemRoot || "C:\\Windows",
			agentDesktopBundle,
			bunInstall: bunInstallDir(process.env, homedir()),
			locale: new Intl.Collator().resolvedOptions().locale,
			// A relative PATH entry or launcher resolves against main's directories, not the core's.
			cwd: process.cwd(),
			driveCwds:
				process.platform === "win32"
					? Object.fromEntries(
							Object.entries(process.env).flatMap(([key, value]) =>
								/^=[A-Za-z]:$/.test(key) && value ? [[key, value]] : [],
							),
						)
					: {},
		},
		asks: {
			// The core adds the proxy itself; detection reads main's own environment with the spawn PATH (detectMachine).
			env: async detect =>
				detect ? { ...process.env, PATH: await spawnPath() } : { ...process.env, ...(await shellSpawnEnv()) },
			refreshPath: () => refreshPath(platform, toolsDir),
			ompResolution: fresh => (fresh ? refreshSystemOmp() : systemOmp()),
			ompReady: () => {
				markStartup("omp-ready");
				void launchStats();
				// Local tabs that failed for lack of omp start now; tabs on paired hosts are theirs.
				for (const sidecar of sidecarPool.allSidecars()) {
					if (sidecar.device === undefined && (sidecar.status === "error" || sidecar.status === "exited")) {
						sidecar.restart();
					}
				}
			},
			firstTab: afterFirstTab,
			releaseHelpers: async () => {
				const stats = statsServer;
				statsServer = null;
				await Promise.all([stats?.kill(), stopStockHelper()]);
			},
			resume: async updated => {
				if (updated) {
					const resolution = await refreshSystemOmp();
					if (resolution.ok) hostOmpVersion = resolution.runtime.version;
				}
				await launchStats();
				if (updated) {
					sidecarPool.restartOnNewOmp();
					hostServices.restartOnNewOmp();
				}
			},
			applyExtensionUpdate: plan => {
				sidecarPool.applyExtensionUpdate(plan);
				hostServices.applyExtensionUpdate(plan);
			},
			// A held omp under the verified list (the core decides when): one runners failed once and once more after a
			// day, one still waiting for them after 6 hours and then every 24 hours.
			notify: (kind, params) => {
				if (kind !== "ompHold") return;
				const text = params as Record<string, string | number>;
				const verifying = text.reason === "verifying";
				const days = Number(text.days) > 0;
				new Notification({
					title: mainT(verifying ? "ompHold.verifyingTitle" : "ompHold.title", undefined, text),
					body: mainT(
						verifying
							? days
								? "ompHold.verifyingBodyDays"
								: "ompHold.verifyingBody"
							: days
								? "ompHold.bodyDays"
								: "ompHold.body",
						undefined,
						text,
					),
				}).show();
			},
			stock: (method, params, timeoutMs) => stockHelperRequest(method, params, { timeoutMs }),
			workspaceDirs: () => [...new Set([...sidecarPool.workspaceDirs(), ...hostServices.workspaceDirs()])],
		},
		onState: (part, state) => {
			const send = (channel: string) => {
				for (const win of BrowserWindow.getAllWindows()) {
					if (!win.isDestroyed()) win.webContents.send(channel, state);
				}
			};
			if (part === "omp") {
				send(IPC_EVENTS.OMP_UPDATE_STATE);
				// Devices that use this computer as their host show the same state.
				devices.hostOmpUpdateChanged(state as OmpUpdateState);
			} else if (part === "cli") send(IPC_EVENTS.CLI_UPDATE_STATE);
			else if (part === "ext") send(IPC_EVENTS.EXTENSION_UPDATE_STATE);
			else {
				const setup = state as SetupState;
				send(IPC_EVENTS.SETUP_STATE);
				mobileWebService?.onSetupState(setup);
				// ai-memory's wiring waits for Bun on Windows: it runs again (once) when the setup reports Bun present.
				if (setup.items.some(item => item.id === "bun" && item.presence?.kind === "present")) {
					aiMemoryService?.bunInstalled();
				}
				if (setup.items.some(item => item.presence !== null)) markStartup("setup-detected");
				// omp just became usable: local tabs that waited for it start now (tabs on paired hosts are theirs),
				// and a session list refused meanwhile is read again.
				const usable = followSetupState(setup);
				if (!usable) return;
				for (const sidecar of sidecarPool.allSidecars()) {
					if (sidecar.device === undefined && sidecar.status === "waiting") sidecar.restart();
				}
				if (usable.refused) sessionIndex.relist();
			}
		},
		// One quiet toast, in one window.
		onOmpUpdated: version => {
			const windows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed());
			const target = BrowserWindow.getFocusedWindow() ?? windows[0];
			target?.webContents.send(IPC_EVENTS.OMP_UPDATED, { version });
		},
	});
	tools = toolsClient;
	registerToolsIpc(ipc, toolsClient);
	const diagnostics: DiagnosticsDeps = {
		system: () => ({
			appVersion: appVersion(),
			packaged: app.isPackaged,
			electron: shellEngine(),
			chrome: process.versions.chrome ?? "?",
			node: process.versions.node ?? "?",
			platform: process.platform,
			arch: process.arch,
			osRelease: release(),
			osVersion: systemVersion(),
			language: deviceLanguage() ?? null,
		}),
		setupState: () => toolsClient.state().setup,
		readLog: readDiagnosticLog,
		pairedVersions: () => {
			const state = devices.state();
			return {
				hosts: state.hosts.flatMap(host => (host.state === "online" && host.appVersion ? [host.appVersion] : [])),
				devices: state.host.peers.flatMap(peer => (peer.online && peer.appVersion ? [peer.appVersion] : [])),
			};
		},
		display: async () => ({
			rendering: (await softwareCompositing()) ? "software" : "hardware",
			reducedMotion:
				typeof systemPreferences.getAnimationSettings === "function"
					? systemPreferences.getAnimationSettings().prefersReducedMotion
					: null,
		}),
	};
	registerDiagnosticsIpc(ipc, diagnostics);
	registerDiagnosticBundleIpc(ipc, {
		tabFor: poolTabFor(sidecarPool),
		agentHidden: () => agentHiddenPaths(prefs.get(AGENT_HIDDEN_PREFS_KEY)),
		diagnosticsText: () => currentDiagnosticsReport(diagnostics),
		readHostFile: async (tab, file) =>
			decodeBinaryRead(
				await devices.request(
					tab.device,
					"host.fs.readBinary",
					{ path: file, rtab: tab.tabId, cwd: tab.sidecar.cwd },
					HOST_FS_READ_BINARY_TIMEOUT_MS,
				),
			),
		fileName: diagnosticBundleFileName,
		chooseFile: async (caller, defaultPath) => {
			if (!caller.browserWindow) return null;
			const chosen = await dialog.showSaveDialog(caller.browserWindow, {
				defaultPath,
				filters: [{ name: "Zip", extensions: ["zip"] }],
			});
			return chosen.canceled ? null : (chosen.filePath ?? null);
		},
		downloadsDir: () => app.getPath("downloads"),
	});
	// One session's MCP change (an add, an adopted server, a sign-in, a reload) reaches every live session of this
	// computer, the tabs it hosts for paired devices included (mcp-live.ts).
	onMcpChange(change => {
		const plan = { ...EMPTY_APPLY_PLAN, mcp: change };
		sidecarPool.applyExtensionUpdate(plan);
		hostServices.applyExtensionUpdate(plan);
	});
	// ai-memory is OMPdesk's memory (src/main/ai-memory/, always on, no switch): the shipped binary is staged
	// into the tools dir, its per-user service serves it, and the omp sessions OMPdesk spawns load an app-owned
	// extension root with `-e` (nothing is written to ~/.omp/agent). A dev build reports only; OMP_GUI_AI_MEMORY_BIN
	// (tests, a developer's own build) runs exactly that binary; OMP_GUI_AI_MEMORY_UNIT_PIDFILE (the e2e fake's
	// "service" is a pid file) stands in for the OS service.
	const aiMemoryBinary = process.env.OMP_GUI_AI_MEMORY_BIN || null;
	const aiMemoryUnitPidFile = process.env.OMP_GUI_AI_MEMORY_UNIT_PIDFILE || null;
	/** The phase memory last reported (`onState`): a sync catches up when it turns `ready`. */
	let aiMemoryPhase: string | null = null;
	const aiMemory = new AiMemoryService({
		platform,
		arch: process.arch,
		automatic: !safeMode && (aiMemoryBinary !== null || (app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1")),
		toolsDir,
		bundledDir: app.isPackaged
			? join(process.resourcesPath, "ai-memory-bin")
			: join(devResourcesDir, "ai-memory-bin", `${process.platform}-${process.arch}`),
		binaryOverride: aiMemoryBinary,
		noService: process.env.OMP_GUI_AI_MEMORY_NO_SERVICE === "1",
		// e2e runs shorten the automatic re-runs of a failed wiring pass with the same seam as the scheduled turn retry.
		...(process.env.OMP_GUI_RETRY_DELAYS_MS
			? { retryDelaysMs: retryDelays(process.env.OMP_GUI_RETRY_DELAYS_MS) }
			: {}),
		home: homedir(),
		agentDir,
		rootDir: join(app.getPath("userData"), "ai-memory", "omp-ext"),
		recallFile: memoryRecallFile,
		terminalPref: () => {
			const stored = prefs.get(AI_MEMORY_TERMINAL_PREF);
			return typeof stored === "boolean" ? stored : undefined;
		},
		persistTerminal: enabled => prefs.set(AI_MEMORY_TERMINAL_PREF, enabled),
		...(aiMemoryUnitPidFile ? { unit: pidFileControl(aiMemoryUnitPidFile) } : {}),
		spawnEnv: async () => ({ ...process.env, ...(await shellSpawnEnv()) }),
		beforeStart: afterFirstTab,
		// Windows starts `setup` through Bun; on a fresh machine the setup may still be installing it, and the setup's
		// state (its `onState` above) runs the wiring again once Bun is there.
		...(platform === "win32"
			? { bunPresent: async () => findBun({ ...process.env, ...(await shellSpawnEnv()) }) !== null }
			: {}),
		quality: () => {
			if (!aiMemoryCare || !aiMemoryUpkeep) throw new Error("Memory quality clients are not initialized");
			return { care: aiMemoryCare.service, upkeep: aiMemoryUpkeep.service, recallTermsFile };
		},
		onState: state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.AI_MEMORY_STATE, state);
			}
			// Memory just came up: catch up with the computers this one is connected to.
			if (state.phase === "ready" && aiMemoryPhase !== "ready") {
				aiMemorySync?.syncAll();
			}
			aiMemoryPhase = state.phase;
		},
		log: (message, details) => writeRuntimeLog({ source: "ai-memory", message, details }),
	});
	aiMemoryService = aiMemory;
	// Memory's own quality upkeep (src/main/ai-memory/upkeep.ts): repairs old titles and child handoffs once per launch,
	// and learns decisions/rules/gotchas from a person's paused conversations on the user's cheap model.
	const memoryClient = new AiMemoryClient({
		url: () => aiMemory.state().serverUrl,
		dataDir: () => aiMemory.state().dataDir,
	});
	aiMemoryUpkeep = new MemoryUpkeep({
		client: memoryClient,
		omp: ompLaunch,
		modelCwd: join(app.getPath("temp"), "ompdesk-memory-upkeep"),
		stateFile: join(app.getPath("userData"), "ai-memory", "upkeep.json"),
		log: (message, details) => writeRuntimeLog({ source: "ai-memory", message: `upkeep-${message}`, details }),
	});
	// Memory's own care (src/main/ai-memory/care.ts): after each update and then daily it fills in older conversations'
	// conclusions, hides pages a newer one repeats or contradicts and pages naming files that are gone; quiet but for the
	// runtime log and one line in Settings › Memory › Maintenance with Undo. The core runs the units; main hands every
	// tick the sessions folder, this computer's device id, how to judge (the judge switch is read per tick) and git's rules.
	aiMemoryCare = new MemoryCare({
		client: memoryClient,
		sessionsDir: sessionIndex.sessionsDir,
		origin: () => devices.deviceId,
		judge: {
			enabled: () => judgeAssistEnabled(prefs.get(JUDGE_ASSIST_PREF)),
			hostFile: join(bridgeDir, "memory-judge-host.ts"),
			cwd: join(app.getPath("temp"), "ompdesk-memory-upkeep"),
		},
		omp: ompLaunch,
		version: app.getVersion(),
		stateFile: join(app.getPath("userData"), "ai-memory", "care.json"),
		log: (message, details) => writeRuntimeLog({ source: "ai-memory", message, details }),
	});
	// Memory shared between the person's paired computers (the core's memsync, src/main/ai-memory/sync.ts): durable
	// pages and session conclusions, over the remote link. This computer serves `host.memory.*` to the devices allowed
	// to use it, and syncs with every host it is connected to when the link comes up, when memory comes up, and every
	// few minutes.
	const memoryReady = (): boolean => aiMemory.state().phase === "ready";
	const memoryHost = {
		server: () => (memoryReady() ? memoryClient.server() : null),
		selfId: () => devices.deviceId,
	};
	hostServices.attachMemory({
		pull: (peer, params) => servePull(memoryHost, peer, params),
		push: (peer, params) => servePush(memoryHost, peer, params),
		conclusionsPull: (peer, params) => serveConclusionPull(memoryHost, peer, params),
		conclusionsPush: (peer, params) => serveConclusionPush(memoryHost, peer, params),
		allows: deviceId => devices.allowsPeer(deviceId),
	});
	aiMemorySync = new MemorySync({
		...memoryHost,
		onlineHosts: () => devices.onlineHosts(),
		request: (host, method, params, timeoutMs) => devices.request(host, method, params, timeoutMs),
		stateFile: join(app.getPath("userData"), "ai-memory", "sync.json"),
		log: (message, details) => writeRuntimeLog({ source: "memory-sync", message, details }),
		// e2e: the memory-sync spec waits seconds, not minutes.
		...(Number(process.env.OMP_GUI_TEST_MEMORY_SYNC_MS) > 0
			? { intervalMs: Number(process.env.OMP_GUI_TEST_MEMORY_SYNC_MS) }
			: {}),
	});
	devices.onHostOnline(host => aiMemorySync?.hostOnline(host));
	// A host's tab that kept running for this computer comes back attached: one the saved layout restored deferred is
	// started, one the layout lost (a quit that stalled before the relaunch) opens in the front window, adopted by
	// session path, under the ids the host knows.
	devices.onHostOnline(host => {
		void readoptHostTabs(host, {
			kept: deviceId => devices.keptTabs(deviceId),
			holder: (deviceId, sessionPath) => sidecarPool.sessionOwner(sessionPath, deviceId)?.tabId ?? null,
			start: tabId => {
				if (quitApproved() || sidecarPool.sidecarOf(tabId)?.status !== "asleep") return false;
				sidecarPool.startTab(tabId);
				return true;
			},
			open: (deviceId, tab) => {
				const win = windowManager.getTargetWindow();
				if (!win || quitApproved()) return null;
				const tabId = nextSnowflake();
				const sidecar = sidecarPool.acquire(
					tab.cwd,
					win,
					tabId,
					tab.sessionPath,
					tab.kind,
					undefined,
					false,
					false,
					false,
					tab.title,
					deviceId,
					undefined,
					[tab.rtab, ...tab.formerRtabs],
				);
				return sidecar ? tabId : null;
			},
			log: (step, details) => writeRuntimeLog({ source: "remote-tab", message: step, details }),
		});
	});
	// A tab restored asleep on a host's finished worktree closes, as one here does: the host's list is read as its link
	// comes up (the push follows only changes), then each change it pushes (`host.projects.changed`).
	devices.onHostOnline(host => {
		void devices
			.request<unknown>(host, "host.projects.command", { request: { action: "get" } })
			.then(data => closeFinishedTabs(host, SidebarProjectsStateSchema.parse(data)))
			.catch((error: unknown) =>
				writeRuntimeLog({
					source: "tab-layout",
					message: "finished worktree read failed",
					details: { level: "warn", device: host, error: error instanceof Error ? error.message : String(error) },
				}),
			);
	});
	devices.onHostProjects(closeFinishedTabs);
	// A session its host deleted closes every tab here on it, asleep ones too: told as it is deleted
	// (`host.sessionsDeleted`) and, for a delete this computer was off the link for, asked as the link comes up
	// (`sessions.deleted`, the paths this computer's tabs on that host hold; an older host answers none).
	devices.onHostSessionsDeleted((host, paths) => closeHostDeletedTabs(host, paths));
	devices.onHostOnline(host => {
		const held = sidecarPool.deviceSessionFiles(host);
		if (held.length === 0) return;
		void devices
			.deletedOnHost(host, held)
			.then(deleted => {
				if (deleted && deleted.length > 0) closeHostDeletedTabs(host, deleted);
			})
			.catch((error: unknown) =>
				writeRuntimeLog({
					source: "tab-layout",
					message: "deleted sessions read failed",
					details: { level: "warn", device: host, error: error instanceof Error ? error.message : String(error) },
				}),
			);
	});
	aiMemorySync.start();
	registerAiMemoryIpc(ipc, aiMemory, {
		openExternal: url => shell.openExternal(url),
		openPath: path => shell.openPath(path),
		copyPassword: clipboard.writePassword,
		care: () => aiMemoryCare,
	});
	// start() turns every failure into the `failed` phase and a log line; anything escaping it is logged too.
	void aiMemory.start().catch(error =>
		writeRuntimeLog({
			source: "ai-memory",
			message: "failed",
			stack: error instanceof Error ? error.stack : undefined,
			details: { detail: error instanceof Error ? error.message : String(error) },
		}),
	);
	// Setup's first pass, then the scheduled updaters (and stock's `update.auto` takeover) on their timers. A core that
	// cannot answer now starts it when the instance opens again on the next one (tools/client.ts).
	try {
		toolsClient.start();
	} catch {}
	githubAuthService = createGithubAuthService(
		state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.GITHUB_AUTH_STATE, state);
			}
		},
		{
			// A sign-in that finds gh missing installs it right then through setup's gh item (no back-off).
			installGh: () => toolsClient.installForConnection("gh"),
			cancelGhInstall: () => {
				if (toolsClient.state().setup.items.find(item => item.id === "gh")?.phase === "running") {
					toolsClient.setupCancel();
				}
			},
		},
	);
	registerGithubAuthIpc(ipc, githubAuthService);
	// A scheduled run starts new agent work: it waits like any while this computer's memory is in danger.
	const launchScheduledRun = ompRunLauncher({
		omp: systemOmp,
		env: async () => ({ ...process.env, ...(await shellSpawnEnv()), ...(await resolveProxyEnvForSpawn()) }),
		extensionArgs: cwd => aiMemoryService?.extensionArgs(cwd) ?? Promise.resolve([]),
		extensionEnv: () => mcpHub?.ompEnv() ?? Promise.resolve({}),
		creditSpend: () => creditSpendRun(bridgeDir, creditSpendEnabled(prefsStore().get(CREDIT_SPEND_PREF))),
	});
	scheduleService = new ScheduleService({
		file: join(app.getPath("userData"), "schedules.json"),
		logDir: join(app.getPath("userData"), "schedule-runs"),
		launch: launchScheduledRun,
		onState: state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(SCHEDULES_STATE, state);
			}
			// Devices showing this computer's schedules (Settings › Schedules on a tab here) follow.
			devices.hostSchedulesChanged(state);
		},
		// A session's own wake-up (`ompdesk_schedule` with `target: "self"`) is delivered into that session by the control
		// tools; the test launches shorten the check and the minute so a wake comes within seconds.
		wake: async (schedule, runId) => {
			if (!sessionWake.current) throw new Error("OMPdesk is still starting");
			return sessionWake.current(schedule, runId);
		},
		...(process.env.OMP_GUI_TEST_SCHEDULE_TICK_MS
			? { tickMs: Number(process.env.OMP_GUI_TEST_SCHEDULE_TICK_MS) }
			: {}),
		...(process.env.OMP_GUI_TEST_SCHEDULE_MINUTE_MS
			? { minuteMs: Number(process.env.OMP_GUI_TEST_SCHEDULE_MINUTE_MS) }
			: {}),
		// A schedule a paired device saved here spends that device's daily model requests at every start.
		reserve: device => {
			const reservation = devices.reserveModelRequest(device);
			return reservation.ok
				? reservation
				: {
						ok: false,
						reason: `The daily ${reservation.refusal === "requests" ? "request" : "token"} limit of the device that saved this schedule is used up on this computer's models`,
					};
		},
	});
	// The owner's mailboxes for email routines; each password is kept encrypted by the OS keystore (mail-accounts.ts).
	mailAccounts = new MailAccounts({
		dir: app.getPath("userData"),
		...(keychainWouldAskForTests ? { rememberSaved: false } : {}),
		// A test launch reaches its fake IMAP server over plain TCP on this computer; a real launch always uses TLS.
		plainLoopback: Boolean(process.env.OMP_GUI_TEST_IMAP_PLAIN),
		box: {
			available: () => safeStorage.isEncryptionAvailable(),
			blocked: () => (keychainWouldAskForTests ? KEYCHAIN_WOULD_ASK : safeStorageUnavailableReason()),
			encrypt: text => safeStorage.encryptString(text),
			decrypt: data => safeStorage.decryptString(data),
		},
	});
	// Before the first window exists, so its page load is seen (it also writes the update's start mark, below).
	const firstWindowReady = firstWindowLoaded();
	void scheduleService
		.start({
			...routinePorts(sidecarPool, mailAccounts),
			file: join(app.getPath("userData"), "routine-marks.json"),
			// A routine catching up after relaunch may open a session.
			ready: firstWindowReady,
			log: message => writeRuntimeLog({ source: "routines", message }),
			...(process.env.OMP_GUI_TEST_EMAIL_POLL_MS
				? { timing: { emailPollMs: Number(process.env.OMP_GUI_TEST_EMAIL_POLL_MS) } }
				: {}),
		})
		.catch(error => console.error("[schedules] couldn't start:", error));
	// Lists every folder sessions ran in (the first pass also the ones from before the list existed).
	void sidebarProjects.sync();
	logWatcher = new LogWatcher();

	// Settings › General › Window: the shell decides what closing the last window does (tauri-shell/src/last_close.rs)
	// from these prefs as stored, pushed now and on every change; its one-time tray notice is recorded here.
	const publishCloseToTray = serveCloseToTray({
		read: () => ({ closeToTray: prefs.get(CLOSE_TO_TRAY_PREF), noticeShown: prefs.get(CLOSE_TO_TRAY_NOTICE_PREF) }),
		noticeShown: () => prefs.set(CLOSE_TO_TRAY_NOTICE_PREF, true),
	});
	// This computer stays awake while any of its own tabs runs a turn.
	const workAwake = new KeepAwakePolicy({
		blocker: keepAwakeBlocker("work"),
	});
	workAwakePolicy = workAwake;
	const syncWorkAwake = () => {
		void workAwake
			.update({
				enabled: prefs.get(KEEP_AWAKE_WORKING_PREF) !== false,
				connected: false,
				running: sidecarPool.tabInventory().some(tab => tab.inFlight),
			})
			.catch(error =>
				writeRuntimeLog({
					source: "keep-awake",
					message: "failed",
					details: { policy: "work", error: error instanceof Error ? error.message : String(error) },
				}),
			);
	};
	// Interrupted turns continue on their own (turn-resume.ts): once the connection is back, and
	// after a relaunch. The marker file is rewritten on every run-state change, so a crash or a
	// SIGKILL, which run no quit hook, still leaves it behind.
	const connectivity = new ConnectivityMonitor({
		isOnline: () => net.isOnline(),
		// Right after a wake the OS can report a link before it carries traffic, and a dead DNS or route never shows in
		// `net.isOnline()`: ask the resolver itself, never its cache, then open a connection (through the agent's proxy
		// when it has one), and give up after `PROBE_TIMEOUT_MS`.
		// OMP_GUI_TEST_UNREACHABLE=1 (unpackaged e2e runs) makes every probe fail without touching the real network.
		probe: host =>
			!app.isPackaged && process.env.OMP_GUI_TEST_UNREACHABLE === "1"
				? Promise.resolve(false)
				: answersWithin(
						spawnProxy().then(({ url: proxy }) =>
							reaches(probeTarget(host ?? "example.com", proxy), async name =>
								(await net.resolveHost(name, { cacheUsage: "disallowed" })).endpoints.map(
									endpoint => endpoint.address,
								),
							),
						),
						PROBE_TIMEOUT_MS,
					),
		now: Date.now,
		schedule: (run, ms) => {
			const timer = setTimeout(run, ms);
			return () => clearTimeout(timer);
		},
		changed: online => {
			turnResume.connectivityChanged();
			if (online) devices.wake("online");
		},
	});
	connectivityMonitor = connectivity;
	const interruptedTurns = new InterruptedTurnStore(join(app.getPath("userData"), "interrupted-turns.json"), error =>
		writeRuntimeLog({
			source: "turn-resume",
			message: "markers not saved",
			details: { error: error instanceof Error ? error.message : String(error) },
		}),
	);
	// A tab that waits long without a step says what it waits on (turn-wait-watch.ts).
	const turnWait = new TurnWaitWatch({
		tabs: () => [...sidecarPool.resumeFacts(), ...hostServices.resumeFacts()],
		facts: tabId => sidecarPool.settleFacts(tabId),
		status: tabId => sidecarPool.sidecarOf(tabId)?.status,
		journal: journalWait,
		log: details => writeRuntimeLog({ source: "turn-wait", message: "still waiting", details }),
	});
	const turnResume = new TurnResume({
		store: interruptedTurns,
		// This computer's own tabs and the ones it runs for paired devices (host-services.ts): the host
		// owns those turns, so their markers, waits and continuations are this computer's.
		pool: {
			// A run's own tab stays revivable between its cycles and in its quota wait, when no turn and no goal may be on:
			// restored deferred, its omp would never start and the run would wait until someone opened the tab.
			resumeFacts: () => [
				...sidecarPool
					.resumeFacts()
					.map(fact => (autopilotRef.current?.runsOn(fact.tabId) ? { ...fact, autopilotActive: true } : fact)),
				...hostServices.resumeFacts(),
			],
			setAwaitingConnection: (tabId, awaiting) => {
				sidecarPool.setAwaitingConnection(tabId, awaiting);
				hostServices.setAwaitingConnection(tabId, awaiting);
			},
			// Only this computer's own tabs show the row: a paired device's tab mirrors its host's turn.
			setResuming: (tabId, resuming) => {
				sidecarPool.setResuming(tabId, resuming);
				hostServices.setResuming(tabId, resuming);
				turnWait.noteResuming(tabId, resuming);
			},
			resumeRank: tabId => sidecarPool.resumeRank(tabId),
			// Only this computer's own tabs get the cut-off row (the core offers no other).
			setCutOff: (tabId, cutOff) => sidecarPool.setCutOff(tabId, cutOff),
			// A window's tab shows its retry; a hosted tab's wait for a provider's limit goes to its device.
			setScheduledRetry: (tabId, retry) => {
				sidecarPool.setScheduledRetry(tabId, retry);
				hostServices.setScheduledRetry(tabId, retry);
				turnWait.noteRetry(tabId, retry);
			},
			startTab: tabId => sidecarPool.startTab(tabId) ?? hostServices.startTab(tabId),
			tabForSession: (sessionPath, peer) =>
				peer ? hostServices.tabForSession(sessionPath, peer) : sidecarPool.tabForSession(sessionPath),
			// A move's command may be on its way in this computer's pool or in a hosted tab: the rules judge `touched` after.
			movesSettled: async tabId => {
				await Promise.all([sidecarPool.movesSettled(tabId), hostServices.movesSettled(tabId)]);
			},
			noteStopped: tabId => {
				sidecarPool.noteStopped(tabId);
				hostServices.noteStopped(tabId);
			},
		},
		network: {
			get online() {
				return connectivity.online;
			},
			shouldWait: () => connectivity.shouldWait(),
			verify: host => connectivity.verify(host),
		},
		enabled: () => prefs.get(RESUME_INTERRUPTED_PREF) !== false,
		scheduledRetry: {
			// OMP_GUI_RETRY_DELAYS_MS (comma list of ms) shortens the waits for e2e runs, OMP_GUI_LIMIT_LOOK_MS the pace
			// at which a limit wait looks whether the limit lifted early.
			delays: retryDelays(process.env.OMP_GUI_RETRY_DELAYS_MS),
			...limitLook(process.env.OMP_GUI_LIMIT_LOOK_MS),
			schedule: (run, ms) => {
				const timer = setTimeout(run, ms);
				return () => clearTimeout(timer);
			},
		},
		// A live Autopilot run waits out its own limits (`waiting_quota`): never a second wait beside it.
		limitHeldElsewhere: tabId => autopilotRef.current?.holdsLimitWait(tabId) === true,
		// A quit tears every tab down: that must not read as the turns ending.
		frozen: () => quitApproved(),
		now: Date.now,
		openTab: marker => {
			if (marker.peer) return devices.reviveHostTab(marker.peer, marker);
			const win = windowManager.getMainWindow();
			if (!win) return null;
			const sidecar = sidecarPool.acquire(marker.cwd, win, undefined, marker.sessionPath, marker.kind);
			return sidecar ? sidecarPool.tabForSession(marker.sessionPath) : null;
		},
		// An autopilot run is armed again before its goal resumes; the coordinator also learns when a tab's launch
		// continuation ended without resuming its goal, and then resumes the run itself (or, after the user's Stop on
		// the tab's resuming row, shows it paused: `app_closed`).
		resumeGoal: async tabId => {
			await autopilotRef.current?.resumeGoal(tabId);
		},
		goalSettled: (tabId, outcome) => {
			autopilotRef.current?.resumeSettled(tabId, outcome);
			// The continuation is over: an omp update's restart that waited for it goes now (a tick later, outside the
			// core's own call).
			setImmediate(() => {
				sidecarPool.ompRestartIfWaiting(tabId);
				hostServices.ompRestartIfWaiting(tabId);
			});
		},
		log: (message, details) => writeRuntimeLog({ source: "turn-resume", message, details }),
		// A cut-off turn waits for the person: the opener of a session an agent opened hears it from the session itself
		// (`reportFor` does nothing for a tab nobody opened). Each cut and each dismissal is its own report.
		cutNote: (tabId, what) => {
			const session = sidecarPool.resumeFacts().find(fact => fact.tabId === tabId)?.sessionFile;
			const name = session ? ` (session ${basename(session)})` : "";
			const because =
				what === "crash-loop"
					? "its omp ended three times within five minutes"
					: what === "failed"
						? "continuing it failed three times"
						: "automatic continuation is off";
			tabReport.current?.(tabId, {
				kind: "blocked",
				id: `cut-${what}-${Date.now()}`,
				text:
					what === "dismissed"
						? `[OMPdesk] The person dismissed this session's cut-off turn${name}: it stays where the cut left it. Send it a message if the work still needs it.`
						: `[OMPdesk] This session's turn was cut off when its omp ended and did not continue on its own${name} (${because}). It waits for the person's Continue on its tab; send it a message if the work should go on now.`,
			});
		},
	});
	ipc.handle(IPC_COMMANDS.RESUME_CANCEL_WAIT, async (_caller, tabId: unknown) => {
		if (typeof tabId !== "string") return;
		// A paired host's tab: the host holds the wait, judged by its own connection.
		const sidecar = sidecarPool.sidecarOf(tabId);
		if (sidecar?.cancelHostWait) await sidecar.cancelHostWait();
		else turnResume.cancelWait(tabId);
	});
	// A paired device's Cancel on the wait or scheduled retry of a window's tab it views: this computer's own tab.
	sidecarPool.onCancelWait = tabId => turnResume.cancelWait(tabId);
	ipc.handle(IPC_COMMANDS.RESUME_STOP, async (_caller, tabId: unknown) => {
		if (typeof tabId === "string") await turnResume.stopResumed(tabId);
	});
	// A tab viewing a paired host's window tab: that host holds the offer.
	ipc.handle(IPC_COMMANDS.RESUME_CONTINUE, async (_caller, tabId: unknown) => {
		if (typeof tabId !== "string") return;
		const sidecar = sidecarPool.sidecarOf(tabId);
		if (sidecar?.continueHostCut) await sidecar.continueHostCut();
		else turnResume.continueCut(tabId);
	});
	ipc.handle(IPC_COMMANDS.RESUME_DISMISS, async (_caller, tabId: unknown) => {
		if (typeof tabId !== "string") return;
		const sidecar = sidecarPool.sidecarOf(tabId);
		if (sidecar?.dismissHostCut) await sidecar.dismissHostCut();
		else turnResume.dismissCut(tabId);
	});
	// A paired device's Continue or Dismiss on the cut-off row of a window's tab it views.
	sidecarPool.onCutOff = (tabId, choice) =>
		choice === "continue" ? turnResume.continueCut(tabId) : turnResume.dismissCut(tabId);
	ipc.on(IPC_COMMANDS.CONNECTIVITY_REPORT, (_caller, online: unknown) => {
		if (typeof online === "boolean") connectivity.report(online);
	});
	setQuitResumes(() => prefs.get(RESUME_INTERRUPTED_PREF) !== false);
	powerMonitor.on("suspend", () => connectivity.suspend());
	powerMonitor.on("resume", () => {
		connectivity.resume();
		devices.wake("resume");
	});
	powerMonitor.on("unlock-screen", () => devices.wake("unlock"));
	app.on("browser-window-focus", () => devices.wake("focus"));
	// Chromium's own link state, sampled for changes the windows' events missed (a window may not exist).
	connectivityPoll = setInterval(() => connectivity.poll(), 3000);
	connectivityPoll.unref();
	sidecarPool.onRunningChange = () => {
		syncWorkAwake();
		turnResume.sync();
		hostServices.workChanged();
	};
	// An ask opening or answered, a title, a step: what the rows show of the session may have changed.
	sidecarPool.observeTabs(() => hostServices.workChanged());
	sidecarPool.settleWatch = new SettleWatch({
		facts: tabId => sidecarPool.settleFacts(tabId),
		log: details => writeRuntimeLog({ source: "settle-watch", message: "still settling", details }),
	});
	sidecarPool.observeTabs(activity => turnWait.activity(activity));
	setInterval(() => {
		if (!quitApproved()) turnWait.sweep();
	}, WAIT_SWEEP_MS).unref();
	if (process.platform === "win32") {
		// A console window that shows on the desktop says whose it is (console-window-watch.ts).
		const consoleWindows = new ConsoleWindowWatch({
			list: listConsoleWindows,
			own: () => {
				const corePid = core().pid;
				return [
					{ pid: process.pid, role: "main" },
					// Under the window's shell main is its child (`OMPDESK_SHELL_SOCKET`, crates/shell/src/node.rs).
					...(process.env.OMPDESK_SHELL_SOCKET ? [{ pid: process.ppid, role: "host" }] : []),
					...(corePid === null ? [] : [{ pid: corePid, role: "core" }]),
				];
			},
			sessionOf: tag => sessionProcesses.owners().find(owner => owner.tag === tag)?.sessionPath,
			log: (message, details) => writeRuntimeLog({ source: "console-window", message, details }),
		});
		setInterval(() => {
			// A look never starts a core: it waits for the one the app runs.
			if (core().pid !== null) void consoleWindows.poll();
		}, CONSOLE_POLL_MS).unref();
	}
	hostServices.attachResume(turnResume);
	// An omp update never restarts a tab under its relaunch continuation (omp-restart.ts).
	sidecarPool.continuationOwed = tabId => turnResume.relaunchContinuation(tabId) === "after_restore";
	// Disk care: idle worktrees' build output, landed and long-idle worktrees (saved first), the HTTP cache and the
	// tools' caches.
	// Automatic only in the packaged app outside a test run: a dev or test instance sees none of the real app's open
	// sessions, so their worktrees would look unused to it. The button runs it anywhere.
	const diskCareDir = join(app.getPath("userData"), "disk-care");
	const savedWorktrees = new SavedWorktreeStore(diskCareDir);
	setSavedWorktreeStore(savedWorktrees);
	const scratchCare = new ScratchCare({
		store: sessionScratch,
		heldTags: () => sessionProcesses.held(),
		processes: listTaggedProcesses,
		sessionFiles: async () => (await sessionIndex.listKnown())?.map(info => info.path) ?? null,
		log: diskCareLog,
	});
	// A deleted session's replies are never shown again: the folder that served only it goes with it.
	onSessionDeleted((sessionPath, device) => {
		if (device === undefined) void scratchCare.sessionDeleted(sessionPath);
	});
	const care = new DiskCare({
		bridge: tablessWorktreeBridge,
		openFolders: sessionOpenFolders,
		projects: () => {
			const { projects, removed } = sidebarProjects.state();
			return [...projects.map(project => project.path), ...removed];
		},
		userData: app.getPath("userData"),
		saved: savedWorktrees,
		clearHttpCache: () => session.defaultSession.clearCache(),
		httpCachePath: () => defaultSessionCachePath() ?? join(app.getPath("userData"), "Cache"),
		cacheTools: systemCacheTools(),
		scratch: {
			root: scratchCare.root,
			sweep: async () => {
				await sessionProcesses.retryReleased();
				return scratchCare.sweep();
			},
		},
		checkInputs: app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1" && !userDataDirectory,
		automatic: app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1",
		worktrees:
			(app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1") ||
			process.env.OMP_GUI_TEST_DISK_CARE_WORKTREES === "1",
		log: diskCareLog,
		broadcast: state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.DISK_CARE_STATE, state);
			}
		},
	});
	diskCare = care;
	registerDiskCareIpc(ipc, care);
	void care.start();

	// Register all handlers and sidecar listeners before loading the renderer.
	// Paired pages' Files-edit reports live in the core's web router; main reads them for the control tools.
	const fileEditReports = new FileEditReports({
		target: windowId => webHost?.fileEditTarget(windowId) ?? null,
		read: (target, tabId) => sidecarPool.fileEdits(target, tabId),
	});
	registerIpcHandlers({
		openPageExternal,
		admitNotification,
		fileEditReports,
		ipc,
		macPermissions,
		sidecarPool,
		sessionIndex,
		machine,
		logWatcher,
		windowManager,
		remoteDevices: devices,
		hostedTabs: hostServices,
		summaries: sessionSummaries,
		webTabNotice,
		sessionWake,
		tabReport,
		agentOpening,
		webPages: () => webHost?.windows.all() ?? [],
		spawnWindow,
		initialCwd: resolveInitialCwd,
		worktreeLifecycle: lifecycle,
		worktreePrompts: prompts,
		autopilotRef,
		desktopSlotRef,
		checkoutFilesRef,
		relaunchContinuation: tabId => turnResume.relaunchContinuation(tabId),
		mediaStreams,
		uploads: { attachHere: (name, bytes) => hostUploads().attachHere(name, bytes) },
		schedules: () => scheduleService,
		mailAccounts: () => mailAccounts,
		sidebarProjects,
		// `webHost` is created below: the prompt origins read it when a prompt is sent, never at registration.
		promptOrigins: {
			of: win => webHost?.promptOrigin(win) ?? null,
			hostName: () => devices.deviceName(),
		},
		onPrefChanged: key => {
			if (key === CLOSE_TO_TRAY_PREF || key === CLOSE_TO_TRAY_NOTICE_PREF) publishCloseToTray();
			if (key === KEEP_AWAKE_WORKING_PREF) {
				syncWorkAwake();
				devices.keepAwakeChanged();
			}
			if (key === RESUME_INTERRUPTED_PREF) turnResume.sync();
			if (key === APP_AUTO_UPDATE_PREF) void appAutoUpdatePrefChanged();
			if (key === TOOLS_AUTO_UPDATE_PREF || key === OMP_FOLLOW_VERIFIED_PREF) toolsClient.ompPrefChanged();
			if (key === TOOLS_AUTO_UPDATE_PREF) {
				toolsClient.cliPrefChanged();
				toolsClient.extPrefChanged();
			}
			if (key === "themeName" || key === "theme") {
				nativeTheme.themeSource = nativeThemeSource(prefsStore().get("themeName"), prefsStore().get("theme"));
			}
		},
	});
	protocol.handle(MEDIA_SCHEME, request => mediaStreams.handle(request));
	const createdWebHost = new WebHost({
		ipc,
		onFileEditReport: () => fileEditReports.reported(),
		userData: app.getPath("userData"),
		// The built renderer: `web.html` and its assets sit beside `index.html` (a dev run has none).
		staticRoot: () => join(__dirname, "../renderer"),
		desktopWindows: () => windowManager.getAllWindows(),
		tabs: {
			activeTab: win => sidecarPool.activeTabForWindow(win),
			cwd: (win, tabId) => {
				const target = sidecarPool.tabTarget(win, tabId);
				return target && !target.device ? target.sidecar.cwd : null;
			},
			facts: tabId => sidecarPool.tabFacts(tabId),
			resnapshot: win => sidecarPool.resnapshotWindow(win),
		},
		openMedia: (url, range) => mediaStreams.handle(new Request(url, range ? { headers: { range } } : undefined)),
		shell: {
			openPath: abs => openLocalPath(abs, shell),
			reveal: abs => shell.showItemInFolder(abs),
			openPageExternal,
		},
		allowedUsers: () => mobileWebService?.allowedUsers() ?? [],
		// Off unless the user turned it on (Settings › Mobile web): a device Tailscale vouches for connects on its own.
		confirmNewDevices: () => mobileWebService?.confirmNewDevices() ?? false,
		whois: address => mobileWebService?.whois(address) ?? Promise.resolve(null),
		onUnpairedAuth: () =>
			new Notification({ title: mainT("web.unknownDevice.title"), body: mainT("web.unknownDevice.body") }).show(),
		language: () => getMainLanguage(),
		// Routine webhooks: `POST /hooks/<schedule id>` (web/server.ts) is answered by the schedule service.
		hooks: () => scheduleService,
		log: message => console.warn(`[web-push] ${message}`),
	});
	// The paired devices and the blocks are the core's: their copies are in before anything reads them (the sharing
	// gate's block check, the paired devices' layouts below), as the files were read when the host was made.
	await createdWebHost
		.ready()
		.catch(error => console.warn(`[web] the paired devices could not be read: ${String(error)}`));
	webHost = createdWebHost;
	// Uploads expire on their own whether or not Mobile web serves: a paired computer's attached files land there too.
	void webHost.keepUploadsSwept();
	// Paired phones hear of finished turns, failures and asks through Web Push (web/web-push-notifier.ts).
	sidecarPool.observeTabs(activity => webHost?.tabActivity(activity));
	webTabNotice.current = (tabId, notice) => webHost?.tabNotice(tabId, notice);
	webHost.devices.onRevoked(deviceId => webTabLayouts.drop(deviceId));
	const host = webHost;
	// Mobile web's Tailscale side (src/main/tailscale/): the switch, Tailscale's own setup and the published
	// address. The server it starts is the WebHost above. `OMP_GUI_TEST_TAILSCALE_OPEN` is a test's stand-in
	// for "start the Tailscale app" (the fake CLI of e2e/fixture/fake-tailscale.ts), never set by users.
	let lastMobileWebUrl: string | null = null;
	const mobileWeb = new MobileWebService({
		platform,
		prefs: {
			get: key => prefs.get(key),
			set: (key, value) => prefs.set(key, value),
			delete: key => prefs.delete(key),
		},
		server: {
			// The loopback port is 47831 when it is free; the published port is chosen separately (serve.ts).
			start: async () => {
				try {
					return await host.start({ port: MOBILE_WEB_PORT });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
					return host.start({ port: 0 });
				}
			},
			stop: () => host.stop(),
			configure: address => host.server.configure(address),
		},
		serveSecret: () => host.serveSecret(),
		setup: {
			installForConnection: item => toolsClient.installForConnection(item),
			cancel: () => toolsClient.setupCancel(),
		},
		locate: locateTs,
		startApp: located =>
			tailscaleOs
				? startTailscaleApp(located, tailscaleOs, process.env.OMP_GUI_TEST_TAILSCALE_OPEN || null)
				: Promise.reject(new Error("Mobile web needs macOS or Windows")),
		openExternal: url => shell.openExternal(url),
		openSystemSettings: () =>
			shell.openExternal(
				tailscaleOs === "darwin"
					? "x-apple.systempreferences:com.apple.preference.security"
					: "ms-settings:network-vpn",
			),
		// Desktop windows only: a paired phone reads the state through its own call.
		onState: state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(MOBILE_WEB_STATE, state);
			}
			// Paired devices show this computer's page to their phones (`HostView.webUrl`): tell them when it moves.
			if (state.url !== lastMobileWebUrl) {
				lastMobileWebUrl = state.url;
				hostServices.mobileWebLinkChanged(state.url);
			}
		},
	});
	mobileWebService = mobileWeb;
	ipc.handle(MOBILE_WEB_GET_STATE, () => mobileWeb.state());
	ipc.handle(MOBILE_WEB_COMMAND, (_caller, request: unknown) => mobileWeb.request(request));
	// Switched on when the app last ran: published again (or found already in place) without a click.
	void mobileWeb.start();
	// Before the first window: a restored remote tab needs its host's link to exist.
	devices.start();
	sessionIndex.start();
	void logWatcher.start().catch(error => console.warn("[log-watcher] couldn't start:", error));
	// Read before the first window restores: every tab change rewrites the store,
	// so a later read would only see the just-restored primary window.
	const savedLayouts = readSavedTabLayouts({ log: true });
	// An update's relaunch comes back as the app sat when it began: hidden in the tray, minimized or behind another
	// app (the user's rule, 23 Oct 2026: it reopened maximized in front of them). Only the windows this launch restores.
	const relaunchPresence = explicitStartupCwd ? null : readRelaunchPresence();
	windowManager.launchPresence = relaunchPresence;
	await spawnWindow(explicitStartupCwd);
	markStartup("window-created");
	// A bare launch restores the saved session in full. The window above carries
	// layout[0]; these are the secondary windows whose tabs used to be dropped at
	// relaunch. An argv cwd is an explicit "open this", not a restore.
	if (!explicitStartupCwd) {
		for (const layout of savedLayouts.slice(1)) await spawnWindowWithLayout(layout);
	}
	windowManager.launchPresence = null;
	// macOS activates the relaunched app; one that comes back in the tray gives the focus straight back.
	if (relaunchPresence === "hidden" && process.platform === "darwin") app.hide();
	// Each paired phone's or tablet's tabs come back into its window, as the host's sessions (web/web-tab-layouts.ts).
	const restoredLayouts = [...savedLayouts];
	// Only from the core's list: an empty copy would forget every device's layout.
	if (webHost?.storesReady) {
		const paired = new Set(webHost.devices.list().map(device => device.deviceId));
		for (const { deviceId, layout } of webTabLayouts.restorable(paired)) {
			sidecarPool.restoreLayout(webHost.windows.windowFor(deviceId), layout);
			restoredLayouts.push(layout);
		}
	}
	// The sessions that come back keep what they started before the relaunch: the restored tabs, and the turns the
	// markers below continue (read before `launch`, which drops the ones it settles).
	const keptSessions = new Set(interruptedTurns.read().map(marker => marker.sessionPath));
	for (const layout of restoredLayouts) {
		for (const tab of layout.tabs) if (tab.device === undefined && tab.sessionPath) keptSessions.add(tab.sessionPath);
	}
	// After the saved windows (and so their tabs) exist: go on with what the last process left running.
	turnResume.launch();
	// A restored tab closed before it ever started gives up what the last launch left for its session.
	sidecarPool.observeTabs(activity => {
		if (activity.type === "released" && activity.session && activity.session.device === undefined)
			sessionProcesses.sessionReleased(activity.session.path);
	});
	void sessionProcesses.sweep({
		keep: keptSessions,
		hostedHeld: sessionPath => hostServices.resumeFacts().some(fact => fact.sessionFile === sessionPath),
		hostedGraceMs: HOST_TAB_GRACE_MS,
	});

	// The shell's app menu and tray (tauri-shell/src/app_menu.rs, tray.rs) speak the UI language; the tray's update
	// item asks for the updater's status, and since when a check found nothing, each time its menu opens.
	publishLanguage(getMainLanguage());
	let notAvailableAt: number | null = null;
	onUpdateStatus(status => {
		notAvailableAt = status.state === "not-available" ? Date.now() : null;
	});
	serveTray({
		update: () => ({ status: updateStatus(), notAvailableAt }),
		runUpdate: action => {
			if (action === "check") void checkForUpdate();
			else if (action === "download") void downloadUpdate();
			else void applyUpdate();
		},
	});
	// The shell's entry points (a second launch, a link, a folder, the Dock, the window shortcut) ask for the windows
	// it does not have; what reached it before now runs after, in order (tauri-shell/src/entry.rs).
	serveSessions({
		spawnWindow: async (cwd, from) => {
			// New Window (the app menu): in the project of the window it was chosen over.
			const beside = windowManager.getAllWindows().find(win => win.id === from);
			const project = cwd ?? (beside ? windowManager.recordFor(beside)?.cwd : undefined);
			return (await spawnWindow(project))?.id ?? null;
		},
		openPath,
	});
	setupUpdater(ipc, {
		// Default on: only a stored `false` turns it off (an unattended Mac running Autopilot updates itself).
		enabled: () => prefs.get(APP_AUTO_UPDATE_PREF) !== false,
		resumes: () => prefs.get(RESUME_INTERRUPTED_PREF) !== false,
		// Running turns, compactions and open asks, on this computer's tabs and the ones it hosts for paired devices.
		busy: () =>
			sidecarPool.tabInventory().some(tab => tab.inFlight) ||
			[...sidecarPool.resumeFacts(), ...hostServices.resumeFacts()].some(fact => fact.running || fact.awaitingUi),
		asking: () =>
			sidecarPool.restartHolds().planWaiting ||
			[...sidecarPool.resumeFacts(), ...hostServices.resumeFacts()].some(fact => fact.awaitingUi),
		planWaiting: () => sidecarPool.restartHolds().planWaiting,
		compacting: () => sidecarPool.restartHolds().compacting || hostServices.compacting(),
		opening: () => agentOpening.current?.() ?? false,
		// Running subagents and background jobs: `composer.jobs` of every omp whose run is on (background-work.ts).
		backgroundWork: () =>
			askBackgroundWork(() => [...sidecarPool.runningBridges(), ...hostServices.runningBridges()]),
		proxy: async () => (await spawnProxy()).url,
	});
	// The first page loaded: the start mark a macOS update's swap helper waits for, then the previous install's report.
	void firstWindowReady.then(noteAppStarted);
	// A paired page shows this computer's update card and notice too: it hears every change, as the windows do.
	onUpdateStatus(status => {
		for (const win of webHost?.windows.all() ?? [])
			if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.UPDATER_STATUS, status);
	});
});

// Quit on all windows closed (except macOS)
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		requestQuit("last-window");
	}
});

// Cleanup on quit, behind the "sessions are still working" confirmation: ⌘Q
// used to SIGTERM every live agent run without a word. Before the teardown,
// tabs owning a `worktree.onStart` worktree apply `worktree.onExit` while their
// windows can still ask.
installQuitGuard(
	() => (sidecarPool ? sidecarPool.tabInventory() : []),
	() => {
		// Each step is named to the hang watchdog first: a stalled quit then names the step that never returned.
		let statsStopped = Promise.resolve();
		let mcpHubStopped = Promise.resolve();
		const steps: Array<[string, () => void]> = [
			[
				"connectivity",
				() => {
					// Before the core ends: its timers, the link sampling and the OS's events reach the core's hub.
					if (connectivityPoll) clearInterval(connectivityPoll);
					connectivityPoll = null;
					connectivityMonitor?.stop();
				},
			],
			[
				"stats-server",
				() => {
					statsStopped = statsServer?.kill() ?? Promise.resolve();
				},
			],
			[
				"mcp-hub",
				() => {
					mcpHubStopped = mcpHub?.kill() ?? Promise.resolve();
				},
			],
			// Setup and the omp, CLI and extension updaters: the running step and what it started end, nothing queued runs.
			["tools", () => tools?.close()],
			["local-engines", () => localEngines?.dispose()],
			["ai-memory-sync", () => aiMemorySync?.dispose()],
			["ai-memory-upkeep", () => aiMemoryUpkeep?.dispose()],
			["ai-memory-care", () => aiMemoryCare?.dispose()],
			["ai-memory", () => aiMemoryService?.dispose()],
			["github-auth", () => githubAuthService?.dispose()],
			[
				"schedules",
				() => {
					schedulesClosed = scheduleService?.dispose() ?? Promise.resolve();
				},
			],
			["work-awake", () => workAwakePolicy?.dispose()],
			["lid-awake", () => lidAwake?.dispose()],
			["disk-care", () => diskCare?.stop()],
			[
				"sidecars",
				() => {
					sidecarPool?.disposeAll();
					// One stop for every omp: the core's lanes join the disposals' stops (an omp that asked to be left to save
					// a login is held, not killed), and the core below is not ended before this answered.
					ompsStopped = ompProcesses?.stopAll() ?? Promise.resolve();
				},
			],
			["remote-devices", () => void remoteDevices?.dispose()],
			["mobile-web", () => mobileWebService?.dispose()],
			["web-host", () => void webHost?.stop()],
			["session-index", () => sessionIndex?.stop()],
			[
				"log-watcher",
				() => {
					logsClosed = logWatcher?.stop() ?? Promise.resolve();
				},
			],
			[
				"core",
				() => {
					coreStopped = Promise.allSettled([
						schedulesClosed,
						ompsStopped,
						logsClosed,
						statsStopped,
						mcpHubStopped,
					]).then(() => shutdownCore());
					void coreStopped.catch((error: unknown) => console.warn(`[quit] core stop failed: ${String(error)}`));
				},
			],
		];
		for (const [name, run] of steps) {
			markMainStep("quit", `teardown:${name}`);
			run();
		}
		markMainStep("quit", "teardown:done");
	},
	async () => {
		const lifecycle = worktreeLifecycle;
		if (!lifecycle) return;
		await lifecycle.finalize({
			prepare: async tabId => {
				const sidecar = sidecarPool.sidecarOf(tabId);
				if (!sidecar) return;
				// Stock stops the turn first, so the questions describe a worktree nothing still writes to.
				recordTurnStop({ command: "abort", tab: tabId, by: "quit", surface: "worktree-finalize" });
				await sidecar.rpcClient?.command({ type: "abort" }).catch(() => undefined);
				await lifecycle.refreshExitPolicy(tabId, () => readLiveLifecycleSettings(sidecar));
			},
			release: tabId => sidecarPool.releaseTabWhenExited(tabId),
		});
	},
	// Main must not exit until the core and the processes it started have ended too.
	async () => {
		const results = await Promise.allSettled([ompsStopped, schedulesClosed, logsClosed, coreStopped]);
		const failure = results.find(result => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	},
);
