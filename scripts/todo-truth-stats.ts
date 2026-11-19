/**
 * How truthful sessions' todo lists were, read from omp session files (docs/open-work.md T1). Prints numbers only,
 * never a message's text, so it may read every project's sessions.
 *
 *   bun scripts/todo-truth-stats.ts [sessions dir (default ~/.omp/agent/sessions)] [--since YYYY-MM-DD]
 *
 * Per session it walks the newest branch (leaf back to root) and reports:
 * - drift: spans in which the list held open items and did not change, in tool calls and in active minutes (the gaps
 *   between consecutive tool results, each capped at `IDLE_CAP_MS`, so time waiting for a person does not count);
 * - instructions: a person's or an opening agent's new request (todo-stale-core `isNewRequest`), at a turn start or
 *   delivered inside a running turn (a steer), and whether a row was added before the next one;
 * - nudges: each reminder kind and whether the list changed within `NUDGE_WINDOW` tool results after it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isNewRequest } from "../resources/gui-bridge/todo-stale-core";
import { nudgeKindOf } from "../resources/gui-bridge/todo-drift-core";

const IDLE_CAP_MS = 5 * 60_000;
const NUDGE_WINDOW = 3;

interface Entry {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	customType?: string;
	content?: unknown;
	message?: {
		role?: string;
		toolName?: string;
		isError?: boolean;
		synthetic?: boolean;
		attribution?: string;
		stopReason?: string;
		content?: unknown;
		details?: { op?: string; phases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }> };
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (typeof part?.text === "string" ? part.text : "")).join("");
}

function branchOf(entries: Entry[]): Entry[] {
	const byId = new Map<string, Entry>();
	for (const entry of entries) if (entry.id) byId.set(entry.id, entry);
	const leaf = entries.findLast(entry => entry.id);
	const path: Entry[] = [];
	for (let at = leaf; at; at = at.parentId ? byId.get(at.parentId) : undefined) path.push(at);
	return path.reverse();
}

const OPEN: Record<string, true> = { pending: true, in_progress: true, blocked: true };

interface Span {
	calls: number;
	activeMs: number;
	/** Ended by a list change (the agent kept the list), not by the session's end or a closed list. */
	closedByChange: boolean;
}

interface Instruction {
	steer: boolean;
	listOpen: boolean;
	rowAdded: boolean;
}

interface Nudge {
	kind: string;
	corrected: boolean;
}

function readSession(file: string): { spans: Span[]; instructions: Instruction[]; nudges: Nudge[] } | undefined {
	const entries = readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap(line => {
			try {
				return [JSON.parse(line) as Entry];
			} catch {
				return [];
			}
		});
	const branch = branchOf(entries);
	const spans: Span[] = [];
	const instructions: Instruction[] = [];
	const nudges: Array<Nudge & { callsLeft: number }> = [];
	let contents = new Set<string>();
	let fingerprint = "";
	let open = false;
	let span: { calls: number; activeMs: number; lastAt: number } | undefined;
	let pending: Instruction | undefined;
	let previousRole: string | undefined;
	let previousStop: string | undefined;
	let anyTodo = false;
	const closeSpan = (closedByChange: boolean) => {
		if (span && span.calls > 0) spans.push({ calls: span.calls, activeMs: span.activeMs, closedByChange });
		span = undefined;
	};
	for (const entry of branch) {
		const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
		const kind = nudgeKindOf(entry);
		if (kind) nudges.push({ kind, corrected: false, callsLeft: NUDGE_WINDOW });
		const message = entry.type === "message" ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "user" && message.synthetic !== true && message.attribution !== "agent") {
			const text = textOf(message.content);
			if (isNewRequest(text)) {
				if (pending) instructions.push(pending);
				const steer = previousRole === "toolResult" || (previousRole === "assistant" && previousStop === "toolUse");
				pending = { steer, listOpen: open, rowAdded: false };
			}
		}
		if (message.role === "toolResult") {
			const phases = message.details?.phases;
			const change =
				message.toolName === "todo" && !message.isError && Array.isArray(phases) && message.details?.op !== "view";
			if (change) {
				anyTodo = true;
				const tasks = phases.flatMap(phase => phase.tasks);
				const next = JSON.stringify(tasks.map(task => [task.content, task.status]));
				if (next !== fingerprint) {
					const added = tasks.some(task => !contents.has(task.content));
					if (added && pending) pending.rowAdded = true;
					for (const nudge of nudges) if (nudge.callsLeft > 0) nudge.corrected = true;
					for (const nudge of nudges) nudge.callsLeft = 0;
					fingerprint = next;
					contents = new Set(tasks.map(task => task.content));
					closeSpan(true);
					open = tasks.some(task => OPEN[task.status]);
					if (open && Number.isFinite(at)) span = { calls: 0, activeMs: 0, lastAt: at };
				}
			} else if (message.toolName !== "todo") {
				for (const nudge of nudges) if (nudge.callsLeft > 0) nudge.callsLeft--;
				if (span && Number.isFinite(at)) {
					span.calls++;
					span.activeMs += Math.min(IDLE_CAP_MS, Math.max(0, at - span.lastAt));
					span.lastAt = at;
				}
			}
		}
		previousRole = message.role;
		previousStop = message.stopReason;
	}
	closeSpan(false);
	if (pending) instructions.push(pending);
	if (!anyTodo) return undefined;
	return { spans, instructions, nudges: nudges.map(({ kind, corrected }) => ({ kind, corrected })) };
}

function files(dir: string, since: number): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap(item => {
		const path = join(dir, item.name);
		if (item.isDirectory()) return files(path, since);
		return item.name.endsWith(".jsonl") && statSync(path).mtimeMs >= since ? [path] : [];
	});
}

function quantile(values: number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const share = (part: number, whole: number) => (whole === 0 ? null : Math.round((1000 * part) / whole) / 10);

function main(): void {
	const args = process.argv.slice(2);
	const sinceAt = args.indexOf("--since");
	const since = sinceAt >= 0 ? Date.parse(args[sinceAt + 1] ?? "") : 0;
	const dir =
		args.find((arg, index) => !arg.startsWith("--") && index !== sinceAt + 1) ??
		join(homedir(), ".omp/agent/sessions");
	const sessions = files(dir, Number.isFinite(since) ? since : 0).flatMap(file => {
		const session = readSession(file);
		return session ? [session] : [];
	});
	const spans = sessions.flatMap(session => session.spans);
	const instructions = sessions.flatMap(session => session.instructions);
	const nudges = sessions.flatMap(session => session.nudges);
	const kept = spans.filter(span => span.closedByChange);
	const minutes = (ms: number) => Math.round(ms / 6000) / 10;
	const long = spans.filter(span => span.activeMs >= 15 * 60_000);
	const byKind = new Map<string, { count: number; corrected: number }>();
	for (const nudge of nudges) {
		const row = byKind.get(nudge.kind) ?? { count: 0, corrected: 0 };
		row.count++;
		if (nudge.corrected) row.corrected++;
		byKind.set(nudge.kind, row);
	}
	const instructionShare = (filter: (instruction: Instruction) => boolean) => {
		const picked = instructions.filter(filter);
		return { count: picked.length, rowAddedPct: share(picked.filter(i => i.rowAdded).length, picked.length) };
	};
	console.log(
		JSON.stringify(
			{
				sessionsWithTodo: sessions.length,
				drift: {
					spans: spans.length,
					callsBetweenChanges: {
						p50: quantile(
							kept.map(s => s.calls),
							0.5,
						),
						p90: quantile(
							kept.map(s => s.calls),
							0.9,
						),
					},
					activeMinutesBetweenChanges: {
						p50: minutes(
							quantile(
								kept.map(s => s.activeMs),
								0.5,
							),
						),
						p90: minutes(
							quantile(
								kept.map(s => s.activeMs),
								0.9,
							),
						),
					},
					longestPerSession: {
						p50Minutes: minutes(
							quantile(
								sessions.map(s => Math.max(0, ...s.spans.map(x => x.activeMs))),
								0.5,
							),
						),
						maxMinutes: minutes(Math.max(0, ...spans.map(s => s.activeMs))),
						maxCalls: Math.max(0, ...spans.map(s => s.calls)),
					},
					spansOver15ActiveMinutes: long.length,
					activeMinutesInThoseSpans: minutes(long.reduce((sum, span) => sum + span.activeMs, 0)),
					spansOver15EndedWithoutChange: long.filter(span => !span.closedByChange).length,
				},
				instructions: {
					all: instructionShare(() => true),
					whileListOpen: instructionShare(i => i.listOpen),
					steers: instructionShare(i => i.steer),
					steersWhileListOpen: instructionShare(i => i.steer && i.listOpen),
				},
				nudges: Object.fromEntries(
					[...byKind].map(([kind, row]) => [
						kind,
						{ count: row.count, correctedPct: share(row.corrected, row.count) },
					]),
				),
			},
			null,
			2,
		),
	);
}

main();
