/**
 * Rules of the `gh` wrapper every OMPdesk session finds first on its PATH (wiring: gh-guard.ts; the launchers in
 * `gh-bin/`; `.omp/rules/waste-guards.md` › Guard 6). The GitHub account's REST quota (5000 requests an hour, shared by
 * every token and project of the user) was emptied by one session reading past runs' logs (20 Nov 2026, core 0/5000
 * for 13 minutes while another project waited to merge). Three rules, all pure here:
 *
 * - A finished run's or job's log is fetched once per session and served from the session's scratch folder after that
 *   (`logRequest`, `runLogFile`, `jobLogFile`).
 * - Below `QUOTA_FLOOR` left on the resource a call spends (`core` for REST, `graphql` for `gh pr` and kin), wide reads
 *   (lists, paging, a whole run's logs, a new watch) are refused with what is left and when it resets
 *   (`classify`, `refusal`); narrow ones (one run's failed jobs, one job's log, a dispatch, a merge) still run.
 * - A watch never refreshes faster than once a minute (`watchArgs`): `gh run watch` refreshes every 3 s by default,
 *   each refresh reading the run and its jobs (about 2,400 requests an hour for one watch).
 *
 * No omp imports and no IO: the GUI's vitest runs it (src/main/gh-guard.test.ts).
 */

/** The variable main names the launchers' folder in (session-owned); the folder goes first on the session's PATH. */
export const GH_GUARD_ENV = "OMP_GUI_GH_GUARD";
/** The launchers' folder inside the bridge's. */
export const GH_BIN_DIR = "gh-bin";
/** In each launcher: a folder whose `gh` holds it is a wrapper, never the real gh. */
export const GUARD_MARKER = "OMPdesk gh guard";

export type GhResource = "core" | "graphql";

/** Requests left below which a wide read is refused, per resource. */
export const QUOTA_FLOOR = 1500;
/** The slowest a watch may refresh, in seconds. */
export const WATCH_MIN_INTERVAL_S = 60;
/** How old the computer's shared quota reading may be before a wide call reads it again (`gh api rate_limit` is free). */
export const QUOTA_READING_MAX_AGE_MS = 60_000;

export type LogMode = "log" | "log-failed" | "api";

/** A log fetch the wrapper can serve from its cache: a run's (by attempt) or a job's (job ids are new per attempt). */
export type LogRequest =
	| { of: "run"; run: string; attempt?: number; mode: LogMode; repo?: string }
	| { of: "job"; job: string; mode: LogMode; repo?: string };

export type GhCall =
	/** Not a GitHub request worth guarding: `api rate_limit`, `auth`, `help`, `--version`, config. */
	| { kind: "free" }
	/** One request or a write (a dispatch, a merge, one run's status): always runs. */
	| { kind: "narrow"; resource: GhResource }
	/** Many requests (a list, paging, a download): refused below the floor. */
	| { kind: "wide"; resource: GhResource }
	/** A refreshing watch: refused below the floor, its interval raised to a minute. */
	| { kind: "watch"; resource: GhResource; args: string[] }
	/** A log fetch: served from the cache; `wide` (a whole run's logs) is refused below the floor on a miss. */
	| { kind: "log"; resource: "core"; log: LogRequest; wide: boolean };

/** `gh` commands whose requests go to GraphQL (pull requests, issues, repositories, projects). */
const GRAPHQL_COMMANDS: Record<string, true> = {
	pr: true,
	issue: true,
	repo: true,
	project: true,
	discussion: true,
	label: true,
	status: true,
};
const FREE_COMMANDS: Record<string, true> = {
	auth: true,
	help: true,
	config: true,
	alias: true,
	completion: true,
	extension: true,
	version: true,
};
/** Flags of `gh api` that take a value, so the word after one is not the endpoint. */
const API_VALUE_FLAG =
	/^(?:-X|--method|-H|--header|-f|--raw-field|-F|--field|-q|--jq|-t|--template|--hostname|--input|--cache|-p|--preview)$/;
/** Flags of `gh run view` that take a value. */
const VIEW_VALUE_FLAG = /^(?:-a|--attempt|-j|--job|--json|-q|--jq|-t|--template|-R|--repo)$/;

function flagValue(args: readonly string[], names: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		for (const name of names) {
			if (arg === name) return args[i + 1];
			if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
		}
	}
	return undefined;
}

function hasFlag(args: readonly string[], name: string): boolean {
	return args.some(arg => arg === name || arg.startsWith(`${name}=`));
}

function apiCall(args: readonly string[]): GhCall {
	let endpoint: string | undefined;
	let extra = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (API_VALUE_FLAG.test(arg)) {
			extra = true;
			i++;
		} else if (arg === "--allow-escape-sequences") {
			// gh 2.97+ refuses a body holding terminal escapes without it (scripts/watch-run.ts passes it): the log as is.
		} else if (arg.startsWith("-")) extra = true;
		else if (endpoint === undefined) endpoint = arg;
	}
	if (endpoint === undefined) return { kind: "free" };
	const path = endpoint.replace(/^\/+/, "").replace(/\?.*$/, "");
	if (path === "rate_limit") return { kind: "free" };
	const resource: GhResource = path === "graphql" ? "graphql" : "core";
	const repo = /^repos\/([^/]+\/[^/]+)\//.exec(path)?.[1];
	const job = /\/actions\/jobs\/(\d+)\/logs$/.exec(path);
	// A log fetch with other flags (a method, a jq filter, headers) is passed on as it is: its output is not the log.
	if (job && !extra)
		return { kind: "log", resource: "core", log: { of: "job", job: job[1], mode: "api", repo }, wide: false };
	const run = /\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?\/logs$/.exec(path);
	if (run && !extra)
		return {
			kind: "log",
			resource: "core",
			log: { of: "run", run: run[1], ...(run[2] ? { attempt: Number(run[2]) } : {}), mode: "api", repo },
			wide: true,
		};
	if (job || run) return { kind: run ? "wide" : "narrow", resource };
	return { kind: hasFlag(args, "--paginate") ? "wide" : "narrow", resource };
}

function runViewCall(args: readonly string[]): GhCall {
	const log = hasFlag(args, "--log") ? "log" : hasFlag(args, "--log-failed") ? "log-failed" : undefined;
	if (!log) return { kind: "narrow", resource: "core" };
	const repo = flagValue(args, ["-R", "--repo"]);
	const job = flagValue(args, ["-j", "--job"]);
	if (job && /^\d+$/.test(job))
		return { kind: "log", resource: "core", log: { of: "job", job, mode: log, repo }, wide: false };
	let run: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (VIEW_VALUE_FLAG.test(arg)) i++;
		else if (!arg.startsWith("-") && run === undefined)
			run = /^\d+$/.exec(arg)?.[0] ?? /\/runs\/(\d+)/.exec(arg)?.[1];
	}
	// No run id (gh would ask which run): nothing to key a cache by.
	if (!run) return { kind: log === "log" ? "wide" : "narrow", resource: "core" };
	const attempt = flagValue(args, ["-a", "--attempt"]);
	const parsed = attempt && /^\d+$/.test(attempt) ? Number(attempt) : undefined;
	return {
		kind: "log",
		resource: "core",
		log: { of: "run", run, ...(parsed ? { attempt: parsed } : {}), mode: log, repo },
		// One run's failed jobs is the narrow read a person needs to fix a red run; every job's log is not.
		wide: log === "log",
	};
}

/**
 * `args` with its refresh interval at least `WATCH_MIN_INTERVAL_S` (a longer one stays): `-i N`, `-iN`, `--interval N`,
 * `--interval=N`, or none (gh's default, 3 s for `run watch`, 10 s for `pr checks --watch`) given.
 */
export function watchArgs(args: readonly string[]): string[] {
	const out = [...args];
	let seen = false;
	for (let i = 0; i < out.length; i++) {
		const arg = out[i] ?? "";
		let value: string | undefined;
		let at = -1;
		let prefix = "";
		if (arg === "-i" || arg === "--interval") {
			value = out[i + 1];
			at = i + 1;
		} else if (arg.startsWith("--interval=")) {
			value = arg.slice(11);
			at = i;
			prefix = "--interval=";
		} else if (/^-i\d+$/.test(arg)) {
			value = arg.slice(2);
			at = i;
			prefix = "-i";
		} else continue;
		seen = true;
		const seconds = Number(value);
		if (!Number.isFinite(seconds) || seconds < WATCH_MIN_INTERVAL_S) out[at] = `${prefix}${WATCH_MIN_INTERVAL_S}`;
	}
	if (!seen) out.push("--interval", String(WATCH_MIN_INTERVAL_S));
	return out;
}

/** What a `gh` invocation (its arguments, without `gh`) costs and how the wrapper treats it. */
export function classify(args: readonly string[]): GhCall {
	const [command, sub] = args;
	if (command === undefined || command.startsWith("-") || Object.hasOwn(FREE_COMMANDS, command))
		return { kind: "free" };
	const rest = args.slice(2);
	if (command === "api") return apiCall(args.slice(1));
	const resource: GhResource = Object.hasOwn(GRAPHQL_COMMANDS, command) ? "graphql" : "core";
	if (command === "run" && sub === "watch") return { kind: "watch", resource, args: watchArgs(args) };
	if (command === "pr" && sub === "checks" && hasFlag(rest, "--watch"))
		return { kind: "watch", resource, args: watchArgs(args) };
	if (command === "run" && sub === "view") return runViewCall(rest);
	if (command === "run" && sub === "download") return { kind: "wide", resource };
	if (sub === "list" || sub === "status" || hasFlag(rest, "--paginate")) return { kind: "wide", resource };
	return { kind: "narrow", resource };
}

/** One resource of `gh api rate_limit`'s `resources`. */
export interface QuotaResource {
	limit: number;
	remaining: number;
	/** Unix seconds. */
	reset: number;
}

/** The computer's shared reading of the account's quota. */
export interface QuotaReading {
	/** Unix milliseconds the reading was taken. */
	at: number;
	core?: QuotaResource;
	graphql?: QuotaResource;
}

/** `value[key]` of parsed JSON; undefined when `value` is no object. */
function member(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function resource(value: unknown): QuotaResource | undefined {
	const limit = member(value, "limit");
	const remaining = member(value, "remaining");
	const reset = member(value, "reset");
	return typeof limit === "number" && typeof remaining === "number" && typeof reset === "number"
		? { limit, remaining, reset }
		: undefined;
}

function json(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The reading from `gh api rate_limit`'s JSON; undefined when it is not one. */
export function parseRateLimit(text: string, at: number): QuotaReading | undefined {
	const resources = member(json(text), "resources");
	const reading: QuotaReading = {
		at,
		core: resource(member(resources, "core")),
		graphql: resource(member(resources, "graphql")),
	};
	return reading.core || reading.graphql ? reading : undefined;
}

/** A stored reading, or undefined when the file holds none. */
export function parseReading(text: string): QuotaReading | undefined {
	const parsed = json(text);
	const at = member(parsed, "at");
	return typeof at === "number"
		? { at, core: resource(member(parsed, "core")), graphql: resource(member(parsed, "graphql")) }
		: undefined;
}

/** Whether `reading` is too old to judge by at `now` (a reading of a passed reset is old too). */
export function readingStale(reading: QuotaReading | undefined, now: number): boolean {
	if (!reading) return true;
	if (now - reading.at >= QUOTA_READING_MAX_AGE_MS || now < reading.at) return true;
	return [reading.core, reading.graphql].some(r => r !== undefined && r.reset * 1000 <= now);
}

/** True when a wide call on `resource` must be refused by `reading` (no reading: the call runs). */
export function belowFloor(reading: QuotaReading | undefined, resource: GhResource): boolean {
	const left = reading?.[resource];
	return left !== undefined && left.remaining < QUOTA_FLOOR;
}

function clock(unixS: number): string {
	const date = new Date(unixS * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())} (${date.toISOString().replace(/\.\d+Z$/, "Z")})`;
}

function left(name: GhResource, value: QuotaResource | undefined): string {
	return value ? `${name} ${value.remaining} of ${value.limit} left, resets ${clock(value.reset)}` : `${name} unknown`;
}

/**
 * The error a refused call ends with: what is left of each resource and when it resets, and the narrow reads that still
 * run (one run's failed jobs, served from this session's cache after the first fetch).
 */
export function refusal(args: readonly string[], resource: GhResource, reading: QuotaReading): string {
	const what = `gh ${args.join(" ")}`;
	const reset = reading[resource];
	return [
		`OMPdesk refused \`${what}\`: the GitHub account's ${resource} quota, shared by every session and project of this account, is below its floor of ${QUOTA_FLOOR} (${left("core", reading.core)}; ${left("graphql", reading.graphql)}).`,
		`Wide reads (lists, paging, a whole run's logs, a new watch) run again ${reset ? `after ${clock(reset.reset)}` : "after the reset"}. Still allowed now: one run's failed jobs, \`gh run view <run> --log-failed\` (served from this session's cache after its first fetch), one job's log (\`gh run view --job <job> --log\`), a dispatch, a rerun, a merge.`,
		"This is an error, not an empty result: nothing was read.",
	].join("\n");
}

/** A log's place in the cache folder: `run-<id>/attempt-<n>/<mode>.log`, a zip for the API's run logs. */
export function runLogFile(run: string, attempt: number, mode: LogMode): string {
	return `run-${run}/attempt-${attempt}/${mode === "api" ? "api.zip" : `${mode}.log`}`;
}

/** A job's log: job ids are new per attempt, so the id alone keys it; its header names the run and attempt. */
export function jobLogFile(job: string, mode: LogMode): string {
	return `job-${job}/${mode}.log`;
}

/** The line every served log starts with (stderr for a zip). */
export function logHeader(
	log: LogRequest,
	owner: { run: string; attempt: number; repo?: string },
	fetchedAt: Date,
): string {
	const flag = log.mode === "api" ? "gh api" : `--${log.mode}`;
	const of = log.of === "job" ? `job ${log.job} of run ${owner.run}` : `run ${owner.run}`;
	return `[OMPdesk gh log cache] ${of} attempt ${owner.attempt}${owner.repo ? ` (${owner.repo})` : ""}, ${flag}, fetched ${fetchedAt.toISOString()}; served from this session's scratch folder, not from GitHub`;
}
