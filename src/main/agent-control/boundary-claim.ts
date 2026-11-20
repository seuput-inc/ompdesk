/**
 * Who makes a control-tool call, carried to a paired host so the host judges the request by its own project boundary
 * too (control-tools.md › Project boundary › Paired devices).
 *
 * The core names the caller with every ask whose work may cross the link (`boundaryCaller`, `service/boundary.rs`
 * `CLAIMED_ASKS`). `withCallerClaim` holds it for whatever main does while it answers that ask, and the link's client
 * (`RemoteClient.request`) adds it to each request sent meanwhile (`withHostClaim`). The host reads it
 * (`hostClaimOf`) and decides (`judgeHostClaim`). A request with no claim is the device's person or the device's own
 * app, which no boundary judges. The claim is the paired computer's word: it guards against accidents, like the
 * boundary itself.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { ProjectBoundary } from "../../shared/agent-control";

const CallerClaimSchema = z.object({
	/** The calling session, by its file (its tab's id while it has none): what a host knows it opened by. */
	caller: z.string(),
	/** The paired host the caller's tab runs on; null: the computer that sends the request. */
	device: z.string().nullable(),
	cwd: z.string(),
	/** The person allowed the caller's session across projects on its own computer. */
	granted: z.boolean(),
	/** Session files and folders of the sessions the caller opened through a check that passed. */
	own: z.array(z.string()),
	/** Those it opened with no such check (before the boundary, or while it only logged). */
	earlier: z.array(z.string()).default([]),
});
export type CallerClaim = z.infer<typeof CallerClaimSchema>;

const HostClaimSchema = z.object({
	caller: z.string(),
	/** The caller's folder, only when its tab runs on the host that reads this: the host names its project itself. */
	cwd: z.string().optional(),
	granted: z.boolean(),
	own: z.array(z.string()),
	/** Absent from an older device, whose `own` holds everything its caller opened. */
	earlier: z.array(z.string()).default([]),
});
export type HostClaim = z.infer<typeof HostClaimSchema>;

/** The key a request's params carry the claim under. */
export const HOST_CLAIM_KEY = "boundary";

const calling = new AsyncLocalStorage<CallerClaim>();

/** Runs `run` as the caller `claim` names (what the core sent as `boundaryCaller`); anything else runs it as nobody. */
export function withCallerClaim<T>(claim: unknown, run: () => T): T {
	const parsed = CallerClaimSchema.safeParse(claim);
	return parsed.success ? calling.run(parsed.data, run) : run();
}

/** A request's params on their way to the host `hostDeviceId`, with the caller main is answering for, if any. */
export function withHostClaim(hostDeviceId: string, params: unknown): unknown {
	const claim = calling.getStore();
	if (!claim || typeof params !== "object" || params === null || Array.isArray(params)) return params;
	const sent: HostClaim = {
		caller: claim.caller,
		...(claim.device === hostDeviceId ? { cwd: claim.cwd } : {}),
		granted: claim.granted,
		own: claim.own,
		earlier: claim.earlier,
	};
	return { ...params, [HOST_CLAIM_KEY]: sent };
}

/** The claim a device's request carries; null for a request no agent's tool call made. */
export function hostClaimOf(params: unknown): HostClaim | null {
	if (typeof params !== "object" || params === null || !(HOST_CLAIM_KEY in params)) return null;
	const parsed = HostClaimSchema.safeParse(params[HOST_CLAIM_KEY]);
	return parsed.success ? parsed.data : null;
}

/** What a request reads or acts on: a session file, a folder, or both; `project` is the folder's, null when unknown. */
export interface ClaimTarget {
	session?: string;
	folder?: string | null;
	project: string | null;
	/** A hosted tab this very caller opened through a request the host let through. */
	opened?: boolean;
}

/**
 * The host's verdict on one request, by the rule of `rules/boundary.rs` under this computer's own setting: allowed
 * when the mode is off, the caller is granted, the caller opened the target through a check (the host's own record,
 * or the claim's `own`), opened it with none while `earlierOpened` is `visible`, or both projects are known and equal.
 * `callerProject` is null for a caller that runs on another computer, whose project is never one of this computer's.
 */
export function judgeHostClaim(
	boundary: ProjectBoundary,
	claim: HostClaim,
	callerProject: string | null,
	target: ClaimTarget,
): "allow" | "log" | "refuse" {
	if (boundary.mode === "off" || claim.granted || target.opened === true) return "allow";
	// A session is the caller's by its file; a folder alone (a worktree) or a tab with no file yet, by the folder.
	const opened = target.session ?? target.folder;
	if (opened != null && claim.own.includes(opened)) return "allow";
	if (opened != null && boundary.earlierOpened === "visible" && claim.earlier.includes(opened)) return "allow";
	if (callerProject !== null && callerProject === target.project) return "allow";
	return boundary.mode === "log" ? "log" : "refuse";
}

/** What a refused request is answered with (the core's `OTHER_PROJECT`). */
export const OTHER_PROJECT =
	"That session is in another project; another project's sessions show counts only. The user can allow this session to work across projects in its sidebar menu.";
