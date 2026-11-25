/**
 * Every foreground/background pair a theme must hold, with its WCAG 2 floor:
 * text (body, secondary, muted, dim, links, status colors, syntax, diff lines,
 * the terminal's ANSI 16, button labels) 4.5:1 on the surfaces it is drawn on,
 * 7:1 in the High Contrast themes; interface boundaries (input outlines, the
 * focus ring, chart series, the accent as a graphic) 3:1. Read by
 * themes.contrast.test.ts, which fails under a floor, and by the audit script
 * that prints the worst pairs.
 */

import { contrastRatio, flatten, mix, withAlpha } from "./theme-color";
import { resolveTokenColor, type ThemeDefinition, type ThemeName, type ThemeTokenKey } from "./themes";

export const AA_TEXT = 4.5;
export const AAA_TEXT = 7;
export const UI_BOUNDARY = 3;
/** How far a waiting session's attention-colored title on the sidebar's selected row leans toward the text color. */
export const SELECTED_ATTENTION_MIX = 0.2;
/** How far a status color drawn as text on its own soft wash (`--sc-*-on-soft`: badges, chips) leans toward the text color. */
export const STATUS_ON_SOFT_MIX = 0.35;
/** A usage gauge's fill (usage-gauges.css): the text color's share, and warning's or danger's once it nears the limit. */
export const USAGE_PLAIN_FILL = 0.14;
export const USAGE_ALERT_FILL = 0.26;
/** An answer's reading text (`--sc-chat-text`, tokens.css): the text color's share over the page. */
export const CHAT_TEXT_MIX = 0.88;
/** An active list option's wash (common/OptionRow): the text color's share. */
export const OPTION_ACTIVE_WASH = 0.11;

/** The surfaces body text sits on. */
const TEXT_SURFACES: ThemeTokenKey[] = [
	"--omp-bg-primary",
	"--omp-bg-secondary",
	"--omp-bg-tertiary",
	"--omp-bg-elevated",
	"--omp-sidebar-bg",
	"--omp-code-bg",
];

/** A token as the page paints it over `base` (an rgba wash is composited, a var() resolved). */
function paint(theme: ThemeDefinition, key: ThemeTokenKey, base: string): string {
	return flatten(resolveTokenColor(theme, key), base);
}

function surface(theme: ThemeDefinition, key: ThemeTokenKey): string {
	return paint(theme, key, theme.tokens["--omp-bg-primary"]);
}

export interface ContrastPair {
	label: string;
	ratio: number;
	floor: number;
}

/** The text floor of a named theme: 7:1 in the High Contrast themes, AA elsewhere. */
export function textFloorFor(name: ThemeName): number {
	return name.startsWith("hc-") ? AAA_TEXT : AA_TEXT;
}

/** Every pair a theme must hold at `text` (its text floor, {@link textFloorFor}), named for the failure message. */
export function contrastPairs(theme: ThemeDefinition, text: number): ContrastPair[] {
	const out: ContrastPair[] = [];
	const add = (label: string, fg: string, bg: string, floor: number) =>
		out.push({ label: `${label} ${fg} on ${bg}`, ratio: contrastRatio(fg, bg), floor });

	for (const surfaceKey of TEXT_SURFACES) {
		const bg = surface(theme, surfaceKey);
		for (const key of [
			"--omp-text",
			"--omp-text-secondary",
			"--omp-muted",
			"--omp-dim",
			"--omp-accent",
			"--omp-md-link",
			"--omp-success",
			"--omp-warning",
			"--omp-error",
			"--omp-info",
			"--omp-attention",
		] as const) {
			add(`${key} (${surfaceKey})`, paint(theme, key, bg), bg, text);
		}
	}

	const code = surface(theme, "--omp-code-bg");
	for (const key of [
		"--omp-syntax-comment",
		"--omp-syntax-keyword",
		"--omp-syntax-function",
		"--omp-syntax-variable",
		"--omp-syntax-string",
		"--omp-syntax-number",
		"--omp-syntax-type",
		"--omp-syntax-operator",
		"--omp-syntax-punctuation",
		"--omp-md-code",
	] as const) {
		add(key, paint(theme, key, code), code, text);
	}

	// Diff lines sit on their own wash over the page and over a code block.
	for (const base of ["--omp-bg-primary", "--omp-code-bg"] as const) {
		for (const [fg, wash] of [
			["--omp-diff-added", "--omp-diff-added-bg"],
			["--omp-diff-removed", "--omp-diff-removed-bg"],
		] as const) {
			const bg = flatten(resolveTokenColor(theme, wash), surface(theme, base));
			add(`${fg} on ${wash} over ${base}`, paint(theme, fg, bg), bg, text);
		}
	}

	// Status colors on their washes (toasts, tool errors, badges).
	for (const [fg, wash] of [
		["--omp-success", "--omp-success-dim"],
		["--omp-warning", "--omp-warning-dim"],
		["--omp-error", "--omp-error-dim"],
		["--omp-info", "--omp-info-dim"],
		["--omp-attention", "--omp-attention-dim"],
		["--omp-accent", "--omp-accent-dim"],
	] as const) {
		const bg = flatten(resolveTokenColor(theme, wash), surface(theme, "--omp-bg-primary"));
		add(`${fg} on ${wash}`, paint(theme, fg, bg), bg, text);
	}

	// Filled buttons, badges and a selected line.
	add("btn-primary", surface(theme, "--omp-btn-primary-text"), surface(theme, "--omp-btn-primary-bg"), text);
	add("btn-danger", surface(theme, "--omp-btn-danger-text"), surface(theme, "--omp-btn-danger-bg"), text);
	add("badge", surface(theme, "--omp-badge-text"), surface(theme, "--omp-badge-bg"), text);
	const selected = flatten(resolveTokenColor(theme, "--omp-selection-bg"), surface(theme, "--omp-bg-primary"));
	add("text over selection", surface(theme, "--omp-text"), selected, text);
	const page = surface(theme, "--omp-bg-primary");
	add("chat body", mix(page, surface(theme, "--omp-text"), CHAT_TEXT_MIX), page, text);
	// A popover's or menu's glass (`ThemeDefinition.floating`) shows whatever is behind it: its quiet text holds over
	// the page and over the text color itself (a line of a reply under a menu).
	for (const behind of [page, surface(theme, "--omp-text")]) {
		const glass = flatten(withAlpha(surface(theme, "--omp-bg-elevated"), theme.floating), behind);
		add(`muted over a floating surface over ${behind}`, paint(theme, "--omp-muted", glass), glass, text);
	}
	// A list option under the keyboard or pointer (common/OptionRow `active`, the palette's row): Orca's cmdk row, a text
	// wash on the menu with a hairline ring; its quiet text reads at secondary there.
	const optionActive = flatten(
		withAlpha(surface(theme, "--omp-text"), OPTION_ACTIVE_WASH),
		surface(theme, "--omp-bg-elevated"),
	);
	add("secondary over an active option", paint(theme, "--omp-text-secondary", optionActive), optionActive, text);

	// The sidebar's current session sits on a 9 % text wash (global.css `--sc-sidebar-row-selected`); there its quiet
	// text reads at secondary (`--sc-text-subtle` and `--sc-text-muted` are lifted to it; muted alone fell under 4.5:1 on solarized-light) and a waiting title's attention color is mixed a fifth toward
	// the text color (`SELECTED_ATTENTION_MIX`).
	const sidebarSelected = flatten(withAlpha(surface(theme, "--omp-text"), 0.09), surface(theme, "--omp-sidebar-bg"));
	add(
		"secondary over sidebar selection",
		paint(theme, "--omp-text-secondary", sidebarSelected),
		sidebarSelected,
		text,
	);
	add(
		"waiting title over sidebar selection",
		mix(paint(theme, "--omp-attention", sidebarSelected), surface(theme, "--omp-text"), SELECTED_ATTENTION_MIX),
		sidebarSelected,
		text,
	);

	// Badges and chips: a status color as text on its own 12 % wash (`--sc-*-on-soft`), over every surface it is laid on
	// and the sidebar's selected row (a waiting session's badge sits there).
	for (const status of ["success", "warning", "error", "info", "accent", "attention"] as const) {
		for (const base of [...TEXT_SURFACES.map(key => surface(theme, key)), sidebarSelected]) {
			const bg = flatten(resolveTokenColor(theme, `--omp-${status}-dim`), base);
			add(
				`${status} badge on its wash over ${base}`,
				mix(paint(theme, `--omp-${status}`, bg), surface(theme, "--omp-text"), STATUS_ON_SOFT_MIX),
				bg,
				text,
			);
		}
	}

	// A row that waits on the person wears the attention wash (the work board); its quiet text reads at secondary there.
	for (const key of TEXT_SURFACES) {
		const bg = flatten(resolveTokenColor(theme, "--omp-attention-dim"), surface(theme, key));
		add(`secondary over an attention wash on ${key}`, paint(theme, "--omp-text-secondary", bg), bg, text);
	}

	// A usage gauge's text over its fill (usage-gauges.css): the window's name at secondary over the plain fill, and
	// everything at the text colour over a near or limit fill.
	for (const key of TEXT_SURFACES) {
		const base = surface(theme, key);
		const bg = flatten(withAlpha(surface(theme, "--omp-text"), USAGE_PLAIN_FILL), base);
		add(`secondary over a usage gauge's fill on ${key}`, paint(theme, "--omp-text-secondary", bg), bg, text);
	}
	for (const status of ["--omp-warning", "--omp-error"] as const) {
		for (const key of TEXT_SURFACES) {
			const base = surface(theme, key);
			const bg = flatten(withAlpha(paint(theme, status, base), USAGE_ALERT_FILL), base);
			add(`text over a usage gauge's ${status} fill on ${key}`, surface(theme, "--omp-text"), bg, text);
		}
	}

	// The terminal's 16 colors on its surface (--sc-surface-1 = the sidebar).
	const terminal = surface(theme, "--omp-sidebar-bg");
	for (const [index, color] of theme.ansi.entries()) add(`ansi ${index}`, color, terminal, text);

	// Interface boundaries and graphics: 3:1.
	for (const surfaceKey of [
		"--omp-bg-primary",
		"--omp-bg-secondary",
		"--omp-sidebar-bg",
		"--omp-bg-elevated",
	] as const) {
		const bg = surface(theme, surfaceKey);
		add(`border-strong (${surfaceKey})`, surface(theme, "--omp-border-strong"), bg, UI_BOUNDARY);
		add(`focus ring (${surfaceKey})`, theme.focusRing, bg, UI_BOUNDARY);
		add(`accent as graphic (${surfaceKey})`, surface(theme, "--omp-accent"), bg, UI_BOUNDARY);
		// The sidebar's ✓ and the transcript's "New" word: text, so the text floor.
		add(`unread (${surfaceKey})`, surface(theme, "--omp-unread"), bg, text);
		for (const [index, color] of theme.chart.entries())
			add(`chart ${index + 1} (${surfaceKey})`, color, bg, UI_BOUNDARY);
	}
	add("input border", surface(theme, "--omp-input-border"), surface(theme, "--omp-input-bg"), UI_BOUNDARY);
	return out;
}
