/**
 * A bot's automations (Orca's `BotUpcomingSection.tsx`, `bot-automation-card.ts:144-200`): this computer's schedules
 * that run in its folder or wake one of its chats, ranked failed first, then running, then the soonest next start;
 * one with no next start keeps its place, a paused one goes last. Its own Look around and memory upkeep are named
 * apart (they always show, outside the cap).
 */
import { useMemo, useSyncExternalStore } from "react";
import { isBotSchedule } from "../../../shared/bot-connectors";
import type { Bot } from "../../../shared/bots";
import type { Schedule, ScheduleRun, SchedulesState } from "../../../shared/schedules";

export interface BotAutomation {
	schedule: Schedule;
	/** Its newest run. */
	last: ScheduleRun | undefined;
	next: string | null;
	state: "failed" | "running" | "paused" | "scheduled";
	/** The bot's own routine. */
	own: "lookAround" | "tidy" | null;
}

const EMPTY: SchedulesState = { paused: false, schedules: [], runs: [], nextRuns: {} };

export function botAutomations(bot: Bot, state: SchedulesState): BotAutomation[] {
	const rows = state.schedules
		.filter(schedule => isBotSchedule(bot, schedule))
		.map((schedule): BotAutomation => {
			const last = state.runs.find(run => run.scheduleId === schedule.id);
			const next = state.nextRuns[schedule.id] ?? null;
			return {
				schedule,
				last,
				next,
				state:
					last?.status === "running"
						? "running"
						: last?.status === "failed"
							? "failed"
							: !schedule.enabled || state.paused
								? "paused"
								: "scheduled",
				own: schedule.id === bot.lookAround ? "lookAround" : schedule.id === bot.tidy ? "tidy" : null,
			};
		});
	const rank = { failed: 0, running: 1, scheduled: 2, paused: 3 } as const;
	return rows
		.map((row, index) => ({ row, index }))
		.toSorted(
			(a, b) =>
				rank[a.row.state] - rank[b.row.state] ||
				(a.row.next && b.row.next ? Date.parse(a.row.next) - Date.parse(b.row.next) : 0) ||
				a.index - b.index,
		)
		.map(({ row }) => row);
}

type Feed = { read: () => SchedulesState; subscribe: (changed: () => void) => () => void };
const feeds = new Map<string | undefined, Feed>();
const emptyFeed: Feed = { read: () => EMPTY, subscribe: () => () => {} };

/** One schedules read and subscription per computer, shared by Activity, the board and the inbox badge. */
function schedulesFeed(device?: string): Feed {
	const known = feeds.get(device);
	if (known) return known;
	let state = EMPTY;
	const listeners = new Set<() => void>();
	let stop: (() => void) | undefined;
	const feed: Feed = {
		read: () => state,
		subscribe: changed => {
			listeners.add(changed);
			if (listeners.size === 1 && typeof window.omp?.schedules?.command === "function") {
				let pushed = false;
				const receive = (next: SchedulesState) => {
					state = next;
					for (const listener of listeners) listener();
				};
				const push = (next: SchedulesState) => {
					pushed = true;
					receive(next);
				};
				const unsubscribe = device
					? window.omp.schedules.onHostState((from, next) => {
							if (from === device) push(next);
						})
					: window.omp.schedules.onState(push);
				stop = () => {
					pushed = true;
					unsubscribe();
				};
				void window.omp.schedules
					.command({ action: "get" }, device)
					.then(next => {
						if (!pushed) receive(next);
					})
					.catch(() => {});
			}
			return () => {
				listeners.delete(changed);
				if (listeners.size === 0) {
					stop?.();
					state = EMPTY;
				}
			};
		},
	};
	feeds.set(device, feed);
	return feed;
}

export function useSchedulesOf(device: string | undefined, enabled = true): SchedulesState {
	const feed = useMemo(() => (enabled ? schedulesFeed(device) : emptyFeed), [device, enabled]);
	return useSyncExternalStore(feed.subscribe, feed.read);
}

/**
 * Why the schedule `id` is off when the app turned it off after failed runs in a row (the core's `wake_failures`
 * records a skipped run saying so): the newest failure's error, "" when it gave none; null when it is on or the owner
 * turned it off.
 */
export function turnedOffAfterFailures(state: SchedulesState, id: string): string | null {
	const schedule = state.schedules.find(entry => entry.id === id);
	if (!schedule || schedule.enabled) return null;
	const runs = state.runs.filter(run => run.scheduleId === id);
	if (runs[0]?.status !== "skipped" || !runs[0].error?.startsWith("Turned off after")) return null;
	return runs.find(run => run.status === "failed")?.error ?? "";
}
