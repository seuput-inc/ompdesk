/**
 * Feedback → GitHub issue bridge. Builds the `issues/new` URL the dialog
 * opens; nothing is sent before the user submits (the draft then reaches
 * GitHub in that URL), and no session content is ever included — only what
 * the dialog previews.
 *
 * Shared (not renderer-only) because the error log tail is assembled in the
 * main process and the fallback page uses the same URL builder.
 */

import type { RuntimeErrorReport } from "./ipc-types";
import { PRODUCT_REPO_URL } from "./product-repo";

export type FeedbackKind = "bug" | "feature" | "question";

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ["bug", "feature", "question"];

const KIND_LABELS: Record<FeedbackKind, string> = {
	bug: "bug",
	feature: "enhancement",
	question: "question",
};

const KIND_TITLE: Record<FeedbackKind, string> = {
	bug: "[Bug] ",
	feature: "[Feature] ",
	question: "[Question] ",
};

export interface FeedbackEnvironment {
	appVersion: string;
	platform: string;
	arch: string;
	electron: string;
	chrome: string;
}

export interface FeedbackInput {
	kind: FeedbackKind;
	title: string;
	description: string;
	environment?: FeedbackEnvironment | null;
	/** Runtime error lines the user opted into. */
	errors?: readonly string[];
	/** Error text carried in from a crash page or error surface. */
	prefillError?: string | null;
	/** A picture rides the clipboard (an issue URL cannot carry one): the body marks where to paste it. */
	picture?: boolean;
}

/** Where the issue body asks for the copied picture; the body's first section, so a shortened body keeps it. */
export const PICTURE_PASTE_MARK =
	"### Screenshot\n\n<!-- The picture is on your clipboard: paste it here (⌘V / Ctrl+V). -->";

/** What the last launch left for a report: a main-thread hang, or launches that kept failing (safe mode). */
export interface LaunchIncident {
	kind: "hang" | "unstable";
	/** Epoch ms of the hang, or of this launch. */
	at: number;
	/** The record, in English, for the issue's error details. */
	detail: string;
}

/** Prefs key main writes at a launch that has an incident to offer; the first window to read it takes it. */
export const LAUNCH_INCIDENT_PREF = "launchIncident";

/**
 * The incident this launch offers to report: the newest `main-thread-hang` line the shell's watchdog left (its
 * marker, `tauri-shell/src/watchdog/marker.rs`), else safe mode after launches that kept failing. Orca offers the
 * same after a crash or a freeze (renderer/src/components/crash-report/CrashReportDialog.tsx:63).
 */
export function launchIncidentOf(
	reports: readonly { source: string; message: string; details?: object }[],
	safeMode: boolean,
	now: number,
): LaunchIncident | null {
	const hang = reports.findLast(report => report.source === "main-thread-hang");
	if (hang) {
		const details = (hang.details ?? {}) as Record<string, unknown>;
		const at = typeof details.detectedAt === "string" ? Date.parse(details.detectedAt) : Number.NaN;
		const lines = [hang.message];
		for (const key of ["detectedAt", "phase", "steps", "unresponsiveMs"] as const) {
			const value = details[key];
			if (typeof value === "string" || typeof value === "number") lines.push(`${key}: ${value}`);
		}
		return { kind: "hang", at: Number.isFinite(at) ? at : now, detail: `main-thread-hang\n${lines.join("\n")}` };
	}
	if (safeMode)
		return {
			kind: "unstable",
			at: now,
			detail: "launch-guard\nThree launches in a row ended within 10 minutes; this launch started in safe mode.",
		};
	return null;
}

export function parseLaunchIncident(value: unknown): LaunchIncident | null {
	if (typeof value !== "object" || value === null) return null;
	const { kind, at, detail } = value as Record<string, unknown>;
	if ((kind !== "hang" && kind !== "unstable") || typeof at !== "number" || typeof detail !== "string") return null;
	return { kind, at, detail };
}

/** One parsed runtime log line, rendered as a compact single-line summary. */
interface RuntimeLogEntry {
	ts?: string;
	report?: RuntimeErrorReport;
	appVersion?: string;
}

/** Keep the whole URL comfortably under every browser's practical limit. */
const MAX_URL_LENGTH = 8000;
const MAX_ERRORS_CHARS = 3000;
const STACK_HEAD_LINES = 6;
const STACK_HEAD_CHARS = 1200;

function compactStack(stack: string | undefined): string {
	if (!stack) return "";
	return stack.split("\n").slice(0, STACK_HEAD_LINES).join("\n").slice(0, STACK_HEAD_CHARS);
}

function toErrorLine(raw: string): string | null {
	try {
		const entry = JSON.parse(raw) as RuntimeLogEntry | RuntimeErrorReport;
		const report = "report" in entry && entry.report ? entry.report : (entry as RuntimeErrorReport);
		const message = typeof report.message === "string" ? report.message : "";
		if (!message) return null;
		const stack = compactStack(report.stack);
		return `\`${report.source ?? "unknown"}\` ${message}${stack ? `\n\`\`\`\n${stack}\n\`\`\`` : ""}`;
	} catch {
		// Tail reads can cut the first line mid-JSON — drop unparseable lines.
		return null;
	}
}

/** Newest-last render of the given tail lines (oldest first), bounded to MAX_ERRORS_CHARS by dropping the oldest. */
export function formatErrorTail(rawLines: readonly string[]): string {
	const lines: string[] = [];
	let size = 0;
	for (const raw of rawLines.toReversed()) {
		const line = toErrorLine(raw);
		if (line === null) continue;
		if (size + line.length > MAX_ERRORS_CHARS) break;
		lines.push(line);
		size += line.length;
	}
	return lines.reverse().join("\n");
}

export function buildIssueBody(input: FeedbackInput): string {
	const sections: string[] = [];
	// First: buildIssueUrl shortens a long body from its end, which must never drop the place to paste.
	if (input.picture) sections.push(PICTURE_PASTE_MARK);
	const description = input.description.trim();
	if (description) sections.push(description);
	const details: string[] = [];
	if (input.prefillError) details.push(input.prefillError.trim());
	if (input.errors && input.errors.length > 0) {
		const tail = formatErrorTail(input.errors);
		if (tail) details.push(tail);
	}
	if (details.length > 0) {
		sections.push(`### Error details\n\n<details>\n\n${details.join("\n\n")}\n\n</details>`);
	}
	if (input.environment) {
		const env = input.environment;
		sections.push(
			`### Environment\n\n- OMPdesk: v${env.appVersion}\n- OS: ${env.platform} ${env.arch}\n- Shell ${env.electron} · Chrome ${env.chrome}`,
		);
	}
	sections.push("---\n*Reported from the OMPdesk feedback dialog.*");
	return sections.join("\n\n");
}

export function buildIssueUrl(input: FeedbackInput): string {
	const url = new URL(`${PRODUCT_REPO_URL}/issues/new`);
	const description = input.description.trim();
	url.searchParams.set("title", `${KIND_TITLE[input.kind]}${input.title.trim()}`.trim());
	url.searchParams.set("labels", `gui,${KIND_LABELS[input.kind]}`);
	// URL-encoding roughly triples non-ASCII text; shrink the body until the
	// finished URL fits. The dialog copy tells the user the paste stays editable.
	let body = buildIssueBody({ ...input, description });
	url.searchParams.set("body", body);
	while (url.toString().length > MAX_URL_LENGTH && body.length > 400) {
		body = `${body.slice(0, Math.floor(body.length * 0.8)).trimEnd()}…`;
		url.searchParams.set("body", body);
	}
	return url.toString();
}
