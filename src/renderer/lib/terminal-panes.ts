/**
 * Which terminals the Terminal panel shows: one, or two side by side or stacked (Orca's pane split, FT9/FM58, kept
 * to two panes in the side panel), and which of them has the keyboard. The tab strip picks the terminal of the pane
 * in focus; a terminal already in a pane only takes the focus.
 */
export type SplitDirection = "right" | "down";

export interface TerminalPanes {
	/** One id, or two when split; the first is the left or top pane. */
	panes: string[];
	/** The pane in focus: the one the tab strip, the toolbar and the key bar act on. */
	focus: number;
	direction: SplitDirection;
}

export const NO_PANES: TerminalPanes = { panes: [], focus: 0, direction: "right" };

export function focusedTerminal(layout: TerminalPanes): string | null {
	return layout.panes[layout.focus] ?? null;
}

/** Show `id`: focus its pane, or put it in the pane in focus. Null shows nothing. */
export function pickTerminal(layout: TerminalPanes, id: string | null): TerminalPanes {
	if (id === null) return NO_PANES;
	const at = layout.panes.indexOf(id);
	if (at >= 0) return at === layout.focus ? layout : { ...layout, focus: at };
	if (layout.panes.length === 0) return { ...layout, panes: [id], focus: 0 };
	const panes = [...layout.panes];
	panes[layout.focus] = id;
	return { ...layout, panes };
}

/** `id` (a new terminal) beside the pane in focus, which then gives it the focus; a split panel replaces its other pane. */
export function splitTerminal(layout: TerminalPanes, id: string, direction: SplitDirection): TerminalPanes {
	const kept = focusedTerminal(layout);
	return kept === null ? { panes: [id], focus: 0, direction } : { panes: [kept, id], focus: 1, direction };
}

export function unsplit(layout: TerminalPanes): TerminalPanes {
	const kept = focusedTerminal(layout);
	return kept === null ? NO_PANES : { ...layout, panes: [kept], focus: 0 };
}

/**
 * `layout` after `closed` went, `listed` being the terminals left in order: its pane goes and the other one takes the
 * focus; a panel left with no pane shows `fallback` (the terminal that took the closed tab's place).
 */
export function closeTerminal(
	layout: TerminalPanes,
	closed: string,
	listed: readonly string[],
	fallback: string | null,
): TerminalPanes {
	const panes = layout.panes.filter(id => id !== closed && listed.includes(id));
	if (panes.length === layout.panes.length) return layout;
	if (panes.length > 0) return { ...layout, panes, focus: 0 };
	return fallback === null ? NO_PANES : { ...layout, panes: [fallback], focus: 0 };
}
