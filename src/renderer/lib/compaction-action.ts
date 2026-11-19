/**
 * Locale key naming an automatic maintenance action the way stock's loader and
 * status lines do (pi-coding-agent `modes/controllers/event-controller.ts`):
 * `Auto-handoff`, `Auto-shake`, `Auto-snapcompact`, `Auto server compaction`,
 * otherwise `Auto context-full maintenance`.
 */
export function compactionActionKey(action: string): string {
	switch (action) {
		case "handoff":
			return "chat.compaction.action.handoff";
		case "shake":
			return "chat.compaction.action.shake";
		case "snapcompact":
			return "chat.compaction.action.snapcompact";
		case "remote":
			return "chat.compaction.action.remote";
		default:
			return "chat.compaction.action.default";
	}
}

/** Locale key saying in plain words what a running pass does to the conversation; every other action summarizes it. */
export function compactionRunningKey(action: string): string {
	switch (action) {
		case "handoff":
			return "chat.compaction.running.handoff";
		case "shake":
			return "chat.compaction.running.shake";
		case "snapcompact":
			return "chat.compaction.running.snapcompact";
		default:
			return "chat.compaction.running.summarize";
	}
}

/** Locale key saying in plain words what a finished pass (a compaction entry's `method`) did; legacy entries name none. */
export function compactionDoneKey(method: string | undefined): string {
	switch (method) {
		case "handoff":
			return "chat.context.done.handoff";
		case "shake":
			return "chat.context.done.shake";
		case "snapcompact":
			return "chat.context.done.snapcompact";
		default:
			return "chat.context.compacted";
	}
}

/** A pass this window watched from its start to its end, on this window's clock. */
export interface CompactionRun {
	action: string;
	startedAt: number;
	endedAt: number;
}

/** `runs` plus the pass `info` opened, ended now. */
export function withCompactionRun(
	runs: readonly CompactionRun[],
	info: { action: string; startedAt: number } | null,
): CompactionRun[] {
	return info ? [...runs, { action: info.action, startedAt: info.startedAt, endedAt: Date.now() }] : [...runs];
}

/** A paired computer's or a phone's clock may sit this far from the host's that stamped the entry. */
const CLOCK_SLACK_MS = 2000;

/**
 * How long the pass that wrote the entry stamped `timestamp` took, when this window watched it: stock appends the
 * entry inside the watched window and records no duration of its own.
 * shortcut: measured per window and kept in memory, so a reload or a view that joined later shows none; upgrade when
 * stock's compaction entry carries a duration.
 */
export function compactionTook(
	runs: readonly CompactionRun[],
	timestamp: string | number | undefined,
): number | undefined {
	const at = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
	if (at === undefined || Number.isNaN(at)) return undefined;
	const run = runs.findLast(run => at >= run.startedAt - CLOCK_SLACK_MS && at <= run.endedAt + CLOCK_SLACK_MS);
	return run ? run.endedAt - run.startedAt : undefined;
}
