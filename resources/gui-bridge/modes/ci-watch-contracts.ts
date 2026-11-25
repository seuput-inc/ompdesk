/**
 * CI results of a session's pushes (engine: ./ci-watch.ts, rules: ./ci-watch-core.ts, control-tools.md › CI results of
 * a session's pushes). Dependency-free: the bridge and the renderer import it.
 */

/** Journal entry for one push or PR the session made: `CiWatchRecord`; never shown, never in model context. */
export const CI_WATCH_ENTRY = "ompdesk-ci-watch";
/** Journal entry ending a watch: `{id, reason}`. */
export const CI_WATCH_END_ENTRY = "ompdesk-ci-watch-end";
/** The transcript line (a displayed custom message the model reads next turn): details `CiResultDetails`. */
export const CI_MESSAGE_TYPE = "ompdesk-ci";

export interface CiResultDetails {
	id: string;
	host: string;
	/** `owner/name`. */
	repo: string;
	branch: string;
	/** Full head sha the runs were read for. */
	sha: string;
	pr?: number;
	outcome: "success" | "failure";
	/** Failed job names, at most `CI_FAILED_SHOWN`. */
	failed: string[];
	/** The run to open (the first failed one, else the first). */
	url?: string;
}

export const CI_FAILED_SHOWN = 5;

/** `owner/repo@abc1234 (main)`: the commit a result is about, as the note and the model text name it. */
export function ciTarget(details: Pick<CiResultDetails, "repo" | "sha" | "branch">): string {
	return `${details.repo}@${details.sha.slice(0, 7)} (${details.branch})`;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** The message's details read back; undefined when malformed. */
export function parseCiResult(details: unknown): CiResultDetails | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const record = details as Record<string, unknown>;
	const id = text(record.id);
	const host = text(record.host);
	const repo = text(record.repo);
	const branch = text(record.branch);
	const sha = text(record.sha);
	const outcome = record.outcome;
	if (!id || !host || !repo || !branch || !sha || (outcome !== "success" && outcome !== "failure")) return undefined;
	const failed = Array.isArray(record.failed)
		? record.failed.filter((name): name is string => typeof name === "string").slice(0, CI_FAILED_SHOWN)
		: [];
	const pr = typeof record.pr === "number" && Number.isSafeInteger(record.pr) && record.pr > 0 ? record.pr : undefined;
	const url = text(record.url);
	return {
		id,
		host,
		repo,
		branch,
		sha,
		outcome,
		failed,
		...(pr ? { pr } : {}),
		...(url?.startsWith("https://") ? { url } : {}),
	};
}
