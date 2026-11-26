/**
 * The sessions a session talks with besides its own family (after Orca's crew panel "Talking with", stablyai/orca
 * `components/orchestration-crew/OrchestrationCrewPanel.tsx:253-255`, MIT; re-implemented; FK-O07): who wrote to it,
 * read from its own transcript, as the window holds it: an `ompdesk_session_send` message arrives wrapped with its
 * sender's title (`parseAgentMessage`), a report or note as `ompdesk.mail` with `fromTitle`. Its opener and the
 * sessions it opened are its family, which the Work tree draws already (`exclude`). Newest first. Pure.
 */
import { parseAgentMessage } from "../../shared/agent-control";
import type { AgentMessage } from "../../shared/rpc-types";
import { messageText } from "./messages";

/** Names listed at most: a tooltip line, not a roster. */
const TALKING_WITH_MAX = 5;

export function talkingWith(messages: readonly AgentMessage[], exclude: ReadonlySet<string>): string[] {
	const names: string[] = [];
	for (let index = messages.length - 1; index >= 0 && names.length < TALKING_WITH_MAX; index--) {
		const message = messages[index] as AgentMessage;
		let name: string | undefined;
		if (message.role === "user") name = parseAgentMessage(messageText(message))?.from;
		else if (message.role === "custom" && message.customType === "ompdesk.mail") {
			const from = (message.details as { fromTitle?: unknown } | undefined)?.fromTitle;
			name = typeof from === "string" ? from : undefined;
		}
		if (name && !exclude.has(name) && !names.includes(name)) names.push(name);
	}
	return names;
}
