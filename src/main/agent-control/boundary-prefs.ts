/**
 * The control tools' project boundary in main's prefs (`shared/agent-control.ts`: `agentProjectBoundary`,
 * `agentCrossProject`): the two writes only a person makes, each from its own IPC channel, and the lines they and
 * `log` mode leave in `gui-runtime.jsonl`. `PREFS_SET` refuses both keys (`refusePersonOnlyPref`), so no generic
 * write reaches them: not `ompdesk_app`, not `agent_power.set`, not a paired page.
 */
import { z } from "zod";
import {
	AGENT_CROSS_PROJECT_PREF,
	AGENT_PROJECT_BOUNDARY_PREF,
	crossProjectSessions,
	PERSON_ONLY_PREFS,
	PROJECT_BOUNDARY_MODES,
	projectBoundaryOf,
	projectBoundaryWithMode,
} from "../../shared/agent-control";
import { codedError } from "../../shared/ipc-error-codes";
import type { SidebarProjectsState } from "../../shared/sidebar-projects";
import type { RuntimeLogReport } from "../runtime-log-core";

export interface BoundaryPrefsStorage {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
}

type Log = (report: RuntimeLogReport) => void;

const GrantSchema = z.object({ sessionPath: z.string().min(1), on: z.boolean() });
const ModeSchema = z.object({ mode: z.enum(PROJECT_BOUNDARY_MODES) });

/** `PREFS_SET` of a key only its own channel writes: refused, whoever asks. */
export function refusePersonOnlyPref(key: string): void {
	if (PERSON_ONLY_PREFS.includes(key))
		throw codedError("invalid_preference_key", `${key} changes only by the person's own action in a desktop window`);
}

/** Only a desktop window's own page is a person: a paired page and an agent's `ompdesk_app` call have no native window. */
function requirePerson(fromDesktopWindow: boolean): void {
	if (!fromDesktopWindow)
		throw codedError("invalid_preference_key", "Only a person in a desktop window changes the project boundary");
}

/** `AGENT_CROSS_PROJECT_SET`: the grant of one session file; true when it changed (written and logged). */
export function setCrossProject(
	storage: BoundaryPrefsStorage,
	payload: unknown,
	fromDesktopWindow: boolean,
	log: Log,
): boolean {
	requirePerson(fromDesktopWindow);
	const parsed = GrantSchema.safeParse(payload);
	if (!parsed.success) throw codedError("invalid_preference_key", "Invalid cross-project grant");
	const { sessionPath, on } = parsed.data;
	const sessions = crossProjectSessions(storage.get(AGENT_CROSS_PROJECT_PREF));
	if (sessions.includes(sessionPath) === on) return false;
	storage.set(AGENT_CROSS_PROJECT_PREF, {
		sessions: on ? [...sessions, sessionPath] : sessions.filter(path => path !== sessionPath),
	});
	log({
		source: "agent-control",
		message: "cross-project grant",
		details: { level: "info", session: sessionPath, on },
	});
	return true;
}

/** `AGENT_PROJECT_BOUNDARY_SET`: the mode the person chose; true when it changed (written and logged). */
export function setProjectBoundary(
	storage: BoundaryPrefsStorage,
	payload: unknown,
	fromDesktopWindow: boolean,
	log: Log,
): boolean {
	requirePerson(fromDesktopWindow);
	const parsed = ModeSchema.safeParse(payload);
	if (!parsed.success) throw codedError("invalid_preference_key", "Invalid project boundary mode");
	const stored = storage.get(AGENT_PROJECT_BOUNDARY_PREF);
	if (projectBoundaryOf(stored).mode === parsed.data.mode) return false;
	storage.set(AGENT_PROJECT_BOUNDARY_PREF, projectBoundaryWithMode(stored, parsed.data.mode));
	log({
		source: "agent-control",
		message: "project boundary mode",
		details: { level: "info", mode: parsed.data.mode },
	});
	return true;
}

/** What the core tells of one call `enforce` would refuse (`boundaryLog`), as the runtime log's line. */
export function boundaryLogLine(entry: unknown): RuntimeLogReport {
	const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
	const text = (key: string): string | null => (typeof record[key] === "string" ? (record[key] as string) : null);
	return {
		source: "agent-control",
		message: "project boundary would refuse",
		details: {
			level: "info",
			tool: text("tool"),
			caller: text("caller"),
			target: text("target"),
			callerProject: text("callerProject"),
			targetProject: text("targetProject"),
		},
	};
}

/**
 * A folder's project by a computer's own sidebar list (a paired host's, whose git this computer cannot ask): a
 * linked worktree's project, a listed or removed project itself, null for a folder the list does not know.
 */
export function projectInList(
	list: Pick<SidebarProjectsState, "projects" | "removed" | "worktrees">,
	folder: string,
): string | null {
	const known = list.projects.some(project => project.path === folder) || list.removed.includes(folder);
	return list.worktrees[folder] ?? (known ? folder : null);
}
