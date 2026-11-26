/**
 * How this device shows the sidebar's Bots section (Orca's bot sidebar view, `shared/bots/bot-sidebar-view.ts:26-30`):
 * the order (`BotSort`, manual by default), whether paused bots hide, the section folded, which bots are unfolded to
 * their chats and the person's own order. Device-local: kept in this page's `localStorage`, as a phone's folds are
 * its own.
 */
import { create } from "zustand";
import { BOT_SORTS, type BotSort } from "../components/bots/bot-view";

const STORAGE_KEY = "omp.botsView";
/** Entries each list keeps (bots unfolded, the order). */
const LIST_LIMIT = 100;

interface BotsView {
	sort: BotSort;
	hidePaused: boolean;
	folded: boolean;
	/** Bot ids unfolded to their chats. */
	open: string[];
	/** Bot ids in the person's order. */
	order: string[];
}

interface BotsViewStore extends BotsView {
	setSort: (sort: BotSort) => void;
	setHidePaused: (hide: boolean) => void;
	setFolded: (folded: boolean) => void;
	setOpen: (id: string, open: boolean) => void;
	/** Every bot unfolded (`ids`) or folded (`[]`). */
	setAllOpen: (ids: readonly string[]) => void;
	setOrder: (ids: readonly string[]) => void;
	reset: () => void;
}

const DEFAULTS: BotsView = { sort: "manual", hidePaused: false, folded: false, open: [], order: [] };

const strings = (value: unknown) =>
	Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, LIST_LIMIT) : [];

function read(): BotsView {
	try {
		const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
		const saved = raw ? (JSON.parse(raw) as Partial<Record<keyof BotsView, unknown>>) : {};
		return {
			sort: BOT_SORTS.includes(saved.sort as BotSort) ? (saved.sort as BotSort) : DEFAULTS.sort,
			hidePaused: saved.hidePaused === true,
			folded: saved.folded === true,
			open: strings(saved.open),
			order: strings(saved.order),
		};
	} catch {
		return DEFAULTS;
	}
}

export const useBotsView = create<BotsViewStore>()((set, get) => {
	const edit = (patch: Partial<BotsView>) => {
		set(patch);
		const { sort, hidePaused, folded, open, order } = get();
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify({ sort, hidePaused, folded, open, order }));
		} catch {
			// A full or refused storage keeps the view for this page only.
		}
	};
	return {
		...read(),
		setSort: sort => edit({ sort }),
		setHidePaused: hidePaused => edit({ hidePaused }),
		setFolded: folded => edit({ folded }),
		setOpen: (id, open) =>
			edit({ open: open ? [id, ...get().open.filter(known => known !== id)] : get().open.filter(k => k !== id) }),
		setAllOpen: ids => edit({ open: ids.slice(0, LIST_LIMIT) }),
		setOrder: ids => edit({ order: ids.slice(0, LIST_LIMIT) }),
		reset: () => set(DEFAULTS),
	};
});
