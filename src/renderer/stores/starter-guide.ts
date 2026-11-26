import { create } from "zustand";
import { PREFS_BOOT_RETRY_MS, readPref } from "../lib/prefs-read";

/**
 * Getting-started checklist at the sidebar foot, the first-visit tours of the shell's surfaces and the one-time
 * feature tips. Each checklist step completes from real app state (StarterGuide watches it) and stays done: the
 * list only ever grows, merged with what prefs already hold, so a slow load never moves a step backwards. A step's
 * tour spotlights the real control (StarterTour); a surface's tour runs once, the first time it is on screen
 * (SurfaceTour); a tip shows once (FeatureTipCard). Saved in prefs (main), not localStorage, so every window agrees.
 */
export const STARTER_STEPS = ["model", "prompt", "project", "split", "panel", "look"] as const;
export type StarterStep = (typeof STARTER_STEPS)[number];

/** The steps before "look" came (Orca FG41): a guide that had all of them done counts "look" as done, so it stays finished. */
const STEPS_BEFORE_LOOK: readonly StarterStep[] = ["model", "prompt", "project", "split", "panel"];

/** Surfaces with a first-visit tour (Orca's contextual tours, FG59); the steps are SurfaceTour's. */
export const SURFACE_TOURS = ["shell", "board", "stats", "schedules", "preview"] as const;
export type SurfaceTourId = (typeof SURFACE_TOURS)[number];

/** Features with a one-time tip card (Orca's feature tips, FG58), in the order they are offered. */
export const FEATURE_TIPS = ["board", "palette", "phone", "pet"] as const;
export type FeatureTipId = (typeof FEATURE_TIPS)[number];

export const STARTER_GUIDE_PREF = "starterGuide";

export interface SavedStarterGuide {
	done: StarterStep[];
	dismissed: boolean;
	toursSeen: SurfaceTourId[];
	tipsSeen: FeatureTipId[];
}

function known<T extends string>(all: readonly T[], value: unknown): T[] {
	return Array.isArray(value) ? all.filter(item => value.includes(item)) : [];
}

/** Surfaces a person who used the app before the tours came already knows: their tours never start for them. */
const KNOWN_BEFORE_TOURS: readonly SurfaceTourId[] = ["schedules", "preview"];

/**
 * Read the saved guide; anything malformed counts as a fresh guide. `seenAll` (test runs: main seeds it under
 * OMP_GUI_HEADLESS, the dev harness unless `?tours=1`) counts every tour and tip as seen, so no spotlight takes a
 * spec's click. A guide saved before the tours existed (no `toursSeen`) belongs to someone who knows the older
 * surfaces; the new shell, the board and the stats tours still greet them once.
 */
export function parseStarterGuide(value: unknown): SavedStarterGuide {
	if (typeof value !== "object" || value === null) return { done: [], dismissed: false, toursSeen: [], tipsSeen: [] };
	const record = value as Record<string, unknown>;
	const saved = known(STARTER_STEPS, record.done);
	const done = STEPS_BEFORE_LOOK.every(step => saved.includes(step))
		? STARTER_STEPS.filter(step => saved.includes(step) || step === "look")
		: saved;
	if (record.seenAll === true)
		return { done, dismissed: record.dismissed === true, toursSeen: [...SURFACE_TOURS], tipsSeen: [...FEATURE_TIPS] };
	const before = !("toursSeen" in record) && (saved.length > 0 || record.dismissed === true);
	return {
		done,
		dismissed: record.dismissed === true,
		toursSeen: before ? [...KNOWN_BEFORE_TOURS] : known(SURFACE_TOURS, record.toursSeen),
		tipsSeen: known(FEATURE_TIPS, record.tipsSeen),
	};
}

interface StarterGuideState extends SavedStarterGuide {
	loaded: boolean;
	/** The step whose spotlight tour is on screen. */
	tour: StarterStep | null;
	/** The surface tour on screen and its step (an index into SurfaceTour's steps for it). */
	surfaceTour: { id: SurfaceTourId; step: number } | null;
	load: () => Promise<void>;
	complete: (steps: readonly StarterStep[]) => void;
	dismiss: () => void;
	startTour: (step: StarterStep) => void;
	endTour: () => void;
	startSurfaceTour: (id: SurfaceTourId) => void;
	setSurfaceTourStep: (step: number) => void;
	/** Ends the surface tour on screen; it never starts by itself again. */
	endSurfaceTour: () => void;
	/** The tip was shown: it is never offered again. */
	seeTip: (id: FeatureTipId) => void;
	reset: () => void;
}

const INITIAL = {
	loaded: false,
	done: [],
	dismissed: false,
	toursSeen: [],
	tipsSeen: [],
	tour: null,
	surfaceTour: null,
} as const;

function persist(state: SavedStarterGuide): void {
	const { done, dismissed, toursSeen, tipsSeen } = state;
	// A failed write only means the next launch re-derives the steps from state again.
	void window.omp.prefs.set(STARTER_GUIDE_PREF, { done, dismissed, toursSeen, tipsSeen }).catch(() => {});
}

function union<T extends string>(all: readonly T[], a: readonly T[], b: readonly T[]): T[] {
	return all.filter(item => a.includes(item) || b.includes(item));
}

export const useStarterGuideStore = create<StarterGuideState>()((set, get) => {
	/**
	 * Reads the saved guide and merges it with what this run completed. A
	 * failed read leaves the guide unloaded: saved steps and a saved dismissal
	 * are unknown, so nothing may be written over them yet.
	 */
	const load = async (retryDelaysMs: readonly number[]): Promise<void> => {
		if (get().loaded) return;
		const read = await readPref(STARTER_GUIDE_PREF, retryDelaysMs);
		// Another read (boot backoff or a change's own) may have landed meanwhile.
		if (!read.ok || get().loaded) return;
		const saved = parseStarterGuide(read.value);
		const current = get();
		const merged: SavedStarterGuide = {
			done: union(STARTER_STEPS, saved.done, current.done),
			dismissed: saved.dismissed || current.dismissed,
			toursSeen: union(SURFACE_TOURS, saved.toursSeen, current.toursSeen),
			tipsSeen: union(FEATURE_TIPS, saved.tipsSeen, current.tipsSeen),
		};
		set({ loaded: true, ...merged });
		const changed =
			merged.done.length !== saved.done.length ||
			merged.dismissed !== saved.dismissed ||
			merged.toursSeen.length !== saved.toursSeen.length ||
			merged.tipsSeen.length !== saved.tipsSeen.length;
		if (changed) persist(merged);
	};

	/** Writes the current state, or (unloaded) reads first: load() merges and writes the union itself. */
	const save = () => {
		if (get().loaded) persist(get());
		else void load([]);
	};

	return {
		...INITIAL,
		done: [],
		toursSeen: [],
		tipsSeen: [],
		load: () => load(PREFS_BOOT_RETRY_MS),
		complete: steps => {
			const current = get();
			const added = steps.filter(step => !current.done.includes(step));
			if (added.length === 0) return;
			const done = union(STARTER_STEPS, current.done, added);
			set({ done, tour: current.tour && added.includes(current.tour) ? null : current.tour });
			save();
		},
		dismiss: () => {
			set({ dismissed: true, tour: null });
			save();
		},
		startTour: step => set({ tour: step, surfaceTour: null }),
		endTour: () => set({ tour: null }),
		startSurfaceTour: id => set({ surfaceTour: { id, step: 0 } }),
		setSurfaceTourStep: step => {
			const current = get().surfaceTour;
			if (current) set({ surfaceTour: { ...current, step } });
		},
		endSurfaceTour: () => {
			const current = get().surfaceTour;
			if (!current) return;
			set({ surfaceTour: null, toursSeen: union(SURFACE_TOURS, get().toursSeen, [current.id]) });
			save();
		},
		seeTip: id => {
			if (get().tipsSeen.includes(id)) return;
			set({ tipsSeen: union(FEATURE_TIPS, get().tipsSeen, [id]) });
			save();
		},
		reset: () => set({ ...INITIAL, done: [], toursSeen: [], tipsSeen: [] }),
	};
});
