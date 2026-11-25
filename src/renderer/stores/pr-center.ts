import { useMemo } from "react";
import { create } from "zustand";
import type { RpcPrDetail, RpcPrListItem, RpcPrListView, RpcPrRepo } from "../../shared/rpc-types";
import type { FocusedScope } from "../lib/focused-scope";
import {
	afterFailure,
	afterSuccess,
	backoff,
	type Freshness,
	pausedUntil,
	shouldReread,
} from "../lib/github-freshness";
import { translate } from "../lib/i18n";
import { lastRead, rememberRead } from "../lib/last-read";
import { hidden, onWindowReturn } from "../lib/visible-poll";
import { useTabsStore } from "./tabs";
import { toast, toastError } from "./toast";

/**
 * PR Center store (plan/21): repo probe → list → detail → per-file lazy
 * diffs, plus the create/checkout actions. One store per window (the panel
 * is a singleton); everything re-probes on repo/cwd change at open time.
 */
interface PrCenterStore {
	/** Whose PRs these are (the focused tab's host and folder): the key of every last-read snapshot below. */
	scope: FocusedScope;
	repo: RpcPrRepo | null;
	listState: "open" | "closed" | "merged" | "all";
	/** Every PR, those waiting on your review, or yours. */
	listView: RpcPrListView;
	list: RpcPrListItem[];
	listLoading: boolean;
	selected: number | null;
	detail: RpcPrDetail | null;
	detailLoading: boolean;
	/** Expanded file paths and their diff state. */
	expandedFiles: Record<string, { phase: "loading" } | { phase: "ready"; diff: string } | { phase: "error" }>;
	error: string | null;
	/** GitHub holds reads until then (`gh_paused`): one muted line instead of an error, timers wait. */
	pausedUntil: number | null;

	/**
	 * The panel opens on `scope`: what it showed last time (repo, list) is the state at once, the probe reads again
	 * in place. A different scope never inherits another repository's rows.
	 */
	enter: (scope: FocusedScope) => void;
	probe: () => Promise<void>;
	/**
	 * Read the shown list again. One read runs at a time; one asked meanwhile (only the latest) runs right after it.
	 * `background`: the window came back, not a person: no in-progress mark, a failure leaves the rows and no error.
	 */
	refresh: (background?: boolean) => Promise<void>;
	setListState: (state: "open" | "closed" | "merged" | "all") => void;
	setListView: (view: RpcPrListView) => void;
	/** Re-read the selected PR and the list after an action changed it (merge, review, edit). */
	reloadSelected: () => Promise<void>;
	select: (number: number) => Promise<void>;
	/** Close the selected PR's detail (a phone's back from the detail). */
	deselect: () => void;
	toggleFile: (path: string) => Promise<void>;
	checkout: (number: number) => Promise<void>;
	reset: () => void;
	/**
	 * While the panel is shown: a return to the window reads the list and the PR again when a minute old and not held,
	 * and a PR whose checks still run is read again after 1, 2, 4 … 15 minutes. Returns the stop.
	 */
	watch: () => () => void;
}

const NO_SCOPE: FocusedScope = { device: undefined, cwd: "" };

/** The snapshot keys of one repository (the folder names it); a diff or a log is only remembered in memory. */
const repoKey = (scope: FocusedScope) => `pr:repo:${scope.cwd}`;
const listKey = (scope: FocusedScope, state: string, view: string) => `pr:list:${scope.cwd}:${state}:${view}`;
const detailKey = (scope: FocusedScope, number: number) => `pr:detail:${scope.cwd}:${number}`;
const diffKey = (scope: FocusedScope, number: number, path: string) => `pr:diff:${scope.cwd}:${number}:${path}`;

const initialState = {
	scope: NO_SCOPE,
	repo: null,
	listState: "open" as const,
	listView: "all" as const,
	list: [],
	listLoading: false,
	selected: null,
	detail: null,
	detailLoading: false,
	expandedFiles: {},
	error: null,
	pausedUntil: null,
};

/** A list read older than this no longer counts as in flight: its mark clears and the next one runs. */
const READ_EXPIRES_MS = 120_000;

// Outside the state: nothing here paints. Each read keeps its generation and writes its outcome only while it is
// still the newest of its kind for the scope, filter or PR it started on.
const fresh = new Map<string, Freshness>();
let probeGen = 0;
let listGen = 0;
let listRunning: { gen: number; timer: ReturnType<typeof setTimeout> } | null = null;
let listQueued: { gen: number; background: boolean } | null = null;
let detailGen = 0;
let detailReads = 0;
let watchers = 0;
let pendingRounds = 0;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let pauseTimer: ReturnType<typeof setTimeout> | undefined;

const store = () => usePrCenterStore.getState();

/** What a failed read leaves: a `gh_paused` hold, a person's read its error, a background read nothing. */
function failed(key: string, error: { code?: string; message: string }, background: boolean): Partial<PrCenterStore> {
	fresh.set(key, afterFailure(fresh.get(key), Date.now(), error));
	const until = error.code === "gh_paused" ? pausedUntil(error.message) : null;
	if (until !== null) return { pausedUntil: until };
	return background ? {} : { error: error.message };
}

function apply(patch: Partial<PrCenterStore>): void {
	usePrCenterStore.setState(patch);
	const until = patch.pausedUntil;
	if (until == null) return;
	clearTimeout(pauseTimer);
	// The hold ends by itself: the line goes and what is shown reads again.
	pauseTimer = setTimeout(() => {
		if (store().pausedUntil !== until) return;
		usePrCenterStore.setState({ pausedUntil: null });
		freshen();
	}, until - Date.now());
}

async function readList(gen: number, background: boolean): Promise<void> {
	listRunning = { gen, timer: setTimeout(() => settleList(gen), READ_EXPIRES_MS) };
	const { scope, listState, listView } = store();
	const key = listKey(scope, listState, listView);
	const current = () => {
		const now = store();
		return gen === listGen && now.scope === scope && now.listState === listState && now.listView === listView;
	};
	try {
		const response = await window.omp.rpc.prList(listState, 50, listView, background);
		if (response.success) {
			const list = response.data as RpcPrListItem[];
			rememberRead(scope.device, key, list);
			fresh.set(key, afterSuccess(Date.now()));
			if (current()) apply({ list, listLoading: false, error: null, pausedUntil: null });
		} else {
			const patch = failed(key, { code: response.code, message: response.error }, background);
			if (current()) apply({ ...patch, listLoading: false });
		}
	} catch (error) {
		const patch = failed(key, { message: String(error) }, background);
		if (current()) apply({ ...patch, listLoading: false });
	} finally {
		settleList(gen);
	}
}

function settleList(gen: number): void {
	if (listRunning?.gen !== gen) return;
	clearTimeout(listRunning.timer);
	listRunning = null;
	if (gen === listGen) usePrCenterStore.setState({ listLoading: false });
	const next = listQueued;
	listQueued = null;
	if (next) void readList(next.gen, next.background);
}

async function readDetail(number: number, background: boolean): Promise<void> {
	const gen = ++detailGen;
	const scope = store().scope;
	const key = detailKey(scope, number);
	// A slower answer for an earlier choice never replaces the PR shown now.
	const current = () => gen === detailGen && store().selected === number && store().scope === scope;
	detailReads++;
	try {
		const response = await window.omp.rpc.prGet(number, background);
		if (!current()) return;
		if (response.success) {
			const detail = response.data as RpcPrDetail;
			rememberRead(scope.device, key, detail);
			fresh.set(key, afterSuccess(Date.now()));
			apply({ detail, detailLoading: false, pausedUntil: null });
		} else {
			apply({ ...failed(key, { code: response.code, message: response.error }, background), detailLoading: false });
		}
		schedulePending();
	} catch (error) {
		if (current()) apply({ ...failed(key, { message: String(error) }, background), detailLoading: false });
	} finally {
		detailReads--;
	}
}

/** The window came back: read again, in place and in the background, what is a minute old and not held. */
function freshen(): void {
	if (watchers === 0 || hidden()) return;
	const { scope, repo, listState, listView, selected } = store();
	if (!repo?.available) return;
	const now = Date.now();
	if ((store().pausedUntil ?? 0) > now) return;
	if (!listRunning && shouldReread(fresh.get(listKey(scope, listState, listView)), now)) void store().refresh(true);
	if (selected === null || detailReads > 0) return;
	if (shouldReread(fresh.get(detailKey(scope, selected)), now)) void readDetail(selected, true);
	else if (pendingTimer === undefined) schedulePending();
}

/** A shown PR whose checks still run is read again after 1, 2, 4 … 15 minutes; a hidden window waits for its return. */
function schedulePending(): void {
	clearTimeout(pendingTimer);
	pendingTimer = undefined;
	const { scope, selected, detail, pausedUntil: paused } = store();
	const running =
		watchers > 0 &&
		selected !== null &&
		detail?.number === selected &&
		detail.checks.some(check => !check.conclusion && ["IN_PROGRESS", "QUEUED", "PENDING"].includes(check.status));
	if (!running) {
		pendingRounds = 0;
		return;
	}
	const held = Math.max(fresh.get(detailKey(scope, selected))?.holdUntil ?? 0, paused ?? 0) - Date.now();
	pendingTimer = setTimeout(
		() => {
			pendingTimer = undefined;
			if (hidden() || store().selected !== selected) return;
			pendingRounds++;
			void readDetail(selected, true);
		},
		Math.max(backoff(pendingRounds), held),
	);
}

export const usePrCenterStore = create<PrCenterStore>()((set, get) => ({
	...initialState,

	enter: scope => {
		const current = get().scope;
		if (current.device === scope.device && current.cwd === scope.cwd) return;
		const { listState, listView } = get();
		set({
			scope,
			repo: lastRead<RpcPrRepo>(scope.device, repoKey(scope)) ?? null,
			list: lastRead<RpcPrListItem[]>(scope.device, listKey(scope, listState, listView)) ?? [],
			selected: null,
			detail: null,
			detailLoading: false,
			expandedFiles: {},
			error: null,
		});
	},

	probe: async () => {
		const gen = ++probeGen;
		set({ error: null });
		const scope = get().scope;
		const current = () => gen === probeGen && get().scope === scope;
		try {
			const response = await window.omp.rpc.prRepo();
			if (!current()) return;
			if (!response.success) {
				// A held read keeps the repository painted; the muted line says until when.
				const until = response.code === "gh_paused" ? pausedUntil(response.error) : null;
				if (until !== null && get().repo) return apply({ pausedUntil: until });
				set({ repo: null, error: response.error });
				return;
			}
			const repo = response.data as RpcPrRepo;
			set({ repo });
			if (repo.available) rememberRead(scope.device, repoKey(scope), repo);
			if (repo.available) await get().refresh();
		} catch (error) {
			if (current()) set({ repo: null, error: String(error) });
		}
	},

	refresh: async (background = false) => {
		const gen = ++listGen;
		if (!background) set({ listLoading: true, error: null });
		if (listRunning) {
			// A person's ask stays a person's even when a background one comes after it.
			listQueued = { gen, background: background && (listQueued?.background ?? true) };
			return;
		}
		await readList(gen, background);
	},

	setListState: state => {
		if (state === get().listState) return;
		const { scope, listView } = get();
		set({
			listState: state,
			list: lastRead<RpcPrListItem[]>(scope.device, listKey(scope, state, listView)) ?? [],
			selected: null,
			detail: null,
			expandedFiles: {},
		});
		void get().refresh();
	},

	setListView: view => {
		if (view === get().listView) return;
		const { scope, listState } = get();
		set({
			listView: view,
			list: lastRead<RpcPrListItem[]>(scope.device, listKey(scope, listState, view)) ?? [],
			selected: null,
			detail: null,
			expandedFiles: {},
		});
		void get().refresh();
	},

	reloadSelected: async () => {
		const number = get().selected;
		await Promise.all([get().refresh(), number === null ? undefined : get().select(number)]);
	},

	deselect: () => set({ selected: null, detail: null, detailLoading: false, expandedFiles: {}, error: null }),

	select: async number => {
		const scope = get().scope;
		pendingRounds = 0;
		// A PR seen before shows at once (its last read), the read below replaces it in place.
		set({
			selected: number,
			detail: lastRead<RpcPrDetail>(scope.device, detailKey(scope, number)) ?? null,
			detailLoading: true,
			expandedFiles: {},
			error: null,
		});
		await readDetail(number, false);
	},

	toggleFile: async path => {
		const current = get().expandedFiles[path];
		if (current) {
			const next = { ...get().expandedFiles };
			delete next[path];
			set({ expandedFiles: next });
			return;
		}
		const number = get().selected;
		if (number === null) return;
		const scope = get().scope;
		const seen = lastRead<string>(scope.device, diffKey(scope, number, path));
		set(state => ({
			expandedFiles: {
				...state.expandedFiles,
				[path]: seen === undefined ? { phase: "loading" } : { phase: "ready", diff: seen },
			},
		}));
		try {
			const response = await window.omp.rpc.prDiff(number, path);
			if (get().selected !== number) return;
			set(state => {
				// pr_diff success arm carries { diff: string } (rpc-types.ts) — named
				// const instead of inline-cast-access so the assertion has one home.
				const data = response.data as { diff: string } | undefined;
				if (response.success && data) rememberRead(scope.device, diffKey(scope, number, path), data.diff, false);
				return {
					expandedFiles: {
						...state.expandedFiles,
						[path]: response.success && data ? { phase: "ready", diff: data.diff } : { phase: "error" },
					},
				};
			});
		} catch {
			set(state => ({ expandedFiles: { ...state.expandedFiles, [path]: { phase: "error" } } }));
		}
	},

	checkout: async number => {
		try {
			const response = await window.omp.rpc.prCheckout(number);
			if (!response.success) {
				toastError({ title: translate("prCenter.checkoutFailed"), error: response });
				return;
			}
			const result = response.data as { path: string; branch: string };
			const repo = get().repo;
			const tabId = await useTabsStore.getState().openTab({
				cwd: result.path,
				worktree: {
					name: `pr-${number}`,
					branch: result.branch,
					baseCwd: repo?.available ? repo.repo : "",
					path: result.path,
				},
			});
			if (tabId)
				toast({ variant: "success", message: translate("prCenter.checkoutOpened", { number: String(number) }) });
		} catch (error) {
			toastError({ title: translate("prCenter.checkoutFailed"), error });
		}
	},

	reset: () => {
		probeGen++;
		listGen++;
		detailGen++;
		if (listRunning) clearTimeout(listRunning.timer);
		listRunning = null;
		listQueued = null;
		fresh.clear();
		clearTimeout(pendingTimer);
		clearTimeout(pauseTimer);
		pendingTimer = undefined;
		pendingRounds = 0;
		set(initialState);
	},

	watch: () => {
		watchers++;
		const stop = onWindowReturn(freshen);
		schedulePending();
		return () => {
			stop();
			watchers--;
			if (watchers === 0) schedulePending();
		};
	},
}));

/**
 * Whether a session row's checkout has a pull request: its repository's name and branch among the PRs the PR center
 * last listed (the status lane's PR mark). shortcut: only the repository the PR center last read is known, so other
 * repositories' rows show none; upgrade to a per-repository PR read when the rows' PR state ships (FB24/FB25).
 */
export function usePullRequestBranches(): (target: {
	name: string;
	head: { kind: string; name?: string } | null;
}) => boolean {
	const repo = usePrCenterStore(s => s.repo);
	const list = usePrCenterStore(s => s.list);
	return useMemo(() => {
		const name = repo?.available ? repo.repo.slice(repo.repo.indexOf("/") + 1) : null;
		const branches = new Set(name ? list.map(pr => pr.headRefName) : []);
		return target => target.name === name && target.head?.kind === "branch" && branches.has(target.head.name ?? "");
	}, [repo, list]);
}
