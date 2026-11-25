/**
 * The docked sidebar's width, remembered where the first paint can read it. The `sidebarWidth` pref arrives over IPC
 * after the first frame, so the shell would paint the default and jump; this mirror (localStorage, written wherever
 * the pref is read or changed) lets the sidebar start at its width and pre-paint.js set `--boot-sidebar-w` for the
 * boot shell (src/shared/boot-shell-geometry.ts).
 */
import { SIDEBAR_WIDTH, SIDEBAR_WIDTH_STORAGE_KEY } from "../../shared/boot-shell-geometry";

/**
 * Below this docked width the rows lead without their 16 px status lane (sidebar.css `data-sidebar-narrow`): with it,
 * a branch's eight-character floor no longer fits its line. Measured on the harness's `…/settings-panel-dark`: the
 * line is the sidebar less 152 px, the floor needs 78 px on macOS (230 px) and 76 px on Windows (228 px); 2 px spare.
 */
export const LANE_MIN_SIDEBAR_WIDTH = 232;

export const clampSidebarWidth = (value: number): number =>
	Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, value));

export function readSidebarWidth(): number {
	try {
		const value = Number.parseFloat(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? "");
		return Number.isFinite(value) ? clampSidebarWidth(value) : SIDEBAR_WIDTH.default;
	} catch {
		return SIDEBAR_WIDTH.default;
	}
}

export function writeSidebarWidth(width: number): void {
	try {
		localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
	} catch {
		// No storage: the next start paints the default width.
	}
}
