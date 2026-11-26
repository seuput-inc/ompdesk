/**
 * The card of a surface's first-visit tour (`surface-tours.ts`): one Spotlight per step whose control was on screen
 * when the tour started, with "n of m", Skip and Next (Done on the last). Escape or a click outside ends it as Skip
 * does; either way the tour is seen and never starts by itself again. Orca: contextual-tours/ContextualTourOverlay.tsx
 * (card, progress dots, step actions), use-contextual-tour.ts (advance, dismiss).
 */

import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { type SurfaceTourId, useStarterGuideStore } from "../../stores/starter-guide";
import { Button } from "../common";
import { measureTarget, Spotlight } from "./Spotlight";
import { SURFACE_TOUR_STEPS } from "./surface-tours";

export function SurfaceTour() {
	const current = useStarterGuideStore(state => state.surfaceTour);
	if (!current) return null;
	return <SurfaceTourCard id={current.id} key={current.id} step={current.step} />;
}

function SurfaceTourCard({ id, step }: { id: SurfaceTourId; step: number }) {
	const t = useT();
	const end = useStarterGuideStore(state => state.endSurfaceTour);
	const steps = SURFACE_TOUR_STEPS[id];
	// The steps whose control is on screen as the tour starts: the count the card shows never changes under it.
	const [shown] = useState(() =>
		steps.flatMap((candidate, index) => (measureTarget(candidate.targets) ? [index] : [])),
	);
	const index = shown.find(candidate => candidate >= step);
	useEffect(() => {
		if (index === undefined) end();
	}, [index, end]);
	if (index === undefined) return null;
	const position = shown.indexOf(index);
	const last = position === shown.length - 1;
	const stepId = steps[index].id;
	return (
		<Spotlight
			body={t(`tour.${id}.${stepId}.body`)}
			cardAttrs={{ "data-surface-tour": id, "data-surface-tour-step": stepId }}
			footer={
				<>
					<span className="mr-auto text-sc-xs tabular-nums text-(--sc-text-muted)">
						{t("tour.progress", { n: position + 1, total: shown.length })}
					</span>
					{!last && (
						<Button onClick={end} size="sm" variant="ghost">
							{t("tour.skip")}
						</Button>
					)}
					<Button
						autoFocus
						onClick={() =>
							last ? end() : useStarterGuideStore.getState().setSurfaceTourStep(shown[position + 1])
						}
						size="sm"
						variant="primary"
					>
						{t(last ? "tour.done" : "tour.next")}
					</Button>
				</>
			}
			id={`tour-${id}-${stepId}`}
			key={stepId}
			onEnd={end}
			targets={steps[index].targets}
			title={t(`tour.${id}.${stepId}.title`)}
		/>
	);
}
