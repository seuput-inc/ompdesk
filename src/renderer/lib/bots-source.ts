/**
 * Whether this build offers bots (Orca's bots, back by the owner's decision of 25 Nov 2026). The sidebar's Bots nav
 * row, its Bots section and the Bots page appear only once both hold: the core's registry ships (`BOTS_AVAILABLE`,
 * shared/bots.ts) and the bots UI does, with a person-pressable "New bot" and the bots' list (`BOTS_UI`, which the
 * orca-bots-ui slice turns on). Until then nothing Bots-related shows, so no empty page ships. Nothing else writes it.
 */
import { create } from "zustand";
import { BOTS_AVAILABLE } from "../../shared/bots";

/** The bots UI (the page's list and "New bot"): false until the orca-bots-ui slice lands it. */
export const BOTS_UI = false;

export const useBotsFeature = create<{ available: boolean }>()(() => ({ available: BOTS_AVAILABLE && BOTS_UI }));

/** The one predicate every Bots entry point reads. */
export function useBotsAvailable(): boolean {
	return useBotsFeature(s => s.available);
}
