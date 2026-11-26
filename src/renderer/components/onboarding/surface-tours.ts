/**
 * First-visit tours (Orca's contextual tours, FG59: renderer/src/components/contextual-tours/contextual-tour-gate.ts:83
 * `getContextualTourStartStepIndex`, shared/feature-education/contextual-tours/contextual-tours.ts:62): each surface's
 * steps name the real controls they point at; a step whose control is not on screen is skipped, and a tour starts only
 * when one of its controls is. It starts once, the first time its surface is shown, never during first-run or machine
 * setup or while another tour runs, and is marked seen when it ends however it ends (Next to the end, Skip, Escape, a
 * click outside). Copy: `tour.<surface>.<step>.title` / `.body`. The card is `SurfaceTour.tsx` (its own chunk).
 */

import { useEffect } from "react";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { type SurfaceTourId, useStarterGuideStore } from "../../stores/starter-guide";
import { useFirstRunActive } from "./FirstRunSlot";
import { measureTarget } from "./Spotlight";

export interface SurfaceTourStep {
	id: string;
	/** Where the step's control lives; the first one on screen wins. */
	targets: readonly string[];
}

export const SURFACE_TOUR_STEPS: Record<SurfaceTourId, readonly SurfaceTourStep[]> = {
	shell: [
		{ id: "nav", targets: ["[data-sidebar-nav]"] },
		{ id: "search", targets: ["[data-command-center-entry]"] },
		{ id: "sessions", targets: ['[data-tour="sessions"]'] },
		{ id: "status", targets: ["[data-status-bar]"] },
		{ id: "panel", targets: ['[data-tour="panel"]'] },
	],
	board: [
		{ id: "lanes", targets: ["[data-board-lanes]", "[data-board-inbox]"] },
		{ id: "chips", targets: ["[data-board-chips]"] },
		{ id: "window", targets: ["[data-board-window]"] },
	],
	stats: [
		{ id: "sections", targets: ["[data-stats-nav]"] },
		{ id: "daily", targets: ["[data-stats-daily]"] },
	],
	schedules: [
		{ id: "new", targets: ["[data-schedule-new]"] },
		{ id: "view", targets: ["[data-schedules-view]"] },
	],
	preview: [
		{ id: "page", targets: ["[data-preview-surface]"] },
		{ id: "status", targets: ["[data-preview-status]"] },
	],
};

/** How long a surface lays out before its tour looks for its controls. */
const SETTLE_MS = 600;

/** Starts `id`'s tour the first time its surface is on screen (`ready`), once. */
export function useFirstVisitTour(id: SurfaceTourId, ready = true): void {
	const loaded = useStarterGuideStore(state => state.loaded);
	const seen = useStarterGuideStore(state => state.toursSeen.includes(id));
	const busy = useStarterGuideStore(state => state.tour !== null || state.surfaceTour !== null);
	const firstRun = useFirstRunActive();
	const takeover = useMachineSetupStore(state => state.takeover);

	useEffect(() => {
		void useStarterGuideStore.getState().load();
	}, []);

	useEffect(() => {
		if (!ready || !loaded || seen || busy || firstRun || takeover) return;
		const timer = setTimeout(() => {
			const guide = useStarterGuideStore.getState();
			if (guide.tour || guide.surfaceTour || guide.toursSeen.includes(id)) return;
			if (SURFACE_TOUR_STEPS[id].some(step => measureTarget(step.targets))) guide.startSurfaceTour(id);
		}, SETTLE_MS);
		return () => clearTimeout(timer);
	}, [id, ready, loaded, seen, busy, firstRun, takeover]);

	// A surface that leaves (another page opens over it, it unmounts) ends its tour, so the card never points at
	// controls that are gone or keeps the Escape the page in front of it is waiting for.
	useEffect(() => {
		if (!ready) return;
		return () => {
			const guide = useStarterGuideStore.getState();
			if (guide.surfaceTour?.id === id) guide.endSurfaceTour();
		};
	}, [id, ready]);
}
