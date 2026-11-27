/**
 * Rules of the work board (`WorkBoard.tsx`): when a session pane has room for it and how its
 * rows are chosen. Pure, so the breakpoint and the sections are tested without a DOM.
 */

import type { RpcGoalState, SubagentSnapshot, TodoTask } from "../../../../shared/rpc-types";
import { type AskKind, type Attention, sessionAttention } from "../../../lib/attention";
import { formatDuration } from "../../../lib/format";
import type { UiTodoPhase } from "../../../stores/todo";
import { buildDockModel } from "../../chat/dock/dock-summary";
import { isLiveSubagentStatus } from "../../panels/subagent-graph";

/** Width of the board and the gap between it and the transcript column (components.css `--omp-board-*`). */
export const WORK_BOARD_WIDTH = 264;
/** The board in a wide pane (a 1920 px window beside the sidebar): fewer titles cut, the transcript column unmoved. */
export const WORK_BOARD_WIDE_WIDTH = 320;
export const WORK_BOARD_GAP = 24;
/** The margin the pane must leave beside the transcript column before the board takes it. */
export const WORK_BOARD_MIN_SPARE = 300;
/** The margin from which the board takes its wide width. */
export const WORK_BOARD_WIDE_SPARE = 420;

/** `--omp-column-reading` (46rem, Orca's chat column) and the clamp of `--omp-column-pad` (16px … 3cqw … 40px), components.css. */
export const READING_COLUMN_PX = 736;
const COLUMN_PAD_MIN_PX = 16;
const COLUMN_PAD_MAX_PX = 40;
const COLUMN_PAD_RATIO = 0.03;

function columnPad(paneWidth: number): number {
	return Math.min(COLUMN_PAD_MAX_PX, Math.max(COLUMN_PAD_MIN_PX, paneWidth * COLUMN_PAD_RATIO));
}

/** The transcript column (reading width plus its two paddings) in a pane `paneWidth` wide. */
export function transcriptColumnWidth(paneWidth: number): number {
	return READING_COLUMN_PX + 2 * columnPad(paneWidth);
}

/** Whether a pane this wide leaves at least `WORK_BOARD_MIN_SPARE` px beside the transcript column. */
export function workBoardFits(paneWidth: number): boolean {
	return paneWidth - transcriptColumnWidth(paneWidth) >= WORK_BOARD_MIN_SPARE;
}

/**
 * The narrowest transcript a sideways tablet keeps beside the docked board. Picked by what still reads (20 Oct 2026,
 * dev harness `?stress=1`, ko, 1 px steps): the composer's toolbar is the box less its 2 px border, and at 500 px
 * (`@container omp-toolbar (max-width: 500px)`, components.css) the model chip loses its name, so the box needs
 * 503. At 504 px the five-column table still fits without scrolling sideways (notes wrap to 3 lines; 5 at 466,
 * 8 at 419), a diff's 61-column paths fit, the work card's head stays one line and the toolbar one row.
 */
export const WORK_BOARD_MIN_TRANSCRIPT = 503;

/**
 * Whether the board docks in a pane this wide when the transcript column may narrow (below its 46rem) to make room:
 * the text keeps at least `WORK_BOARD_MIN_TRANSCRIPT` px after the board, its gap and the column's paddings.
 * Measured (web build, sidebar at its default 280 px): with the sidebar open, iPad Pro 12.9" sideways (1366) keeps
 * 731 px of text, iPad Air (1180) 556 and iPad mini (1133) 512, so all dock; a 1024 px tablet (744 px pane) keeps the
 * strip until its sidebar folds.
 */
export function workBoardFitsNarrowed(paneWidth: number): boolean {
	return paneWidth - WORK_BOARD_WIDTH - WORK_BOARD_GAP - 2 * columnPad(paneWidth) >= WORK_BOARD_MIN_TRANSCRIPT;
}

/**
 * Whether the board docks in a pane this wide: beside the full 46rem column, or beside a column narrowed to
 * `WORK_BOARD_MIN_TRANSCRIPT` in a desktop window and on a tablet held sideways. Only a phone and a portrait tablet
 * keep the strip whatever their width. A desktop window narrowed its column for the board too since 22 Oct 2026 (the
 * user's report: on a Windows laptop at 150 % scaling, a 1280 px window beside the sidebar, the board never docked
 * and only the strip showed; before, a desktop window kept the full column, docking from a 1137 px pane).
 */
export function workBoardDocks(paneWidth: number, shell: string | null): boolean {
	if (workBoardFits(paneWidth)) return true;
	return shell !== "phone" && shell !== "tablet-portrait" && workBoardFitsNarrowed(paneWidth);
}

/** The docked board's width in a pane this wide (`workBoardFits` first): wide where the margin has room for it. */
export function workBoardWidth(paneWidth: number): number {
	return paneWidth - transcriptColumnWidth(paneWidth) >= WORK_BOARD_WIDE_SPARE
		? WORK_BOARD_WIDE_WIDTH
		: WORK_BOARD_WIDTH;
}

/**
 * How a session pane shows its work: docked beside the transcript where the margin holds it and the side panel is
 * closed, else the status strip under the header (a phone, a tablet, a narrow window, a split pane, the side panel
 * open), which expands into the same board. Never nothing: the board has no close (the user's call, 22 Oct 2026: there
 * was a ✕ and no way to open it again).
 */
export function workBoardForm(input: { panelOpen: boolean; fits: boolean }): "docked" | "strip" {
	return input.fits && !input.panelOpen ? "docked" : "strip";
}

/**
 * The goal row's one figure: the larger share of its token budget or time limit used ("62%"), else the time it has
 * run; the budget and time in words are the row's tooltip.
 */
export function goalMeta(detail: RpcGoalState | null): string | undefined {
	if (!detail) return undefined;
	const shares = [
		detail.tokenBudget ? (detail.tokensUsed ?? 0) / detail.tokenBudget : null,
		detail.timeLimitSeconds ? (detail.timeUsedSeconds ?? 0) / detail.timeLimitSeconds : null,
	].filter((share): share is number => share !== null);
	if (shares.length > 0) return `${Math.round(Math.min(1, Math.max(...shares)) * 100)}%`;
	return (detail.timeUsedSeconds ?? 0) > 0 ? formatDuration((detail.timeUsedSeconds ?? 0) * 1000) : undefined;
}

export interface TodoBoardRow {
	content: string;
	status: TodoTask["status"];
}

export interface TodoBoard {
	/** Completed tasks: all of them fold into the one "n done" row, wherever they sit in the plan. */
	done: number;
	total: number;
	/** The first in-progress task, else null. */
	active: string | null;
	rows: TodoBoardRow[];
	/** Tasks after the last shown row. */
	hidden: number;
	/** Every counted task's status in order, for the progress bar. */
	segments: TodoTask["status"][];
}

/** Rows the plan section lists before it folds the rest into a count. */
export const TODO_BOARD_ROWS = 5;

/** Cap the dock's ordered plan, not the stored plan: the active task can be in its last phase. */
export function todoBoard(phases: readonly UiTodoPhase[]): TodoBoard | null {
	const plan = buildDockModel(phases);
	if (!plan.total) return null;
	const rows: TodoBoardRow[] = [];
	for (const phase of plan.phases) {
		rows.push(...phase.tasks.slice(0, TODO_BOARD_ROWS - rows.length));
		if (rows.length === TODO_BOARD_ROWS) break;
	}
	return {
		done: plan.done,
		total: plan.total,
		active: plan.active?.content ?? null,
		rows,
		hidden: plan.total - plan.done - rows.length,
		segments: phases.flatMap(phase => phase.tasks.filter(t => t.status !== "abandoned").map(t => t.status)),
	};
}

/** Live subagents (working or waiting; a finished, failed or aborted one has left the board) in spawn order. */
export function liveSubagents(subagents: ReadonlyMap<string, SubagentSnapshot>): SubagentSnapshot[] {
	const live: SubagentSnapshot[] = [];
	for (const agent of subagents.values()) if (isLiveSubagentStatus(agent.status)) live.push(agent);
	return live.sort((a, b) => a.index - b.index);
}

/** A subagent that waits (parked, idle) is live but not at work: the pulse and "Working…" leave it out. */
export function isWaitingSubagent(status: string): boolean {
	return status === "parked" || status === "idle";
}

/** The live subagents that are at work. */
export function workingSubagents(agents: readonly SubagentSnapshot[]): SubagentSnapshot[] {
	return agents.filter(agent => !isWaitingSubagent(agent.status));
}

/** What the board counts, once: its head, the Needs you section, the live region and the strip's label all read these. */
export interface BoardCounts {
	/** Questions and approvals waiting on the person, a plan up for review included. */
	asks: number;
	/** Sessions the agent opened that wait for an answer. */
	children: number;
	/** What needs the person (`sessionAttention`, as the title bar and the sidebar say it); null when nothing does. */
	attention: Attention | null;
	/** What the Needs you section lists: asks and waiting children. */
	needs: number;
	/** Subagents and background jobs (children at work are counted apart, as the board's "Now" lists them apart). */
	running: number;
	/** Sessions the agent opened that run. */
	childrenRunning: number;
	/** Whatever is at work, a parked subagent excluded: the pulse and "Working…" read it. */
	working: number;
	/**
	 * The pulse: a question, an approval or a waiting child (attention), else something works, else nothing.
	 */
	pulse: "waiting" | "working" | "idle";
}

export function boardCounts(input: {
	asks: readonly AskKind[];
	childrenWaiting: number;
	childrenRunning: number;
	agents: number;
	agentsWorking: number;
	jobs: number;
	/** The turn runs, or an Autopilot run does. */
	turnWorking: boolean;
}): BoardCounts {
	const attention = sessionAttention({ asks: input.asks, childrenWaiting: input.childrenWaiting });
	const needs = attention?.count ?? 0;
	const working = input.agentsWorking + input.jobs + input.childrenRunning + (input.turnWorking ? 1 : 0);
	return {
		asks: input.asks.length,
		children: input.childrenWaiting,
		attention,
		needs,
		running: input.agents + input.jobs,
		childrenRunning: input.childrenRunning,
		working,
		pulse: input.asks.length + input.childrenWaiting > 0 ? "waiting" : working > 0 ? "working" : "idle",
	};
}
