/**
 * A session that runs without stock's advisor (control-tools › Tools: `ompdesk_session_open` `advisor: false`, and by
 * default a session opened on the review role). C17, 20 Nov 2026: a review session another project opened on
 * openai-codex had its advisor (the advisor role, Claude) interject, and the reviewer turned its "needs fix" into
 * "ok" 18 s later; a review is worth what the model the person chose for it says, with no second model steering it.
 * `advisor: true`, or no option on another role, runs the session as the person's settings say: the advisor role's
 * model, whatever its family (no same-family or cross-family guarantee either way).
 *
 * Stock's `AgentSession.setAdvisorEnabled(false)` is session-only (what `/advisor off` calls; no setting is written),
 * so the bridge calls it, journals one entry so the omp that continues the session after a relaunch turns it off
 * again before its first turn, and turns it off again after stock re-applies a changed `advisor.enabled` to every
 * session (`agent-session.ts`, its `cfgAdvisorRuntimeInputs` listener). The advisor role is never changed.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { guard } from "./health";
import type { BridgeMethods } from "./types";

/** Journaled once per session: its advisor stays off in every omp that runs it. */
const ADVISOR_OFF_ENTRY = "ompdesk.advisor-off";

/** The slice of stock's `AgentSession` this reads. */
interface AdvisorSession {
	setAdvisorEnabled(enabled: boolean): boolean;
	settings: object;
}

/** Sessions whose `advisor.enabled` changes are watched (one listener per live session). */
const held = new WeakSet<object>();

async function holdOff(session: AdvisorSession): Promise<void> {
	session.setAdvisorEnabled(false);
	if (held.has(session)) return;
	held.add(session);
	// Loaded on use, like ompdesk-roles.ts: a static import would tie this area's link to stock's settings registry.
	const { lookup } = await import("./omp/pi-coding-agent/config/registry");
	const enabled = lookup("advisor.enabled") as { listen?(scope: object, onChange: () => void): unknown } | undefined;
	// After stock's own listener, whichever order the two run in: it turns a changed setting on for every session.
	enabled?.listen?.(session.settings, () => queueMicrotask(() => session.setAdvisorEnabled(false)));
}

function journaled(branch: readonly { customType?: unknown }[]): boolean {
	return branch.some(entry => entry.customType === ADVISOR_OFF_ENTRY);
}

export const methods: BridgeMethods = guard("advisorOff", {
	/** `{}` → `{}`: this session runs without its advisor from now on, relaunches included. */
	"agent_control.advisor_off": async (_params, env) => {
		const session = env.session();
		if (!journaled(session.sessionManager.getBranch()))
			session.sessionManager.appendCustomEntry(ADVISOR_OFF_ENTRY, { at: Date.now() });
		await holdOff(session);
		return {};
	},
});

export function install(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main" || !journaled(ctx.sessionManager.getBranch())) return undefined;
		const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
		if (session) await holdOff(session);
		return undefined;
	});
}
