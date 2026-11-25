import { useCallback, useEffect, useRef, useState } from "react";
import type { GithubRequest, GithubResults } from "../../shared/github";
import { useFocusedScope } from "./focused-scope";
import { afterFailure, afterSuccess, type Freshness, pausedUntil, shouldReread } from "./github-freshness";
import { lastRead, rememberRead } from "./last-read";
import { hidden, onWindowReturn } from "./visible-poll";

/** A failed `github` command: gh's message plus main's code (gh_missing, gh_unauthenticated, github_failed, …). */
export class GithubError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "GithubError";
	}
}

/**
 * Run one Agents › GitHub operation on the focused tab's machine (src/main/local/git/github.ts). `background`: no
 * person asked (the window came back), so main refuses it while GitHub's limit or the background pace is spent.
 */
export async function github<R extends GithubRequest>(request: R, background = false): Promise<GithubResults[R["op"]]> {
	const response = await window.omp.rpc.command({ type: "github", request, ...(background ? { background } : {}) });
	if (!response.success) throw new GithubError(response.error, response.code ?? "github_failed");
	return response.data as GithubResults[R["op"]];
}

export interface GithubLoad<T> {
	data: T | null;
	error: string | null;
	/** Main's code for `error` (gh_missing, gh_unauthenticated, not_a_repo, no_github_remote, github_failed). */
	errorCode: string | null;
	loading: boolean;
	/** GitHub holds reads until then (`gh_paused`): shown as one quiet line, never as `error`. */
	pausedUntil: number | null;
	reload: () => void;
}

/**
 * Load `request` whenever `key` changes (and on `reload`); `null` loads nothing. A slower earlier answer never
 * replaces a newer one, and rows from the last success stay while a reload of the same key runs or fails. A return
 * to the window reads the key again in place, in the background, once its last read is a minute old and not held.
 */
export function useGithubLoad<R extends GithubRequest>(
	request: R | null,
	key: string,
): GithubLoad<GithubResults[R["op"]]> {
	type Data = GithubResults[R["op"]];
	const scope = useFocusedScope();
	// What this key showed last time (a run's log is not kept): painted at the first frame, read again in place.
	// The folder is part of it: a repo-less request resolves the checkout repo from the tab's cwd.
	const snapKey = request && request.op !== "run_log" ? `github:${scope.cwd}:${request.op}:${key}` : null;
	const [loaded, setLoaded] = useState<{ key: string; data: Data } | null>(null);
	const [error, setError] = useState<{ message: string; code: string } | null>(null);
	const [loading, setLoading] = useState(false);
	const [paused, setPaused] = useState<number | null>(null);
	const latest = useRef(0);
	const settled = useRef(true);
	const fresh = useRef<{ key: string; f: Freshness } | null>(null);
	const current = useRef({ request, snapKey, device: scope.device, key });
	current.current = { request, snapKey, device: scope.device, key };
	const read = useCallback((background: boolean) => {
		const { request: next, snapKey: remember, device, key: at } = current.current;
		const sequence = ++latest.current;
		if (!background) setError(null);
		if (!next) {
			settled.current = true;
			setLoading(false);
			return;
		}
		settled.current = false;
		if (!background) setLoading(true);
		const done = () => {
			settled.current = true;
			setLoading(false);
		};
		github(next, background).then(
			result => {
				if (sequence !== latest.current) return;
				fresh.current = { key: at, f: afterSuccess(Date.now()) };
				setLoaded({ key: at, data: result });
				if (remember) rememberRead(device, remember, result);
				setError(null);
				setPaused(null);
				done();
			},
			(cause: unknown) => {
				if (sequence !== latest.current) return;
				const failure = {
					message: cause instanceof Error ? cause.message : String(cause),
					code: cause instanceof GithubError ? cause.code : "github_failed",
				};
				fresh.current = {
					key: at,
					f: afterFailure(fresh.current?.key === at ? fresh.current.f : undefined, Date.now(), failure),
				};
				const until = failure.code === "gh_paused" ? pausedUntil(failure.message) : null;
				// A background failure leaves what is shown; only a person's read says it failed.
				if (until !== null) setPaused(until);
				else if (!background) setError(failure);
				done();
			},
		);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` names the request; the ref holds its latest value
	useEffect(() => read(false), [key, read]);
	const reload = useCallback(() => read(false), [read]);
	const freshen = useCallback(() => {
		const shown = fresh.current;
		if (hidden() || !settled.current || !current.current.request || shown?.key !== current.current.key) return;
		if (shouldReread(shown.f, Date.now())) read(true);
	}, [read]);
	useEffect(() => onWindowReturn(freshen), [freshen]);
	// The hold ends by itself: the line goes and the key reads again.
	useEffect(() => {
		if (paused === null) return;
		const timer = setTimeout(() => {
			setPaused(null);
			freshen();
		}, paused - Date.now());
		return () => clearTimeout(timer);
	}, [paused, freshen]);
	// Rows of this key (live, else its last snapshot), never another key's.
	const data = loaded?.key === key ? loaded.data : snapKey ? (lastRead<Data>(scope.device, snapKey) ?? null) : null;
	return { data, error: error?.message ?? null, errorCode: error?.code ?? null, loading, pausedUntil: paused, reload };
}
