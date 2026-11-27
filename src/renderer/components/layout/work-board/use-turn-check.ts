import { useMemo } from "react";
import { useMessagesStore } from "../../../stores/messages";
import { useSessionStore } from "../../../stores/session";
import { useTodoStore } from "../../../stores/todo";
import { useToolsStore } from "../../../stores/tools";
import { callStops } from "../../chat/chat-stream-utils";
import { backgroundJobVerdicts } from "../../chat/completion-events";
import { useRunOutcome, useRunStores } from "../../chat/work/use-work-run";
import { turnScope } from "../../chat/work/work-findings";
import { type LastCheck, lastCheck } from "./session-board";

/** A call and the turn containing it can be stamped by different events in one batch. */
export const TURN_CLOCK_SLACK_MS = 500;
const NO_KEYS: readonly string[] = [];

/** The board hydrates a finished agent's transcript; the folded dock reads only evidence already in this pane. */
export function useTurnCheck(mode: "hydrate" | "cached" | "off") {
	const enabled = mode !== "off";
	const { tools } = useRunStores();
	const cwd = useSessionStore(state => state.cwd);
	const messages = useMessagesStore(state => (enabled ? state.messages : null));
	const live = useToolsStore(state => (enabled ? state.liveTools : null));
	const version = useToolsStore(state => (enabled ? state.finishedVersion : 0));
	const running = useTodoStore(state => enabled && state.turnActive);
	const start = useTodoStore(state => (state.turnActive ? state.turnStartedAt : state.lastTurn?.start));
	const prompted = messages?.findLast(message => message.role === "user")?.timestamp;
	const from = (start ?? (typeof prompted === "number" ? prompted : 0)) - TURN_CLOCK_SLACK_MS;
	// biome-ignore lint/correctness/useExhaustiveDependencies: version marks the finished map changing in place.
	const keys = useMemo(() => {
		if (!enabled) return NO_KEYS;
		const result: string[] = [];
		for (const [key, entry] of tools.getState().finishedTools) if (entry.startTime >= from) result.push(key);
		return result;
	}, [enabled, from, tools, version]);
	const stops = messages ? callStops(messages) : undefined;
	const { outcome } = useRunOutcome(keys, undefined, stops, mode === "hydrate");
	// biome-ignore lint/correctness/useExhaustiveDependencies: version marks the finished map changing in place.
	const check = useMemo(() => {
		if (!live || !messages || !stops) return null;
		const finished = tools.getState().finishedTools;
		const entries = keys.flatMap(key => {
			const entry = finished.get(key);
			return entry ? [[key, entry] as const] : [];
		});
		return lastCheck(
			[...finished, ...live],
			outcome.commands,
			cwd,
			backgroundJobVerdicts(messages),
			stops,
			turnScope(entries, outcome.commands, { running, failedEnd: false }),
		);
	}, [tools, live, version, cwd, messages, stops, outcome.commands, keys, running]);
	return { outcome, check };
}

export function checkWords(t: (key: string, params?: Record<string, string | number>) => string, check: LastCheck): string {
	const verdict = check.state === "passed" ? "passed" : "failed";
	const words =
		check.state === "running"
			? t(`workBoard.session.check.${check.kind}.running`)
			: check.count !== undefined
				? t(`chat.work.check.${check.kind}.${verdict}Count`, { count: check.count })
				: t(`chat.work.check.${check.kind}.${verdict}`);
	return check.release ? `${words} · ${t("workBoard.session.check.release")}` : words;
}
