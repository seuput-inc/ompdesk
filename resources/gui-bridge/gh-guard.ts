/**
 * The `gh` every OMPdesk session finds first on its PATH (launchers in `gh-bin/`, the folder main puts first on a tab
 * omp's PATH, `OMP_GUI_GH_GUARD`; rules in gh-guard-core.ts, `.omp/rules/waste-guards.md` › Guard 6). It runs for every
 * `gh` an agent's command starts, piped or from a script: a finished run's or job's log comes from this session's scratch
 * folder after its first fetch, a wide read is refused below the quota floor, a watch refreshes at most once a minute.
 * A command the person runs (the composer's `!`, a terminal) carries no `PI_TOOL_CALL_ID` (stock sets it only for the
 * agent's tool calls) and goes to the real gh untouched. Everything else is passed to the real gh as it is.
 */
import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, constants as osConstants } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
	belowFloor,
	classify,
	GH_GUARD_ENV,
	type GhResource,
	GUARD_MARKER,
	jobLogFile,
	type LogRequest,
	logHeader,
	parseRateLimit,
	parseReading,
	type QuotaReading,
	readingStale,
	refusal,
	runLogFile,
} from "./gh-guard-core";

const LOCK_STALE_MS = 30_000;

/** The first `gh` on PATH that is not a wrapper (`gh.exe` on Windows); undefined when there is none. */
export function realGh(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const names = process.platform === "win32" ? ["gh.exe"] : ["gh"];
	for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
		if (!dir || dir === env[GH_GUARD_ENV]) continue;
		for (const name of names) {
			const file = join(dir, name);
			try {
				if (!statSync(file).isFile()) continue;
				if (process.platform !== "win32") accessSync(file, constants.X_OK);
				// A launcher is a few lines; a real gh is megabytes and never holds the marker in its first bytes.
				if (statSync(file).size < 4096 && readFileSync(file, "utf8").includes(GUARD_MARKER)) continue;
				return file;
			} catch {
				// not there, or not runnable
			}
		}
	}
	return undefined;
}

/** The computer's shared quota folder: `OMPDESK_GH_BUDGET_DIR`, else `~/.cache/ompdesk/gh-budget` (as the heavy pool). */
export function budgetDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.OMPDESK_GH_BUDGET_DIR || join(homedir(), ".cache", "ompdesk", "gh-budget");
}

function writeAtomic(file: string, data: string | Uint8Array): void {
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, data);
	renameSync(temp, file);
}

function readStored(file: string): QuotaReading | undefined {
	try {
		return parseReading(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * The account's quota as this computer last read it, read again from GitHub (`gh api rate_limit`, which the quota does
 * not count) when the reading is a minute old: one session at a time takes the lock and reads, the others keep the
 * reading they have. Undefined when nothing could be read (offline, not signed in): the caller lets the call run.
 */
export function quotaReading(
	gh: string,
	env: NodeJS.ProcessEnv = process.env,
	now = Date.now(),
): QuotaReading | undefined {
	const dir = budgetDir(env);
	const file = join(dir, "rate-limit.json");
	const stored = readStored(file);
	if (!readingStale(stored, now)) return stored;
	const lock = join(dir, "rate-limit.lock");
	try {
		mkdirSync(dir, { recursive: true });
		mkdirSync(lock);
	} catch {
		try {
			if (now - statSync(lock).mtimeMs < LOCK_STALE_MS) return stored;
			rmdirSync(lock);
			mkdirSync(lock);
		} catch {
			return stored;
		}
	}
	try {
		const read = spawnSync(gh, ["api", "rate_limit"], { encoding: "utf8", env, timeout: 15_000, windowsHide: true });
		const reading = read.status === 0 ? parseRateLimit(read.stdout, Date.now()) : undefined;
		if (!reading) return stored;
		writeAtomic(file, JSON.stringify(reading));
		return reading;
	} catch {
		return stored;
	} finally {
		try {
			rmdirSync(lock);
		} catch {
			// another session took a stale lock over
		}
	}
}

/** The refusal for a wide call on `resource`, or undefined when the quota allows it (or cannot be read). */
export function wideRefusal(
	args: readonly string[],
	resource: GhResource,
	gh: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const reading = quotaReading(gh, env);
	return reading && belowFloor(reading, resource) ? refusal(args, resource, reading) : undefined;
}

/** Where a refused tool call's message waits for the bridge, which turns the call into an error (waste-guards.ts). */
export function refusedFile(scratch: string, toolCallId: string): string {
	return join(scratch, "gh-refused", toolCallId.replace(/[^\w.-]/g, "_"));
}

function refuse(message: string, env: NodeJS.ProcessEnv): never {
	process.stderr.write(`${message}\n`);
	const scratch = env.OMP_GUI_SCRATCH;
	const id = env.PI_TOOL_CALL_ID;
	if (scratch && id) {
		try {
			writeAtomic(refusedFile(scratch, id), message);
		} catch {
			// the message is on stderr either way
		}
	}
	process.exit(1);
}

function exitWith(status: number | null, signal: NodeJS.Signals | null): never {
	process.exit(status ?? (signal ? 128 + (osConstants.signals[signal] ?? 1) : 1));
}

function passThrough(gh: string, args: readonly string[]): never {
	const run = spawnSync(gh, args, { stdio: "inherit", windowsHide: true });
	if (run.error) {
		process.stderr.write(`gh: ${run.error.message}\n`);
		process.exit(1);
	}
	exitWith(run.status, run.signal);
}

/** Runs one `gh api` read for the cache's bookkeeping; tab-separated fields, or undefined when it failed. */
function apiFields(gh: string, path: string, jq: string, env: NodeJS.ProcessEnv): string[] | undefined {
	const read = spawnSync(gh, ["api", path, "--jq", `${jq} | @tsv`], {
		encoding: "utf8",
		env,
		timeout: 30_000,
		windowsHide: true,
	});
	return read.status === 0 ? read.stdout.trim().split("\t") : undefined;
}

interface Owner {
	run: string;
	attempt: number;
	completed: boolean;
	repo?: string;
}

function runOwner(gh: string, run: string, repo: string | undefined, env: NodeJS.ProcessEnv): Owner | undefined {
	const fields = apiFields(
		gh,
		`repos/${repo ?? "{owner}/{repo}"}/actions/runs/${run}`,
		"[.run_attempt, .status, .repository.full_name]",
		env,
	);
	const attempt = Number(fields?.[0]);
	if (!fields || !Number.isInteger(attempt) || attempt < 1) return undefined;
	return { run, attempt, completed: fields[1] === "completed", repo: fields[2] || repo };
}

function jobOwner(gh: string, job: string, repo: string | undefined, env: NodeJS.ProcessEnv): Owner | undefined {
	const fields = apiFields(
		gh,
		`repos/${repo ?? "{owner}/{repo}"}/actions/jobs/${job}`,
		"[.run_id, .run_attempt, .status, .html_url]",
		env,
	);
	const attempt = Number(fields?.[1]);
	if (!fields?.[0] || !Number.isInteger(attempt) || attempt < 1) return undefined;
	const fromUrl = /github\.com\/([^/]+\/[^/]+)\/actions\//.exec(fields[3] ?? "")?.[1];
	return { run: fields[0], attempt, completed: fields[2] === "completed", repo: fromUrl ?? repo };
}

async function serve(file: string): Promise<never> {
	if (file.endsWith(".zip")) process.stderr.write(`${readFileSync(`${file}.header`, "utf8")}\n`);
	await Bun.write(Bun.stdout, Bun.file(file));
	process.exit(0);
}

/** `args` fetching `attempt` of the run: `--attempt` for `gh run view`, the attempts endpoint for `gh api`. */
function attemptArgs(args: readonly string[], log: LogRequest, attempt: number): string[] {
	if (log.of !== "run" || log.attempt !== undefined) return [...args];
	if (log.mode !== "api") return [...args, "--attempt", String(attempt)];
	return args.map(arg => arg.replace(/\/actions\/runs\/(\d+)\/logs$/, `/actions/runs/$1/attempts/${attempt}/logs`));
}

/**
 * A log fetch: from the cache when this session fetched it before, else from GitHub, kept when it was a finished
 * attempt's (a running one's log still grows). An attempt that cannot be told is fetched as asked and not kept.
 */
async function serveLog(
	gh: string,
	args: readonly string[],
	log: LogRequest,
	wide: boolean,
	env: NodeJS.ProcessEnv,
): Promise<never> {
	const scratch = env.OMP_GUI_SCRATCH;
	const floorCheck = () => {
		const refused = wide ? wideRefusal(args, "core", gh, env) : undefined;
		if (refused) refuse(refused, env);
	};
	if (!scratch) {
		floorCheck();
		passThrough(gh, args);
	}
	const root = join(scratch, "gh-logs");
	let owner: Owner | undefined;
	let file: string;
	if (log.of === "run") {
		let attempt = log.attempt;
		if (attempt === undefined) {
			// Reruns reuse the run id: which attempt is the latest decides which log this is.
			owner = runOwner(gh, log.run, log.repo, env);
			if (!owner) {
				floorCheck();
				passThrough(gh, args);
			}
			attempt = owner.attempt;
		}
		file = join(root, runLogFile(log.run, attempt, log.mode));
		if (existsSync(file)) await serve(file);
		floorCheck();
		owner ??= runOwner(gh, log.run, log.repo, env);
		if (!owner || (owner.attempt === attempt && !owner.completed)) passThrough(gh, args);
		owner = { ...owner, attempt, completed: true };
	} else {
		file = join(root, jobLogFile(log.job, log.mode));
		if (existsSync(file)) await serve(file);
		floorCheck();
		owner = jobOwner(gh, log.job, log.repo, env);
		if (!owner?.completed) passThrough(gh, args);
	}
	const fetched = spawnSync(gh, attemptArgs(args, log, owner.attempt), {
		stdio: ["inherit", "pipe", "inherit"],
		maxBuffer: 1 << 30,
		windowsHide: true,
	});
	if (fetched.status !== 0 || fetched.error) {
		if (fetched.stdout?.length) await Bun.write(Bun.stdout, fetched.stdout);
		if (fetched.error) process.stderr.write(`gh: ${fetched.error.message}\n`);
		exitWith(fetched.status, fetched.signal);
	}
	const header = logHeader(log, owner, new Date());
	if (file.endsWith(".zip")) {
		writeAtomic(`${file}.header`, header);
		writeAtomic(file, fetched.stdout);
	} else writeAtomic(file, Buffer.concat([Buffer.from(`${header}\n`), fetched.stdout]));
	return serve(file);
}

async function main(args: string[], env: NodeJS.ProcessEnv): Promise<never> {
	const gh = realGh(env);
	if (!gh) {
		process.stderr.write("gh: command not found (OMPdesk's gh guard found no gh after itself on PATH)\n");
		process.exit(127);
	}
	// The person's own command: never cached, refused or changed.
	if (!env.PI_TOOL_CALL_ID) passThrough(gh, args);
	const call = classify(args);
	switch (call.kind) {
		case "free":
		case "narrow":
			passThrough(gh, args);
			break;
		case "wide": {
			const refused = wideRefusal(args, call.resource, gh, env);
			if (refused) refuse(refused, env);
			passThrough(gh, args);
			break;
		}
		case "watch": {
			const refused = wideRefusal(args, call.resource, gh, env);
			if (refused) refuse(refused, env);
			passThrough(gh, call.args);
			break;
		}
		case "log":
			return serveLog(gh, args, call.log, call.wide, env);
	}
	process.exit(0);
}

if (import.meta.main) await main(process.argv.slice(2), process.env);
