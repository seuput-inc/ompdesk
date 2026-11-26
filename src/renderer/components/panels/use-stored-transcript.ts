import { useCallback, useEffect, useRef, useState } from "react";
import { readTranscriptSnapshot } from "../../lib/transcript-snapshot";
import type { SubagentTranscriptState } from "./use-subagent-transcript";

/**
 * A stored session's transcript read from its journal (`sessions.messages`: this computer's, or the paired host's),
 * not through a tab. It paints the last transcript this computer kept of the session at once when it has one (the
 * snapshot of a tab that showed it; a first visit, or a host's session never opened here, shows the transcript's
 * static skeleton) and replaces it in place with the read. A change of `version` reads it again (a session that ran
 * on meanwhile).
 */
export function useStoredTranscript(
	sessionPath: string,
	device: string | undefined,
	version?: unknown,
): SubagentTranscriptState {
	const [state, setState] = useState(() => ({
		messages: readTranscriptSnapshot({ sessionPath, ...(device === undefined ? {} : { device }) })?.messages ?? [],
		loading: true,
		error: null as string | null,
	}));
	const generation = useRef(0);
	const load = useCallback(() => {
		const mine = ++generation.current;
		setState(prev => (prev.error === null ? prev : { ...prev, loading: true, error: null }));
		window.omp.sessions.messages(sessionPath, device).then(
			messages => {
				if (mine === generation.current) setState({ messages, loading: false, error: null });
			},
			cause => {
				if (mine === generation.current)
					setState(prev => ({
						...prev,
						loading: false,
						error: cause instanceof Error ? cause.message : String(cause),
					}));
			},
		);
	}, [sessionPath, device]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` only asks for the read again.
	useEffect(() => {
		load();
		return () => {
			generation.current++;
		};
	}, [load, version]);
	return { ...state, busy: false, hasMore: false, loadMore: () => undefined, reload: load };
}
