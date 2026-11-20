/**
 * The verified-omp list (docs/design/follow-omp.md): which omp versions runners verified against each OMPdesk
 * release's code, and the one held because it failed. omp-latest.yml writes it (`recordVerdict`) to `omp-compat.json`
 * on the `omp-compat` branch; the app reads its own release's entry (main `omp-compat-source.ts`) and a pass nobody
 * asked for installs only what `followTarget` picks from it. One file, one writer, read strictly: a list of another
 * shape is not used at all (the reader keeps its last good one), so a broken or hostile file can never name a range,
 * a tag, a URL or a package; the app installs only `@oh-my-pi/pi-coding-agent` at an exact version it names itself.
 */
import { compareVersions, isNewer } from "./version";

export const OMP_COMPAT_BRANCH = "omp-compat";
export const OMP_COMPAT_FILE = "omp-compat.json";

/** A version that failed verification for one OMPdesk release: nothing installs it unasked until it passes. */
export interface OmpCompatHolding {
	version: string;
	/** When the first failing run recorded it (ISO 8601); a later failure of the same version keeps it. */
	since: string;
	/** The issue the failing run opened; null when none could be opened. */
	issue: number | null;
}

/** One OMPdesk release's entry. */
export interface OmpCompatEntry {
	/** Every omp a run verified against this release, oldest first. */
	verified: string[];
	holding: OmpCompatHolding | null;
}

/** The whole file: an entry per OMPdesk release, keyed by its version. */
export type OmpCompatList = Record<string, OmpCompatEntry>;

/** An exact release version, nothing else: no range, tag, prerelease, build, `v` or leading zero. */
const EXACT = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
/** Far more than a release ever gets; a list past it is not the workflow's. */
const MAX_VERIFIED = 2000;

export function isExactVersion(value: unknown): value is string {
	return typeof value === "string" && EXACT.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every(key => keys.includes(key));
}

function parseHolding(value: unknown): OmpCompatHolding | null | undefined {
	if (value === null) return null;
	if (!isPlainObject(value) || !hasOnly(value, ["version", "since", "issue"])) return undefined;
	const { version, since, issue } = value;
	if (!isExactVersion(version) || typeof since !== "string" || Number.isNaN(Date.parse(since))) return undefined;
	if (issue !== null && !(typeof issue === "number" && Number.isSafeInteger(issue) && issue > 0)) return undefined;
	return { version, since, issue };
}

function parseEntry(value: unknown): OmpCompatEntry | undefined {
	if (!isPlainObject(value) || !hasOnly(value, ["verified", "holding"])) return undefined;
	const { verified } = value;
	if (!Array.isArray(verified) || verified.length > MAX_VERIFIED || !verified.every(isExactVersion)) return undefined;
	const holding = parseHolding(value.holding ?? null);
	if (holding === undefined) return undefined;
	return { verified: [...verified], holding };
}

/** The file's text as the workflow writes it, or null when anything in it is of another shape. */
export function parseOmpCompat(text: string): OmpCompatList | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isPlainObject(data)) return null;
	const list: OmpCompatList = Object.create(null);
	for (const [app, value] of Object.entries(data)) {
		const entry = isExactVersion(app) ? parseEntry(value) : undefined;
		if (!entry) return null;
		list[app] = entry;
	}
	return list;
}

/** `app`'s entry; an empty one when the list names nothing for it yet (a release no run has reached). */
export function compatEntry(list: OmpCompatList, app: string): OmpCompatEntry {
	return Object.hasOwn(list, app) ? list[app] : { verified: [], holding: null };
}

function byVersion(a: string, b: string): number {
	return compareVersions(a, b) ?? 0;
}

/**
 * The omp a pass nobody asked for installs, or null: the newest of the tested omp and the verified ones that is newer
 * than the installed omp (never a step down) and not newer than the registry's latest (a version the registry this
 * omp updates from does not offer yet cannot install).
 */
export function followTarget(input: {
	installed: string;
	latest: string;
	tested: string;
	verified: readonly string[];
}): string | null {
	const candidates = [input.tested, ...input.verified].filter(
		version => isExactVersion(version) && isNewer(version, input.installed) && !isNewer(version, input.latest),
	);
	return candidates.sort(byVersion).at(-1) ?? null;
}

/** Whether a run still has to verify `omp` for `app`: neither verified nor held for it. */
export function compatPending(list: OmpCompatList, app: string, omp: string): boolean {
	const entry = compatEntry(list, app);
	return !entry.verified.includes(omp) && entry.holding?.version !== omp;
}

export type CompatVerdict = { green: true } | { green: false; at: string; issue: number | null };

/**
 * The list after a run verified (`green`) or failed `omp` against `app`'s code. Green adds it to `verified` and lets
 * go of a holding that is not newer. Red holds it (keeping the first failure's time and issue) and drops it from
 * `verified`: the newest verdict on a version wins.
 */
export function recordVerdict(list: OmpCompatList, app: string, omp: string, verdict: CompatVerdict): OmpCompatList {
	if (!isExactVersion(app) || !isExactVersion(omp)) throw new Error(`not exact versions: ${app}, ${omp}`);
	const entry = compatEntry(list, app);
	let next: OmpCompatEntry;
	if (verdict.green) {
		next = {
			verified: [...new Set([...entry.verified, omp])].sort(byVersion),
			holding: entry.holding && isNewer(entry.holding.version, omp) ? entry.holding : null,
		};
	} else {
		const same = entry.holding?.version === omp ? entry.holding : null;
		next = {
			verified: entry.verified.filter(version => version !== omp),
			holding: { version: omp, since: same?.since ?? verdict.at, issue: verdict.issue ?? same?.issue ?? null },
		};
	}
	const out: OmpCompatList = Object.create(null);
	for (const key of [...new Set([...Object.keys(list), app])].sort(byVersion)) {
		out[key] = key === app ? next : list[key];
	}
	return out;
}
