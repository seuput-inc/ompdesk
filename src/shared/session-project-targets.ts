import type { ProjectTargets } from "../../resources/gui-bridge/project-target-contracts";

export interface SessionProjectSource {
	cwd: string;
	projectTargets?: ProjectTargets | null;
}

/** A cwd is only a lookup input: the execution host still verifies whether it belongs to a repository. */
export function sessionProjectPaths(session: SessionProjectSource): readonly string[] {
	return session.projectTargets?.paths ?? (session.cwd ? [session.cwd] : []);
}
