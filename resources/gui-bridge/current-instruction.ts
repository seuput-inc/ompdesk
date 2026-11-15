import { hasPath, REQUIREMENTS, UnsupportedOmpError } from "./capabilities";

/** Admission fence only. It neither enqueues nor treats an accepted prompt as consumed context. */
export function prepareCurrentInstruction(session: { readonly isStreaming: boolean }): void {
	if (!session.isStreaming) return;
	const missing = (REQUIREMENTS.currentInstruction.session ?? [])
		.filter(path => !hasPath(session, path))
		.map(path => `AgentSession.${path}`);
	if (missing.length) throw new UnsupportedOmpError([{ feature: "currentInstruction", missing }]);
}
