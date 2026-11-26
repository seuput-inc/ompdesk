import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import geometry from "./boot-shell-geometry.json" with { type: "json" };

// The Tauri host paints the boot shell natively from boot-shell-geometry.json (boot_paint.rs) before WebView2 has
// started; these are the stylesheet values it repeats, so a CSS change that moves the web shell fails here instead of
// making the native frame jump when the page replaces it.
const styles = join(__dirname, "../renderer/styles");
const css = (file: string) => readFileSync(join(styles, file), "utf8");
const px = (file: string, name: string, last = false) => {
	const values = [...css(file).matchAll(new RegExp(`${name}:\\s*([\\d.]+)(px|rem);`, "g"))];
	const match = last ? values.at(-1) : values[0];
	if (!match) throw new Error(`${name} not found in ${file}`);
	return Number(match[1]) * (match[2] === "rem" ? 16 : 1);
};

describe("boot-shell-geometry.json", () => {
	it("repeats the desktop layout's stylesheet values", () => {
		expect(geometry.topbarPx).toBe(px("tokens.css", "--sc-topbar-h"));
		expect(geometry.composerRadiusPx).toBe(px("tokens.css", "--sc-radius-xl"));
		expect(geometry.scrollbarPx).toBe(px("global.css", "--omp-scrollbar-size"));
		// The transcript column wins the cascade: the later of the two .omp-workspace-main blocks.
		expect(geometry.columnReadingPx).toBe(px("components.css", "--omp-column-reading", true));
		expect(css("components.css")).toContain(
			`--omp-column-pad: clamp(var(--sc-space-4), ${geometry.columnPadPx.share * 100}cqw, var(--sc-space-10));`,
		);
		expect(geometry.columnPadPx.min).toBe(px("tokens.css", "--sc-space-4"));
		expect(geometry.columnPadPx.max).toBe(px("tokens.css", "--sc-space-10"));
	});

	it("repeats the boot shell's own spacing around the composer", () => {
		const shell = readFileSync(join(__dirname, "../../scripts/boot-shell.ts"), "utf8");
		// The empty region over the composer is pt-2 (8px), the composer's own region pb-3 (12px).
		expect(shell).toContain('omp-composer-region relative shrink-0 bg-transparent pt-2"');
		expect(geometry.composerGapPx).toBe(8);
		expect(shell).toContain('omp-composer-region relative shrink-0 bg-transparent pb-3"');
		expect(geometry.composerBottomPx).toBe(12);
		expect(shell).toContain(`width="${geometry.markPx}" height="${geometry.markPx}"`);
	});
});
