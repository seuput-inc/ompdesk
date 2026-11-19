/**
 * The session files the person allowed to work across projects (`agentCrossProject`, control-tools.md › Project
 * boundary), as main stores them: read once and again whenever main says the key changed. The grant is written only
 * through `window.omp.prefs.setCrossProject`, from a desktop window.
 */
import { useEffect, useState } from "react";
import { AGENT_CROSS_PROJECT_PREF, crossProjectSessions } from "../../shared/agent-control";

export function useCrossProjectSessions(): string[] {
	const [sessions, setSessions] = useState<string[]>([]);
	useEffect(() => {
		let live = true;
		const read = () =>
			void window.omp.prefs.get(AGENT_CROSS_PROJECT_PREF).then(
				stored => {
					const next = crossProjectSessions(stored);
					// The same list keeps the same array: nothing renders again for a read that changed nothing.
					if (live) setSessions(held => (held.join("\n") === next.join("\n") ? held : next));
				},
				() => undefined,
			);
		read();
		// A test's bridge may have no change events.
		const off = window.omp.prefs.onChanged?.(event => {
			if (event.key === AGENT_CROSS_PROJECT_PREF) read();
		});
		return () => {
			live = false;
			off?.();
		};
	}, []);
	return sessions;
}
