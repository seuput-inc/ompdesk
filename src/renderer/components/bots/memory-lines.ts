/**
 * One memory upkeep's changes to MEMORY.md, line by line, and the Undo of each (Orca's memory History rows,
 * `shared/bots/bot-memory-history.ts`: each change's added and removed lines with its own Undo). The upkeep keeps a
 * copy of MEMORY.md from before it (`memory/history/<stamp>.md`); what that copy has and the file lacks was taken out,
 * what the file has and the copy lacks was put in.
 */

export interface MemoryLineChange {
	kind: "added" | "removed";
	line: string;
}

const lines = (text: string): string[] => text.split("\n").filter(line => line.trim() !== "");

/** The lines the upkeep took out of MEMORY.md and the ones it put in, in file order. */
export function memoryLineChanges(before: string, after: string): MemoryLineChange[] {
	const old = new Set(lines(before));
	const now = new Set(lines(after));
	return [
		...lines(before)
			.filter(line => !now.has(line))
			.map((line): MemoryLineChange => ({ kind: "removed", line })),
		...lines(after)
			.filter(line => !old.has(line))
			.map((line): MemoryLineChange => ({ kind: "added", line })),
	];
}

/**
 * MEMORY.md with one change undone: a line taken out goes back after the nearest line above it in the copy that is
 * still there (else first); a line put in comes out. Every other line stays as it is now.
 */
export function undoMemoryLine(current: string, before: string, change: MemoryLineChange): string {
	const rows = current.split("\n");
	if (change.kind === "added") {
		const at = rows.indexOf(change.line);
		return at < 0 ? current : [...rows.slice(0, at), ...rows.slice(at + 1)].join("\n");
	}
	if (rows.includes(change.line)) return current;
	const copy = before.split("\n");
	const from = copy.indexOf(change.line);
	for (let index = from - 1; index >= 0; index -= 1) {
		const anchor = copy[index];
		if (anchor === undefined || anchor.trim() === "") continue;
		const at = rows.indexOf(anchor);
		if (at >= 0) return [...rows.slice(0, at + 1), change.line, ...rows.slice(at + 1)].join("\n");
	}
	return [change.line, ...rows].join("\n");
}
