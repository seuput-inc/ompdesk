/**
 * What the control socket asks of the app: the same agent-control service the `ompdesk_*` host tools use
 * (`AgentControlRuntime`), called as an outside caller, and the pool's tab activity for waits and events. The socket
 * never decides a tool's rules itself.
 */

import type { SessionStatus } from "../../shared/control-protocol";
import type { AgentControlRuntime, ControlTabSnapshot, OutsideCaller } from "../agent-control/host";
import type { ToolOutcome } from "../agent-control/service";
import type { SidecarPool, TabActivity } from "../sidecar-pool";

export type { OutsideCaller };

export interface ControlBackend {
	/** One control tool call, exactly as an agent in a session makes it (`AgentControlRuntime.runOutside`). */
	run(caller: OutsideCaller, tool: string, args: unknown): Promise<ToolOutcome>;
	/**
	 * The open session `name` names, by the tools' own rules (tab id, saved id, prefix, title); a session hidden from
	 * agents is refused. Rejects with the tools' own message when nothing open matches.
	 */
	resolve(caller: OutsideCaller, name: string): Promise<SessionStatus>;
	/** Host facts for the core's waits and events. Hidden tabs never cross this boundary. */
	snapshots(): ControlTabSnapshot[];
	/** The pool's tab activity (a turn starting or ending, an ask, a close), as it happens. */
	observe(listener: (activity: TabActivity) => void): () => void;
	/** Reports addressed to an outside caller (a session it opened called `ompdesk_report`). */
	onOutsideMail(listener: (callerId: string, text: string) => void): () => void;
	/** The caller's connection closed: it no longer acts or hears reports. */
	release(caller: OutsideCaller): void;
}

/** The backend over the app's control runtime and pool. A session hidden from agents is never seen. */
export function createControlBackend(
	runtime: Pick<
		AgentControlRuntime,
		"runOutside" | "resolveOutside" | "controlTabs" | "onOutsideMail" | "releaseOutside"
	>,
	pool: Pick<SidecarPool, "observeTabs">,
): ControlBackend {
	return {
		run: (caller, tool, args) => runtime.runOutside(caller, tool, args),
		resolve: (caller, name) => runtime.resolveOutside(caller, name),
		snapshots: () => runtime.controlTabs(),
		observe: listener => pool.observeTabs(listener),
		onOutsideMail: listener => runtime.onOutsideMail(listener),
		release: caller => runtime.releaseOutside(caller),
	};
}
