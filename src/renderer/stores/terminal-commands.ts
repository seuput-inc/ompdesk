/**
 * The saved terminal commands (pref `terminalCommands`, `shared/terminal-commands.ts`): read once and again whenever
 * main says the pref changed, so the Terminal panel, the palette and another window show the same list.
 */
import { create } from "zustand";
import { parseTerminalCommands, TERMINAL_COMMANDS_PREF, type TerminalCommand } from "../../shared/terminal-commands";
import { readPref } from "../lib/prefs-read";

interface TerminalCommandsStore {
	commands: readonly TerminalCommand[];
	load: () => Promise<void>;
	/** Writes the whole list; the stored copy comes back through the pref's change. */
	save: (commands: readonly TerminalCommand[]) => Promise<void>;
}

export const useTerminalCommandsStore = create<TerminalCommandsStore>()(set => ({
	commands: [],
	load: async () => {
		const read = await readPref(TERMINAL_COMMANDS_PREF);
		if (read.ok) set({ commands: parseTerminalCommands(read.value) });
	},
	save: async commands => {
		set({ commands });
		await window.omp.prefs.set(TERMINAL_COMMANDS_PREF, commands);
	},
}));

let subscribed = false;

/** Load the list and follow main's changes; a missing bridge (tests) is skipped. */
export function ensureTerminalCommands(): void {
	if (subscribed || typeof window === "undefined" || typeof window.omp?.prefs?.get !== "function") return;
	subscribed = true;
	void useTerminalCommandsStore.getState().load();
	window.omp.prefs.onChanged?.(event => {
		if (event.key === TERMINAL_COMMANDS_PREF) void useTerminalCommandsStore.getState().load();
	});
}
