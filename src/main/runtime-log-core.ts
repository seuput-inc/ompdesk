import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeErrorReport, RuntimeErrorSource } from "../shared/ipc-types";

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 8_192;
const MAX_STACK_LENGTH = 32_768;
const MAX_URL_LENGTH = 4_096;
const MAX_DETAIL_KEYS = 24;
const MAX_DETAIL_VALUE_LENGTH = 4_096;

/** Every source, keyed by the union: a source added to `RuntimeErrorSource` without a row here fails tsc. */
const RUNTIME_ERROR_SOURCE_TABLE: Record<RuntimeErrorSource, true> = {
	"react-render": true,
	"react-uncaught": true,
	"react-recoverable": true,
	"window-error": true,
	"unhandled-rejection": true,
	"renderer-console": true,
	"renderer-load": true,
	preload: true,
	"renderer-process": true,
	"renderer-unresponsive": true,
	"application-resources": true,
	"child-process": true,
	"main-uncaught": true,
	"main-unhandled-rejection": true,
	"error-toast": true,
	"background-task": true,
	"core-shutdown": true,
	"startup-timing": true,
	"turn-resume": true,
	hub: true,
	"core-loss": true,
	"tab-layout": true,
	autopilot: true,
	"app-update": true,
	"omp-update": true,
	"ai-memory": true,
	"disk-care": true,
	"main-thread-hang": true,
	"web-reload": true,
	"remote-tab": true,
	"session-delete": true,
	"turn-stop": true,
	"remote-link": true,
	"gpu-fallback": true,
	"launch-guard": true,
	"app-quit": true,
	"user-data-migration": true,
	setup: true,
	"keep-awake": true,
	remote: true,
	"memory-sync": true,
	"settle-watch": true,
	"sidecar-restart": true,
	"omp-slow-start": true,
	"omp-start-input": true,
	"process-priority": true,
	"omp-reap": true,
	"session-processes": true,
	"session-owner": true,
	"bridge-health": true,
	"goal-time-limit": true,
	"turn-stages": true,
	"chain-stall": true,
	"console-window": true,
	"slow-step": true,
	"turn-wait": true,
	"machine-state": true,
	routines: true,
	memory: true,
	sidebar: true,
	"agent-control": true,
	"transcript-seed": true,
	unknown: true,
};

/** What main writes: the source is checked by the compiler; `details` values are bounded when written. */
export type RuntimeLogReport = Omit<RuntimeErrorReport, "details"> & { details?: object };

export interface RuntimeLogContext {
	appVersion: string;
	platform: string;
	pid: number;
	windowId?: number;
	cwd?: string;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Untrusted input only (a renderer's IPC payload): a name outside the union becomes "unknown". */
function source(value: unknown): RuntimeErrorSource {
	return typeof value === "string" && Object.hasOwn(RUNTIME_ERROR_SOURCE_TABLE, value)
		? (value as RuntimeErrorSource)
		: "unknown";
}

/** Untrusted input only: flat details (a string, number, boolean or null per key); anything nested is dropped. */
function details(value: unknown): Record<string, string | number | boolean | null> | undefined {
	const input = record(value);
	if (!input) return undefined;
	const output: Record<string, string | number | boolean | null> = {};
	for (const [key, detail] of Object.entries(input).slice(0, MAX_DETAIL_KEYS)) {
		if (detail === null || typeof detail === "number" || typeof detail === "boolean") {
			output[key] = detail;
		} else {
			const text = boundedString(detail, MAX_DETAIL_VALUE_LENGTH);
			if (text !== undefined) output[key] = text;
		}
	}
	return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * The one structured detail a main source may log, by source: an array kept as an array. Its source bounds the list
 * (`bridge-health.ts` drops whole entries and counts them); a list that still serializes past MAX_DETAIL_VALUE_LENGTH
 * is left out, never cut into a string. Every other detail stays flat, as `details` keeps it.
 */
const STRUCTURED_DETAIL: Partial<Record<RuntimeErrorSource, string>> = { "bridge-health": "unavailable" };

function mainDetails(source: RuntimeErrorSource, value: unknown): Record<string, unknown> | undefined {
	const flat = details(value);
	const key = STRUCTURED_DETAIL[source];
	const list = key === undefined ? undefined : record(value)?.[key];
	if (key === undefined || !Array.isArray(list)) return flat;
	let json: string;
	try {
		json = JSON.stringify(list);
	} catch {
		return flat;
	}
	if (json.length > MAX_DETAIL_VALUE_LENGTH) return flat;
	return { ...flat, [key]: JSON.parse(json) as unknown };
}

/** Validate and bound an IPC payload before it reaches disk. */
export function normalizeRuntimeErrorReport(value: unknown): RuntimeErrorReport {
	const input = record(value);
	const message = boundedString(input?.message, MAX_MESSAGE_LENGTH) ?? "Unknown runtime error";
	return {
		source: source(input?.source),
		message,
		stack: boundedString(input?.stack, MAX_STACK_LENGTH),
		componentStack: boundedString(input?.componentStack, MAX_STACK_LENGTH),
		url: boundedString(input?.url, MAX_URL_LENGTH),
		line: finiteNumber(input?.line),
		column: finiteNumber(input?.column),
		details: details(input?.details),
	};
}

/** A line repeated within this long of its last copy is counted, not written again. */
const REPEAT_WINDOW_MS = 10_000;
/** A repeat that never pauses still has its count written this often. */
const REPEAT_REPORT_MS = 60_000;
/** Distinct recent lines followed per file; past it the oldest has its count written and is forgotten. */
const MAX_FOLDS = 64;

/** One line written lately and the identical copies that came after it. */
interface Fold {
	readonly context: RuntimeLogContext;
	readonly source: RuntimeErrorSource;
	readonly message: string;
	/** When the line, or its last count line, was written. */
	since: number;
	/** When the latest copy came. */
	last: number;
	/** Copies since `since` that were not written. */
	count: number;
}

interface FileFolds {
	/** Keyed by the whole line but its timestamp; in the order they were written. */
	readonly lines: Map<string, Fold>;
	timer: NodeJS.Timeout | null;
}

const foldsByFile = new Map<string, FileFolds>();
let flushOnExit = false;

/** Rotates a full log and appends one line; the caller made the folder. */
function appendLine(filePath: string, entry: object): void {
	try {
		if (fs.statSync(filePath).size >= MAX_LOG_BYTES) {
			const archivePath = `${filePath}.1`;
			fs.rmSync(archivePath, { force: true });
			fs.renameSync(filePath, archivePath);
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

/** The line that stands for the copies of `fold` not written since `since`; none when there are none. */
function writeCount(filePath: string, fold: Fold, now: number): void {
	const { count, since, last } = fold;
	fold.count = 0;
	fold.since = now;
	if (count === 0) return;
	try {
		appendLine(filePath, {
			timestamp: new Date(last).toISOString(),
			...fold.context,
			source: fold.source,
			message: `repeated ${count} times in ${last - since} ms`,
			details: {
				repeatOf: fold.message.slice(0, 200),
				count,
				spanMs: last - since,
				first: new Date(since).toISOString(),
			},
		});
	} catch {
		// As every other line here: a failed write is lost, never a second failure.
	}
}

/** Writes the count of every line whose copies stopped, and forgets it; returns the time the next one may stop. */
function settleFolds(filePath: string, file: FileFolds, now: number): number | null {
	let next: number | null = null;
	for (const [key, fold] of file.lines) {
		const ends = fold.last + REPEAT_WINDOW_MS;
		if (ends <= now) {
			writeCount(filePath, fold, now);
			file.lines.delete(key);
		} else if (next === null || ends < next) next = ends;
	}
	return next;
}

function armFolds(filePath: string, file: FileFolds, at: number | null): void {
	if (file.timer !== null || at === null) return;
	file.timer = setTimeout(
		() => {
			file.timer = null;
			armFolds(filePath, file, settleFolds(filePath, file, Date.now()));
			if (file.lines.size === 0) foldsByFile.delete(filePath);
		},
		Math.max(0, at - Date.now()),
	);
	file.timer.unref();
}

/** The counts not written yet go out as the process ends (an exit, or the crash a `main-uncaught` line precedes). */
function flushAllFolds(): void {
	for (const [filePath, file] of foldsByFile)
		for (const fold of file.lines.values()) writeCount(filePath, fold, fold.last);
}

/**
 * Crash logging intentionally uses synchronous file I/O: renderer/process-gone
 * events may be the last useful callback before shutdown, so queued async writes
 * are not reliable enough here. Each write is a single bounded JSON line.
 *
 * A line identical to one written within {@link REPEAT_WINDOW_MS} of its last copy (same source, message, stack,
 * details and context) is not written again: its copies become one line `repeated N times in T ms` under the same
 * source, written when the copies stop, before the next new line, every {@link REPEAT_REPORT_MS} while they go on,
 * and at exit. The 0.134.0 quit wrote 6,175 copies of one rejection in 0.23 s, and the two 4 MB files then held
 * nothing of what came before it.
 */
export function appendRuntimeLogAtPath(filePath: string, report: RuntimeLogReport, context: RuntimeLogContext): void {
	try {
		// The renderer's reports reach here already through `normalizeRuntimeErrorReport` (ipc.ts); main's own keep
		// their source's one structured detail.
		const normalized = normalizeRuntimeErrorReport(report);
		const line = { ...context, ...normalized, details: mainDetails(normalized.source, report.details) };
		const key = JSON.stringify(line);
		const now = Date.now();
		let file = foldsByFile.get(filePath);
		if (!file) {
			file = { lines: new Map(), timer: null };
			foldsByFile.set(filePath, file);
		}
		settleFolds(filePath, file, now);
		const fold = file.lines.get(key);
		if (fold) {
			fold.count++;
			fold.last = now;
			if (now - fold.since >= REPEAT_REPORT_MS) writeCount(filePath, fold, now);
			return;
		}
		// What repeated before this line is told before it.
		for (const earlier of file.lines.values()) writeCount(filePath, earlier, now);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		appendLine(filePath, { timestamp: new Date(now).toISOString(), ...line });
		file.lines.set(key, {
			context,
			source: normalized.source,
			message: normalized.message,
			since: now,
			last: now,
			count: 0,
		});
		if (file.lines.size > MAX_FOLDS) {
			for (const [oldestKey, oldest] of file.lines) {
				writeCount(filePath, oldest, now);
				file.lines.delete(oldestKey);
				break;
			}
		}
		armFolds(filePath, file, now + REPEAT_WINDOW_MS);
		if (!flushOnExit) {
			flushOnExit = true;
			process.once("exit", flushAllFolds);
		}
	} catch {
		// A crash logger must never trigger a second failure path.
	}
}

/** gui-runtime.jsonl under a profile: main's one log of what happened at run time. */
export function runtimeLogFile(userData: string): string {
	return path.join(userData, "logs", "gui-runtime.jsonl");
}

/**
 * The last `maxLines` complete lines of a log, read from its end (`maxBytes` at most), so a large log
 * is never parsed end to end. A read that starts mid-line drops that first fragment; a missing file is `[]`.
 */
export async function tailLogLines(filePath: string, maxLines: number, maxBytes = 256 * 1024): Promise<string[]> {
	try {
		const handle = await fs.promises.open(filePath, "r");
		try {
			const { size } = await handle.stat();
			const length = Math.min(size, maxBytes);
			const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
			const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
			if (size > length) lines.shift();
			return lines.filter(Boolean).slice(-maxLines);
		} finally {
			await handle.close();
		}
	} catch {
		return [];
	}
}
