/**
 * Saved terminal commands (Orca's quick commands, `shared/terminal/quick-commands/terminal-quick-commands.ts`): a label
 * and the text a terminal runs, for one project folder or every one, kept in the pref `terminalCommands` and run from
 * the Terminal panel or the command palette. Orca's agent-prompt kind is stock's prompt templates here, so only shell
 * commands are kept; each runs as typed and ends with Enter.
 */
export const TERMINAL_COMMANDS_PREF = "terminalCommands";
export const MAX_COMMAND_LABEL = 80;
export const MAX_COMMAND_TEXT = 4000;
const MAX_COMMANDS = 200;

export interface TerminalCommand {
	id: string;
	label: string;
	command: string;
	/** The project folder it belongs to; absent: every project. */
	folder?: string;
}

/** The stored list as far as it reads: each entry a label and a command, ids unique, lengths held. */
export function parseTerminalCommands(value: unknown): TerminalCommand[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const commands: TerminalCommand[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || commands.length >= MAX_COMMANDS) continue;
		const { id, label, command, folder } = item as Record<string, unknown>;
		if (typeof id !== "string" || !id || seen.has(id) || typeof label !== "string" || typeof command !== "string")
			continue;
		const text = command.trimEnd().slice(0, MAX_COMMAND_TEXT);
		const name = label.trim().slice(0, MAX_COMMAND_LABEL);
		if (!name || !text) continue;
		seen.add(id);
		commands.push({ id, label: name, command: text, ...(typeof folder === "string" && folder ? { folder } : {}) });
	}
	return commands;
}

/** The commands a tab in `folder` offers: its own folder's first, then every project's. */
export function commandsFor(commands: readonly TerminalCommand[], folder: string | undefined): TerminalCommand[] {
	return [
		...commands.filter(command => folder && command.folder === folder),
		...commands.filter(command => !command.folder),
	];
}

/** What a terminal is sent: the lines as typed (`\r`), ending with one Enter. */
export function commandInput(command: string): string {
	return `${command.replace(/\r?\n/g, "\r").replace(/\r+$/, "")}\r`;
}
