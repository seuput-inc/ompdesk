/**
 * The commit graph's lanes for one page of the log (FR86), newest commit first: each row says which column its dot
 * sits in and which lines cross it. A lane is a commit still to come (a parent of a row above); a commit takes the
 * first lane that waits for it, or a new one on the right, and hands that lane to its first parent; a merge opens a
 * lane per other parent. A parent past the page keeps its lane open to the last row, and the next page continues it.
 * Ported from Orca's swimlanes, `src/shared/git/history/git-history-graph.ts:116-193` (`appendGitHistoryViewModels`)
 * and the edges `src/renderer/src/components/right-sidebar/source-control/sync/git-history-graph-svg.tsx:56-167`
 * draws, without ref colours.
 */

export interface GraphRow {
	/** The column of this commit's dot. */
	lane: number;
	/** Columns whose line runs from the row's top into the dot: the lanes that waited for this commit. */
	into: number[];
	/** Lines across the whole row: from a column at the top to the column that lane takes at the bottom. */
	through: [from: number, to: number][];
	/** Columns the dot's lines run down to: the parents' lanes at the row's bottom. */
	out: number[];
	/** Columns the row draws. */
	width: number;
	/** Two or more parents. */
	merge: boolean;
}

export function graphLanes(commits: readonly { sha: string; parents: readonly string[] }[]): GraphRow[] {
	let waiting: string[] = [];
	return commits.map(({ sha, parents }) => {
		const [first, ...others] = parents;
		const found = waiting.indexOf(sha);
		const lane = found === -1 ? waiting.length : found;
		const next: string[] = [];
		const into: number[] = [];
		const through: [number, number][] = [];
		waiting.forEach((id, column) => {
			if (id !== sha) {
				through.push([column, next.length]);
				next.push(id);
				return;
			}
			into.push(column);
			// The first lane that waited takes the first parent; any other lane for this commit ends here.
			if (column === lane && first !== undefined) next.push(first);
		});
		const out: number[] = [];
		if (first !== undefined) {
			if (found === -1) next.push(first);
			out.push(lane);
		}
		for (const parent of others) {
			out.push(next.length);
			next.push(parent);
		}
		const width = Math.max(waiting.length, next.length, lane + 1);
		waiting = next;
		return { lane, into, through, out, width, merge: parents.length > 1 };
	});
}
