/** Main resolves the git/gh launcher and environment. The core runs the processes; the active repository-lock
 * step tracks their final reply even if its caller has already timed out or stopped. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withoutGitSelectors } from "../../../shared/git-env";
import { type CoreAnswer, core } from "../../core/process";
import { ChainBusyError, currentStepSignal, SerialChain, trackEffect } from "../../serial-chain";
import { brewBinDirs, spawnPath } from "../../shell-env";
import { findOnPath } from "../../spawn";
import { LocalCommandError } from "../types";

/** Timeout for a `git`/`gh` call that names none; commands' answer budgets count in it. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Hard cap on captured stdout; matches gh's 8 MiB output ceiling. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** How long a process that was asked to end may ignore it before it is killed outright. */
const KILL_GRACE_MS = 2_000;

const binCache = new Map<string, Promise<string | null>>();

// The spawn PATH is read on every lookup, never kept here: setup changes it while the app runs (refreshPath
// appends the managed tools dirs and drops the login-shell probe after an install), and a copy taken at the
// first git call hid a freshly installed gh until relaunch. spawnPath shares the probe it caches.

// Homebrew's prefixes are looked in too when its bin dir is not on the login-shell PATH (a shell that never
// runs `brew shellenv`, a PATH an rc file rebuilds): a gh or git installed by brew is still the user's.

/** Absolute path to `git`/`gh`, or null when not installed. */
export function resolveBin(name: "git" | "gh"): Promise<string | null> {
	let pending = binCache.get(name);
	if (!pending) {
		const platform = process.platform;
		// `<name>.exe`, then the bare name, on Windows.
		const names = platform === "win32" ? [`${name}.exe`, name] : [name];
		pending = spawnPath().then(pathEnv =>
			findOnPath(names, pathEnv, platform, platform === "darwin" ? brewBinDirs().map(dir => join(dir, name)) : []),
		);
		binCache.set(name, pending);
		// A missing binary is re-probed next call (the user may install it).
		void pending.then(bin => {
			if (!bin && binCache.get(name) === pending) binCache.delete(name);
		});
	}
	return pending;
}

/** The git `/usr/bin/git` forwards to from developer dir `dir` (`DEVELOPER_DIR` or `xcode-select -p`), when it is there. */
export function developerGit(dir: string | null): string | null {
	const git = dir?.trim() ? join(dir.trim(), "usr", "bin", "git") : null;
	return git && existsSync(git) ? git : null;
}

let trampolineTarget: Promise<string> | null = null;

/**
 * The git GUI git calls run. macOS's `/usr/bin/git` is xcrun's trampoline: every run looks the active developer
 * dir up before it starts that dir's `usr/bin/git` (measured on an M-series Mac: about 3.4 ms of CPU and 4.5 ms
 * of wall time per call, more than a `git rev-parse` itself and half again a `git status` of 500 changed files).
 * Calling the git it forwards to runs the same binary without the lookup. With no developer dir (where the
 * trampoline offers the Command Line Tools install), `/usr/bin/git` stays.
 */
async function gitBin(): Promise<string | null> {
	const found = await resolveBin("git");
	if (process.platform !== "darwin" || found !== "/usr/bin/git") return found;
	trampolineTarget ??= (async () => {
		if (process.env.DEVELOPER_DIR) return developerGit(process.env.DEVELOPER_DIR) ?? found;
		const { promise, resolve } = Promise.withResolvers<string | null>();
		execFile("/usr/bin/xcode-select", ["-p"], { timeout: 5_000 }, (error, stdout) => resolve(error ? null : stdout));
		return developerGit(await promise) ?? found;
	})();
	return trampolineTarget;
}

/** What every spawn here gets: ambient repository selectors dropped, the login shell's PATH, no optional git locks. */
async function spawnEnv(env: Record<string, string> | undefined): Promise<NodeJS.ProcessEnv> {
	// A read-only `git status` must not take `.git/index.lock` to refresh the index: the agent's own git would fail on it.
	// Ambient repository selectors (an OMPdesk started from a hook or `git bisect run`) are dropped, so git works on the
	// repository `cwd` is in; a selector the caller means (disk care's scratch GIT_INDEX_FILE) comes in `env`.
	return { ...withoutGitSelectors(process.env), PATH: await spawnPath(), GIT_OPTIONAL_LOCKS: "0", ...env };
}

/** Never page, never prompt for credentials from a headless GUI call; paths unquoted, no colour. */
const GIT_ARGS = ["-c", "core.quotepath=false", "-c", "color.ui=false"];
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" };

/** How a git or a gh runs, as the core process is told it: the core spawns `bin` with `args` first and exactly `env`. */
export interface CoreRunner {
	bin: string;
	args: string[];
	env: Record<string, string>;
	timeoutMs: number;
	maxBytes: number;
}

/** `spawnEnv` with `extra` over it, as the plain strings a request carries. */
async function runnerEnv(extra: Record<string, string>): Promise<Record<string, string>> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(await spawnEnv(extra))) if (value !== undefined) env[name] = value;
	return env;
}

async function availableGitRunner(): Promise<CoreRunner | null> {
	const bin = await gitBin();
	if (!bin) return null;
	return {
		bin,
		args: GIT_ARGS,
		env: await runnerEnv(GIT_ENV),
		timeoutMs: DEFAULT_TIMEOUT_MS,
		maxBytes: DEFAULT_MAX_BYTES,
	};
}

/** This process's git rules for a git the core runs (the PATH and environment can change between calls). */
export async function gitRunner(): Promise<CoreRunner> {
	const runner = await availableGitRunner();
	if (!runner) throw new Error("git is not installed or not on PATH");
	return runner;
}

/** Never prompt, never check for a newer gh, no colour. */
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };

/** This process's rules for the gh (or, for the sign-in's git calls, the git) at `bin` that the core runs, read now. */
export async function ghRunner(bin: string): Promise<CoreRunner> {
	return { bin, args: [], env: await runnerEnv(GH_ENV), timeoutMs: DEFAULT_TIMEOUT_MS, maxBytes: DEFAULT_MAX_BYTES };
}

/** Room past a request's git timeouts for its disk work, the core round trip and the end of a git that ran past one. */
const CORE_SLACK_MS = KILL_GRACE_MS + 5_000;

/**
 * A request to the core whose processes run with this process's rules (`params` builds it, runners included), held to
 * the repository-lock step it is made in: it never starts in a stopped step; when its step
 * is stopped it fails at once with the stop, the core ends the process it runs (asked, then killed `KILL_GRACE_MS`
 * later) and starts no other, and the lock's next holder waits until the core is done with the request, which is once
 * every process it started exited. `timeoutMs` is how long its processes may take in all; the call waits that plus
 * `CORE_SLACK_MS`.
 */
async function heldRequest<T>(method: string, params: () => Promise<object>, timeoutMs: number): Promise<T> {
	return (await heldAnswer<T>(method, params, timeoutMs)).result;
}

/** `heldRequest` with the answer's `bin` tail. */
export async function heldAnswer<T>(
	method: string,
	params: () => Promise<object>,
	timeoutMs: number,
): Promise<CoreAnswer<T>> {
	const hold = currentStepSignal();
	if (hold?.aborted) throw hold.reason;
	const request = await params();
	if (hold?.aborted) throw hold.reason;
	const ended = Promise.withResolvers<void>();
	void trackEffect(method, ended.promise);
	const answer = core().call<T>(method, request, {
		timeoutMs: timeoutMs + CORE_SLACK_MS,
		signal: hold,
		onEnded: ended.resolve,
	});
	if (!hold) return answer;
	const stopped = Promise.withResolvers<never>();
	const stop = () => stopped.reject(hold.reason);
	hold.addEventListener("abort", stop, { once: true });
	try {
		return await Promise.race([answer, stopped.promise]);
	} finally {
		hold.removeEventListener("abort", stop);
	}
}

/**
 * A git request to the core (`gitRunner`), held as `heldRequest` says. `rounds` is how many gits it runs one after
 * another at the default timeout, `slowMs` the timeout of its slow one (a hook, the network, a merge); the call waits
 * for both.
 */
export async function coreGit<T>(method: string, params: object, rounds: number, slowMs = 0): Promise<T> {
	return (await coreGitAnswer<T>(method, params, rounds, slowMs)).result;
}

/** `coreGit` with the answer's `bin` tail (file contents the request read). */
export function coreGitAnswer<T>(method: string, params: object, rounds: number, slowMs = 0): Promise<CoreAnswer<T>> {
	// A diff checks its path first; an unknown project is cached even when git is unavailable.
	return heldAnswer(
		method,
		async () => ({
			...params,
			git: await (method === "git.diff" || method === "git.projectOrigin" ? availableGitRunner() : gitRunner()),
		}),
		rounds * DEFAULT_TIMEOUT_MS + slowMs,
	);
}

/**
 * A request to the core whose params already carry what it runs (disk care's walks, copies and removals, which run no
 * process; the GitHub sign-in's requests, with the gh and git runners `ghRunner` built), held as `heldRequest` says: a
 * stopped step cancels it and the lock's next holder waits until the core is done with it. `timeoutMs` is how long its
 * work may take.
 */
export function coreHeld<T>(method: string, params: object, timeoutMs: number): Promise<T> {
	return heldRequest(method, async () => params, timeoutMs);
}

/**
 * A gh request to the core (`gh.*`, `routines.github`), held as `heldRequest` says: gh as `find` finds it (`resolveBin`
 * unless a test hands a stand-in; `null` when it is not installed, which the core refuses as `gh_missing` where the
 * request's rules say) and git for the checkout root (`null` when missing). `timeoutMs` is how long its gh and git
 * runs may take in all.
 */
export function coreGh<T>(
	method: string,
	params: object,
	timeoutMs: number,
	find: () => Promise<string | null> = () => resolveBin("gh"),
): Promise<T> {
	return heldRequest(
		method,
		async () => {
			const bin = await find();
			return { ...params, gh: bin ? await ghRunner(bin) : null, git: await gitRunner().catch(() => null) };
		},
		timeoutMs,
	);
}

/** Run gh at `bin` (core `gh.run`); resolves stdout text, rejects with gh's stderr on a non-zero exit or a cut output. */
export function gh(
	cwd: string,
	bin: string,
	args: string[],
	opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<string> {
	return heldRequest(
		"gh.run",
		async () => ({ gh: await ghRunner(bin), cwd, args, timeoutMs: opts.timeoutMs, env: opts.env }),
		opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
}

/** `ghText`'s timeout. */
export const GH_TEXT_TIMEOUT_MS = 30_000;

/**
 * Run gh (or git) at `bin` with gh's non-interactive env to completion as text (core `gh.text`); never rejects on a
 * non-zero exit, rejects when it could not run or ran past `GH_TEXT_TIMEOUT_MS`.
 */
export function ghText(
	cwd: string,
	bin: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	return heldRequest("gh.text", async () => ({ gh: await ghRunner(bin), cwd, args }), GH_TEXT_TIMEOUT_MS);
}

/**
 * The longest one holder keeps a repository's lock. The longest legitimate holder is `worktree_create`'s answer
 * budget (six git steps, `git worktree add`, the seed and setup hook: 16 min); a holder past this is hung.
 */
export const REPO_LOCK_HOLD_MS = 20 * 60_000;

const repoLocks = new Map<string, SerialChain>();

/**
 * Per-repository mutex for worktree/branch/config mutations (git uses O_EXCL lock files with no waiter).
 * A holder that runs past `REPO_LOCK_HOLD_MS` fails with a `StepStalledError`, the git processes it started end and
 * it starts no more (nor does any file call: `fenced-fs`). The repository's next mutation runs once the git process
 * and the file calls the stopped holder already had running ended; while they still run a minute after the stop, every
 * mutation fails at once with a `repo_busy` error naming them (reads take no lock and are not held).
 */
export function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
	let chain = repoLocks.get(root);
	if (!chain) {
		chain = new SerialChain({ name: "repository lock", maxStepMs: REPO_LOCK_HOLD_MS });
		repoLocks.set(root, chain);
	}
	const held = chain;
	const run = held
		.run(() => fn(), root)
		.catch((error: unknown) => {
			// Refused, not run: a stopped holder's git or file call still runs on this repository.
			if (error instanceof ChainBusyError) throw new LocalCommandError(error.message, "repo_busy");
			throw error;
		});
	const release = () => {
		if (held.pending === 0 && repoLocks.get(root) === held) repoLocks.delete(root);
	};
	// A chain that a stopped holder still holds stays registered until that ended: the next holder checks it.
	const retire = () => {
		if (!held.held) release();
		else void held.released().then(release);
	};
	run.then(retire, retire);
	return run;
}
