/**
 * Keeps this computer's omp current. While OMPdesk runs it asks stock
 * `omp update --check` (SetupService.latestOmp: the omp OMPdesk runs, with the
 * user's registry, channel and install method) for the newest omp at launch and
 * then every few hours, backing off after errors. When that is newer than the
 * installed omp it installs it on its own (SetupService.updateOmp, under the
 * setup supervisor, in the same environment as the check): no click, and
 * without waiting for any turn to end, because a running omp keeps the code it
 * loaded — `bun install -g` replaces package files with new ones (new inodes)
 * instead of rewriting them, and the bridge's `@oh-my-pi/*` imports resolve to
 * omp's bundled singletons, not to files on disk. The processes that do read
 * omp's files from disk (the stats server and the stock helper) are stopped
 * before the installer starts and brought back after it. Windows locks files a
 * running omp holds, so there an install can fail; that attempt is just a
 * failure here, shown in Settings and retried on the next check.
 *
 * **Nothing here installs an unverified omp unasked** (the owner's rule, 19 Nov 2026: omp 19.0.0 came out and
 * OMPdesk, tested with 18, put it on two computers within hours; the composer's extras, the plan card and resume
 * broke). A pass nobody asked for (the timer's, the bridge compatibility repair's) runs only under the pref and
 * installs, at its exact version, only the tested omp (`src/shared/omp-tested.json`) or one runners verified against
 * this OMPdesk release (the verified list, `followTarget` in src/shared/omp-compat.ts; docs/design/follow-omp.md). A
 * newer omp is `held` (`verifying` until runners judge it, `failed` when they found it breaks this release): the state
 * names it, Settings says so, and a person's "Update now" installs it anyway.
 *
 * OMPdesk's own update is not part of this (updater.ts).
 * Each computer runs its own instance under its own pref. A paired device
 * that wants a host's omp updated asks that host's instance (`host.ompUpdate.now`,
 * LocalMachine.startOmpUpdate) and follows its state, which the host pushes.
 */
import { IPC_COMMANDS } from "../shared/ipc-types";
import { followTarget, type OmpCompatEntry } from "../shared/omp-compat";
import type {
	OmpUpdatedNotice,
	OmpUpdateFailure,
	OmpUpdateHold,
	OmpUpdateState,
	OmpUpdateTrigger,
} from "../shared/omp-update";
import { isNewer } from "../shared/version";
import { TESTED_OMP_VERSION } from "./omp-runtime";
import type { OmpUpdateOutcome } from "./setup/service";
import { nextCheckDelay, UpdateScheduler } from "./update-scheduler";
import type { IpcRegistry } from "./web/ipc-registry";

/**
 * A step of a pass, one gui-runtime.jsonl line each (source `omp-update`), so a later reader can tell who installed
 * what and when: `checked` (installed, latest, tested, newest verified), `held` (the version left alone and why),
 * `started` (from, target),
 * `finished` (the version that runs now), `failed` (reason), `skipped` (nothing ran, and why). Every line names
 * its `path` (`OmpUpdateTrigger`).
 */
export type OmpUpdateLogStep = "checked" | "held" | "started" | "finished" | "failed" | "skipped";

export interface OmpUpdaterDeps {
	/** This launch checks on a timer: a packaged app, or a test launch that opts in. Dev and test launches never do. */
	scheduled: boolean;
	/** The pref `toolsAutoUpdate` (default on), shared with the tool CLIs and extensions. */
	enabled: () => boolean;
	/** The newest omp for the installed one (stock `omp update --check`); rejects with the reason it could not tell. */
	fetchLatest: () => Promise<string>;
	/**
	 * This OMPdesk release's entry of the verified list (OmpCompatSource); an empty entry when the list was never
	 * read or names nothing for this release. Never rejects.
	 */
	compat: () => Promise<OmpCompatEntry>;
	/** The omp that runs now (from machine setup's detection); null while omp is missing. */
	installed: () => string | null;
	/**
	 * Install `target` and detect omp again (SetupService.updateOmp). `beforeInstall` runs just before the installer
	 * starts. `exactOnly`: `target` is not the registry's newest, so only an install that names the version may run,
	 * never stock `omp update`, which picks its own.
	 */
	update: (target: string, beforeInstall: () => Promise<void>, exactOnly: boolean) => Promise<OmpUpdateOutcome>;
	/** Stop what reads omp's files from disk (stats server, stock helper); resolves once they are gone. */
	releaseHelpers: () => Promise<void>;
	/**
	 * The install ended and the helpers were released: bring them back, on the new omp when
	 * `updated`. Then, for an update, re-resolve omp and restart the tabs on it (idle ones now,
	 * busy ones after their turn); their bridges answer the capabilities probe again.
	 */
	resume: (updated: boolean) => Promise<void>;
	onState: (state: OmpUpdateState) => void;
	/** One quiet "omp updated to X". */
	onUpdated: (notice: OmpUpdatedNotice) => void;
	log: (step: OmpUpdateLogStep, details: Record<string, unknown>) => void;
	/** Whether OMPdesk holds stock `update.auto` turned off now (OmpAutoTakeover); false when absent. */
	stockAutoTaken?: () => boolean;
	/** The omp this OMPdesk was tested with; `TESTED_OMP_VERSION` unless a test names another. */
	tested?: string;
	now?: () => number;
}

export class OmpUpdater {
	readonly #deps: OmpUpdaterDeps;
	/** The check after `#failures` failed ones in a row waits `nextCheckDelay(#failures)`. */
	readonly #scheduler: UpdateScheduler;
	readonly #tested: string;
	#state: OmpUpdateState;
	#failures = 0;
	/** One check at a time: Update now during a check joins it. */
	#running: Promise<void> | null = null;
	/** A person asked for the pass that runs now ("Update now"), whoever started it. */
	#asked = false;
	/** The timer's first tick is the launch check. */
	#ticked = false;

	constructor(deps: OmpUpdaterDeps) {
		this.#deps = deps;
		this.#tested = deps.tested ?? TESTED_OMP_VERSION;
		this.#scheduler = new UpdateScheduler({
			scheduled: deps.scheduled,
			tick: async () => {
				const trigger = this.#ticked ? "scheduled" : "launch";
				this.#ticked = true;
				if (this.#deps.enabled()) await this.#run(trigger);
			},
			delay: () => nextCheckDelay(this.#failures),
		});
		this.#state = {
			enabled: deps.enabled(),
			scheduled: deps.scheduled,
			phase: "idle",
			installed: deps.installed(),
			latest: null,
			checkedAt: null,
			updatedTo: null,
			failure: null,
			tested: this.#tested,
			held: null,
		};
	}

	state(): OmpUpdateState {
		return {
			...this.#state,
			enabled: this.#deps.enabled(),
			installed: this.#deps.installed() ?? this.#state.installed,
			stockAutoTaken: this.#deps.stockAutoTaken?.() ?? false,
		};
	}

	/** Something the state reads from outside changed (stock `update.auto` taken or given back): push it again. */
	changed(): void {
		this.#emit();
	}

	/** Machine setup finished its first pass: check now (when this launch schedules) and then on the timer. */
	start(): void {
		this.#scheduler.start();
	}

	/** The pref changed: turning it on checks right away, turning it off lets the next timer pass. */
	prefChanged(): void {
		this.#emit();
		if (this.#scheduler.started && this.#deps.scheduled && this.#deps.enabled() && !this.#running)
			void this.#scheduler.tick();
	}

	/**
	 * Settings › Update now: check and install the newest omp whatever the pref, the schedule or the verified list say. A
	 * click that lands while another pass has not yet chosen what to install makes that pass the person's.
	 */
	updateNow(): Promise<void> {
		this.#asked = true;
		return this.#run("manual");
	}

	/**
	 * A tab's omp lacks what the bridge needs, or the bridge never reached it (BridgeHealth): a newer omp may have
	 * it. Nobody asked, so this is the timer's pass run early: in a launch that schedules, under the pref, only to a
	 * verified omp.
	 */
	repair(): Promise<void> {
		if (this.#scheduler.disposed) return Promise.resolve();
		const enabled = this.#deps.enabled();
		if (!this.#deps.scheduled || !enabled) {
			this.#deps.log("skipped", { path: "repair", reason: enabled ? "not-scheduled" : "auto-update-off" });
			return Promise.resolve();
		}
		return this.#run("repair");
	}

	dispose(): void {
		this.#scheduler.dispose();
	}

	#run(trigger: OmpUpdateTrigger): Promise<void> {
		if (this.#scheduler.disposed) return Promise.resolve();
		this.#running ??= this.#check(trigger).finally(() => {
			this.#running = null;
			this.#asked = false;
			this.#set({ phase: "idle" });
		});
		return this.#running;
	}

	#set(patch: Partial<OmpUpdateState>): void {
		this.#state = { ...this.#state, ...patch };
		this.#emit();
	}

	#emit(): void {
		if (!this.#scheduler.disposed) this.#deps.onState(this.state());
	}

	#fail(path: OmpUpdateTrigger, failure: OmpUpdateFailure, target?: string): void {
		this.#failures += 1;
		this.#deps.log("failed", { path, ...(target ? { target } : {}), ...failure });
		this.#set({ failure });
	}

	async #check(trigger: OmpUpdateTrigger): Promise<void> {
		// Missing, outdated or broken omp is machine setup's to install; there is nothing to check or update yet.
		if (this.#deps.installed() === null) return;
		this.#set({ phase: "checking" });
		let latest: string;
		try {
			latest = await this.#deps.fetchLatest();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.#fail(this.#asked ? "manual" : trigger, { reason: "check", detail });
			return;
		}
		const entry = await this.#deps.compat();
		const installed = this.#deps.installed();
		if (installed === null) {
			this.#set({ latest, checkedAt: (this.#deps.now ?? Date.now)(), verified: entry.verified });
			return;
		}
		const followed = followTarget({ installed, latest, tested: this.#tested, verified: entry.verified });
		const held: OmpUpdateHold | null =
			isNewer(latest, installed) && followed !== latest
				? entry.holding?.version === latest
					? { version: latest, reason: "failed", since: entry.holding.since }
					: { version: latest, reason: "verifying" }
				: null;
		this.#set({ latest, checkedAt: (this.#deps.now ?? Date.now)(), verified: entry.verified, held });
		// Whoever started the pass, a click before the version is chosen makes it the person's.
		const path = (): OmpUpdateTrigger => (this.#asked ? "manual" : trigger);
		this.#deps.log("checked", {
			path: path(),
			installed,
			latest,
			tested: this.#tested,
			verified: entry.verified.at(-1) ?? null,
		});
		if (held && !this.#asked) {
			this.#deps.log("held", { path: path(), installed, version: held.version, reason: held.reason });
		}
		const target = this.#asked ? latest : (followed ?? installed);
		if (!isNewer(target, installed)) {
			this.#failures = 0;
			this.#set({ failure: null });
			return;
		}
		// The version is chosen: from here the install is this path's, whatever is clicked meanwhile.
		const by = path();
		this.#deps.log("started", { path: by, from: installed, target });
		this.#set({ phase: "updating" });
		let released = false;
		const outcome = await this.#deps.update(
			target,
			async () => {
				released = true;
				await this.#deps.releaseHelpers();
			},
			target !== latest,
		);
		// Quit while the installer ran: teardown is under way, so nothing starts again (helpers, tabs, toast).
		if (this.#scheduler.disposed) return;
		if (outcome.kind === "updated") {
			this.#failures = 0;
			this.#deps.log("finished", { path: by, from: installed, target, version: outcome.version });
			this.#set({
				failure: null,
				updatedTo: outcome.version,
				held: held && isNewer(held.version, outcome.version) ? held : null,
			});
			await this.#deps.resume(true).catch(() => undefined);
			this.#deps.onUpdated({ version: outcome.version });
			return;
		}
		if (released) await this.#deps.resume(false).catch(() => undefined);
		if (outcome.kind === "failed") this.#fail(by, outcome.failure, target);
		else this.#deps.log("skipped", { path: by, target, reason: "no-install" });
	}
}

/** IPC for the renderer: a snapshot and "Update now". Nothing else crosses; no handler takes a version, command or path. */
export function registerOmpUpdateIpc(ipc: IpcRegistry, updater: Pick<OmpUpdater, "state" | "updateNow">): void {
	ipc.handle(IPC_COMMANDS.OMP_UPDATE_GET_STATE, () => updater.state());
	// Runs in the background; progress arrives as OMP_UPDATE_STATE pushes.
	ipc.handle(IPC_COMMANDS.OMP_UPDATE_NOW, () => {
		void updater.updateNow().catch(() => undefined);
	});
}
