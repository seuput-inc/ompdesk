/**
 * Every session of every computer as one board (after Orca's agent dashboard, stablyai/orca
 * `components/dashboard/board/agent-board-projection.ts:19-121` and `agent-board-filtering.ts:24-64`, MIT;
 * re-implemented): one card per session, in one of four lanes by the one rule every surface reads (`sessionRun`, the
 * computer's own summary): Needs you (its own question or approval), Working (a turn, background work, a compaction or
 * subagents at work), Done (a finish nobody in this window looked at yet: its tab's ✓) and Idle (the rest). A waiting
 * child is a card of its own in Needs you, so its opener is not counted again. Nothing here is a status the person
 * picks: the lanes are OMPdesk's facts (work-board.md). Pure.
 */
import type { SessionInfo } from "../../../shared/ipc-types";
import { isUnsavedSession, type SessionSummary } from "../../../shared/session-summary";
import { type SessionRun, sessionRun } from "../../lib/session-run";
import { sessionHasContent } from "../../lib/session-title";
import type { SessionTab } from "../../stores/tabs";
import { workingAgentCount } from "../layout/live-work";

export const BOARD_LANES = ["needs", "working", "done", "idle"] as const;
export type BoardLane = (typeof BOARD_LANES)[number];

/** One computer's sessions as this window knows them. `device` absent: this computer. */
export interface BoardComputer {
	device?: string;
	/** A paired computer's name (the card's host badge). */
	name?: string;
	sessions: readonly SessionInfo[];
	summaries: readonly SessionSummary[];
}

export interface BoardCard {
	/** `device\npath`: unique across computers. */
	key: string;
	device?: string;
	deviceName?: string;
	sessionPath: string;
	/** Its row in its computer's list; absent for a live tab whose omp has not named a file yet. */
	info?: SessionInfo;
	summary?: SessionSummary;
	/** The tab of this window that holds it. */
	tab?: SessionTab;
	cwd: string;
	chat: boolean;
	lane: BoardLane;
	run: SessionRun;
	/** Subagents at work under it. */
	agents: number;
	/** When it last changed (ms): the running turn's start, else its newest message. */
	at: number;
}

function laneOf(run: SessionRun, agents: number): BoardLane {
	if (run.waiting) return "needs";
	if (run.running || agents > 0) return "working";
	return run.done ? "done" : "idle";
}

/**
 * The board's cards: every listed session with content, and every live session its computer summarizes (a new tab's
 * row before its file exists included), newest first. `archived` names sessions the sidebar keeps archived: they stay
 * off the board unless they run.
 */
export function boardCards(
	computers: readonly BoardComputer[],
	tabs: readonly SessionTab[],
	archived: ReadonlySet<string> = new Set(),
): BoardCard[] {
	const cards: BoardCard[] = [];
	for (const computer of computers) {
		const summaries = new Map(computer.summaries.map(summary => [summary.sessionPath, summary]));
		const tabOf = (path: string, tabId?: string) =>
			tabs.find(
				tab =>
					(tab.device ?? undefined) === computer.device &&
					(tab.sessionPath === path || (tabId !== undefined && tab.id === tabId && !tab.sessionPath)),
			);
		const add = (sessionPath: string, info: SessionInfo | undefined, summary: SessionSummary | undefined) => {
			const tab = tabOf(sessionPath, summary?.tabId);
			const run = sessionRun(summary, tab?.unreadDone === true);
			const agents = workingAgentCount(summary?.agents ?? []);
			const modified = info ? Date.parse(info.modified) : 0;
			cards.push({
				key: `${computer.device ?? ""}\n${sessionPath}`,
				...(computer.device === undefined ? {} : { device: computer.device }),
				...(computer.name === undefined ? {} : { deviceName: computer.name }),
				sessionPath,
				...(info ? { info } : {}),
				...(summary ? { summary } : {}),
				...(tab ? { tab } : {}),
				cwd: info?.cwd ?? summary?.cwd ?? tab?.cwd ?? "",
				chat: (info?.kind ?? summary?.kind) === "chat",
				lane: laneOf(run, agents),
				run,
				agents,
				at: Math.max(Number.isFinite(modified) ? modified : 0, summary?.since ?? 0),
			});
		};
		const listed = new Set<string>();
		for (const info of computer.sessions) {
			listed.add(info.path);
			const summary = summaries.get(info.path);
			if (!summary && (!sessionHasContent(info) || archived.has(info.id))) continue;
			add(info.path, info, summary);
		}
		for (const summary of computer.summaries) {
			if (listed.has(summary.sessionPath)) continue;
			// A tab of a paired device's that this computer runs is a card of that device's.
			if (summary.openFor !== undefined && isUnsavedSession(summary)) continue;
			add(summary.sessionPath, undefined, summary);
		}
	}
	return cards.sort((a, b) => b.at - a.at);
}

/** What the board narrows to: free text, and the projects and computers picked (none picked: all). */
export interface BoardFilter {
	query: string;
	projects: readonly string[];
	/** `""` is this computer. */
	computers: readonly string[];
}

/** Whether a card passes the filter; `projectOf` names its project as its chip does, `title` its shown title. */
export function matchesBoard(
	card: BoardCard,
	filter: BoardFilter,
	projectOf: (cwd: string) => string,
	title: string,
): boolean {
	if (filter.projects.length > 0 && !filter.projects.includes(projectOf(card.cwd))) return false;
	if (filter.computers.length > 0 && !filter.computers.includes(card.device ?? "")) return false;
	const query = filter.query.trim().toLowerCase();
	if (!query) return true;
	const text = [title, card.info?.firstMessage, card.cwd, card.deviceName, projectOf(card.cwd)]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	return query.split(/\s+/).every(token => text.includes(token));
}

/** The cards of each lane, in board order. */
export function boardLanes(cards: readonly BoardCard[]): Record<BoardLane, BoardCard[]> {
	const lanes: Record<BoardLane, BoardCard[]> = { needs: [], working: [], done: [], idle: [] };
	for (const card of cards) lanes[card.lane].push(card);
	return lanes;
}
