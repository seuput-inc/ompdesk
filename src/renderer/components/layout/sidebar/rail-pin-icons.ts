/** The lucide glyph of each pinned sidebar shortcut: the sidebar's footer rows and the Customize sidebar sheet share it. */
import { Files, Gauge, GitCompareArrows, Globe, Hourglass, type LucideIcon, Terminal } from "lucide-react";
import type { FooterPin } from "../../../../shared/sidebar-prefs";

export const RAIL_PIN_ICONS: Record<FooterPin, LucideIcon> = {
	usage: Gauge,
	terminal: Terminal,
	diff: GitCompareArrows,
	preview: Globe,
	files: Files,
	jobs: Hourglass,
};
