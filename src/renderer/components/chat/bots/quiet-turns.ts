import { isQuietResult } from "../../../../shared/bots";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { resultDetails } from "../../../lib/format";
import { messageText } from "../../../lib/messages";
import { parseTodoReminder } from "../todo-reminder";

/** Only a completed marker, never a result with NO_REPLY appended or a person's quotation. */
export function quietMarker(message: AgentMessage): boolean {
	if (
		message.role !== "assistant" ||
		message.stopReason !== "stop" ||
		message.errorMessage ||
		message.cancelled ||
		message.isError ||
		message.steering
	)
		return false;
	if (
		Array.isArray(message.content) &&
		!message.content.every(block => block.type === "text" || (block.type === "thinking" && !block.narration))
	)
		return false;
	const text = messageText(message);
	return !text.includes("\n") && isQuietResult(text);
}

const LOOKUPS = ["read", "grep", "find", "ls", "glob"];

/** Keep every unknown operation. A lookup is private bookkeeping only after its matching successful result. */
function quietStart(messages: AgentMessage[], end: number, floor: number): number {
	let start = end;
	while (start > floor) {
		const entry = messages[start - 1];
		if (!entry || entry.errorMessage || entry.cancelled || entry.isError) break;
		if (parseTodoReminder(entry)) {
			start--;
			continue;
		}
		if (entry.role === "custom" && entry.customType === "advisor") {
			const notes = resultDetails(entry)?.notes;
			if (Array.isArray(notes) && notes.length && notes.every(note => note?.severity === "nit")) {
				start--;
				continue;
			}
		}
		if (
			entry.role !== "toolResult" ||
			entry.isError !== false ||
			!entry.toolCallId ||
			!LOOKUPS.includes(entry.toolName ?? "") ||
			start - 2 < floor
		)
			break;
		const request = messages[start - 2];
		if (
			request?.role !== "assistant" ||
			request.stopReason !== "toolUse" ||
			request.errorMessage ||
			!Array.isArray(request.content)
		)
			break;
		const calls = request.content.filter(block => block.type !== "thinking" || block.narration);
		if (
			calls.length !== 1 ||
			calls[0]?.type !== "toolCall" ||
			calls[0].id !== entry.toolCallId ||
			calls[0].name !== entry.toolName
		)
			break;
		start -= 2;
	}
	return start;
}

/** Projection of finalized compact bot history only. Full detail, live pending work and the journal keep their records. */
export function compactBotHistory(messages: AgentMessage[]): AgentMessage[] {
	let kept: AgentMessage[] | undefined;
	let from = 0;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!message || !quietMarker(message)) continue;
		const end = quietStart(messages, i, from);
		kept ??= [];
		for (; from < end; from++) kept.push(messages[from]);
		from = i + 1;
	}
	if (!kept) return messages;
	for (; from < messages.length; from++) kept.push(messages[from]);
	return kept;
}
