/**
 * The session MODES of the composer's one Run chip (`RunChip`): Goal and Autopilot, each with its inline config. This
 * file owns the Mode section of the Run popover (`ModesSection`), what the chip says about the modes
 * (`useComposerModes`: accent = active mode), and the conditional chip that sits beside the Run chip while it applies
 * (`ComposerModeExtras`: Autopilot's "show the run" button). Run behavior (thinking, approval, toggles) is in
 * `RunSettings`; model roles live in Settings › Models.
 *
 * `useUiStore.openModes(tab)` — palette commands, the goal dock, Settings › Features — opens the Run popover on
 * that mode in the focused pane (`RunChip` answers it); closing it clears the request.
 */

import { LayoutDashboard, Rocket, Target } from "lucide-react";
import type { ReactNode } from "react";
import { useDisplayPreference } from "../../../lib/display-preferences";
import { useT } from "../../../lib/i18n";
import { isLiveAutopilot, useAutopilotStore } from "../../../stores/autopilot";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useUiStore } from "../../../stores/ui";
import { useAutopilotStateText } from "../../autopilot/use-autopilot-state-text";
import { IconButton, SectionLabel, Tabs } from "../../common";
import { AutopilotModeConfig } from "../../modes/AutopilotConfig";
import { GoalModeConfig } from "../../modes/ModeConfig";

export type ComposerModeId = "goal" | "autopilot";

export const MODE_IDS: readonly ComposerModeId[] = ["goal", "autopilot"];

export const MODE_ICONS: Record<ComposerModeId, ReactNode> = {
	goal: <Target aria-hidden />,
	autopilot: <Rocket aria-hidden />,
};

export interface ComposerModesView {
	active: Record<ComposerModeId, boolean>;
	/** The modes the chip names, in tab order (a Goal hidden from the footer by its preference is left out). */
	shown: ComposerModeId[];
	/** The chip's text for the shown modes ("Goal"); `null` with none. */
	summary: string | null;
	/** The shown modes spelled for the chip's accessible name ("Goal mode"); `null` with none. */
	fullName: string | null;
}

/** What the composer says about the session's modes; the Run chip paints and names itself from it. */
export function useComposerModes(): ComposerModesView {
	const t = useT();
	// An Autopilot run is a Goal underneath: it shows as Autopilot, never as the user's Goal.
	const autopilotLive = useAutopilotStore(isLiveAutopilot);
	// A paused goal is still the session's goal.
	const goalActive =
		useSessionStore(s => s.goalState?.status === "active" || s.goalState?.status === "paused" || !!s.goal) &&
		!autopilotLive;
	const goalStatusInFooter = useDisplayPreference("goalStatusInFooter");
	const autopilotState = useAutopilotStateText();

	const active: Record<ComposerModeId, boolean> = {
		goal: goalActive,
		autopilot: autopilotLive,
	};
	const shown = MODE_IDS.filter(mode => active[mode] && (mode !== "goal" || goalStatusInFooter));
	const named = (mode: ComposerModeId, key: "tab" | "name") =>
		mode === "autopilot" && autopilotState
			? `${t(`input.modes.${key}.autopilot`)} · ${autopilotState}`
			: t(`input.modes.${key}.${mode}`);
	return {
		active,
		shown,
		summary: shown.length > 0 ? shown.map(mode => named(mode, "tab")).join(" · ") : null,
		fullName: shown.length > 0 ? shown.map(mode => named(mode, "name")).join(" · ") : null,
	};
}

/**
 * The popover's Mode section: a tab per mode (Goal, Autopilot) and the selected one's config. `tab` is controlled so
 * `openModes(tab)` and the chip's first-active-mode default can pick it; with none (`null`) no tab is selected and the
 * section stays short (a Goal form open by default made the popover scroll in an ordinary window).
 */
export function ModesSection({
	active,
	tab,
	onTabChange,
	onClose,
}: {
	active: Record<ComposerModeId, boolean>;
	tab: ComposerModeId | null;
	onTabChange: (tab: ComposerModeId) => void;
	/** Closes the Run popover (Autopilot's Start leaves it). */
	onClose: () => void;
}) {
	const t = useT();
	return (
		<section
			aria-label={t("input.modes.label")}
			className="flex flex-col gap-2 break-keep"
			data-composer-modes-section
		>
			<SectionLabel>{t("input.modes.label")}</SectionLabel>
			<Tabs
				activeId={tab ?? ""}
				ariaLabel={t("input.modes.formsLabel")}
				className="w-full *:flex-1 *:justify-center"
				compact
				onChange={id => onTabChange(id as ComposerModeId)}
				tabs={MODE_IDS.map(mode => ({
					id: mode,
					label: t(`input.modes.tab.${mode}`),
					badge: active[mode] ? t("modesPanel.on") : undefined,
				}))}
			/>
			{tab && (
				<div className="min-h-0">
					{tab === "goal" && <GoalModeConfig />}
					{tab === "autopilot" && <AutopilotModeConfig onStarted={onClose} />}
				</div>
			)}
		</section>
	);
}

/**
 * Autopilot's "show the run" button beside the Run chip. The run is shown on this pane's work board (docked, or its
 * strip expanded), never in the side panel. While the docked board shows the run's section open and in view it
 * already shows the run beside the composer, so the button gives way there (components.css, the pane's
 * `data-work-board-run-shown`, set by the board); the Mode tab's own button stays.
 */
export function ComposerModeExtras() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const autopilotLive = useAutopilotStore(isLiveAutopilot);
	if (!autopilotLive) return null;
	return (
		<IconButton
			className="omp-composer-chip"
			data-autopilot-chip-open
			icon={<LayoutDashboard />}
			label={t("autopilot.chip.open")}
			onClick={() => useUiStore.getState().revealWorkBoard(tabId)}
			size="sm"
		/>
	);
}
