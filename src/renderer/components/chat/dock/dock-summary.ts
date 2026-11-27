import type { UiTodoPhase, UiTodoTask } from "../../../stores/todo";

export interface DockRunner {
	id: string;
	title: string;
	step?: string;
	startedAt?: number;
	session?: string;
}

export interface DockFacts {
	runners?: DockRunner[];
	links?: { session: string; number: number; title: string }[];
	attention?: string;
	failure?: string;
	step?: string;
	startedAt?: number;
	finished?: string;
	nextLabel?: (task: string) => string;
}

const PRIORITY = { attention: 0, failure: 1, active: 2, running: 3, next: 4, finished: 5 } as const;
type DockLine = { id: string; kind: keyof typeof PRIORITY; text: string };

export interface DockModel {
	phases: UiTodoPhase[];
	closed: UiTodoPhase[];
	done: number;
	total: number;
	abandoned: number;
	phaseCounts: Map<string, { done: number; total: number }>;
	active?: UiTodoTask;
	runners: (DockRunner & { taskId?: string })[];
	lines: DockLine[];
	step?: string;
	startedAt?: number;
}

export function buildDockModel(source: readonly UiTodoPhase[], facts: DockFacts = {}): DockModel {
	const phases: UiTodoPhase[] = [];
	const closed: UiTodoPhase[] = [];
	const phaseCounts = new Map<string, { done: number; total: number }>();
	let done = 0;
	let total = 0;
	let abandoned = 0;
	let active: UiTodoTask | undefined;
	for (const phase of source) {
		const openTasks: UiTodoTask[] = [];
		const closedTasks: UiTodoTask[] = [];
		const count = { done: 0, total: 0 };
		let pinned = false;
		for (const task of phase.tasks) {
			if (task.status !== "abandoned") count.total++;
			else abandoned++;
			if (task.status === "completed") count.done++;
			if (task.status === "completed" || task.status === "abandoned") closedTasks.push(task);
			else if (task.status === "in_progress" && !active) {
				active = task;
				pinned = true;
				openTasks.unshift(task);
			} else openTasks.push(task);
		}
		if (openTasks.length) {
			const visible = { ...phase, tasks: openTasks };
			if (pinned) phases.unshift(visible);
			else phases.push(visible);
		}
		if (closedTasks.length) closed.push({ ...phase, tasks: closedTasks });
		done += count.done;
		total += count.total;
		phaseCounts.set(phase.id, count);
	}

	const runners = (facts.runners ?? []).map((runner): DockRunner & { taskId?: string } => {
		if (!runner.session) return runner;
		const evidence = facts.links?.filter(link => link.session === runner.session).map(link => ({
			title: link.title,
			token: new RegExp(`(?:^|[^\\p{L}\\p{N}_#])#${link.number}(?![\\p{L}\\p{N}_])`, "u"),
		}));
		if (!evidence?.length) return runner;
		let match: UiTodoTask | undefined;
		for (const phase of source) {
			for (const task of phase.tasks) {
				if (!evidence.some(link => (link.title && task.content === link.title) || link.token.test(task.content))) continue;
				if (match) return runner;
				match = task;
			}
		}
		return match && match.status !== "completed" && match.status !== "abandoned" ? { ...runner, taskId: match.id } : runner;
	});

	const lines: DockLine[] = [];
	if (facts.attention) lines.push({ kind: "attention", id: "attention", text: facts.attention });
	if (facts.failure) lines.push({ kind: "failure", id: "failure", text: facts.failure });
	if (active) lines.push({ kind: "active", id: `active:${active.id}`, text: [active.content, facts.step].filter(Boolean).join(" · ") });
	for (const runner of runners) {
		lines.push({ kind: "running", id: `running:${runner.id}`, text: [runner.title, runner.step].filter(Boolean).join(" · ") });
	}
	const linked = new Set(runners.map(runner => runner.taskId));
	let next: UiTodoTask | undefined;
	for (const phase of phases) {
		next = phase.tasks.find(task => task !== active && !linked.has(task.id));
		if (next) break;
	}
	if (next) lines.push({ kind: "next", id: `next:${next.id}`, text: facts.nextLabel?.(next.content) ?? next.content });
	if (facts.finished) lines.push({ kind: "finished", id: "finished", text: facts.finished });
	lines.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
	return { phases, closed, done, total, abandoned, phaseCounts, active, runners, lines, step: facts.step, startedAt: facts.startedAt };
}

export function buildTodoDockPeek(phases: readonly UiTodoPhase[], model = buildDockModel(phases)) {
	return { done: model.done, total: model.total, current: model.phases[0]?.tasks[0] };
}

export function reorderOpenTasks(tasks: UiTodoTask[], fromId: string, toId: string): UiTodoTask[] {
	const movable = tasks.filter(task => task.status === "pending" || task.status === "blocked");
	const from = movable.findIndex(task => task.id === fromId);
	const to = movable.findIndex(task => task.id === toId);
	if (from < 0 || to < 0 || from === to) return tasks;
	movable.splice(to, 0, ...movable.splice(from, 1));
	let slot = 0;
	return tasks.map(task => task.status === "pending" || task.status === "blocked" ? movable[slot++]! : task);
}
