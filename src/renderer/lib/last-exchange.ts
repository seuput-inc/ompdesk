/**
 * A session's last exchange (its last prompt and the reply after it), for a row's tooltip and a board card (after
 * Orca's thread preview, stablyai/orca `activity/thread-preview/activity-thread-hover-card-summary.tsx:149-161`, MIT;
 * re-implemented). Read only from what this window already holds, never from disk: a tab's transcript in memory,
 * else the transcript snapshot of a session a tab here showed (`lib/transcript-snapshot.ts`). A session this window
 * never showed has none.
 */
import type { AgentMessage } from "../../shared/rpc-types";
import type { MessagesStore } from "../stores/messages";
import { sessionRuntimeStore } from "../stores/session-runtime-context";
import { messageDisplayText } from "./messages";
import { readTranscriptSnapshot } from "./transcript-snapshot";

export interface LastExchange {
	prompt?: string;
	reply?: string;
}

/** Characters kept of each side: a tooltip line and a card's two lines, not a transcript. */
const EXCHANGE_CHARS = 280;

function clip(text: string): string | undefined {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length > EXCHANGE_CHARS ? `${flat.slice(0, EXCHANGE_CHARS - 1)}…` : flat;
}

/** The newest typed prompt and the last assistant text after it; null when the transcript has neither. */
export function lastExchange(messages: readonly AgentMessage[]): LastExchange | null {
	let reply: string | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as AgentMessage;
		if (message.role === "assistant" && reply === undefined) reply = clip(messageDisplayText(message));
		if (message.role === "user") {
			const prompt = clip(messageDisplayText(message));
			return prompt || reply ? { ...(prompt ? { prompt } : {}), ...(reply ? { reply } : {}) } : null;
		}
	}
	return reply ? { reply } : null;
}

/** The exchange as tooltip lines: "You: …" then "Reply: …". */
export function lastExchangeWords(
	t: (key: string, params?: Record<string, string | number>) => string,
	exchange: LastExchange,
): string {
	return [
		exchange.prompt ? t("lastExchange.prompt", { text: exchange.prompt }) : null,
		exchange.reply ? t("lastExchange.reply", { text: exchange.reply }) : null,
	]
		.filter(Boolean)
		.join("\n");
}

/** Snapshot reads parse a whole stored page: one per session file and journal stamp. */
const snapshotReads = new Map<string, LastExchange | null>();

/**
 * The last exchange this window holds of a session: its tab's transcript, else its snapshot (read once per `stamp`,
 * the row's last-modified time).
 */
export function readLastExchange(session: {
	tabId?: string;
	sessionPath: string;
	device?: string;
	stamp?: string;
}): LastExchange | null {
	const live = session.tabId
		? sessionRuntimeStore<MessagesStore>(session.tabId, "messages")?.getState().messages
		: undefined;
	if (live && live.length > 0) return lastExchange(live);
	const key = `${session.device ?? ""}\n${session.sessionPath}\n${session.stamp ?? ""}`;
	if (snapshotReads.has(key)) return snapshotReads.get(key) ?? null;
	const snapshot = readTranscriptSnapshot({ sessionPath: session.sessionPath, device: session.device });
	const exchange = snapshot ? lastExchange(snapshot.messages) : null;
	if (snapshotReads.size > 200) snapshotReads.clear();
	snapshotReads.set(key, exchange);
	return exchange;
}
