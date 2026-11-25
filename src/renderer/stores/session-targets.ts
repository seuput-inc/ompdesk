/**
 * What each listed session works in (`shared/session-target.ts`), as the computer that runs it resolved it, and each
 * repository's picture. Rows and the work board read it here, never on their own: `requestSessionTargets` asks the
 * session's computer (`window.omp.sessions.targets`, routed by `device`, so a paired host's rows and the phone page
 * read the host's facts) for the rows it has not asked about at their journal's stamp, 24 at a time, and then
 * `sessions.artwork` once per repository whose picture was not looked up yet. A window coming back to the front asks
 * again about every row it holds (a branch switched in a terminal writes no journal).
 *
 * The last answers paint the next launch's first frame (`lib/last-read.ts`, one entry per computer: targets without
 * pictures, and the newest pictures by repository), so a row never starts on a letter mark it had a picture for.
 */
import { create } from "zustand";
import {
	SESSION_TARGET_BATCH,
	type SessionArtwork,
	type SessionTarget,
	type SessionTargetQuery,
} from "../../shared/session-target";
import { lastRead, rememberRead } from "../lib/last-read";

/** A call that failed (handlers not there yet, a dropped link) may be asked again after this. */
export const TARGETS_RETRY_MS = 10_000;
/** Pictures kept for the next launch per computer; the rest are looked up again (they are cached there). */
const PERSISTED_ARTWORKS = 40;
const SNAPSHOT_KEY = "session-targets";

/** The key of a session or a repository root on a computer (`device` undefined: this one). */
export const targetKey = (device: string | undefined, path: string) => `${device ?? ""}\n${path}`;

interface SessionTargetsState {
	/** By `targetKey(device, sessionPath)`; null: the folder is gone or could not be read. Absent: not answered. */
	targets: Readonly<Record<string, SessionTarget | null>>;
	/** By `targetKey(device, root)`; null: the repository has no picture. Absent: not looked up yet. */
	artworks: Readonly<Record<string, SessionArtwork | null>>;
}

export const useSessionTargets = create<SessionTargetsState>(() => ({ targets: {}, artworks: {} }));

/** One row to ask about: its query and the stamp (its journal's time) its answer holds for. */
export interface SessionTargetRow extends SessionTargetQuery {
	stamp?: string;
}

/** What each session was last asked about at (`targetKey` → `cwd\nstamp`), and each root's picture asked for. */
const asked = new Map<string, string>();
const askedArtwork = new Set<string>();
/** The rows each computer's views hold, for the ask on focus. */
const held = new Map<string, Map<string, SessionTargetRow>>();
const hydrated = new Set<string>();

interface Persisted {
	targets: Record<string, SessionTarget | null>;
	artworks: Record<string, SessionArtwork | null>;
}

function hydrate(device: string | undefined): void {
	const ns = device ?? "";
	if (hydrated.has(ns)) return;
	hydrated.add(ns);
	const saved = lastRead<Persisted>(device, SNAPSHOT_KEY);
	if (!saved) return;
	useSessionTargets.setState(state => ({
		// What this run already read outranks what the last run left.
		targets: {
			...Object.fromEntries(
				Object.entries(saved.targets ?? {}).map(([path, target]) => [targetKey(device, path), target]),
			),
			...state.targets,
		},
		artworks: {
			...Object.fromEntries(
				Object.entries(saved.artworks ?? {}).map(([root, art]) => [targetKey(device, root), art]),
			),
			...state.artworks,
		},
	}));
}

function persist(device: string | undefined): void {
	const prefix = targetKey(device, "");
	const { targets, artworks } = useSessionTargets.getState();
	const own = <T>(record: Readonly<Record<string, T>>) =>
		Object.entries(record)
			.filter(([key]) => key.startsWith(prefix))
			.map(([key, value]) => [key.slice(prefix.length), value] as const);
	const saved: Persisted = {
		// The picture lives once per repository, never once per row.
		targets: Object.fromEntries(
			own(targets).map(([path, target]) => {
				if (!target || target.artwork === undefined) return [path, target];
				const { artwork: _picture, ...rest } = target;
				return [path, rest];
			}),
		),
		artworks: Object.fromEntries(own(artworks).slice(-PERSISTED_ARTWORKS)),
	};
	rememberRead(device, SNAPSHOT_KEY, saved);
}

function forget(keys: readonly string[], from: Map<string, string> | Set<string>): void {
	setTimeout(() => {
		for (const key of keys) from.delete(key);
	}, TARGETS_RETRY_MS);
}

function loadArtwork(device: string | undefined, roots: readonly string[]): void {
	const api = window.omp?.sessions;
	const wanted = roots.filter(root => !askedArtwork.has(targetKey(device, root)));
	if (!api?.artwork || wanted.length === 0) return;
	for (const root of wanted) askedArtwork.add(targetKey(device, root));
	for (let from = 0; from < wanted.length; from += SESSION_TARGET_BATCH) {
		const batch = wanted.slice(from, from + SESSION_TARGET_BATCH);
		api.artwork(batch, device)
			.then(answers => {
				useSessionTargets.setState(state => ({
					artworks: {
						...state.artworks,
						...Object.fromEntries(batch.map(root => [targetKey(device, root), answers?.[root] ?? null])),
					},
				}));
				persist(device);
			})
			.catch(() =>
				forget(
					batch.map(root => targetKey(device, root)),
					askedArtwork,
				),
			);
	}
}

function loadTargets(device: string | undefined, rows: readonly SessionTargetRow[]): void {
	const api = window.omp?.sessions;
	if (!api?.targets || rows.length === 0) return;
	for (let from = 0; from < rows.length; from += SESSION_TARGET_BATCH) {
		const batch = rows.slice(from, from + SESSION_TARGET_BATCH);
		api.targets(
			batch.map(({ sessionPath, cwd }) => ({ sessionPath, cwd })),
			device,
		)
			.then(answers => {
				const received = answers && typeof answers === "object" ? answers : {};
				const pictures: Record<string, SessionArtwork | null> = {};
				const missing = new Set<string>();
				for (const row of batch) {
					const target = received[row.sessionPath];
					const root = target?.repository?.root;
					if (!root) continue;
					if (target.artwork !== undefined) pictures[targetKey(device, root)] = target.artwork;
					else missing.add(root);
				}
				useSessionTargets.setState(state => ({
					targets: {
						...state.targets,
						...Object.fromEntries(
							batch.map(row => [targetKey(device, row.sessionPath), received[row.sessionPath] ?? null]),
						),
					},
					artworks: { ...state.artworks, ...pictures },
				}));
				persist(device);
				const known = useSessionTargets.getState().artworks;
				loadArtwork(
					device,
					[...missing].filter(root => known[targetKey(device, root)] === undefined),
				);
			})
			.catch(() =>
				forget(
					batch.map(row => targetKey(device, row.sessionPath)),
					asked,
				),
			);
	}
}

/**
 * The rows a view shows on one computer: asks about each one not asked about at its folder and stamp yet. Call it with
 * every row the view holds whenever they change; rows asked about already cost nothing.
 */
export function requestSessionTargets(device: string | undefined, rows: readonly SessionTargetRow[]): void {
	hydrate(device);
	const ns = device ?? "";
	let mine = held.get(ns);
	if (!mine) {
		mine = new Map();
		held.set(ns, mine);
	}
	const fresh: SessionTargetRow[] = [];
	for (const row of rows) {
		if (!row.sessionPath) continue;
		const key = targetKey(device, row.sessionPath);
		const before = asked.get(key);
		// A row with no stamp (a tab, the work board) is answered by any ask about its folder; the list's stamped
		// row keeps the one held for the focus ask.
		if (row.stamp === undefined && before?.startsWith(`${row.cwd}\n`)) continue;
		mine.set(row.sessionPath, row);
		const at = `${row.cwd}\n${row.stamp ?? ""}`;
		if (before === at) continue;
		asked.set(key, at);
		fresh.push(row);
	}
	loadTargets(device, fresh);
}

/** Asks again about every row any view holds (the window came back to the front). */
export function refreshSessionTargets(): void {
	for (const [ns, rows] of held) loadTargets(ns || undefined, [...rows.values()]);
}

let focusHooked = false;
/** Once per page: a window that comes back to the front asks again. */
export function ensureSessionTargetsOnFocus(): void {
	if (focusHooked || typeof window === "undefined") return;
	focusHooked = true;
	window.addEventListener("focus", refreshSessionTargets);
}

/** Tests: forget everything. */
export function resetSessionTargetsForTest(): void {
	asked.clear();
	askedArtwork.clear();
	held.clear();
	hydrated.clear();
	useSessionTargets.setState({ targets: {}, artworks: {} });
}
