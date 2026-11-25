/**
 * A todo list that only grows (rules; wiring: todo-compact.ts). Stock's `todo` tool appends, ticks and drops but
 * never folds: a long session that takes round after round ("independent review 20", "perf baseline", next fix…)
 * appended each round to the same list until the work board read 33/38 with one progress segment per task (the
 * owner's report, 3 Nov 2026). Stock's reminders only push the agent to finish open items, and OMPdesk's stale-list
 * rule (todo-stale-core.ts) fires only when a new request meets an old list, never inside one long run.
 *
 * A long list with many finished items gets a reminder to append new requests by phase. The panel can collapse
 * phases without changing stock's list. An `init` would reset every task, including any active or blocked one.
 *
 * Measured (3 Nov 2026). The owner's 33/38 session (rng-arena, 438 todo calls): while it re-`init`ed per round its
 * list stayed at 2-17 items; after its last `init` (6 items) the next 70 calls held 24 appends and no `init`, `rm` or
 * fold over 28 h, each spawned subagent's work one more row in the same catch-all phase, until 33 done, 2 blocked rows
 * stale to the end and 3 open. `drop` only marks a row abandoned, so nothing shrank the list. The longest lists in this
 * PC's sessions and in the owner's replayed corpus (e2e/fixtures/work-verdict-corpus.json, 16 sessions) held 18 and
 * 16 items, all from one `init` of a playbook's steps plus the task's own items.
 *
 * No omp imports: the GUI's vitest runs it (src/main/bridge-todo-compact.test.ts).
 */

/** The longest initial list in the observed sessions had 18 items. */
export const COMPACT_MIN_TASKS = 20;
/** Minimum number of finished items before a long-list reminder is useful. */
export const COMPACT_MIN_CLOSED = 10;

export interface TodoCompactPhase {
	name: string;
	tasks: ReadonlyArray<{ content: string; status: string }>;
}

export interface LongTodo {
	total: number;
	closed: number;
	open: number;
}

export function isClosedTodo(status: string): boolean {
	return status === "completed" || status === "abandoned";
}

/** The long list this `todo` result leaves, or undefined to say nothing. `op` is stock's resolved op (`details.op`). */
export function todoCompaction(op: unknown, phases: readonly TodoCompactPhase[]): LongTodo | undefined {
	if (op !== "append") return undefined;
	const tasks = phases.flatMap(phase => phase.tasks);
	const closed = tasks.filter(task => isClosedTodo(task.status)).length;
	if (tasks.length <= COMPACT_MIN_TASKS || closed < COMPACT_MIN_CLOSED) return undefined;
	return { total: tasks.length, closed, open: tasks.length - closed };
}

/** How the long-list reminder opens; todo-drift-core recognizes it in the journal. */
export const COMPACT_LEAD = "Your todo list now holds";

/** The line the agent reads after that call, wrapped like stock's own todo reminders. */
export function compactTodoText(long: LongTodo): string {
	return `<system-reminder>
${COMPACT_LEAD} ${long.total} items, ${long.closed} of them finished. Keep the ${long.open} unfinished items in their phases with their current statuses and blockers. Leave finished history in place; phases can be collapsed in the panel. Append each new request in its own phase.
</system-reminder>`;
}
