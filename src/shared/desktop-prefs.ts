/**
 * Preference keys main reads for desktop behaviour (Settings › General ›
 * Window, Settings › Projects & launch › Worktrees), written by the renderer
 * through `prefs.set`.
 */

/**
 * Closing the last window hides it instead of ending the app: to the tray on Windows, and on
 * macOS to the Dock, which brings the same window back (default on; only `false` keeps the quit on Windows).
 * The shell reads it (`tauri-shell/src/last_close.rs`), with the notice key below.
 */
export const CLOSE_TO_TRAY_PREF = "closeToTray";

/** Set once the "keeps running in the tray" notice has been shown. */
export const CLOSE_TO_TRAY_NOTICE_PREF = "closeToTrayNoticeShown";

/**
 * Hold off system sleep while any tab on this computer runs a turn or another device is connected or runs a session
 * here (remote/devices.ts), and on a charging laptop keep the work running through a lid close
 * (src/main/power/lid-awake.ts). Default on; only a stored `false` turns it off.
 */
export const KEEP_AWAKE_WORKING_PREF = "keepAwakeWhileWorking";

/** Continue turns that were running when OMPdesk quit, crashed or restarted for an update (default on; only `false` turns it off). */
export const RESUME_INTERRUPTED_PREF = "resumeInterrupted";

/**
 * Install a downloaded OMPdesk update and restart by itself (Settings › Updates & about; default on, only a stored
 * `false` turns it off). With Continue interrupted work on it restarts at the next safe point, running work and all.
 */
export const APP_AUTO_UPDATE_PREF = "appAutoUpdate";

/**
 * Keep tools up to date (Settings › Updates & about; default on, only a stored `false` turns it off): omp itself
 * (`omp-updater.ts`), the tool CLIs of connected accounts (`cli-tools/`) and omp's extensions (`ext-update/`).
 * Replaced the three switches `ompAutoUpdate`, `cliAutoUpdate`, `extensionAutoUpdate` (`crates/core/src/prefs/retired.rs`).
 */
export const TOOLS_AUTO_UPDATE_PREF = "toolsAutoUpdate";

/**
 * omp follows the verified list (src/shared/omp-compat.ts): a pass nobody asked for installs only an omp runners
 * verified against this release, a newer one is held (`verifying`/`failed`) and told, and stock's own `update.auto` is
 * taken while "Keep tools up to date" is on. Hidden, default off (only a stored `true` turns it on; the hub's call,
 * 20 Nov 2026): off, omp's passes stay those of 0.135.0 with the major guard, nothing reads the list and stock's config
 * is never touched.
 */
export const OMP_FOLLOW_VERIFIED_PREF = "ompFollowVerified";

/**
 * A launch ends by itself a restored session's process whose output path is closed with its other end closed and that
 * keeps spinning (`session-processes.ts`; the owner's answer of 20 Nov 2026). Hidden, default on: only a stored `false`
 * turns it off, and then such a process is only reported. No Settings row: Settings has no home for session
 * processes and the minimal-settings rule keeps it out of a section of its own.
 */
export const END_SPINNING_ON_CLOSED_OUTPUT_PREF = "endSpinningOnClosedOutput";

/** A dev server's address in a bash result opens the Preview for the focused tab (default off; only `true` turns it on). */
export const AUTO_PREVIEW_DEV_SERVER_PREF = "autoPreviewDevServer";

/** A turn that edited files opens Changes at its end while the side panel is closed (default off; only `true` turns it on). */
export const AUTO_OPEN_CHANGES_PREF = "autoOpenChanges";
