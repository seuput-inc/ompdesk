/**
 * The pull request of each session row's branch (Orca's hosted-review refresh,
 * `source-control/hosted-review-refresh-pacing.ts:1-44`, MIT), read on the computer that runs the session
 * (`window.omp.sessions.pullRequest`, `gh pr list --head` in the repository's root) and paced so a long sidebar never
 * spends the account's GitHub quota:
 * - a row of an open tab (the selection's tier, at most `MAX_ACTIVE_BRANCHES`, the current one first) is read again
 *   after a minute, every other row after 15 minutes, whether or not its branch had a PR;
 * - a failed read waits 1, 2, 4, 8, then 15 minutes before that branch is asked again;
 * - one read runs at a time, none while the window is hidden, and each is a background read the core's gate holds while
 *   GitHub's quota is low.
 * Rows sharing a repository root and branch (sessions in one worktree) share one read.
 */
import { create } from "zustand";
import type { GithubBranchPr } from "../../shared/github";
import { hidden, onWindowReturn } from "../lib/visible-poll";

export const ACTIVE_REFRESH_MS = 60_000;
export const IDLE_REFRESH_MS = 15 * 60_000;
export const MAX_ACTIVE_BRANCHES = 8;
const BACKOFF_BASE_MS = 60_000;
const TICK_MS = 30_000;

export interface BranchRow {
	device?: string;
	root: string;
	branch: string;
}

/** The key of a branch of a repository on a computer (`device` undefined: this one). */
export const branchPrKey = (row: BranchRow) => `${row.device ?? ""}\n${row.root}\n${row.branch}`;

/** A failed read's wait before the branch is asked again (Orca's `lookupBackoffDelayMs`). */
export function backoffMs(failures: number): number {
	return Math.min(IDLE_REFRESH_MS, BACKOFF_BASE_MS * 2 ** Math.min(Math.max(failures, 1) - 1, 4));
}

interface Read {
	at: number;
	failures: number;
}

interface BranchPrsState {
	/** By `branchPrKey`; null: the branch has no PR. Absent: not read yet. */
	prs: Readonly<Record<string, GithubBranchPr | null>>;
	/** When each PR was last read (epoch ms), so a reader holding an older copy of it knows which is newer. */
	readAt: Readonly<Record<string, number>>;
}

export const useBranchPrs = create<BranchPrsState>(() => ({ prs: {}, readAt: {} }));

const reads = new Map<string, Read>();
let rows = new Map<string, BranchRow>();
let active: string[] = [];
let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopReturn: (() => void) | undefined;

/** When the branch is next due, or 0 when it never was read. */
function dueAt(key: string): number {
	const read = reads.get(key);
	if (!read) return 0;
	if (read.failures > 0) return read.at + backoffMs(read.failures);
	return read.at + (active.includes(key) ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
}

function next(now: number): string | undefined {
	let best: string | undefined;
	let bestRank = Number.POSITIVE_INFINITY;
	for (const key of rows.keys()) {
		const due = dueAt(key);
		if (due > now) continue;
		// The active rows first, in their order; then the rest, oldest read first.
		const index = active.indexOf(key);
		const rank = index >= 0 ? index - MAX_ACTIVE_BRANCHES : due;
		if (rank < bestRank) {
			best = key;
			bestRank = rank;
		}
	}
	return best;
}

async function pump(): Promise<void> {
	if (running || hidden()) return;
	const key = next(Date.now());
	const row = key ? rows.get(key) : undefined;
	if (!key || !row) return;
	running = true;
	try {
		const pr = await window.omp.sessions.pullRequest(row.root, row.branch, row.device);
		const at = Date.now();
		reads.set(key, { at, failures: 0 });
		useBranchPrs.setState(state => ({
			prs: state.prs[key] === pr ? state.prs : { ...state.prs, [key]: pr },
			readAt: { ...state.readAt, [key]: at },
		}));
	} catch {
		reads.set(key, { at: Date.now(), failures: (reads.get(key)?.failures ?? 0) + 1 });
	} finally {
		running = false;
	}
	void pump();
}

function schedule(): void {
	clearTimeout(timer);
	timer = rows.size
		? setTimeout(() => {
				timer = undefined;
				void pump();
				schedule();
			}, TICK_MS)
		: undefined;
	if (rows.size && !stopReturn) stopReturn = onWindowReturn(() => void pump());
	if (!rows.size && stopReturn) {
		stopReturn();
		stopReturn = undefined;
	}
}

/** What each view (this computer's rows, a paired computer's section) shows and holds in the minute tier. */
const views = new Map<string, { shown: readonly BranchRow[]; selected: readonly BranchRow[] }>();

/**
 * The rows `view` shows now and the ones in the selection's tier (open tabs, the current one first): replaces what that
 * view watched and reads what is due. Cheap when nothing changed, so a view may call it after every render; an empty
 * `shown` lets the view go.
 */
export function watchBranchPrs(view: string, shown: readonly BranchRow[], selected: readonly BranchRow[]): void {
	if (shown.length) views.set(view, { shown, selected });
	else views.delete(view);
	const all = [...views.values()];
	const nextRows = new Map(all.flatMap(entry => entry.shown.map(row => [branchPrKey(row), row] as const)));
	const nextActive = [...new Set(all.flatMap(entry => entry.selected.map(branchPrKey)))]
		.filter(key => nextRows.has(key))
		.slice(0, MAX_ACTIVE_BRANCHES);
	const same =
		nextRows.size === rows.size &&
		[...nextRows.keys()].every(key => rows.has(key)) &&
		nextActive.length === active.length &&
		nextActive.every((key, index) => active[index] === key);
	if (same) return;
	rows = nextRows;
	active = nextActive;
	schedule();
	void pump();
}

/** The PR of a row's branch, when one was read. */
export function branchPrOf(prs: BranchPrsState["prs"], row: BranchRow | null): GithubBranchPr | null {
	return row ? (prs[branchPrKey(row)] ?? null) : null;
}

/** How a PR stands for its row's glyph: a draft, failing checks, checks still running; undefined: open and green. */
export function branchPrTone(pr: GithubBranchPr): "draft" | "failure" | "pending" | undefined {
	if (pr.isDraft) return "draft";
	if (pr.checks.failure > 0) return "failure";
	return pr.checks.pending > 0 ? "pending" : undefined;
}

export function resetBranchPrs(): void {
	reads.clear();
	views.clear();
	rows = new Map();
	active = [];
	running = false;
	clearTimeout(timer);
	timer = undefined;
	stopReturn?.();
	stopReturn = undefined;
	useBranchPrs.setState({ prs: {}, readAt: {} });
}
