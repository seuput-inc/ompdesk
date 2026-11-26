/**
 * What a session row's leading status lane shows (Orca's card status lane, the owner's decision of 25 Nov 2026): one
 * state per row, from the rules every surface reads (`sessionRun`, `sessionAttention`, the working cue's
 * `liveWorkState`), ranked as Orca ranks its workspace status and as FX14 asks: what needs the person (its own
 * approval, its own question, a child waiting) > a failure > its turn > work it started that still runs > a session not
 * up yet (connecting, held, waiting for the network) > a turn the person stopped (not news, not done) > an unseen
 * finish > a pull request of its branch > open in a tab > nothing. Pure.
 */
import type { LiveState } from "../components/common";
import type { AttentionKind } from "./attention";
import type { SessionRun } from "./session-run";

export type LaneState =
	| "approval"
	| "question"
	| "childWaiting"
	| "failed"
	| "working"
	| "background"
	| "pending"
	| "interrupted"
	| "done"
	| "pr"
	| "open"
	| "none";

export interface LaneFacts {
	run: Pick<SessionRun, "ask" | "failed" | "done" | "down" | "signal">;
	/** What needs the person (`sessionAttention`): a child waiting reaches the lane too. */
	attention: AttentionKind | undefined;
	/** The working cue's state for the session (`liveWorkState`). */
	live: LiveState | null;
	/** Its last turn ended because the person stopped it. */
	stopped: boolean;
	/** A pull request of its branch is known. */
	pullRequest: boolean;
	/** A tab here holds it. */
	open: boolean;
}

export function laneState(facts: LaneFacts): LaneState {
	const { run } = facts;
	if (run.ask === "approval" || facts.attention === "approval") return "approval";
	if (run.ask === "question" || facts.attention === "question") return "question";
	if (facts.attention === "childWaiting") return "childWaiting";
	if (run.failed) return "failed";
	if (facts.live === "turn") return "working";
	if (facts.live === "background") return "background";
	if (run.down || run.signal?.labelKey === "titlebar.status.connectionWait") return "pending";
	if (facts.stopped) return "interrupted";
	if (run.done) return "done";
	if (facts.pullRequest) return "pr";
	return facts.open ? "open" : "none";
}
