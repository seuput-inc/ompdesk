/**
 * Idle compaction and the idle recap for GUI tabs. Stock owns both: the settings (`compaction.idleEnabled`,
 * `compaction.idleThresholdTokens`, `compaction.idleTimeoutSeconds`, `recap.enabled`, `recap.idleSeconds`), the
 * scheduler and the work (`AgentSession.enableIdleMaintenance`, omp://sdk.md › Idle maintenance). RPC mode never
 * opts a session in, so this module does, once per live session, and supplies the two things only OMPdesk knows:
 *
 * - `isBlocked`: the tab's composer holds a draft. The bridge cannot see it, so the renderer reports every
 *   empty ⇄ non-empty change (`idle_maintenance_draft`, src/renderer/hooks/use-idle-compaction-draft.ts) and each
 *   report calls `refreshIdleMaintenance()`, which re-arms what the quiet stretch still owes. Stock listens to its
 *   own settings, so a settings write re-arms without a call from here.
 * - `onRecap`: stock journals the reply (`recordRecap`, history.db) and hands it over. Its TUI notice is transient
 *   and the GUI has no such row, so the one-line preview becomes a displayed `recap` custom message (a
 *   `custom_message` journal entry the transcript replays; the renderer draws a quiet line), and the `context` hook
 *   below keeps it out of every model request, so a recap never becomes something the model said or was told.
 */
import type { ContextEvent, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { armContextHook, installContextHook } from "./context-hook";
import { guard } from "./health";
import { isUtf8Mojibake } from "./mojibake";
import type { BridgeMethods } from "./types";

/** `customType` of the recap's custom message (the renderer's RecapCard). */
export const RECAP_MESSAGE_TYPE = "recap";

/** The draft each opted-in session's `isBlocked` reads; stock keeps the first options it was given. */
const drafts = new WeakMap<AgentSession, { empty: boolean }>();

/** Shows a recap stock has journaled and found still current. */
async function deliverRecap(session: AgentSession, reply: string): Promise<void> {
	// UTF-8 the model wrote as Windows-1252 ("ì§€ê¸ˆ") is no recap: not shown.
	if (isUtf8Mojibake(reply)) return;
	// Deferred: stock internals load only after `guard` checked the feature.
	const { previewLine, TRUNCATE_LENGTHS } = await import("./omp/pi-tui/render/render-utils");
	const preview = previewLine(reply, TRUNCATE_LENGTHS.RECAP);
	if (!preview) return;
	// The hook may have left the request path of a session that held no recap: back before the recap lands, and held
	// there until it is in the branch (a side request meanwhile, idle compaction or an ephemeral turn, cannot take it off).
	const release = armContextHook(RECAP_MESSAGE_TYPE, session.sessionManager);
	try {
		await session.sendCustomMessage({
			customType: RECAP_MESSAGE_TYPE,
			content: preview,
			display: true,
			details: { recap: reply },
		});
	} finally {
		release();
	}
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	// A recap is for the person: drop it from what the model is sent (the journal keeps it).
	installContextHook(pi, RECAP_MESSAGE_TYPE, (event: ContextEvent) => {
		const messages = event.messages.filter(
			message => !(message.role === "custom" && message.customType === RECAP_MESSAGE_TYPE),
		);
		return messages.length === event.messages.length ? undefined : { messages };
	});
}

export const methods: BridgeMethods = guard("idleMaintenance", {
	/** `{empty}`: the tab's composer draft is (not) empty. Opts the live session in on its first report. */
	idle_maintenance_draft: async (params, env) => {
		const empty = typeof params === "object" && params !== null && "empty" in params ? params.empty : undefined;
		if (typeof empty !== "boolean") throw new Error("idle_maintenance_draft needs {empty: boolean}");
		const session = env.session();
		let draft = drafts.get(session);
		if (!draft) {
			const state = { empty };
			draft = state;
			drafts.set(session, state);
			session.enableIdleMaintenance({
				isBlocked: () => !state.empty,
				onRecap: reply => void deliverRecap(session, reply).catch(() => {}),
			});
		}
		draft.empty = empty;
		session.refreshIdleMaintenance();
		return { empty };
	},
});
