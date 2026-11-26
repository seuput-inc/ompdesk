/**
 * Whether this build offers bots (Orca's bots, back by the owner's decision of 25 Nov 2026). The sidebar's Bots nav
 * row, its Bots section, the Bots page, Settings › Bots, the palette's bots, the composer's `@` bots, Hand to bot and a
 * schedule's bot target show only while both hold: the core's registry ships (`BOTS_AVAILABLE`, shared/bots.ts) and
 * the bots UI does (`BOTS_UI`, on since the orca-bots-ui slice landed it). Nothing else writes it.
 */
import { create } from "zustand";
import { BOTS_AVAILABLE } from "../../shared/bots";

/** The bots UI (the section, the page, New bot): on since orca-bots-ui. */
export const BOTS_UI = true;

export const useBotsFeature = create<{ available: boolean }>()(() => ({ available: BOTS_AVAILABLE && BOTS_UI }));

/** The one predicate every Bots entry point reads. */
export function useBotsAvailable(): boolean {
	return useBotsFeature(s => s.available);
}
