import { useCallback, useEffect, useRef, useState } from "react";
import type { GitlabOp, GitlabRequest, GitlabResults } from "../../shared/gitlab";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import type { TrackersRequest, TrackersResults } from "../../shared/trackers";
import { errorDetail } from "./error-detail";
import { translate } from "./i18n";

export interface KeyedLoad<T> {
	data: T | null;
	/** A sentence to show: main's coded failure in the UI language, else the service's own words. */
	error: string | null;
	/** The failure's code (`glab_missing`, `tracker_auth`, …), when it has one. */
	errorCode: string | null;
	loading: boolean;
	/** Read again; `fresh` skips main's 60 s answer (the refresh button). */
	reload: (fresh?: boolean) => void;
}

/** A Linear or Jira failure as words: the coded ones in the UI language, then what the service said. */
export function trackerErrorText(error: unknown): string {
	const code = ipcErrorCode(error);
	const detail = errorDetail(error).replace(/^\[[a-z_]+\] /, "");
	return code ? `${translate(`ipcError.${code}`)} ${detail}`.trim() : detail;
}

/** A failed `gitlab` command: glab's or GitLab's words plus main's code. */
export class GitlabError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "GitlabError";
	}
}

/** One Agents › GitHub › GitLab operation on the focused tab's machine (`src/main/local/git/gitlab.ts`). */
export async function gitlab<R extends GitlabRequest>(request: R): Promise<GitlabResults[R["op"] & GitlabOp]> {
	const response = await window.omp.rpc.command({ type: "gitlab", request });
	if (!response.success) throw new GitlabError(response.error, response.code ?? "gitlab_failed");
	return response.data as GitlabResults[R["op"] & GitlabOp];
}

/**
 * Load what `read` answers whenever `key` changes (and on `reload`); a null `read` loads nothing. What the last read of
 * the same key showed stays while a reload runs or fails, and a slower earlier answer never replaces a newer one. No
 * read here runs on a timer.
 */
export function useKeyedLoad<T>(read: ((fresh: boolean) => Promise<T>) | null, key: string): KeyedLoad<T> {
	const [loaded, setLoaded] = useState<{ key: string; data: T } | null>(null);
	const [failure, setFailure] = useState<{ text: string; code: string | null } | null>(null);
	const [loading, setLoading] = useState(false);
	const sequence = useRef(0);
	const current = useRef({ read, key });
	current.current = { read, key };
	const run = useCallback((fresh: boolean) => {
		const { read: next, key: at } = current.current;
		const mine = ++sequence.current;
		setFailure(null);
		if (!next) {
			setLoading(false);
			return;
		}
		setLoading(true);
		next(fresh).then(
			data => {
				if (mine !== sequence.current) return;
				setLoaded({ key: at, data });
				setLoading(false);
			},
			(error: unknown) => {
				if (mine !== sequence.current) return;
				const code = error instanceof GitlabError ? error.code : (ipcErrorCode(error) ?? null);
				setFailure({ text: error instanceof GitlabError ? error.message : trackerErrorText(error), code });
				setLoading(false);
			},
		);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the key names the read; `run` takes it from a ref.
	useEffect(() => run(false), [key, read === null, run]);
	return {
		data: loaded?.key === key ? loaded.data : null,
		error: failure?.text ?? null,
		errorCode: failure?.code ?? null,
		loading,
		reload: (fresh = false) => run(fresh),
	};
}

/** `useKeyedLoad` of one Linear or Jira request (`window.omp.trackers`). */
export function useTrackerLoad<R extends TrackersRequest>(
	request: R | null,
	key: string,
): KeyedLoad<TrackersResults[R["action"]]> {
	return useKeyedLoad(
		request
			? fresh =>
					window.omp.trackers.command((fresh ? { ...request, fresh: true } : request) as R) as Promise<
						TrackersResults[R["action"]]
					>
			: null,
		key,
	);
}

/** `useKeyedLoad` of one GitLab request. */
export function useGitlabLoad<R extends GitlabRequest>(
	request: R | null,
	key: string,
): KeyedLoad<GitlabResults[R["op"] & GitlabOp]> {
	return useKeyedLoad(request ? () => gitlab(request) : null, key);
}
