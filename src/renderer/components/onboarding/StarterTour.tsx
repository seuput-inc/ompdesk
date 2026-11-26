/**
 * Spotlight tour for one getting-started step (Spotlight): the real control the step is about, a card beside it with
 * "Got it". The step completing ends it too. The look step has no spotlight: its "Show me" opens the theme picker.
 */

import { useT } from "../../lib/i18n";
import { type StarterStep, useStarterGuideStore } from "../../stores/starter-guide";
import { Button } from "../common";
import { Spotlight } from "./Spotlight";

/** Where each step's control lives; the first one on screen wins. */
const TARGETS: Record<StarterStep, readonly string[]> = {
	model: ["[data-model-chip]"],
	prompt: [".omp-composer-input"],
	project: ["[data-sidebar-open-project]", '[data-sidebar-device-add="local"]', ".omp-sidebar-controls"],
	split: ['[data-tour="sessions"]'],
	panel: ['[data-tour="panel"]'],
	look: [],
};

export function StarterTour() {
	const t = useT();
	const step = useStarterGuideStore(state => state.tour);
	const end = useStarterGuideStore(state => state.endTour);
	if (!step) return null;
	return (
		<Spotlight
			body={t(`starter.step.${step}.tour`)}
			footer={
				<Button autoFocus onClick={end} size="sm" variant="primary">
					{t("starter.gotIt")}
				</Button>
			}
			id={`starter-${step}`}
			key={step}
			onEnd={end}
			targets={TARGETS[step]}
			title={t(`starter.step.${step}.title`)}
		/>
	);
}
