/**
 * File paths in a terminal's output as links (Orca `terminal-pane/links/files/*`, after VS Code's local link
 * detector): the same path grammar replies use (`markdown-paths.ts` `prosePaths`), only paths the tab's computer has
 * (checked once per path, `verifyPath`), opened with ⌘-click (Ctrl-click on Windows) as a terminal's links are, a file
 * in the Files viewer at its line, a folder in the Files tree. A relative path is the tab's folder's, not the shell's
 * current one (shortcut: the panel does not track the shell's folder; resolve against it once it does).
 */
import type { IBufferLine, ILink, ILinkProvider } from "@xterm/xterm";
import { prosePaths } from "./markdown-paths";

/** Where each UTF-16 unit of the line's text sits on screen: a wide character takes two cells, its text one. */
function cellColumns(line: IBufferLine, length: number): { text: string; columns: number[] } {
	let text = "";
	const columns: number[] = [];
	for (let x = 0; x < length; x += 1) {
		const cell = line.getCell(x);
		if (!cell || cell.getWidth() === 0) continue;
		const chars = cell.getChars() || " ";
		for (let unit = 0; unit < chars.length; unit += 1) columns.push(x);
		text += chars;
	}
	return { text, columns };
}

/** The paths on one screen line, as xterm ranges (1-based, the end inclusive). */
export function pathLinksOn(
	line: IBufferLine,
	cols: number,
	y: number,
): Array<{ range: ILink["range"]; text: string; path: string; line?: number }> {
	const { text, columns } = cellColumns(line, cols);
	return prosePaths(text).map(({ start, end, mention }) => ({
		range: { start: { x: (columns[start] ?? 0) + 1, y }, end: { x: (columns[end - 1] ?? 0) + 1, y } },
		text: text.slice(start, end),
		path: mention.path,
		...(mention.line ? { line: mention.line } : {}),
	}));
}

/** ⌘ on macOS, Ctrl elsewhere: a plain click in a terminal selects text. */
export function isLinkClick(event: Pick<MouseEvent, "metaKey" | "ctrlKey">, mac: boolean): boolean {
	return mac ? event.metaKey : event.ctrlKey;
}

export function pathLinkProvider(deps: {
	buffer: () => { getLine(y: number): IBufferLine | undefined } | undefined;
	cols: () => number;
	exists: (path: string) => Promise<boolean>;
	open: (event: MouseEvent, path: string, line?: number) => void;
}): ILinkProvider {
	return {
		provideLinks(y, callback) {
			const line = deps.buffer()?.getLine(y - 1);
			const found = line ? pathLinksOn(line, deps.cols(), y) : [];
			if (found.length === 0) {
				callback(undefined);
				return;
			}
			void Promise.all(found.map(link => deps.exists(link.path).catch(() => false))).then(present => {
				const links = found
					.filter((_, index) => present[index])
					.map(
						(link): ILink => ({
							range: link.range,
							text: link.text,
							decorations: { pointerCursor: true, underline: true },
							activate: event => deps.open(event, link.path, link.line),
						}),
					);
				callback(links.length ? links : undefined);
			});
		},
	};
}
