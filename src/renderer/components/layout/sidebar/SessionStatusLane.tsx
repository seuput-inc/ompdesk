/**
 * A session row's leading status lane (Orca's `worktree-card-status-lane`, the owner's decision of 25 Nov 2026): one
 * 16 px column before the picture, the same width whatever it shows, so a title never moves when the state does. The
 * state comes from `laneState` (lib/session-lane.ts); its words stay the row's tooltip and screen-reader text, so the
 * lane itself is decorative. One component for this computer's rows and a paired host's.
 */
import { CircleHelp, GitPullRequest, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { LaneState } from "../../../lib/session-lane";
import { WorkingArc } from "../../common";
import { SidebarDoneMark } from "./SidebarDoneMark";

export function SessionStatusLane({
	state,
	fresh = false,
	prTone,
}: {
	state: LaneState;
	fresh?: boolean;
	/** How the branch's pull request stands, tinting the `pr` glyph (`branchPrTone`). */
	prTone?: string;
}) {
	let mark: ReactNode = null;
	switch (state) {
		case "approval":
			mark = <ShieldAlert aria-hidden />;
			break;
		case "question":
		case "childWaiting":
			mark = <CircleHelp aria-hidden />;
			break;
		case "working":
		case "background": {
			const live = state === "working" ? "turn" : "background";
			mark = (
				<span className="contents" data-session-working={live}>
					<WorkingArc state={live} />
				</span>
			);
			break;
		}
		case "done":
			mark = <SidebarDoneMark fresh={fresh} />;
			break;
		case "pr":
			mark = <GitPullRequest aria-hidden />;
			break;
		case "failed":
		case "pending":
		case "interrupted":
		case "open":
			mark = <span className="omp-status-lane-dot" />;
			break;
	}
	return (
		<span
			aria-hidden
			className="omp-status-lane"
			data-pr-checks={state === "pr" ? prTone : undefined}
			data-status-lane={state}
		>
			{mark}
		</span>
	);
}
