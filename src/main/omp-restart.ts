/**
 * After `omp update`, which tabs move to the new omp and when. An omp process
 * keeps the code it loaded, so a tab that is running a turn is never touched:
 * it restarts the moment its turn ends. A tab whose relaunch continuation is
 * still owed (`TurnResume.relaunchContinuation` is `after_restore`: its restore
 * may be on its way to the omp, and the tab reads idle until stock starts the
 * restored turn) waits the same way, and restarts once the continuation ended
 * (`ompRestartIfWaiting`) or its turn did. Every other tab restarts at once,
 * resuming the session file it is attached to, so no conversation is lost; the
 * composer draft lives in the window, not in the process, and survives the
 * restart. A tab that never started (`asleep`) needs nothing: its first spawn
 * resolves the new omp.
 */
import type { SidecarStatus } from "../shared/rpc-types";

export type OmpRestartDecision = "restart" | "wait" | "skip";

export function ompRestartDecision(facts: {
	status: SidecarStatus;
	busy: boolean;
	resuming?: boolean;
}): OmpRestartDecision {
	if (facts.status === "asleep") return "skip";
	return facts.busy || facts.resuming === true ? "wait" : "restart";
}
