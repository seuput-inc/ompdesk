/**
 * Whether this build offers bots (Orca's bots, back by the owner's decision of 25 Nov 2026). The sidebar's Bots nav
 * row, its Bots section and the Bots page appear only once the bots feature is available: the bots slice turns
 * `available` on when its registry and "New bot" ship, so nothing empty ships before. Nothing else writes it.
 */
import { create } from "zustand";

export const useBotsFeature = create<{ available: boolean }>()(() => ({ available: false }));

/** The one predicate every Bots entry point reads. */
export function useBotsAvailable(): boolean {
	return useBotsFeature(s => s.available);
}
