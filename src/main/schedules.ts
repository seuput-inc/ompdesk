/**
 * Scheduled runs: stock `omp -p` started in a project folder when a schedule comes due, only while OMPdesk is open
 * (contract in src/shared/schedules.ts). This is the typed client of the core's schedules
 * (`native/ompdesk/crates/core/src/schedules`), which keeps the clock, the journal (`<userData>/schedules.json`), the
 * run logs (`<userData>/schedule-runs/<runId>.log`), routine sources and their marks (`routine-marks.json`), the
 * loop guard and webhook validation, and starts each omp under the supervisor.
 *
 * What stays here is what only main has:
 * - a copy of the state, written from the core's `schedules.state` events alone, for synchronous UI readers;
 * - the first-window gate, stock pool observations and private, per-read machine/keystore lookups;
 * - what the core asks for: whether a paired device has a model request left (`reserve`, main's `PeerQuota`), a
 *   session's own wake-up (`wake`, the control tools), and a run's omp with its environment and extensions, which
 *   `ompRunLauncher` resolves and hands to the core's launcher.
 *
 * Requests go to the core one after the other, in the order they were made here, because the core takes requests
 * side by side: two saves, or an event and the end of the run it came during, keep their order.
 *
 * A core that ended took its timers and every omp it ran with it (the journal reads them stopped); the service opens
 * again on the next core, from the journal.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { RUN_SESSION_FIELD, RUN_USAGE_ENV } from "../../resources/gui-bridge/credit-spend-core";
import { AGENT_SCHEDULE_PREFIX } from "../shared/agent-control";
import { codedError } from "../shared/ipc-error-codes";
import {
	ROUTINE_CHAIN_LIMIT,
	SCHEDULE_ONCE_DONE_KEPT,
	SCHEDULE_RUNS_KEPT,
	SCHEDULE_RUNS_PER_SCHEDULE,
	type Schedule,
	type ScheduleCreated,
	type ScheduleDraft,
	type ScheduleResultsTo,
	type ScheduleRunUsage,
	type SchedulesRequest,
	type SchedulesState,
	type SlackMirrorAction,
} from "../shared/schedules";
import { CoreError, core } from "./core/process";
import type { CoreRunner } from "./local/git/exec";
import { nativeBinPath } from "./native-bin";
import { OMP_TELEMETRY_OFF, type OmpResolution, ompPathEnv } from "./omp-runtime";
import type { RoutineHost } from "./routines/ports";
import { needsShell, spawnArgs, spawnCommand } from "./spawn";

/** How often due schedules are checked; a wall-clock check survives system sleep, a long timer would not. */
export const SCHEDULE_TICK_MS = 30_000;
/** The request kept open on the service: it fails when the core dies, which is how this side learns it. */
const HOLD_MS = 2 ** 31 - 1;
/**
 * How long a quit waits for the core to say the journal is written: what was asked before it and the journal's
 * rename, which Windows can hold back for 5 s; under the quit watchdog's 30 s.
 */
export const QUIT_SCHEDULES_CLOSE_MS = 8_000;
/** How long after a core could not take the schedules back they are offered again. */
const REOPEN_MS = 30_000;

/** One started run: `stop()` ends it, `done` settles once it ended (an omp: exited, its log flushed). */
export interface RunProcess {
	stop(): void;
	/** A Slack thread's run that opened its thread's chat: that chat's session file (`schedules.threadChat`). */
	opened?: string;
	/**
	 * `usage`: what a fresh run's model replies used, as its omp counted it (stock's session tally); `session`: the
	 * session file that omp saved; `worktree`: the worktree it ran in.
	 */
	done: Promise<{
		code: number | null;
		error?: string;
		usage?: ScheduleRunUsage;
		session?: string;
		worktree?: string;
	}>;
}

/** A wake-up's schedule as the core tells it: a bot's Slack thread's run names its thread. */
export type ThreadWake = Schedule & { thread?: string };

export type RunLauncher = (schedule: Schedule, files: { log: string; prompt: string }) => Promise<RunProcess>;

/** The production launcher has not yet sent anything to the supervisor. */
class RunNotDispatched extends Error {}

/** A paired device's daily model requests on this computer (`PeerQuota`): one counted, or why not. */
export type ScheduleCharge = { ok: true; refund(): void } | { ok: false; reason: string };

export interface ScheduleServiceOptions {
	/** `schedules.json`. */
	file: string;
	/** Directory of run logs (and each running prompt). */
	logDir: string;
	launch: RunLauncher;
	onState: (state: SchedulesState) => void;
	/**
	 * Delivers a wake-up's prompt (`schedule.prompt`, with what fired it) into its session on this computer
	 * (`Schedule.wakeSession`) and follows the turn it starts: `done` settles when that turn ends (`code` 0, or null and
	 * the turn's error), `stop()` stops that turn. Rejects with a readable reason when it cannot deliver. Absent: a
	 * wake-up's run fails (no tab holds sessions here). A bot's Slack connector's run for a thread (`thread`, the core's
	 * `slack_mirror::thread_key`) with no `wakeSession` opens that thread's chat in the schedule's folder first and
	 * names it in `opened`.
	 */
	wake?: (schedule: ThreadWake, runId: string) => Promise<RunProcess>;
	/** How often due schedules are checked (default `SCHEDULE_TICK_MS`); only a test launch shortens it. */
	tickMs?: number;
	/** The length of a minute for intervals (default 60 000 ms); only a test launch shortens it. */
	minuteMs?: number;
	/**
	 * Count one run against `device`'s daily model limit here. A schedule a paired device saved (`Schedule.device`)
	 * is charged at every start, timed or not; absent = no device is ever charged (tests, no remote host).
	 */
	reserve?: (device: string, reservationId: string) => ScheduleCharge;
	/** Admit a delivery once before coalescing it with others; the resulting run, not each delivery, costs one request. */
	remember?: (device: string, reservationId: string) => boolean;
	/**
	 * The clock, where a test owns it: the core then keeps no timer and reads no clock, this side checks every
	 * `tickMs` and says the time with each request. Absent: the core's own timer and the system's clock.
	 */
	now?: () => number;
	/**
	 * A quiet note (no turn) into the session file `session` on this computer: a wake-up that turned itself off after
	 * failing again and again. Absent: the note is dropped (the run history says it anyway).
	 */
	note?: (session: string, text: string) => void;
	/** A fresh run's answer for where its schedule (`name`) sends it (`resultsTo`); quiet answers never come here. */
	result?: (name: string, to: ScheduleResultsTo, text: string) => void;
	/** How a schedule's precheck command runs (a shell and its `-c`, the login environment); absent: prechecks say no. */
	shell?: () => Promise<CoreRunner>;
	/**
	 * A bot's Slack connector's signing secret (`account`: its Slack app), handed to the core with each call to the
	 * connector's `/hooks/<id>` and nowhere else; null when none is kept.
	 */
	slackSigningSecret?: (account: string) => string | null;
	/**
	 * A bot's Slack app's bot token (`account`), handed to the core for one post of a thread chat's mirror
	 * (`schedules.mirror`, `schedules.mirrorAction`) and nowhere else; null when none is kept.
	 */
	slackBotToken?: (account: string) => string | null;
}

/**
 * What a webhook call came to (`ScheduleService.webhook`): started or kept for after the running one, passed over by
 * its filters or already taken (both answered 202), Slack's URL check of a bot's Slack connector (`challenge`: the
 * edge echoes its challenge), or why not.
 */
export type WebhookOutcome = "fired" | "ignored" | "duplicate" | "challenge" | "unknown" | "denied" | "off";

/** A webhook call as the core's edge read it: the bearer key it sent (null: a sender's signature instead), its
 * headers (lowercase names, credentials left out) and its body, base64. */
export interface WebhookCallIn {
	id: string;
	bearer: string | null;
	headers: Record<string, string>;
	body: string;
}

/** `schedules.start`: the core asks main to start a run. */
interface StartAsk {
	run: string;
	/** The schedule with the prompt as the run is told it (what fired it under it). */
	schedule: ThreadWake;
	files: { log: string; prompt: string };
	wake: boolean;
	/** The request the start was charged with (`schedules.reserve`'s `ask`). */
	charge: number | null;
}

interface RoutineToken {
	id: string;
	generation: number;
}
interface RoutineAsk {
	token: RoutineToken;
	ask: number;
	kind: "git" | "github" | "email" | "slack" | "linear" | "google";
	account: string;
}

/** Names a service and a launched omp to the core; one counter for this process. */
let sequence = 0;

/** A refusal of the core as the service threw it: a plain error with its words, the device's limit with its code. */
function refusal(error: unknown): unknown {
	if (!(error instanceof CoreError)) return error;
	if (error.code === "remote_limit_reached") return codedError("remote_limit_reached", error.message);
	return error.code === "schedule_error" || error.code === "schedules_closed" ? new Error(error.message) : error;
}

export class ScheduleService {
	readonly #options: ScheduleServiceOptions;
	readonly #name = `${process.pid}.${++sequence}`;
	/** The requests' queue: each is sent once the one before it was answered. */
	#lane: Promise<unknown> = Promise.resolve();
	/** The runs main started and still follows, by run id; null while one is being started. */
	readonly #runs = new Map<string, RunProcess | null>();
	/** What gives a counted request back, by the ask it answered, until its run started. */
	readonly #refunds = new Map<number, () => void>();
	#unsubscribe: (() => void)[] = [];
	#routineHost: RoutineHost | undefined;
	/** Each bot Slack connector's routine id and its Slack app, from the newest state (`webhook` signs with it). */
	#slackRoutines = new Map<string, string>();
	/** Each bot Slack thread chat's session file, with its routine and thread (`threads` of the newest state). */
	#threadChats = new Map<string, { id: string; key: string }>();
	readonly #routineObservers = new Map<number, () => void>();
	#tick: NodeJS.Timeout | null = null;
	#retry: NodeJS.Timeout | null = null;
	#started = false;
	#disposed = false;
	/** The quit's close, once asked for. */
	#closing: Promise<void> | null = null;

	constructor(options: ScheduleServiceOptions) {
		this.#options = options;
	}

	/** Open the saved schedules in the core (a run left `running` by a crash ends as stopped) and start the clock. */
	async start(routines?: RoutineHost): Promise<void> {
		this.#routineHost = routines;
		const host = core();
		const mine =
			<T>(handle: (told: T, generation: number) => void) =>
			(data: unknown, _bin: Uint8Array | null, generation: number) => {
				// A frame of this app's own core, spelled by `schedules/mod.rs`.
				const told = data as T & { service: string };
				if (told.service === this.#name && generation === host.generation) handle(told, generation);
			};
		this.#started = true;
		this.#unsubscribe = [
			host.on(
				"schedules.state",
				mine<{ state: SchedulesState }>(({ state }) => {
					if (this.#disposed) return;
					this.#slackRoutines = new Map(
						state.schedules.flatMap(schedule =>
							schedule.frequency.kind === "event" && schedule.frequency.event.source === "slack"
								? [[schedule.id, schedule.frequency.event.account] as const]
								: [],
						),
					);
					this.#threadChats = new Map(
						Object.entries(state.threads ?? {}).flatMap(([id, chats]) =>
							chats.flatMap(chat => (chat.session ? [[chat.session, { id, key: chat.key }] as const] : [])),
						),
					);
					this.#options.onState(state);
				}),
			),
			host.on(
				"schedules.start",
				mine<StartAsk>((ask, generation) => void this.#run(ask, generation)),
			),
			host.on(
				"schedules.stop",
				mine<{ run: string }>(({ run }) => this.#runs.get(run)?.stop()),
			),
			host.on(
				"schedules.remember",
				mine<{ ask: number; device: string; reservationId: string }>(
					({ ask, device, reservationId }, generation) =>
						void this.#remember(ask, device, reservationId, generation),
				),
			),
			host.on(
				"schedules.reserve",
				mine<{ ask: number; device: string; reservationId: string }>(({ ask, device, reservationId }, generation) =>
					this.#reserve(ask, device, reservationId, generation),
				),
			),
			host.on(
				"schedules.refund",
				mine<{ charge: number }>(({ charge }) => {
					this.#refunds.get(charge)?.();
					this.#refunds.delete(charge);
				}),
			),
			host.on(
				"schedules.routineAsk",
				mine<RoutineAsk>((ask, generation) => void this.#routineAnswer(ask, generation)),
			),
			host.on(
				"schedules.routineSession",
				mine<{ token: RoutineToken; on: boolean; wake?: string }>(({ token, on, wake }, generation) => {
					if (!routines || this.#disposed) return;
					if (!on) {
						this.#routineObservers.get(token.generation)?.();
						this.#routineObservers.delete(token.generation);
						return;
					}
					this.#routineObservers.set(
						token.generation,
						routines.observe(wake ?? null, (activity, tab) => {
							if (this.#disposed) return;
							void this.#send("schedules.routineActivity", { token, activity, tab }, generation).catch(error => {
								if (!this.#disposed && generation === host.generation)
									routines.log(`A session event was lost: ${String(error)}`);
							});
						}),
					);
				}),
			),
			host.on(
				"schedules.routineLog",
				mine<{ message: string }>(({ message }) => routines?.log(message)),
			),
			host.on(
				"schedules.note",
				mine<{ session: string; text: string }>(({ session, text }) => {
					if (!this.#disposed) this.#options.note?.(session, text);
				}),
			),
			host.on(
				"schedules.result",
				mine<{ name: string; to: ScheduleResultsTo; text: string }>(({ name, to, text }) => {
					if (!this.#disposed) this.#options.result?.(name, to, text);
				}),
			),
		];
		await this.#opening();
	}

	/** Opens the schedules; whatever is asked meanwhile waits for it. A core that cannot take them is asked again later. */
	#opening(): Promise<void> {
		const opened = this.#open();
		this.#lane = opened.catch(() => undefined);
		opened.catch(() => {
			if (this.#disposed) return;
			this.#retry = setTimeout(() => {
				this.#opening().catch(error => console.error("[schedules] couldn't open in ompdesk-core:", error));
			}, REOPEN_MS);
			this.#retry.unref();
		});
		return opened;
	}

	async #open(): Promise<void> {
		const { file, logDir, tickMs = SCHEDULE_TICK_MS, minuteMs = 60_000, now } = this.#options;
		// A shell that cannot be read leaves prechecks saying no; the schedules still open.
		const shell = await this.#options.shell?.().catch(() => undefined);
		await this.#call("schedules.open", {
			...(shell ? { shell } : {}),
			file,
			logDir,
			tickMs,
			minuteMs,
			manual: now !== undefined,
			charges: this.#options.reserve !== undefined,
			wakes: this.#options.wake !== undefined,
			limits: {
				runsKept: SCHEDULE_RUNS_KEPT,
				runsPerSchedule: SCHEDULE_RUNS_PER_SCHEDULE,
				onceDoneKept: SCHEDULE_ONCE_DONE_KEPT,
				chainLimit: ROUTINE_CHAIN_LIMIT,
				agentPrefix: AGENT_SCHEDULE_PREFIX,
			},
		});
		if (this.#disposed) {
			// The quit came while the journal was read: its close found nothing open yet.
			await this.#call("schedules.close").catch(() => undefined);
			return;
		}
		if (now && !this.#tick) {
			this.#tick = setInterval(() => void this.#send("schedules.tick").catch(() => undefined), tickMs);
		}
		void this.#hold();
		const routines = this.#routineHost;
		if (routines) {
			const generation = core().generation;
			const attach = () => {
				if (!this.#disposed && generation !== 0 && generation === core().generation)
					return this.#call<void>(
						"schedules.routinesReady",
						{ file: routines.file, timing: routines.timing },
						generation,
					);
			};
			if (routines.ready)
				void routines.ready
					.then(attach)
					.catch(error => routines.log(`Could not start routine sources: ${String(error)}`));
			else await attach();
		}
	}

	/** Keeps a request open on the service; when the core dies under it, opens the schedules on the next one. */
	async #hold(): Promise<void> {
		const host = core();
		const home = host.generation;
		while (!this.#disposed && host.generation === home) {
			try {
				await host.call("schedules.closed", { service: this.#name }, { timeoutMs: HOLD_MS });
				return;
			} catch (error) {
				if (this.#disposed) return;
				if (error instanceof CoreError && error.code === "timeout") continue;
				break;
			}
		}
		// The core's omps went with it and the journal reads them stopped; a woken session's turn goes on unfollowed.
		this.#runs.clear();
		this.#refunds.clear();
		this.#dropRoutineHost();
		if (this.#disposed) return;
		this.#opening().catch(error => console.error("[schedules] couldn't open in ompdesk-core:", error));
	}

	#dropRoutineHost(): void {
		for (const off of this.#routineObservers.values()) off();
		this.#routineObservers.clear();
	}

	async #routineAnswer({ token, ask, kind, account }: RoutineAsk, generation: number): Promise<void> {
		const host = this.#routineHost;
		if (!host || this.#disposed) return;
		let answer: { value: unknown } | { error: string };
		try {
			let value: unknown;
			if (kind === "email") value = await host.email(account);
			else if (kind === "slack" || kind === "linear" || kind === "google") {
				const own = host[kind];
				if (!own) throw new Error("A bot's connectors are not available here");
				value = own(account);
			} else value = await host[kind]();
			answer = { value };
		} catch (error) {
			answer = { error: error instanceof Error ? error.message : String(error) };
		}
		if (!this.#disposed) {
			// Only a request on the private core pipe; never include its contents in an event or diagnostic.
			await this.#call("schedules.routineAnswer", { token, ask, ...answer }, generation).catch(() => undefined);
		}
	}

	/** One request to the core, at once. */
	async #call<T>(method: string, params: Record<string, unknown> = {}, generation?: number): Promise<T> {
		const now = this.#options.now;
		try {
			const sent = { service: this.#name, ...(now ? { now: now() } : {}), ...params };
			return (await core().call<T>(method, sent, generation === undefined ? {} : { generation })).result;
		} catch (error) {
			throw refusal(error);
		}
	}

	/** One request to the core in its turn; it carries the time it was made at, not the time it is sent at. */
	#send<T>(method: string, params: Record<string, unknown> = {}, generation?: number): Promise<T> {
		const now = this.#options.now;
		const stamped = now ? { now: now(), ...params } : params;
		const sent = this.#lane.then(() => this.#call<T>(method, stamped, generation));
		this.#lane = sent.catch(() => undefined);
		return sent;
	}

	/**
	 * The owner typed `text` in `session`: when it is a bot's Slack thread chat set to post, the core posts it to that
	 * thread with the app's bot token (Orca `slack-mirror.ts:120-145` `admitted`). Any other session, the bot's home
	 * chat among them, posts nothing. Never throws: a post that failed shows on the chat's card.
	 */
	async mirror(session: string, text: string): Promise<void> {
		const chat = this.#threadChats.get(session);
		const app = chat ? this.#slackRoutines.get(chat.id) : undefined;
		if (app === undefined) return;
		try {
			// A keystore that cannot be read now posts nothing; its card says so once the owner opens the bot's page.
			const botToken = this.#options.slackBotToken?.(app);
			if (botToken) await this.#call("schedules.mirror", { session, text, botToken });
		} catch {
			// Nothing to tell the person typing: the chat's card shows what posted.
		}
	}

	/** The owner's change of a thread chat's mirror: its switch, or Retry, Dismiss or Delete from Slack of one post. */
	async mirrorAction(request: SlackMirrorAction): Promise<SchedulesState> {
		const app = this.#slackRoutines.get(request.id);
		const botToken = app === undefined ? null : (this.#options.slackBotToken?.(app) ?? null);
		if (!botToken && request.op !== "set" && request.op !== "dismiss")
			throw new Error("The Slack app's bot token is not kept on this computer");
		return this.#call<SchedulesState>("schedules.mirrorAction", { ...request, ...(botToken ? { botToken } : {}) });
	}

	/**
	 * `POST /hooks/<id>` (the core's edge, relayed by src/main/web/server.ts): fires the routine whose webhook it is,
	 * when the call carries its key or, once the routine has a signing secret, its sender's signature. The core checks
	 * both in constant time and keeps the routine's recent calls.
	 */
	async webhook(call: WebhookCallIn): Promise<WebhookOutcome> {
		if (this.#disposed) return "off";
		// A bot's Slack connector is signed with its app's secret, which main's keystore holds: it goes with this call.
		const app = this.#slackRoutines.get(call.id);
		const secret = app === undefined ? null : (this.#options.slackSigningSecret?.(app) ?? null);
		return this.#send<WebhookOutcome>("schedules.webhook", { ...call, ...(secret ? { secret } : {}) });
	}

	/**
	 * `origin`: the paired device a request comes from (`host.schedules.command`). A save from a device makes the
	 * schedule that device's (its runs count against its daily model limit here); a save here makes it this computer's.
	 * A run now from a device is charged to that device and refused past its limit.
	 */
	async command(
		request: SchedulesRequest,
		origin?: string,
		hostWindow?: boolean,
		reservationId?: string,
	): Promise<SchedulesState> {
		// A thread chat's mirror carries the Slack app's token, which only this side holds: never a paired device's.
		if (request.action === "mirror") {
			if (origin !== undefined) throw new Error("A bot's Slack thread chat is this computer's own");
			return this.mirrorAction(request);
		}
		return this.#send<SchedulesState>("schedules.command", { request, origin, hostWindow, reservationId });
	}

	/**
	 * Save a new schedule and say which one it is: the id comes from this save, never from a diff a concurrent save
	 * could share. `origin`: the paired device it is made for (its runs count against that device), as in `command`.
	 */
	async create(draft: ScheduleDraft, origin?: string): Promise<ScheduleCreated> {
		return this.#send<ScheduleCreated>("schedules.create", { draft, origin });
	}

	/** The run's captured output, from its end when long. */
	async readLog(runId: string): Promise<string> {
		return this.#send<string>("schedules.log", { run: runId });
	}

	/**
	 * Ages out what agents left (launch and hourly): an agent schedule's finished runs past seven days, and a spent
	 * one-time agent schedule, at once when its run did not fail (or it never ran: an older build kept them), or a day
	 * after a failed run ended. The owner's own schedules keep their history.
	 */
	async prune(now: number): Promise<void> {
		if (this.#disposed) return;
		await this.#send("schedules.prune", { at: now });
	}

	/** The computer woke from sleep: the core holds timed starts for a short settle, then starts what came due. */
	resumed(): void {
		if (this.#disposed || !this.#started) return;
		void this.#send("schedules.resumed").catch(() => undefined);
	}

	/**
	 * App quit: stop every run main follows (a woken session's turn; an omp's supervisor kills its tree) and have the
	 * core record them and write the journal. Resolves once the core answered that the journal is written, or after
	 * `boundMs`. The quit holds the process and the core's stop until then (`index.ts`): main's exit ends the core at
	 * once on Windows, whatever it still had to write.
	 */
	dispose(boundMs = QUIT_SCHEDULES_CLOSE_MS): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#disposed = true;
		this.#dropRoutineHost();
		clearInterval(this.#tick ?? undefined);
		clearTimeout(this.#retry ?? undefined);
		for (const off of this.#unsubscribe) off();
		for (const process of this.#runs.values()) process?.stop();
		// A service that never asked the core for anything has nothing there to close.
		if (!this.#started) {
			this.#closing = Promise.resolve();
			return this.#closing;
		}
		// In its turn: what was asked before the quit is taken first, so the journal the close writes holds it.
		const closed = this.#send<void>("schedules.close").catch(() => undefined);
		const { promise: bound, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, boundMs);
		this.#closing = Promise.race([closed, bound]).then(() => clearTimeout(timer));
		return this.#closing;
	}

	async #remember(ask: number, device: string, reservationId: string, generation: number): Promise<void> {
		let accepted = false;
		let refused: string | undefined;
		try {
			if (!this.#options.remember) throw new Error("Quota unavailable");
			accepted = this.#options.remember(device, reservationId);
		} catch (error) {
			refused = error instanceof Error ? error.message : String(error);
		}
		await this.#call("schedules.remembered", { ask, accepted, refused }, generation).catch(() => undefined);
	}

	/** Counts a start against its device, tells the core, and keeps how to give it back until the run started. */
	#reserve(ask: number, device: string, reservationId: string, generation: number): void {
		let charge: ScheduleCharge;
		try {
			charge = this.#options.reserve?.(device, reservationId) ?? { ok: false, reason: "Quota unavailable" };
		} catch (error) {
			charge = { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
		if (charge.ok) this.#refunds.set(ask, charge.refund);
		// A lost reply does not prove the core missed the reservation. Only its explicit pre-dispatch refund counts.
		this.#call("schedules.reserved", { ask, ...(charge.ok ? {} : { refused: charge.reason }) }, generation).catch(
			() => undefined,
		);
	}

	/** Starts the run the core asks for and follows it to its end. */
	async #run({ run, schedule, files, wake, charge }: StartAsk, generation: number): Promise<void> {
		// Consume this admission before dispatch. A repeated start or an ambiguous launcher failure cannot spend it twice.
		const refund = charge === null ? undefined : this.#refunds.get(charge);
		if (charge !== null && !this.#refunds.delete(charge)) return;
		this.#runs.set(run, null);
		let result: { code: number | null; error?: string };
		try {
			const process = wake
				? await this.#options.wake?.(schedule, run)
				: await this.#options.launch(schedule, files).catch(error => {
						if (error instanceof RunNotDispatched) refund?.();
						throw error;
					});
			if (!process) {
				refund?.();
				throw new Error("Waking a session is not available here");
			}
			this.#runs.set(run, process);
			if (this.#disposed) process.stop();
			// The core sends a stop that was asked for meanwhile once it hears the run started.
			if (process.opened) await this.#send("schedules.threadChat", { run, session: process.opened }, generation);
			await this.#send("schedules.started", { run }, generation);
			result = await process.done;
		} catch (error) {
			result = { code: null, error: error instanceof Error ? error.message : String(error) };
		}
		this.#runs.delete(run);
		if (this.#disposed) return;
		await this.#send("schedules.ended", { run, ...result }, generation).catch(() => undefined);
	}
}

/**
 * The production launcher: `omp -p [--model m] [--thinking t] [--yolo]` under the supervisor, started by the core
 * (`schedules.launch`), the prompt file as its stdin, stdout and stderr appended to the run's log. This side resolves
 * what the run needs at its start: the omp, the environment, the extensions of its folder, and for a `worktree`
 * schedule the worktree it runs in.
 */
export function ompRunLauncher(options: {
	omp: () => Promise<OmpResolution>;
	env: () => Promise<NodeJS.ProcessEnv>;
	/** Extension flags every run gets in its folder (ai-memory's root while memory is on). */
	extensionArgs?: (cwd: string) => Promise<string[]>;
	/** What a run with those extensions needs to reach their MCP servers (src/main/mcp-hub.ts `ompEnv`). */
	extensionEnv?: (cwd: string) => Promise<Record<string, string>>;
	/** The Credit use switch for this run (omp-launch.ts `creditSpendRun`): a run has no bridge to apply it. */
	creditSpend?: () => { args: string[]; env: Record<string, string> };
	/** A new worktree of `schedule.cwd` for one run, seeded and set up as a worktree tab's; its folder. */
	worktree?: (schedule: Schedule) => Promise<string>;
}): RunLauncher {
	const prepare = async (schedule: Schedule, files: { log: string }) => {
		const resolution = await options.omp();
		if (!resolution.ok) throw new Error(resolution.error);
		const { bin } = resolution.runtime;
		// A worktree that cannot be made fails the run before it launches: it may be sent again.
		const worktree = schedule.worktree && options.worktree ? await options.worktree(schedule) : undefined;
		const cwd = worktree ?? schedule.cwd;
		const extensions = (await options.extensionArgs?.(cwd)) ?? [];
		const creditSpend = options.creditSpend?.();
		// The run extension that carries the Credit use switch also writes stock's usage tally here as the run ends.
		const usageFile = creditSpend ? `${files.log}.usage.json` : undefined;
		const env: NodeJS.ProcessEnv = {
			...(await options.env()),
			...(extensions.length ? await options.extensionEnv?.(cwd) : {}),
			...creditSpend?.env,
			...(usageFile ? { [RUN_USAGE_ENV]: usageFile } : {}),
		};
		const args = [
			"-p",
			...extensions,
			...(creditSpend?.args ?? []),
			...(schedule.model ? ["--model", schedule.model] : []),
			...(schedule.thinking ? ["--thinking", schedule.thinking] : []),
			...(schedule.autoApprove ? ["--yolo"] : []),
		];
		const ompEnv: Record<string, string> = {};
		for (const [name, value] of Object.entries({
			...env,
			PATH: ompPathEnv(bin, env.PATH ?? ""),
			PI_NOTIFICATIONS: "off",
			PI_NO_PTY: "1",
			...OMP_TELEMETRY_OFF,
		}))
			if (value !== undefined) ompEnv[name] = value;
		return { bin, worktree, cwd, usageFile, ompEnv, args };
	};
	return async (schedule, files) => {
		const { bin, worktree, cwd, usageFile, ompEnv, args } = await prepare(schedule, files).catch(error => {
			throw new RunNotDispatched(error instanceof Error ? error.message : String(error));
		});
		const run = `${process.pid}.${++sequence}`;
		const host = core();
		const ended = Promise.withResolvers<{ code: number | null; error?: string }>();
		// Heard from the tick the request is sent in: the end of a supervisor that could not start comes before the answer.
		const unsubscribe = [
			host.on("schedules.launchEnded", data => {
				const told = data as { run: string; code: number | null; error?: string };
				if (told.run === run) ended.resolve(told.error === undefined ? { code: told.code } : told);
			}),
			// A core that started after the one the omp was started on holds nothing of it: it ended with its core.
			host.on("ready", () => {
				if (host.generation !== home) ended.resolve({ code: null, error: "ompdesk-core exited during the run" });
			}),
		];
		const done = ended.promise.then(async ({ code, error }) => {
			for (const off of unsubscribe) off();
			const { usage, session } = usageFile ? await readRunTally(usageFile) : {};
			return {
				code,
				...(error === undefined ? {} : { error }),
				...(usage ? { usage } : {}),
				...(session ? { session } : {}),
				...(worktree ? { worktree } : {}),
			};
		});
		const started = host.call("schedules.launch", {
			run,
			supervisor: nativeBinPath("ompdesk-core"),
			file: spawnCommand(bin),
			args: spawnArgs(bin, args),
			shell: needsShell(bin),
			env: ompEnv,
			cwd,
			log: files.log,
			prompt: files.prompt,
			header: `$ omp ${args.join(" ")}\n# ${cwd}\n\n`,
		});
		const home = host.generation;
		try {
			await started;
		} catch (error) {
			for (const off of unsubscribe) off();
			throw error;
		}
		return {
			stop: () => {
				host.call("schedules.launchStop", { run }).catch(() => undefined);
			},
			done,
		};
	};
}

/**
 * What a run's extension wrote as the run ended (stock's `UsageStatistics`, and the session file its omp saved), kept
 * to the fields a run row shows; the file goes.
 */
async function readRunTally(file: string): Promise<{ usage?: ScheduleRunUsage; session?: string }> {
	try {
		const told = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		const count = (name: string) => {
			const value = told[name];
			return typeof value === "number" && Number.isFinite(value) ? value : 0;
		};
		const session = told[RUN_SESSION_FIELD];
		return {
			usage: {
				input: count("input"),
				output: count("output"),
				cacheRead: count("cacheRead"),
				cacheWrite: count("cacheWrite"),
				cost: count("cost"),
			},
			...(typeof session === "string" && path.isAbsolute(session) ? { session } : {}),
		};
	} catch {
		// No file: the run never reached a model, or its omp lacks the extension.
		return {};
	} finally {
		await rm(file, { force: true }).catch(() => undefined);
	}
}
