/**
 * How truthful sessions' todo lists were, read from omp session files (docs/open-work.md T1). Prints numbers only,
 * never a message's text, so it may read every project's sessions.
 *
 *   bun scripts/todo-truth-stats.ts [sessions dir (default ~/.omp/agent/sessions)] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 *
 * Only sessions that held a todo list count. Each session's newest branch (leaf back to root) is read in order and
 * every step lands in a bucket: `before` until the bridge's marker (`TODO_DRIFT_MARKER`, journaled by todo-drift.ts
 * the first time it reads a session), `after` from it on, so a session still on an older bridge after a release
 * counts as before. Within a bucket, steps go by model (the newest assistant message's provider/model).
 *
 * - Active time: the gaps between consecutive tool results, each capped at `IDLE_CAP_MS` (waiting for a person is
 *   not work).
 * - Stale spans: a list with open items unchanged for 15+ active minutes, counted once, per 100 active hours.
 * - Instructions: a person's or an opening agent's new request (todo-stale-core `isNewRequest`, at a turn's start or
 *   steered in) while a list is open; got a row = a todo change that adds an item before the next instruction.
 * - Reminders (todo-drift-core `nudgeKindOf`, ours and stock's): followed by a list change within `NUDGE_WINDOW` tool
 *   results.
 *
 * Every figure is numerator / denominator. A bucket under `MIN_AFTER_HOURS` active hours reads "not yet known".
 * Recount the same three numbers for a period as long as the one before a release, e.g. a day after it:
 *   bun scripts/todo-truth-stats.ts --since <release day> --until <release day + N>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TODO_DRIFT_MARKER } from "../resources/gui-bridge/todo-drift-contracts";
import { IDLE_CAP_MS, nudgeKindOf, type TodoDriftEntry } from "../resources/gui-bridge/todo-drift-core";
import { isNewRequest } from "../resources/gui-bridge/todo-stale-core";

const NUDGE_WINDOW = 3;
const STALE_SPAN_MS = 15 * 60_000;
const MIN_AFTER_HOURS = 20;

interface Entry extends TodoDriftEntry {
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: TodoDriftEntry["message"] & {
		provider?: string;
		model?: string;
		details?: { op?: string; phases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }> };
	};
}

type Bucket = "before" | "after";

interface Tally {
	activeMs: number;
	staleSpans: number;
	instructions: number;
	instructionsWithRow: number;
	reminders: Map<string, { count: number; changed: number }>;
}

function tally(): Tally {
	return { activeMs: 0, staleSpans: 0, instructions: 0, instructionsWithRow: 0, reminders: new Map() };
}

/** Bucket → model → tally; model "all" holds every model's sum. */
const tallies = new Map<Bucket, Map<string, Tally>>();

function counted(bucket: Bucket, model: string, add: (tally: Tally) => void): void {
	const byModel = tallies.get(bucket) ?? new Map<string, Tally>();
	tallies.set(bucket, byModel);
	for (const key of ["all", model]) {
		const row = byModel.get(key) ?? tally();
		byModel.set(key, row);
		add(row);
	}
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

function readSession(file: string): void {
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
	if (!branch.some(entry => entry.message?.role === "toolResult" && entry.message.toolName === "todo")) return;
	let bucket: Bucket = "before";
	let model = "unknown";
	let fingerprint = "";
	let contents = new Set<string>();
	let open = false;
	let lastResultAt: number | undefined;
	let span = { activeMs: 0, counted: false };
	let pending: { bucket: Bucket; model: string } | undefined;
	const reminders: Array<{ bucket: Bucket; model: string; kind: string; left: number }> = [];
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === TODO_DRIFT_MARKER) bucket = "after";
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role === "assistant" && message.model) model = `${message.provider ?? "?"}/${message.model}`;
		const kind = nudgeKindOf(entry);
		if (kind) reminders.push({ bucket, model, kind, left: NUDGE_WINDOW });
		if (
			message?.role === "user" &&
			message.synthetic !== true &&
			message.attribution !== "agent" &&
			open &&
			isNewRequest(textOf(message.content))
		) {
			const previous = pending;
			if (previous) counted(previous.bucket, previous.model, row => row.instructions++);
			pending = { bucket, model };
		}
		if (message?.role !== "toolResult") continue;
		const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		if (Number.isFinite(at)) {
			const gap = lastResultAt === undefined ? 0 : Math.min(IDLE_CAP_MS, Math.max(0, at - lastResultAt));
			lastResultAt = at;
			counted(bucket, model, row => {
				row.activeMs += gap;
			});
			if (open) span.activeMs += gap;
			if (open && !span.counted && span.activeMs >= STALE_SPAN_MS) {
				span.counted = true;
				counted(bucket, model, row => row.staleSpans++);
			}
		}
		const phases = message.details?.phases;
		const change =
			message.toolName === "todo" && !message.isError && Array.isArray(phases) && message.details?.op !== "view";
		if (!change) {
			if (message.toolName !== "todo") for (const reminder of reminders) if (reminder.left > 0) reminder.left--;
			continue;
		}
		const tasks = phases.flatMap(phase => phase.tasks);
		const next = JSON.stringify(tasks.map(task => [task.content, task.status]));
		if (next === fingerprint) continue;
		if (pending && tasks.some(task => !contents.has(task.content))) {
			const { bucket: from, model: by } = pending;
			counted(from, by, row => {
				row.instructions++;
				row.instructionsWithRow++;
			});
			pending = undefined;
		}
		for (const reminder of reminders) {
			if (reminder.left > 0)
				counted(reminder.bucket, reminder.model, row => {
					const kinds = row.reminders.get(reminder.kind) ?? { count: 0, changed: 0 };
					kinds.changed++;
					row.reminders.set(reminder.kind, kinds);
				});
			reminder.left = 0;
		}
		fingerprint = next;
		contents = new Set(tasks.map(task => task.content));
		open = tasks.some(task => OPEN[task.status]);
		span = { activeMs: 0, counted: false };
	}
	if (pending) counted(pending.bucket, pending.model, row => row.instructions++);
	for (const reminder of reminders)
		counted(reminder.bucket, reminder.model, row => {
			const kinds = row.reminders.get(reminder.kind) ?? { count: 0, changed: 0 };
			kinds.count++;
			row.reminders.set(reminder.kind, kinds);
		});
}

function files(dir: string, since: number, until: number): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap(item => {
		const path = join(dir, item.name);
		if (item.isDirectory()) return files(path, since, until);
		if (!item.name.endsWith(".jsonl")) return [];
		const changed = statSync(path).mtimeMs;
		return changed >= since && changed < until ? [path] : [];
	});
}

const hours = (ms: number) => ms / 3_600_000;

function line(label: string, row: Tally): string {
	const active = hours(row.activeMs);
	const per100 = active > 0 ? ((100 * row.staleSpans) / active).toFixed(1) : "-";
	const reminders = [...row.reminders]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([kind, { count, changed }]) => `${kind} ${changed}/${count}`)
		.join(", ");
	return [
		`${label}: active ${active.toFixed(1)} h`,
		`stale 15+ min spans ${row.staleSpans} / ${active.toFixed(1)} h (${per100} per 100 h)`,
		`instructions that got a row ${row.instructionsWithRow} / ${row.instructions}`,
		`reminders followed by a list change within ${NUDGE_WINDOW} calls: ${reminders || "none"}`,
	].join("; ");
}

function main(): void {
	const args = process.argv.slice(2);
	const flag = (name: string) => {
		const at = args.indexOf(name);
		return at >= 0 ? Date.parse(args[at + 1] ?? "") : Number.NaN;
	};
	const since = flag("--since");
	const until = flag("--until");
	const dir =
		args.find((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--")) ??
		join(homedir(), ".omp/agent/sessions");
	for (const file of files(dir, Number.isFinite(since) ? since : 0, Number.isFinite(until) ? until : Infinity))
		readSession(file);
	for (const bucket of ["before", "after"] as const) {
		const byModel = tallies.get(bucket);
		const all = byModel?.get("all");
		if (!all || hours(all.activeMs) < (bucket === "after" ? MIN_AFTER_HOURS : 0)) {
			console.log(
				`${bucket}: not yet known (${hours(all?.activeMs ?? 0).toFixed(1)} active h${bucket === "after" ? `, under ${MIN_AFTER_HOURS}` : ""})`,
			);
			continue;
		}
		console.log(line(`${bucket} all models`, all));
		for (const [model, row] of [...(byModel ?? [])].sort(([a], [b]) => a.localeCompare(b)))
			if (model !== "all") console.log(line(`  ${bucket} ${model}`, row));
	}
}

main();
