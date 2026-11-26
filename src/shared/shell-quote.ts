/**
 * A path or argument typed into a shell as one word: what a file dropped on a terminal types, what "Open in terminal"
 * and an SSH host's terminal run. Adapted from Orca's `shared/shell/launch/shell-path-quoting.ts` and
 * `shell-argument-quoting.ts` (MIT, see THIRD_PARTY_NOTICES.txt): quote for the shell that reads it, not this computer.
 */
export type ShellKind = "posix" | "windows";

/** POSIX single quotes, `'` closed, escaped and reopened; a plain word (`A-Za-z0-9_./@:-`) stays bare. */
export function quotePosix(value: string): string {
	return /^[a-zA-Z0-9_./@:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/** cmd.exe and PowerShell both read a double-quoted word; a plain one (also `\`) stays bare. */
export function quoteWindows(value: string): string {
	return /^[a-zA-Z0-9_./@:\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}

export function shellQuote(value: string, kind: ShellKind): string {
	return kind === "windows" ? quoteWindows(value) : quotePosix(value);
}

/** The quoting a shell reads, by its program's path: cmd and PowerShell are Windows', every other shell POSIX's. */
export function shellKindOf(shell: string | undefined, windows: boolean): ShellKind {
	const name = (shell ?? "").split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
	if (/^(cmd|powershell|pwsh)(\.exe)?$/.test(name)) return "windows";
	if (name) return "posix";
	return windows ? "windows" : "posix";
}
