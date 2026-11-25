/**
 * Background bash jobs that outlive their omp and OMPdesk (rules: `.omp/rules/interrupted-work.md` › Background jobs
 * survive a relaunch). Dependency-free: main imports `KEEP_CLI_ENV`.
 */

/** The `ompdesk` CLI a session's omp starts kept jobs with (`ompdesk keep`); unset: jobs run in omp as stock's. */
export const KEEP_CLI_ENV = "OMP_GUI_KEEP_CLI";

/** The folder a kept job of call `toolCallId` lives in, under the session's artifacts folder (deleted with it). */
export function keptJobDir(artifactsDir: string, toolCallId: string, join: (...parts: string[]) => string): string {
	return join(artifactsDir, "kept-jobs", toolCallId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/**
 * Whether a background call's command runs as a kept job. Its process has no session, so the URL paths the session's
 * shell resolves (`local://` and the like) do not exist there; such a command stays in omp, as stock runs it.
 */
export function keepable(command: string): boolean {
	return !/\b(?:local|skill|attachment|artifact|agent|history|rule|xd|proc|mcp|omp|issue|pr|ssh|memory):\/\//i.test(
		command,
	);
}

/** How a kept job ended: `exit` holds its exit code, `-1` for none (cancelled, or it could not start). */
export function keptExit(text: string): number | undefined {
	const code = Number.parseInt(text.trim(), 10);
	return Number.isFinite(code) ? code : undefined;
}

/** The text a reattached job delivers: the command's output and how it ended, as the agent reads a job's result. */
export function keptResult(output: string, code: number, limit = 50_000): string {
	const tail =
		output.length > limit ? `[… ${output.length - limit} earlier characters]\n${output.slice(-limit)}` : output;
	const body = tail.trimEnd() || "(no output)";
	return code === 0 ? body : `${body}\n\nCommand exited with code ${code}`;
}
