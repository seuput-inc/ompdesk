import type { IBufferLine, ILink } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { pathLinkProvider, pathLinksOn } from "./terminal-links";

/** A screen line as xterm holds it: one cell per column, a wide character's second cell empty (width 0). */
function line(cells: Array<[chars: string, width: number]>): IBufferLine {
	return {
		length: cells.length,
		getCell: (x: number) => {
			const cell = cells[x];
			return cell ? { getChars: () => cell[0], getWidth: () => cell[1] } : undefined;
		},
	} as unknown as IBufferLine;
}
const ascii = (text: string) => line([...text].map((char): [string, number] => [char, 1]));

describe("terminal path links", () => {
	it("finds a path with its line in compiler output and places it on the screen's columns, wide characters included", () => {
		expect(pathLinksOn(ascii("error at src/main.rs:12:5 here"), 30, 3)).toEqual([
			{
				range: { start: { x: 10, y: 3 }, end: { x: 25, y: 3 } },
				text: "src/main.rs:12:5",
				path: "src/main.rs",
				line: 12,
			},
		]);
		// 한 takes two cells, so the path starts one column later than its text index.
		const wide = line([["한", 2], ["", 0], [" ", 1], ...[..."a/b.ts"].map((char): [string, number] => [char, 1])]);
		expect(pathLinksOn(wide, 9, 1)[0]?.range).toEqual({ start: { x: 4, y: 1 }, end: { x: 9, y: 1 } });
	});
	it("links only paths the tab's computer has, and hands a link's click to the opener with its line", async () => {
		const open = vi.fn();
		const provider = pathLinkProvider({
			buffer: () => ({ getLine: () => ascii("cat ./gone.txt ./here.txt") }),
			cols: () => 25,
			exists: async path => path === "./here.txt",
			open,
		});
		const { promise, resolve } = Promise.withResolvers<ILink[] | undefined>();
		provider.provideLinks(1, resolve);
		const links = await promise;
		expect(links?.map(link => link.text)).toEqual(["./here.txt"]);
		const click = { metaKey: true, ctrlKey: false } as MouseEvent;
		links?.[0]?.activate(click, "./here.txt");
		expect(open).toHaveBeenCalledWith(click, "./here.txt", undefined);
	});
});
