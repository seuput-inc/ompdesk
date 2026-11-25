/**
 * CI results of a session's pushes reach that session (rules: ./ci-watch-core.ts, contracts: ./ci-watch-contracts.ts,
 * control-tools.md › CI results of a session's pushes; after Orca I1–I12). A bash call of any agent of this omp that
 * ran `git push` to a GitHub host or `gh pr create` is journaled as an `ompdesk-ci-watch` entry; one engine per omp
 * then reads the pushed commit's workflow runs with stock's `gh_run_watch` internals and, once they settle, adds one
 * displayed `ompdesk-ci` message to the main session between turns (no turn starts; the model reads it next turn).
 *
 * Only non-modifying events: `tool_execution_start`/`tool_execution_end`, never a `tool_result` handler (waste-guards.md
 * › What the tool_result hook costs). The journal, not process state, carries the watches, so a relaunch keeps
 * watching and a result is never told twice.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { GhRunJobSnapshot, GhRunSnapshot } from "@oh-my-pi/pi-coding-agent/tools/details/github";
import type * as GhCommon from "@oh-my-pi/pi-coding-agent/tools/gh-common";
import type * as GhRunWatch from "@oh-my-pi/pi-coding-agent/tools/gh-run-watch";
import type * as GithubUtils from "@oh-my-pi/pi-coding-agent/utils/github";
import { guard, probe } from "../health";
import { CI_MESSAGE_TYPE, CI_WATCH_END_ENTRY, CI_WATCH_ENTRY, type CiResultDetails } from "./ci-watch-contracts";
import {
	CI_FIRST_READ_MS,
	CI_POLL_MS,
	type CiEndReason,
	type CiTarget,
	type CiWatchRecord,
	ciDeadline,
	ciFailure,
	ciResultText,
	isDelivered,
	isPushCommand,
	parseGitPush,
	parsePrCreate,
	pendingWatches,
	readVerdict,
	retryDelay,
} from "./ci-watch-core";
import { boundEnv, errorMessage } from "./shared";

interface Stock {
	runs: typeof GhRunWatch;
	common: typeof GhCommon;
	gh: (typeof GithubUtils)["github"];
}

interface Armed {
	watch: CiWatchRecord;
	supersededAt?: number;
	failures: number;
	/** The full head sha, once resolved (a PR's or a branch's head, or git's abbreviated sha expanded). */
	sha?: string;
	/** A PR's head branch, once resolved. */
	branch?: string;
	timer?: ReturnType<typeof setTimeout>;
	/** Stock's cache of finished runs' jobs across this watch's reads. */
	jobs: Map<number, GhRunJobSnapshot[]>;
}

/** The main agent's `pi` (the first install; a subagent's rebinding never replaces it). */
let mainPi: ExtensionAPI | undefined;
let stopped = false;
/** Watches of the current session being read, by id. */
const armed = new Map<string, Armed>();
/** Results that settled while a turn ran: delivered once the session is idle. */
const held = new Map<string, CiResultDetails>();
/** Ids handed to stock this process (its idle append is asynchronous, the journal check alone could miss one). */
const sent = new Set<string>();
/** Bash calls that may push, by tool call id, until their output comes back. */
const pushCalls = new Set<string>();
let stockLoad: Promise<Stock | undefined> | undefined;

function mainSession() {
	return mainPi?.pi.AgentRegistry.global().get(mainPi.pi.MAIN_AGENT_ID)?.session;
}

/** Stock's GitHub internals, loaded at the first push (literal specifiers: health.ts LOADERS). Undefined on an omp without them. */
function loadStock(): Promise<Stock | undefined> {
	stockLoad ??= (async () => {
		const env = boundEnv();
		const unavailable = env ? await probe(env, ["ciWatch"]) : [];
		if (unavailable.length > 0) {
			mainPi?.logger.warn("gui-bridge: CI watch is off on this omp", { missing: unavailable[0]?.missing });
			return undefined;
		}
		const [runs, common, utils] = await Promise.all([
			import("../omp/pi-coding-agent/tools/gh-run-watch"),
			import("../omp/pi-coding-agent/tools/gh-common"),
			import("../omp/pi-coding-agent/utils/github"),
		]);
		return { runs, common, gh: utils.github };
	})().catch((error: unknown) => {
		mainPi?.logger.warn("gui-bridge: CI watch could not load stock's GitHub tools", { error: errorMessage(error) });
		return undefined;
	});
	return stockLoad;
}

function end(id: string, reason: CiEndReason): void {
	const entry = armed.get(id);
	if (entry) clearTimeout(entry.timer);
	armed.delete(id);
	held.delete(id);
	try {
		mainSession()?.sessionManager.appendCustomEntry(CI_WATCH_END_ENTRY, { id, reason });
	} catch {
		// Unjournaled, the next load reads it once more and ends it again.
	}
}

function schedule(entry: Armed, delay: number): void {
	clearTimeout(entry.timer);
	const untilDeadline = ciDeadline(entry.watch, entry.supersededAt).at - Date.now();
	entry.timer = setTimeout(() => void tick(entry), Math.max(0, Math.min(delay, untilDeadline)));
	// A watch never keeps omp alive.
	entry.timer.unref?.();
}

function arm(watch: CiWatchRecord, supersededAt?: number): void {
	const entry: Armed = { watch, failures: 0, jobs: new Map(), ...(supersededAt ? { supersededAt } : {}) };
	armed.set(watch.id, entry);
	schedule(entry, watch.at + CI_FIRST_READ_MS - Date.now());
}

/** The session loaded or changed: read again every watch its branch still owes a result for (Orca I1). */
function rearm(): void {
	for (const entry of armed.values()) clearTimeout(entry.timer);
	armed.clear();
	held.clear();
	const session = mainSession();
	if (!session || stopped) return;
	for (const { watch, supersededAt } of pendingWatches(session.sessionManager.getBranch(), Date.now()))
		arm(watch, supersededAt);
}

function record(target: CiTarget): void {
	const session = mainSession();
	if (!session || stopped) return;
	const watch: CiWatchRecord = { id: `ci-${randomUUID()}`, ...target, at: Date.now() };
	try {
		session.sessionManager.appendCustomEntry(CI_WATCH_ENTRY, watch);
	} catch {
		return;
	}
	for (const entry of armed.values()) {
		const { watch: older } = entry;
		if (older.branch === watch.branch && older.repo === watch.repo && older.host === watch.host)
			entry.supersededAt ??= watch.at;
	}
	arm(watch);
}

async function detect(output: string): Promise<void> {
	const stock = await loadStock();
	if (!stock) return;
	// gh serves github.com and the host it defaults to (`GH_HOST`); a push anywhere else has no Actions gh could read.
	const hosts = new Set([stock.common.GITHUB_HOST, stock.common.defaultGhHost()]);
	for (const target of [...parseGitPush(output, hosts), ...parsePrCreate(output, stock.common)]) record(target);
}

async function resolveHead(stock: Stock, cwd: string, entry: Armed): Promise<void> {
	const { watch } = entry;
	const repo = `${watch.host}/${watch.repo}`;
	const ref = stock.common.parseRepoRef(repo);
	const api = (path: string) =>
		stock.gh.json<{ sha?: string; head?: { sha?: string; ref?: string } }>(
			cwd,
			["api", ...stock.common.ghApiHostArgs(ref), "--method", "GET", path],
			undefined,
			{ repoProvided: true },
		);
	if (watch.pr !== undefined) {
		const pull = await api(`/repos/${ref.slug}/pulls/${watch.pr}`);
		entry.sha = pull.head?.sha;
		entry.branch = pull.head?.ref;
	} else if (watch.sha?.length === 40) entry.sha = watch.sha;
	else if (watch.sha) entry.sha = (await api(`/repos/${ref.slug}/commits/${watch.sha}`)).sha;
	// shortcut: a new branch's push prints no sha, so its head is read at the first read (30 s later); journal the sha if a fast second push ever matters.
	else if (watch.branch) entry.sha = await stock.runs.resolveGitHubBranchHead(cwd, repo, watch.branch);
	if (!entry.sha) throw new Error(`no head commit for ${repo}`);
}

async function tick(entry: Armed): Promise<void> {
	const { watch } = entry;
	const current = () => !stopped && armed.get(watch.id) === entry;
	if (!current()) return;
	const deadline = ciDeadline(watch, entry.supersededAt);
	if (Date.now() >= deadline.at) return end(watch.id, deadline.reason);
	const stock = await loadStock();
	const session = mainSession();
	// Without stock's internals the watch stays open in the journal: an omp that has them reads it.
	if (!stock || !session || !current()) return;
	const cwd = session.sessionManager.getCwd();
	let runs: GhRunSnapshot[];
	try {
		if (!entry.sha) await resolveHead(stock, cwd, entry);
		runs = await stock.runs.fetchRunsForCommit(
			cwd,
			`${watch.host}/${watch.repo}`,
			entry.sha ?? "",
			undefined,
			entry.jobs,
		);
	} catch (error) {
		if (!current()) return;
		entry.failures += 1;
		const rateLimited = stock.runs.GH_RATE_LIMIT_ERROR_PATTERN.test(errorMessage(error));
		return schedule(entry, retryDelay(entry.failures, rateLimited));
	}
	if (!current()) return;
	entry.failures = 0;
	const outcome = stock.runs.getRunCollectionOutcome(runs);
	const verdict = readVerdict(watch, runs.length, outcome, Date.now());
	if (verdict === "no_ci") return end(watch.id, "no_ci");
	if (verdict === "pending" || outcome === "pending") return schedule(entry, CI_POLL_MS);
	const { failed, url } = ciFailure(
		runs,
		run => stock.runs.getRunSnapshotOutcome(run) === "failure" || run.jobs.some(stock.runs.isFailedJob),
		stock.runs.isFailedJob,
	);
	deliver({
		id: watch.id,
		host: watch.host,
		repo: watch.repo,
		branch: entry.branch ?? watch.branch ?? `#${watch.pr}`,
		sha: entry.sha ?? "",
		...(watch.pr !== undefined ? { pr: watch.pr } : {}),
		outcome,
		failed: outcome === "failure" ? failed : [],
		...(url ? { url } : {}),
	});
}

/** Exactly once per watch, and once per commit (a push and the PR made of it); never into a running turn (Orca I6/I7). */
function deliver(details: CiResultDetails): void {
	const session = mainSession();
	if (!session || !mainPi) return;
	if (session.isStreaming) {
		held.set(details.id, details);
		return;
	}
	const branch = session.sessionManager.getBranch();
	if (!sent.has(details.id) && !isDelivered(branch, details.id, details.repo, details.sha)) {
		sent.add(details.id);
		// Idle, stock shows a no-turn message at once and journals it; the model reads it with the next prompt.
		mainPi.sendMessage(
			{ customType: CI_MESSAGE_TYPE, content: ciResultText(details), display: true, details },
			{ triggerTurn: false },
		);
	}
	end(details.id, "delivered");
}

function flushHeld(): void {
	const session = mainSession();
	if (!session || session.isStreaming) return;
	for (const details of [...held.values()]) deliver(details);
}

function outputText(result: unknown): string {
	const content = typeof result === "object" && result !== null && "content" in result ? result.content : undefined;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap(part => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	// Any agent of this omp pushes for the session; the engine and the journal are the main session's.
	pi.on("tool_execution_start", event => {
		const command = (event.args as { command?: unknown } | undefined)?.command;
		if (event.toolName === "bash" && typeof command === "string" && isPushCommand(command))
			pushCalls.add(event.toolCallId);
	});
	// shortcut: a push sent to the background (`async` bash) ends here before its output exists and is missed; read its job's end if agents push that way.
	pi.on("tool_execution_end", event => {
		if (!pushCalls.delete(event.toolCallId)) return;
		void detect(outputText(event.result)).catch((error: unknown) =>
			mainPi?.logger.warn("gui-bridge: CI watch missed a push", { error: errorMessage(error) }),
		);
	});
	if (mainPi) return;
	mainPi = pi;
	pi.on("session_start", () => rearm());
	pi.on("session_switch", () => rearm());
	// A result that settled during the turn goes once the session is idle; not awaited, the handler must not hold stock's idle wait.
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.agent.kind !== "main" || held.size === 0) return;
		void mainSession()
			?.waitForIdle()
			.then(flushHeld, () => undefined);
	});
	pi.on("session_shutdown", () => {
		stopped = true;
		for (const entry of armed.values()) clearTimeout(entry.timer);
		armed.clear();
	});
	// An area's install never sees the boot `session_start`: the session that is already open is armed here.
	rearm();
}

/** Hooks only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("ciWatch", {});
