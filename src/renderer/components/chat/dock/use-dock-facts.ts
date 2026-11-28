import { useEffect, useMemo, useState } from "react";
import { ITEMS_LINKED_MAX, type ItemsV2Request } from "../../../../shared/items-v2";
import { useJobs } from "../../../hooks/use-background-jobs";
import { useLiveReview } from "../../../hooks/use-live-review";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { useT } from "../../../lib/i18n";
import { requestLabel } from "../../../lib/question-inbox";
import { parseStreamingArgs } from "../../../lib/streaming-json";
import { botOfFolder, botOfSession, useBotsStore } from "../../../stores/bots";
import { isUserBlockingRequest, useExtensionUiStore } from "../../../stores/extension-ui";
import { cachedItemQuery, queryItems } from "../../../stores/item-query";
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
type Links = NonNullable<DockFacts["links"]>;
type LinkRequest = Extract<ItemsV2Request, { action: "itemsLinked" }>;
const NO_LINKS: Links = [];

function linkRequests(bot: string, aliases: Map<string, string>): LinkRequest[] {
	if (aliases.size <= ITEMS_LINKED_MAX)
		return [{ protocol: 2, action: "itemsLinked", bot, sessions: [...aliases.keys()] }];
	const batches: LinkRequest[] = [];
	const groups = new Map<string, string[]>();
	for (const [key, session] of aliases) {
		const group = groups.get(session);
		if (group) group.push(key);
		else groups.set(session, [key]);
	}
	// The dock matches one runner at a time. Keep its tab and path in insertion order in one reply.
	let batch: string[] = [];
	for (const group of groups.values()) {
		if (batch.length + group.length > ITEMS_LINKED_MAX) batch = [];
		for (const key of group) {
			if (batch.length === ITEMS_LINKED_MAX) batch = [];
			if (!batch.length) batches.push({ protocol: 2, action: "itemsLinked", bot, sessions: batch });
			batch.push(key);
		}
	}
	return batches;
}

function useDockLinks(bot: string | undefined, device: string | undefined, sessionKey: string): Links {
	const plan = useMemo(() => {
		if (!bot || !sessionKey) return null;
		const aliases = new Map<string, string>(JSON.parse(sessionKey));
		const requests = linkRequests(bot, aliases);
		const cached = requests.map(r => cachedItemQuery(device ?? null, r)?.links);
		return { bot, device, aliases, requests, cached };
	}, [bot, device, sessionKey]);
	const revision = useBotsStore(s => plan && s.linkRevision(plan.device, plan.bot));
	const online = useBotsStore(s => !device || s.state.remote?.some(host => host.device === device && host.online));
	const [loaded, setLoaded] = useState<{ plan: NonNullable<typeof plan>; links: Links }>();
	useEffect(() => {
		if (!plan || !online || revision === null) return;
		let current = true;
		void Promise.all(plan.requests.map(r => queryItems(plan.device ?? null, r))).then(
			replies => {
				if (current) setLoaded({ plan, links: replies.flatMap(reply => reply.links) });
			},
			// A failed refresh is not evidence that the host has no links.
			() => undefined,
		);
		return () => {
			current = false;
		};
	}, [online, plan, revision]);
	return useMemo(() => {
		if (!plan) return NO_LINKS;
		const previous = loaded?.plan.bot === plan.bot && loaded.plan.device === plan.device ? loaded.links : NO_LINKS;
		const raw =
			loaded?.plan === plan
				? loaded.links
				: plan.requests.flatMap(
						(r, i) => plan.cached[i] ?? previous.filter(link => r.sessions.includes(link.session)),
					);
		const links: Links = [];
		for (const link of raw) {
			const session = plan.aliases.get(link.session);
			if (session) links.push({ ...link, session });
		}
		return links;
	}, [loaded, plan]);
}

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

	const { facts, recent, sessionKey } = useMemo<{ facts: DockFacts; recent?: Completion; sessionKey: string }>(() => {
		if (!subagents) return { facts: NO_FACTS, recent: undefined, sessionKey: "" };
		const runners: DockRunner[] = [];
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
		const waiting = opened.rows.find(row => row.status === "waiting");
		const attention = ask
			? requestLabel(ask, t)
			: waiting
				? `${t("attention.childWaiting")} · ${childActivity(waiting) || waiting.title || t("workBoard.review.untitled")}`
				: undefined;
		const facts: DockFacts = {
			runners,
			attention,
			failure: check?.state === "failed" ? checkWords(t, check) : undefined,
			step: call ? workNarrative(call.toolName, call.args, t, undefined, call.intent) : undefined,
			startedAt: active ? (start ?? tab?.runningSince) : undefined,
			nextLabel: task => t("dock.todo.next", { task }),
		};
		return { facts, recent, sessionKey: sessions.size ? JSON.stringify([...sessions]) : "" };
	}, [active, ask, call, check, ended, jobs, opened.rows, start, subagents, t, tab, tabs]);
	const device = tab?.device;
	const botId = useBotsStore(state =>
		sessionKey
			? (botOfSession(state.state.bots, session, device) ?? botOfFolder(state.state.bots, cwd, device))?.id
			: undefined,
	);
	const links = useDockLinks(botId, botId ? device : undefined, sessionKey);
	const linkedFacts = useMemo(() => (enabled ? { ...facts, links } : NO_FACTS), [enabled, facts, links]);

	const until = recent ? recent.at + RECENT_MS : 0;
	const [expired, setExpired] = useState(0);
	useEffect(() => {
		const left = until - Date.now();
		if (left <= 0) return;
		const timer = window.setTimeout(() => setExpired(until), left);
		return () => window.clearTimeout(timer);
	}, [until]);
	return recent && expired !== until && until > Date.now() ? { ...linkedFacts, finished: recent.text } : linkedFacts;
}
