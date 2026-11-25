/**
 * C115: the read-only `gui_terminal_read` host tool. Every tab's omp gets it
 * through stock RPC `set_host_tools` once ready; a call reads that tab's own
 * Terminal panel sessions (a paired host's tab: the host's) and returns their
 * recent output as plain text. It never writes to a terminal.
 */
import type { HostToolDefinition } from "../../shared/rpc-types";
import type { TerminalRead } from "../../shared/terminal-types";

export const TERMINAL_READ_TOOL = "gui_terminal_read";
const DEFAULT_LINES = 200;
export const MAX_TERMINAL_READ_LINES = 2_000;

export const TERMINAL_READ_DEFINITION: HostToolDefinition = {
	name: TERMINAL_READ_TOOL,
	label: "Read terminal",
	description:
		"Read the user's recent terminal output: an error, a server log, a command they ran.\n" +
		"Read the recent output of the user's terminals in OMPdesk's Terminal panel for this tab (read-only; it cannot type or run anything). " +
		"Use it when the user refers to something in their terminal. " +
		"Lists every terminal with its state and returns the last lines of the chosen one (default: the first).",
	parameters: {
		type: "object",
		properties: {
			terminal: { type: "integer", minimum: 1, description: "1-based terminal number as listed; default 1." },
			lines: {
				type: "integer",
				minimum: 1,
				maximum: MAX_TERMINAL_READ_LINES,
				description: `How many trailing lines to return; default ${DEFAULT_LINES}.`,
			},
		},
		additionalProperties: false,
	},
};

export function terminalReadOptions(args: Record<string, unknown>): TerminalRead {
	const pick = typeof args.terminal === "number" && Number.isInteger(args.terminal) ? args.terminal : 1;
	const wanted = typeof args.lines === "number" && Number.isInteger(args.lines) ? args.lines : DEFAULT_LINES;
	return { pick: String(pick), lines: Math.min(MAX_TERMINAL_READ_LINES, Math.max(1, wanted)) };
}
