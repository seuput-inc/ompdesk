/**
 * The project boundary on the receiving side of the link (control-tools.md › Project boundary › Paired devices): a
 * request a paired device's agent made through the control tools names its caller (`agent-control/boundary-claim.ts`),
 * and this computer judges it by its own setting before `LocalHostServices` serves it. A request that names no caller
 * (the device's person, the device's own app) is not judged here.
 */

import type { ProjectBoundaryMode } from "../../shared/agent-control";
import { codedError } from "../../shared/ipc-error-codes";
import type { SessionInfo } from "../../shared/ipc-types";
import type { SchedulesState } from "../../shared/schedules";
import { type ClaimTarget, hostClaimOf, judgeHostClaim, OTHER_PROJECT } from "../agent-control/boundary-claim";
import type { RuntimeLogReport } from "../runtime-log-core";

export interface HostBoundaryDeps {
	/** This computer's `agentProjectBoundary` mode. */
	mode(): ProjectBoundaryMode;
	/** The project a folder of this computer belongs to (the sidebar's rule); null when it cannot be told. */
	projectOf(folder: string): Promise<string | null>;
	log(report: RuntimeLogReport): void;
}

/** What one request reads or acts on, before its folder's project is known. */
export type RequestTarget = Omit<ClaimTarget, "project">;

/** Whether the caller of one request may reach a session or folder of this computer. */
export type InScope = (target: RequestTarget) => Promise<boolean>;

/**
 * Judges one request that names its caller. `target` is what it reads or acts on (null for a list, which its method
 * filters with the answer). Throws `other_project` for a target `enforce` refuses and writes the runtime log's line
 * for one `log` would. Answers the filter of this caller's lists while the boundary enforces, else null.
 */
export async function hostBoundary(
	deps: HostBoundaryDeps,
	peerId: string,
	method: string,
	params: unknown,
	target: RequestTarget | null,
): Promise<InScope | null> {
	const claim = hostClaimOf(params);
	const mode = deps.mode();
	if (!claim || mode === "off" || claim.granted) return null;
	const projects = new Map<string, Promise<string | null>>();
	const projectOf = (folder: string | null | undefined): Promise<string | null> => {
		if (!folder) return Promise.resolve(null);
		const known = projects.get(folder);
		if (known) return known;
		const asked = deps.projectOf(folder).catch(() => null);
		projects.set(folder, asked);
		return asked;
	};
	const callerProject = await projectOf(claim.cwd);
	const verdictOf = async (wanted: RequestTarget) =>
		judgeHostClaim(mode, claim, callerProject, { ...wanted, project: await projectOf(wanted.folder) });
	if (target) {
		const verdict = await verdictOf(target);
		if (verdict === "log")
			deps.log({
				source: "agent-control",
				message: "project boundary would refuse",
				details: {
					level: "info",
					tool: method,
					caller: claim.cwd ?? `device:${peerId}`,
					target: target.session ?? target.folder ?? null,
					callerProject,
					targetProject: await projectOf(target.folder),
				},
			});
		if (verdict === "refuse") throw codedError("other_project", OTHER_PROJECT);
	}
	return mode === "enforce" ? async wanted => (await verdictOf(wanted)) === "allow" : null;
}

/** The rows a caller may reach, and one empty row per session it may not: counted on the device, never named. */
export async function scopedSessions(rows: readonly SessionInfo[], inScope: InScope): Promise<SessionInfo[]> {
	const scoped: SessionInfo[] = [];
	let outside = 0;
	for (const row of rows) {
		if (await inScope({ session: row.path, folder: row.cwd })) {
			scoped.push(row);
			continue;
		}
		outside += 1;
		scoped.push({
			path: `outside:${outside}`,
			id: `outside:${outside}`,
			title: null,
			cwd: "",
			created: "",
			modified: "",
			messageCount: 0,
			size: 0,
			status: "unknown",
			firstMessage: "",
			outsideProject: true,
		});
	}
	return scoped;
}

/** The schedules a caller may reach (by the folder each runs in), with the rest as a count. */
export async function scopedSchedules(state: SchedulesState, inScope: InScope): Promise<SchedulesState> {
	const kept = new Set<string>();
	for (const schedule of state.schedules) if (await inScope({ folder: schedule.cwd })) kept.add(schedule.id);
	const outside = state.schedules.length - kept.size;
	if (outside === 0) return state;
	return {
		...state,
		schedules: state.schedules.filter(schedule => kept.has(schedule.id)),
		runs: state.runs.filter(run => kept.has(run.scheduleId)),
		nextRuns: Object.fromEntries(Object.entries(state.nextRuns).filter(([id]) => kept.has(id))),
		outside,
	};
}
