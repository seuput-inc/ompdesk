/**
 * omp keeps itself current (the core's `crates/core/src/tools/omp`): while OMPdesk runs it
 * asks stock `omp update --check` for the newest omp and installs, on its own,
 * only an omp it may: by default one within the major it was tested with; with
 * the hidden pref `ompFollowVerified`, only one runners verified against this
 * OMPdesk release (the verified list, src/shared/omp-compat.ts) or the omp it
 * was tested with. A newer one waits (`held`), or for a person's "Update now".
 * Each computer, a paired host included, updates its own omp under its own
 * pref, always through its own updater: a client only asks the host to run it
 * (`host.ompUpdate.now`) and follows the state the host pushes; it never runs
 * `omp update` there.
 */

/**
 * Who started a pass. `launch` and `scheduled` are the timer's, `repair` is the bridge compatibility check's
 * (an omp that lacks what the bridge needs): nobody asked for those, so they run only under the pref and install
 * only an omp they may (`held`). `manual` is a person's "Update now", here or from a paired device.
 */
export type OmpUpdateTrigger = "launch" | "scheduled" | "repair" | "manual";

/**
 * Why a newer omp is not installed on its own:
 * - `untested-major`: its major is above the tested omp's (the default, `ompFollowVerified` off).
 * - `verifying`: runners have not verified it against this OMPdesk release yet; it installs once they have.
 * - `failed`: runners found it breaks this OMPdesk release; it stays held until a fixed OMPdesk release verifies it.
 */
export type OmpUpdateHoldReason = "verifying" | "failed" | "untested-major";

/** A newer omp OMPdesk does not install on its own. */
export interface OmpUpdateHold {
	version: string;
	reason: OmpUpdateHoldReason;
	/**
	 * When the hold began (ISO 8601), so Settings and the notification can say for how long: `failed`, when runners
	 * first failed it; `verifying`, when this computer first saw it held.
	 */
	since?: string;
}

/**
 * Runners judge a new omp within the hour, so a `verifying` hold this old means the hourly run reached no verdict:
 * the person is told (the core's `tools/omp/hold.rs`) and Settings says how long it has waited.
 */
export const VERIFYING_OVERDUE_MS = 6 * 60 * 60 * 1000;

/**
 * - `check`: the registry lookup failed (`detail` is the reason).
 * - `install`: `omp update` failed or could not start.
 * - `not-updated`: it exited cleanly but omp is still older than the registry's latest.
 * - `unusable`: the new omp does not run (or is below the minimum); tabs stay on the omp they have.
 * - `cancelled`: the user cancelled the install from This computer.
 */
export const OMP_UPDATE_FAILURE_REASONS = ["check", "install", "not-updated", "unusable", "cancelled"] as const;
export type OmpUpdateFailureReason = (typeof OMP_UPDATE_FAILURE_REASONS)[number];

export interface OmpUpdateFailure {
	reason: OmpUpdateFailureReason;
	/** Last lines of the installer's output, or the lookup error. */
	detail?: string;
}

export interface OmpUpdateState {
	/** The pref: whether scheduled checks may install. A manual "Update now" works either way. */
	enabled: boolean;
	/** This launch schedules checks (packaged app, or a test launch with a fake installer and registry); dev and test launches never do. */
	scheduled: boolean;
	phase: "idle" | "checking" | "updating";
	/** The omp that runs on this computer now; null before detection or while omp is missing. */
	installed: string | null;
	/** npm's latest as of the last successful check. */
	latest: string | null;
	/** When the last check finished (ms since the epoch); null before the first. */
	checkedAt: number | null;
	/** The newest version this launch installed on its own. */
	updatedTo: string | null;
	/** Why the last attempt failed; cleared by the next success. Kept until then. */
	failure: OmpUpdateFailure | null;
	/**
	 * The omp this OMPdesk release was tested with (`src/shared/omp-tested.json`). Absent from a host whose OMPdesk
	 * predates it.
	 */
	tested?: string;
	/**
	 * Every omp runners verified against this OMPdesk release, as the last check read the verified list; with `tested`,
	 * what a pass nobody asked for may install. Absent before the first check, and from a host whose OMPdesk predates it.
	 */
	verified?: string[];
	/**
	 * The newest omp is newer than the installed one and held back: only "Update now" installs it. Null while
	 * nothing is held; absent from a host whose OMPdesk predates it.
	 */
	held?: OmpUpdateHold | null;
	/**
	 * omp's own background update (stock `update.auto`) was on and OMPdesk turned it off while it keeps omp current
	 * (`tools/omp/takeover.rs`); turning "Keep tools up to date" off gives it back. Absent from older hosts.
	 */
	stockAutoTaken?: boolean;
}

/** What the renderer toasts once an update has been installed ("omp updated to X"). */
export interface OmpUpdatedNotice {
	version: string;
}
