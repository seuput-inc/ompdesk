import { useEffect, useMemo, useState } from "react";
import { useJobs } from "../../../hooks/use-background-jobs";
import { useLiveReview } from "../../../hooks/use-live-review";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { useT } from "../../../lib/i18n";
import { requestLabel } from "../../../lib/question-inbox";
import { parseStreamingArgs } from "../../../lib/streaming-json";
import { botOfFolder, botOfSession, useBotsStore } from "../../../stores/bots";
import { isUserBlockingRequest, useExtensionUiStore } from "../../../stores/extension-ui";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../../stores/tools";
import { childActivity } from "../../layout/work-board/opened-children";
import { checkWords, useTurnCheck } from "../../layout/work-board/use-turn-check";
import { liveSubagents, workingSubagents } from "../../layout/work-board/work-board";
import { subagentPrimaryLabel } from "../../panels/subagent-graph";
import { workNarrative } from "../work/work-view";
import type { DockFacts, DockRunner } from "./dock-summary";

const NO_FACTS: DockFacts = {};
const RECENT_MS = 15_000;
type Completion = { at: number; text: string };

/** Only calls that still run can describe what the parent is doing now. */
function newestLiveStep(entries: ReadonlyMap<string, ToolEntry>): ToolEntry | undefined {
	let newest: ToolEntry | undefined;
	for (const call of entries.values()) {
		if (!newest || call.startTime >= newest.startTime) newest = call;
	}
	return newest;
}

export function useDockFacts(enabled = true): DockFacts {
	const t = useT();
	const runtimeTabId = useRuntimeTabId();
	const focused = useTabsStore(state => state.activeTabId);
	const tabId = enabled ? (runtimeTabId ?? focused) : null;
	const tabs = useTabsStore(state => state.tabs);
	const tab = tabs.find(row => row.id === tabId);
	const session = useSessionStore(state => state.sessionFile) ?? tab?.sessionPath;
	const cwd = useSessionStore(state => state.cwd) || tab?.cwd;
	const bot = useBotsStore(state =>
		enabled
			? (botOfSession(state.state.bots, session, tab?.device) ?? botOfFolder(state.state.bots, cwd, tab?.device))
			: undefined,
	);
	const items = useBotsStore(state => (bot ? state.state.items : undefined));
	const subagents = useSubagentsStore(state => (enabled ? state.subagents : undefined));
	const jobs = useJobs(feed => (enabled ? feed.rows : null), false);
	const opened = useOpenedChildren(tabId);
	useLiveReview(tabId, tabId !== null && tabId === focused && opened.counts.running > 0);
	const active = useTodoStore(state => enabled && state.turnActive);
	const start = useTodoStore(state => (state.turnSourceKnown && state.turnActive ? state.turnStartedAt : null));
	const ended = useTodoStore(state => (enabled && !state.turnActive ? state.lastTurn?.end : undefined));
	const call = useToolsStore(state => (active ? newestLiveStep(state.liveTools) : undefined));
	const ask = useExtensionUiStore(state =>
		enabled ? state.pendingRequests.find(request => isUserBlockingRequest(state, request)) : undefined,
	);
	const { check } = useTurnCheck(enabled ? "cached" : "off");

	const { facts, recent } = useMemo<{ facts: DockFacts; recent?: Completion }>(() => {
		if (!subagents) return { facts: NO_FACTS, recent: undefined };
		const runners: DockRunner[] = [];
		const links: NonNullable<DockFacts["links"]> = [];
		// The core first records a child tab id, then replaces it with its session path. Neither id crosses hosts.
		const sessions = new Map<string, string>();
		for (const agent of workingSubagents(liveSubagents(subagents))) {
			const progress = agent.progress;
			const sampled = progress?.durationMs;
			const startedAt =
				sampled !== undefined && Number.isFinite(sampled) && sampled >= 0 && agent.lastUpdate > sampled
					? agent.lastUpdate - sampled
					: undefined;
			const args = progress?.currentToolArgs?.trim();
			const step = progress?.currentTool
				? workNarrative(
						progress.currentTool,
						args?.startsWith("{") ? parseStreamingArgs(args) : { target: args },
						t,
						undefined,
						progress.currentToolIntent,
					)
				: progress?.currentToolIntent || progress?.lastIntent;
			runners.push({
				id: `agent:${agent.id}`,
				title: subagentPrimaryLabel(agent),
				step,
				startedAt,
				session: agent.sessionFile,
			});
			if (agent.sessionFile) sessions.set(agent.sessionFile, agent.sessionFile);
		}
		let recent: Completion | undefined;
		function completed(at: number | undefined, title?: string): void {
			if (!at || (recent && at <= recent.at)) return;
			const text = title ? `${t("workBoard.opened.status.done")} · ${title}` : t("workBoard.head.done");
			recent = { at, text };
		}
		for (const child of opened.rows) {
			const title = child.title || t("workBoard.review.untitled");
			if (child.status === "running") {
				const device = child.tabId
					? (tabs.find(row => row.id === child.tabId)?.device ?? child.deviceId)
					: child.deviceId;
				const session = device === tab?.device ? child.sessionPath || child.key : undefined;
				if (session) {
					sessions.set(session, session);
					sessions.set(child.key, session);
				}
				runners.push({
					id: `child:${child.key}`,
					title,
					session,
					step: child.stopping ? t("workBoard.opened.stopping") : (childActivity(child) ?? undefined),
					startedAt: child.since,
				});
			} else if (child.status === "done" && child.report?.kind === "done") {
				completed(child.report.at, title);
			}
		}
		for (const row of jobs ?? []) {
			if (row.kind !== "job" || row.job.type === "task") continue;
			const job = row.job;
			if (job.status === "running") {
				runners.push({
					id: `job:${job.agentId ?? ""}:${job.id}:${job.startTime}`,
					title: job.label,
					startedAt: job.startTime,
				});
			} else if (job.status === "completed") completed(job.endedAt, job.label);
		}
		for (const agent of subagents.values()) {
			if (agent.status === "completed") completed(agent.lastUpdate, subagentPrimaryLabel(agent));
		}
		if (tab?.lastRun?.stopReason === "stop") completed(ended);
		for (const item of items ?? []) {
			if (item.bot !== bot?.id || item.device !== bot?.device) continue;
			for (const link of item.links) {
				const session = link.kind === "session" && sessions.get(link.ref);
				if (session) links.push({ session, number: item.number, title: item.title });
			}
		}
		const waiting = opened.rows.find(row => row.status === "waiting");
		const attention = ask
			? requestLabel(ask, t)
			: waiting
				? `${t("attention.childWaiting")} · ${childActivity(waiting) || waiting.title || t("workBoard.review.untitled")}`
				: undefined;
		const facts: DockFacts = {
			runners,
			links,
			attention,
			failure: check?.state === "failed" ? checkWords(t, check) : undefined,
			step: call ? workNarrative(call.toolName, call.args, t, undefined, call.intent) : undefined,
			startedAt: active ? (start ?? tab?.runningSince) : undefined,
			nextLabel: task => t("dock.todo.next", { task }),
		};
		return { facts, recent };
	}, [active, ask, bot, call, check, ended, items, jobs, opened.rows, start, subagents, t, tab, tabs]);

	const until = recent ? recent.at + RECENT_MS : 0;
	const [expired, setExpired] = useState(0);
	useEffect(() => {
		const left = until - Date.now();
		if (left <= 0) return;
		const timer = window.setTimeout(() => setExpired(until), left);
		return () => window.clearTimeout(timer);
	}, [until]);
	return recent && expired !== until && until > Date.now() ? { ...facts, finished: recent.text } : facts;
}
