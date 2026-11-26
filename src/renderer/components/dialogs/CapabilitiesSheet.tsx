/**
 * Help › "What OMPdesk can do" (Orca's feature wall, FG57: renderer/src/components/feature-wall/FeatureWallModal.tsx,
 * FeatureWallTourSurface.tsx, setup/FeatureWallSetupChecklist.tsx): one right sheet listing what the app adds around
 * omp, each with one line, "In use" where the app knows it is (a split used, a look picked, the pet on), and the one
 * action that shows it: "Show me" spotlights the real control (the getting-started tour), "Open" goes to the place,
 * whose own first-visit tour then explains it. Orca's animated storyboards, its setup checklist of agent hooks and its
 * telemetry are not ported: OMPdesk sets those parts up itself (machine setup) or has no such part.
 * A phone's page lists only what a phone can open.
 */

import {
	BarChart3,
	Brain,
	CalendarClock,
	Columns2,
	Columns3,
	Globe,
	type LucideIcon,
	Palette,
	PawPrint,
	Smartphone,
	SquareTerminal,
} from "lucide-react";
import { useT } from "../../lib/i18n";
import { type StarterStep, useStarterGuideStore } from "../../stores/starter-guide";
import { useUiStore } from "../../stores/ui";
import { webRuntime } from "../../web/runtime";
import { Badge, Button, ListRow, Sheet } from "../common";
import { usePetPrefs } from "../pet/pet-prefs";

interface Capability {
	id: string;
	icon: LucideIcon;
	/** Its getting-started step: done means in use, and "Show me" runs that step's spotlight. */
	step?: StarterStep;
	/** What "Open" does (ui store actions). */
	open?: () => void;
	desktopOnly?: true;
}

const ui = () => useUiStore.getState();

export const CAPABILITIES: readonly Capability[] = [
	{ id: "parallel", icon: Columns2, step: "split" },
	{ id: "board", icon: Columns3, open: () => ui().openBoard() },
	{ id: "preview", icon: Globe, open: () => ui().setPanelTab("preview") },
	{ id: "schedules", icon: CalendarClock, open: () => ui().openSettings("schedules") },
	{ id: "memory", icon: Brain, open: () => ui().openSettings("memory") },
	{ id: "phone", icon: Smartphone, open: () => ui().openSettings("connections:mobile-web"), desktopOnly: true },
	{ id: "stats", icon: BarChart3, open: () => ui().openInsights("stats", "all") },
	{ id: "cli", icon: SquareTerminal, open: () => ui().setPanelTab("terminal"), desktopOnly: true },
	{ id: "look", icon: Palette, step: "look", open: () => ui().openThemePicker() },
	{ id: "pet", icon: PawPrint, open: () => ui().openSettings("appearance"), desktopOnly: true },
];

export function CapabilitiesSheet() {
	const t = useT();
	const open = useUiStore(state => state.capabilitiesOpen);
	const close = useUiStore(state => state.closeCapabilities);
	const done = useStarterGuideStore(state => state.done);
	const petOn = usePetPrefs(state => state.enabled);
	const onPhone = webRuntime() !== null;

	return (
		<Sheet
			description={t("capabilities.description")}
			kind="capabilities"
			onClose={close}
			open={open}
			size="md"
			title={t("capabilities.title")}
		>
			<ul className="flex flex-col gap-0.5" data-capabilities>
				{CAPABILITIES.filter(item => !(onPhone && item.desktopOnly)).map(item => {
					const Icon = item.icon;
					const inUse = (item.step !== undefined && done.includes(item.step)) || (item.id === "pet" && petOn);
					const run = () => {
						close();
						if (item.open) item.open();
						else if (item.step) useStarterGuideStore.getState().startTour(item.step);
					};
					return (
						<li data-capability={item.id} key={item.id}>
							<ListRow
								actions={
									<Button onClick={run} size="sm" variant="secondary">
										{t(item.open ? "capabilities.open" : "capabilities.showMe")}
									</Button>
								}
								actionsAtRest
								description={t(`capabilities.${item.id}.body`)}
								descriptionLines={2}
								leading={<Icon aria-hidden className="size-4 text-(--sc-text-muted)" />}
								meta={inUse ? <Badge variant="success">{t("capabilities.inUse")}</Badge> : undefined}
								title={t(`capabilities.${item.id}.title`)}
							/>
						</li>
					);
				})}
			</ul>
		</Sheet>
	);
}
