/**
 * `parseXdTarget` (`src/renderer/lib/xdev.ts`) copies stock pi-tui `tools/xd-url` `parseXdUrl`, because the renderer
 * reads a write's `xd://` target with no omp to ask. The installed omp's function answers the same paths here.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseXdTarget } from "../renderer/lib/xdev";
import { runStock, stockSource } from "./test-bridge-probe";

const xdUrl = stockSource("pi-tui", path.join("tools", "xd-url.ts"));

const PATHS = [
	"xd://security_scan",
	"  XD://lsp ",
	"Xd://mcp__docs_search",
	"xd://",
	" xd:// ",
	"xd://lsp/document/symbol",
	"xd://lsp?raw",
	"xd://lsp#top",
	"xd://lsp:raw",
	"xd:/lsp",
	"xd_lsp",
	"https://example.com",
	"src/xd://lsp",
	"src/app.ts",
	"",
];

describe.skipIf(!xdUrl)("xd:// targets against the installed stock parseXdUrl", () => {
	it("names the device stock names, and no device where stock finds none", () => {
		const stock = runStock<Array<string | null>>(
			`const { parseXdUrl } = await import(${JSON.stringify(xdUrl)});
			console.log(JSON.stringify(${JSON.stringify(PATHS)}.map(p => parseXdUrl(p)?.name ?? null)));`,
		);
		expect(PATHS.map(parseXdTarget)).toEqual(stock);
		expect(stock).toContain("security_scan");
	}, 90_000);
});
