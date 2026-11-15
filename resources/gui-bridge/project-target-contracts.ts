export const PROJECT_TARGET_ENTRY = "ompdesk.project-targets";

export interface ProjectTargets {
	/** Journal entry id, or "cwd" before the person selected a target. Never a path or a branch. */
	revision: string;
	source: "cwd" | "explicit";
	paths: string[];
}

export interface ProjectTargetInstructions {
	path: string;
	content: string;
}

export interface ProjectTargetSelection {
	version: 1;
	paths: string[];
	instructions: ProjectTargetInstructions[];
}

export function isProjectTargetSelection(value: unknown): value is ProjectTargetSelection {
	if (!value || typeof value !== "object") return false;
	const data = value as Record<string, unknown>;
	return (
		data.version === 1 &&
		Array.isArray(data.paths) &&
		data.paths.every(path => typeof path === "string" && path.length > 0) &&
		Array.isArray(data.instructions) &&
		data.instructions.every(
			item =>
				item !== null &&
				typeof item === "object" &&
				typeof item.path === "string" &&
				typeof item.content === "string",
		)
	);
}

export function selectedProjectTargets(
	entries: readonly { id?: unknown; type?: unknown; customType?: unknown; data?: unknown }[],
	cwd: string,
): { targets: ProjectTargets; instructions: ProjectTargetInstructions[] } {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry.type === "custom" &&
			entry.customType === PROJECT_TARGET_ENTRY &&
			typeof entry.id === "string" &&
			isProjectTargetSelection(entry.data)
		) {
			return {
				targets: { revision: entry.id, source: "explicit", paths: entry.data.paths },
				instructions: entry.data.instructions,
			};
		}
	}
	return { targets: { revision: "cwd", source: "cwd", paths: cwd ? [cwd] : [] }, instructions: [] };
}

export function projectTargetContext(
	targets: ProjectTargets,
	instructions: readonly ProjectTargetInstructions[],
): string {
	if (targets.source !== "explicit") return "";
	const scope = targets.paths.length
		? `The person selected these task directories on this session's execution host:\n${targets.paths.map(path => `- ${JSON.stringify(path)}`).join("\n")}`
		: "The person cleared the explicit task targets. Resolve the next task's directory before making changes.";
	return [
		scope,
		"The session's original working directory has not moved. For new work, use the selected target's absolute paths and pass its directory explicitly to commands. Existing commands and persistent kernels keep their original execution context; pass cwd explicitly to new sh/command calls rather than assuming the kernel moved. With multiple targets, name the directory for each operation; there is no implicit single repository. Reading another file does not change this selection. Change targets only when the person changes the task, after resolving the real directory. Read the selected project's instructions before changing its files.",
		...instructions.map(
			file => `<project-instructions path=${JSON.stringify(file.path)}>\n${file.content}\n</project-instructions>`,
		),
	].join("\n\n");
}
