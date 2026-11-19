/**
 * Settings › Appearance › Theme: the five sets as cards, each previewing its light and its dark half, and under
 * them whether the chosen set follows the OS or stays on its light or dark half. Every choice applies at once.
 */

import { SunMoon } from "lucide-react";
import { useEffect, useState } from "react";
import { THEME_SETS, type ThemeSet } from "../../../shared/theme-names";
import { useT } from "../../lib/i18n";
import type { ThemeMode } from "../../lib/theme";
import {
	applyThemeSet,
	getPersistedThemeSelection,
	resolveTokenColor,
	THEMES,
	type ThemeDefinition,
	type ThemeSetChoice,
	themeSetChoice,
} from "../../lib/themes";
import { useUiStore } from "../../stores/ui";
import { ChoiceCards, SegmentedChoice } from "../common";
import { SettingsRow } from "./SettingsLayout";

/**
 * A theme drawn in its own colors: sidebar strip, a text line and the accent, and a line of
 * code as bars in its syntax colors. Decorative; the card carries the name.
 */
export function ThemePreview({ theme }: { theme: ThemeDefinition }) {
	const color = (key: Parameters<typeof resolveTokenColor>[1]) => resolveTokenColor(theme, key);
	return (
		<span
			aria-hidden
			className="flex h-full w-full overflow-hidden"
			data-theme-preview={theme.label}
			style={{ background: color("--omp-bg-primary") }}
		>
			<span
				className="h-full w-1/5 shrink-0"
				style={{ background: color("--omp-sidebar-bg"), borderRight: `1px solid ${color("--omp-border")}` }}
			/>
			<span className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 px-2">
				<span className="flex items-center gap-1.5">
					<span className="h-1 w-1/2 rounded-(--sc-radius-full)" style={{ background: color("--omp-text") }} />
					<span className="h-1.5 w-1/4 rounded-(--sc-radius-full)" style={{ background: color("--omp-accent") }} />
				</span>
				<span className="h-1 w-2/3 rounded-(--sc-radius-full)" style={{ background: color("--omp-muted") }} />
				{/* A line of code as syntax-colored runs: they scale with the swatch, so a half-width preview never cuts text. */}
				<span
					className="flex h-3 items-center gap-0.5 overflow-hidden rounded-(--sc-radius-sm) px-1"
					style={{ background: color("--omp-code-bg") }}
				>
					{(
						[
							["--omp-syntax-keyword", 2],
							["--omp-syntax-function", 3],
							["--omp-syntax-string", 4],
							["--omp-syntax-number", 2],
						] as const
					).map(([token, weight]) => (
						<span
							className="h-1 min-w-0 rounded-(--sc-radius-full)"
							key={token}
							style={{ background: color(token), flex: weight }}
						/>
					))}
				</span>
			</span>
		</span>
	);
}

/** A set drawn as its two halves side by side, the light one first. */
export function ThemeSetPreview({ set }: { set: ThemeSet }) {
	return (
		<>
			<span className="w-1/2 overflow-hidden">
				<ThemePreview theme={THEMES[set.light]} />
			</span>
			<span className="w-1/2 overflow-hidden">
				<ThemePreview theme={THEMES[set.dark]} />
			</span>
		</>
	);
}

const MODES: readonly ThemeMode[] = ["system", "light", "dark"];

/** Theme choice: one radio per set, and one of follow the OS, light or dark for the set chosen. A choice applies at once. */
export function ThemePicker() {
	const t = useT();
	const [choice, setChoice] = useState<ThemeSetChoice | null>(null);

	useEffect(() => {
		let cancelled = false;
		void getPersistedThemeSelection().then(selection => {
			// A read sent before a click answers with the prefs from before it: the choice wins.
			if (!cancelled) setChoice(chosen => chosen ?? themeSetChoice(selection));
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// Until the stored choice is read, the store's scheme is the mode (no segment flashes) and the System pair names the set.
	const uiTheme = useUiStore(state => state.theme);
	const mode = choice?.mode ?? uiTheme;
	const choose = (next: Partial<ThemeSetChoice>) => {
		const chosen = { set: choice?.set ?? themeSetChoice("system").set, mode, ...next };
		applyThemeSet(chosen);
		useUiStore.getState().setTheme(chosen.mode);
		setChoice(chosen);
	};

	return (
		<>
			<div className="scroll-mt-4 py-2" data-setting-row="true" id="setting-gui-theme">
				<ChoiceCards
					aria-label={t("settings.gui.theme")}
					className="settings-theme-grid"
					onChange={set => choose({ set })}
					optionAttr="data-theme-set"
					options={THEME_SETS.map(set => ({
						value: set.id,
						title: t(`themePicker.set.${set.id}.label`),
						preview: <ThemeSetPreview set={set} />,
						tooltip: t(`themePicker.set.${set.id}.description`),
					}))}
					value={choice?.set ?? null}
				/>
			</div>
			<SettingsRow
				control={
					<SegmentedChoice
						aria-label={t("themePicker.mode")}
						onChange={next => choose({ mode: next })}
						optionAttr="data-theme-mode"
						options={MODES.map(value => ({ value, label: t(`themePicker.mode.${value}`) }))}
						value={mode}
					/>
				}
				icon={<SunMoon />}
				id="setting-gui-themeMode"
				label={t("themePicker.mode")}
			/>
		</>
	);
}
