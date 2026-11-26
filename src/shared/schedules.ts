/**
 * Scheduled runs (Settings › Schedules): a prompt run as stock `omp -p` in a
 * project folder on a timer, by OMPdesk's core process, only while OMPdesk is open. A start missed while the app was
 * closed runs once at launch when it is under an hour old, else it is recorded as missed. Stock omp has no
 * scheduler, so this one is GUI-owned; each run is one ordinary print-mode
 * session that stock saves like any other. A schedule with `wakeSession` is a session's own wake-up instead: its
 * start delivers the prompt into that existing session (a mail that starts a turn) and spawns no omp.
 */

import { GITHUB_LOGIN_PATTERN } from "./github";

export const SCHEDULES_COMMAND = "schedules:command";
export const SCHEDULES_LOG = "schedules:log";
export const SCHEDULES_STATE = "schedules:state";

/** Shortest and longest interval a schedule may repeat at, in minutes. */
export const SCHEDULE_MIN_INTERVAL = 5;
export const SCHEDULE_MAX_INTERVAL = 7 * 24 * 60;
/** Runs kept in the log, all schedules together; older ones and their log files go. */
export const SCHEDULE_RUNS_KEPT = 200;
/** Runs kept per schedule (a routine's run history); a schedule's older ones go first. */
export const SCHEDULE_RUNS_PER_SCHEDULE = 20;
/** Finished one-time schedules kept (off, with their runs); older ones are deleted. */
export const SCHEDULE_ONCE_DONE_KEPT = 20;
/**
 * Loop guard: event runs in a row, each asked for while the one before it was still going, after which the routine
 * is turned off instead of starting again (its own run keeps firing its trigger).
 */
export const ROUTINE_CHAIN_LIMIT = 10;
/** How often a GitHub trigger asks GitHub for news, in minutes (the shortest interval any schedule repeats at). */
export const GITHUB_POLL_MINUTES = SCHEDULE_MIN_INTERVAL;

export type ScheduleFrequency =
	| { kind: "interval"; minutes: number }
	/** Local wall-clock `HH:MM`; `days` are weekdays (0 = Sunday), empty = every day. */
	| { kind: "daily"; time: string; days: number[] }
	/** One start at `at` (ISO); then the schedule turns itself off (a follow-up set for a moment). */
	| { kind: "once"; at: string }
	/**
	 * Five-field cron in this computer's local time: minute, hour, day of month, month, day of week (0 or 7 = Sunday).
	 * Each field is `*`, a number, a range `a-b`, a step `*\/n` or `a-b/n`, or a comma list of them. When both day
	 * fields are restricted a day matching either runs, as cron reads them.
	 */
	| { kind: "cron"; expr: string }
	/**
	 * No clock: started by its event (src/main/routines). With `by` (ISO) it is a one-time wait: its first event runs
	 * it once and spends it (off, like `once`); at `by` with no event it runs once, told the deadline passed.
	 */
	| { kind: "event"; event: ScheduleEvent; by?: string };

export const GITHUB_EVENT_KINDS = [
	"pull_request",
	"pr_merged",
	"pr_closed",
	"issue",
	"issue_closed",
	"comment",
	"labeled",
	"ci_failure",
	"ci_passed",
	"workflow_finished",
	"release",
	"push",
] as const;
export type GithubEventKind = (typeof GITHUB_EVENT_KINDS)[number];
export const SESSION_EVENT_KINDS = ["done", "failed", "waiting"] as const;
/** A session of this computer finished a turn, failed one, or waits for the person's answer. */
export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];

/** Whose signature a routine's webhook calls must carry (Orca's sender adapters). */
export const WEBHOOK_SENDERS = ["standard", "github", "sentry", "linear", "pagerduty", "stripe"] as const;
export type WebhookSender = (typeof WEBHOOK_SENDERS)[number];
/** The display name of a sender. */
export const WEBHOOK_SENDER_NAMES: Record<WebhookSender, string> = {
	standard: "Standard Webhooks",
	github: "GitHub",
	sentry: "Sentry",
	linear: "Linear",
	pagerduty: "PagerDuty",
	stripe: "Stripe",
};
/** Senders whose secret OMPdesk may make (the owner pastes it into the sender); the others make their own. */
export function webhookSenderMakesSecret(sender: WebhookSender): boolean {
	return sender === "standard" || sender === "github";
}
/** Every sender but GitHub can hand over a secret it made (GitHub takes the one you type). */
export function webhookSenderTakesSecret(sender: WebhookSender): boolean {
	return sender !== "github";
}
/**
 * A new signing secret, made on the page that shows it once: Standard Webhooks' `whsec_<base64>` form, else 32 hex
 * characters. The core keeps it; no state ever carries it back.
 */
export function newWebhookSecret(sender: WebhookSender, random: (bytes: Uint8Array) => Uint8Array): string {
	const bytes = random(new Uint8Array(sender === "standard" ? 24 : 16));
	if (sender === "standard") return `whsec_${btoa(String.fromCharCode(...bytes))}`;
	return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** "Only when" tests on a call: `path` starts at `body.` or `headers.` (`body.action`, `body.items[0].id`). */
export const WEBHOOK_WHERE_OPS = ["=", "!=", "contains", "exists", "!exists"] as const;
export type WebhookWhereOp = (typeof WEBHOOK_WHERE_OPS)[number];
/** `=`: the value is one of `values`; `!=`: none of them (a missing value passes); `contains`: has one of them, case aside. */
export interface WebhookWhere {
	path: string;
	op: WebhookWhereOp;
	values?: string[];
}
export const WEBHOOK_FILTER_LIMITS = { where: 8, values: 10, pick: 12, path: 200, value: 200 } as const;
/** After a rotate that keeps the old key, it still starts runs this long. */
export const WEBHOOK_KEY_OVERLAP_MS = 24 * 60 * 60_000;
/** Recent calls kept per routine (`SchedulesState.calls`). */
export const WEBHOOK_CALLS_KEPT = 20;

/** What became of one webhook call (C2-48). */
export type WebhookVerdict =
	/** It started run `run`. */
	| "started"
	/** The routine was running: it runs once more after that run, with this call among what fired it. */
	| "queued"
	/** Its "only when" filters did not match. */
	| "ignored"
	/** Its delivery id came already (a sender's retry or redelivery). */
	| "duplicate"
	/** Wrong key or signature, or a signature out of its time window (`reason`). */
	| "refused"
	/** The routine is off or every schedule is paused. */
	| "off";

export interface WebhookCall {
	id: string;
	/** ISO; for a folded row, the newest call's moment. */
	at: string;
	verdict: WebhookVerdict;
	/** Why it was refused (English). */
	reason?: string;
	/** The run it started. */
	run?: string;
	/** Sent with Settings' Send test call. */
	sample?: true;
	/** The same refusal or duplicate this many times within a minute; this row is the newest. Absent = once. */
	count?: number;
}

export type ScheduleEvent =
	/**
	 * `POST /hooks/<schedule id>` on this computer's web server, with `Authorization: Bearer <key>` (or the old key
	 * until `previousKey.until` after a rotate). With `signedBy` only a call signed by that sender's secret starts it,
	 * and the key alone no longer does; the secret never leaves the core. `where`, `contains` and `pick` are read from
	 * a JSON body (`contains` from any body).
	 */
	| {
			source: "webhook";
			key: string;
			previousKey?: { key: string; until: string };
			signedBy?: WebhookSender;
			where?: WebhookWhere[];
			contains?: string;
			pick?: string[];
	  }
	/**
	 * News on a GitHub repository (`owner/name`), asked with the person's `gh` every `GITHUB_POLL_MINUTES`. Filters:
	 * `from` (logins; any), `contains` (in the title or text, case aside), `label` (the label added, or one the
	 * item carries).
	 */
	| { source: "github"; repo: string; events: GithubEventKind[]; from?: string[]; contains?: string; label?: string }
	/** A file under `path` (absolute; a folder is watched with everything in it) was created, changed or removed. */
	| { source: "files"; path: string }
	/** New commits on a local branch of the repository at `repo` (absolute). */
	| { source: "git"; repo: string; branch: string }
	/** A session on this computer (`folder`: only those whose folder contains it). Never the session it wakes. */
	| { source: "session"; events: SessionEventKind[]; folder?: string }
	/**
	 * New mail in a mailbox the owner added in Settings › Schedules › Email accounts (`account`: its id or label), asked
	 * over IMAP every `EMAIL_POLL_MINUTES`. Each filter is optional text the mail must contain (case aside): `from` in
	 * its sender, only when the receiving server's own (topmost) `Authentication-Results` says `dmarc=pass`, since a
	 * From line alone can be forged; `subject` in its subject, `to` in a recipient address (`owner+ci@…`).
	 */
	| { source: "email"; account: string; from?: string; subject?: string; to?: string }
	/**
	 * An event of an ICS calendar feed (`url`, https; Google, iCloud and Outlook all publish one) about to start: fires
	 * once per occurrence `leadMinutes` before it starts. The feed is read every `CALENDAR_POLL_MINUTES`.
	 */
	| { source: "calendar"; url: string; leadMinutes: number };

/** How often an email trigger asks its mailbox for new mail, in minutes. */
export const EMAIL_POLL_MINUTES = 2;
/** How often a calendar trigger reads its feed, in minutes. */
export const CALENDAR_POLL_MINUTES = 5;
export const CALENDAR_LEAD_MINUTES_MIN = 1;
export const CALENDAR_LEAD_MINUTES_MAX = 1440;
export const CALENDAR_LEAD_MINUTES_DEFAULT = 10;

export type ScheduleEventSource = ScheduleEvent["source"];

export interface ScheduleDraft {
	name: string;
	prompt: string;
	/** Absolute project folder the run starts in. */
	cwd: string;
	frequency: ScheduleFrequency;
	/** `--model` selector; null = omp's default model. */
	model: string | null;
	/** `--yolo`: run every tool without asking (print mode cannot ask). */
	autoApprove: boolean;
	enabled: boolean;
	/**
	 * A session file on this computer to deliver `prompt` into at every start (`ompdesk_schedule` with `target: "self"`),
	 * instead of running it as a fresh `omp -p`. `model` and `autoApprove` mean nothing then. Never set by a paired device.
	 */
	wakeSession?: string;
	/**
	 * A shell command run in `cwd` before every start, 60 s at most: exit 0 starts the run, anything else records it
	 * as skipped with the start of its output. In a save: absent keeps the schedule's, empty or null removes it. This
	 * computer's own schedules only (refused from a paired device).
	 */
	precheck?: string | null;
	/**
	 * Where a fresh run's answer goes when it succeeds (not a wake-up's: its session has it): a quiet note into a
	 * session file on this computer, or a notification. An answer ending in `NO_REPLY` goes nowhere. Absent in a save
	 * keeps the schedule's; null removes it.
	 */
	resultsTo?: ScheduleResultsTo | null;
	/** `--thinking <level>` of a fresh run; absent or null = omp's default. */
	thinking?: ScheduleThinking | null;
	/**
	 * A fresh run starts in a new git worktree of `cwd` made for it (seeded and set up as a worktree tab's), not in
	 * `cwd` itself. Disk care removes it once its work landed.
	 */
	worktree?: boolean;
}

/** Where a fresh run's answer goes (`ScheduleDraft.resultsTo`). */
export type ScheduleResultsTo = { kind: "session"; session: string } | { kind: "notify" };

/** Stock's `--thinking` levels (`CLI_THINKING_LEVELS` of pi-coding-agent's `thinking/levels`). */
export const SCHEDULE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
export type ScheduleThinking = (typeof SCHEDULE_THINKING_LEVELS)[number];

export interface Schedule extends ScheduleDraft {
	id: string;
	createdAt: string;
	/** The paired device that saved it (its agent or Settings there): every run counts against that device's daily model limit on this computer. Absent = this computer's own. */
	device?: string;
}

/** `stopped`: ended by the user or by the app closing; `skipped`: the previous run was still going. */
export type ScheduleRunStatus = "running" | "succeeded" | "failed" | "stopped" | "skipped";

export interface ScheduleRun {
	id: string;
	scheduleId: string;
	/** `manual`: run now (a routine's Test); `event`: its trigger fired. */
	trigger: "schedule" | "manual" | "event";
	startedAt: string;
	endedAt: string | null;
	status: ScheduleRunStatus;
	exitCode: number | null;
	/** Why a run failed to start or was skipped (English; the log has the details). */
	error: string | null;
	/** What fired an event run, one line per event (English), as its prompt was told; absent otherwise. */
	detail?: string;
	/** The same skip came this many times in a row; this row is the newest of them. Absent = once. */
	repeats?: number;
	/** The run failed before it launched (its files, its omp, the wake-up refused): it may be sent again once. */
	notStarted?: boolean;
	/** The run `resend` started for it: its one "Send again" is spent. */
	resentAs?: string;
	/** What a fresh run's model replies used (stock's session tally, subagents included). Absent for a wake-up run. */
	usage?: ScheduleRunUsage;
	/** The session file a fresh run's omp saved (Open session). Absent for a wake-up run or an omp too old to say. */
	session?: string;
	/** The worktree a `worktree` schedule's run ran in. */
	worktree?: string;
}

/** Tokens and USD cost of one run (`ScheduleRun.usage`). */
export interface ScheduleRunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface SchedulesState {
	/** Every schedule held, without editing each one. */
	paused: boolean;
	schedules: Schedule[];
	/** Newest first. */
	runs: ScheduleRun[];
	/** Next start per schedule id (ISO); null when it will not run (disabled or paused). */
	nextRuns: Record<string, string | null>;
	/** A webhook routine's recent calls, newest first, by schedule id (`WEBHOOK_CALLS_KEPT` each). */
	calls?: Record<string, WebhookCall[]>;
}

export type SchedulesRequest =
	| { action: "get" }
	| { action: "save"; id?: string; draft: ScheduleDraft }
	| { action: "delete"; id: string }
	| { action: "setEnabled"; id: string; enabled: boolean }
	| { action: "setPaused"; paused: boolean }
	| { action: "runNow"; id: string }
	| { action: "stop"; runId: string }
	/** Starts a run that could not start once more (`notStarted`); a second ask starts nothing. This computer only. */
	| { action: "resend"; runId: string }
	/** A new webhook key; `keepOld` keeps the old one working for `WEBHOOK_KEY_OVERLAP_MS`, else waiting calls go too. */
	| { action: "rotateKey"; id: string; keepOld: boolean }
	/** Calls must carry `sender`'s signature made with `secret` (kept by the core, never sent back); null: no signature. */
	| { action: "setSecret"; id: string; sender: WebhookSender | null; secret?: string }
	/** Settings' Send test call: the routine's own hook called with a sample body, past the key and signature check. */
	| { action: "sampleCall"; id: string };

/** A new schedule's id as the save that made it reported it, with the state after it. */
export interface ScheduleCreated {
	id: string;
	state: SchedulesState;
}

/** `device`: a paired host by id (Settings follows the focused tab); absent = this computer. */
export interface SchedulesApi {
	command(request: SchedulesRequest, device?: string): Promise<SchedulesState>;
	/** A run's captured output (stdout and stderr of `omp -p`), tail-capped. */
	readLog(runId: string, device?: string): Promise<string>;
	/** This computer's schedules changed. */
	onState(callback: (state: SchedulesState) => void): () => void;
	/** A paired host's schedules changed (the host pushes them over the link). */
	onHostState(callback: (device: string, state: SchedulesState) => void): () => void;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;
/** `owner/name` as GitHub spells a repository. */
export const GITHUB_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/** A branch name git accepts in `refs/heads/` (the common subset: no spaces, `..`, `~^:?*[\`, or leading `-`). */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[^\s~^:?*[\\]+(?<![./])$/;

/**
 * Why a draft cannot be saved, as a locale key suffix; null when it can. The core keeps a copy for the journal it
 * reads and the drafts it saves (`native/ompdesk/crates/core/src/schedules/rules.rs`); `schedules.test.ts` holds this
 * one to the same captured rows.
 */
export function scheduleDraftProblem(
	draft: ScheduleDraft,
): "name" | "prompt" | "cwd" | "interval" | "time" | "days" | "once" | "cron" | "event" | null {
	if (!draft.name.trim()) return "name";
	if (!draft.prompt.trim()) return "prompt";
	if (!draft.cwd || !ABSOLUTE.test(draft.cwd)) return "cwd";
	const frequency = draft.frequency;
	switch (frequency.kind) {
		case "interval": {
			const { minutes } = frequency;
			if (!Number.isInteger(minutes) || minutes < SCHEDULE_MIN_INTERVAL || minutes > SCHEDULE_MAX_INTERVAL)
				return "interval";
			return null;
		}
		case "daily":
			if (!TIME.test(frequency.time)) return "time";
			if (!frequency.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) return "days";
			return null;
		case "once":
			return typeof frequency.at === "string" && Number.isFinite(Date.parse(frequency.at)) ? null : "once";
		case "cron":
			// Its shape only: each field's ranges are the core's (`schedules/cron.rs`), which refuses the save.
			return typeof frequency.expr === "string" && CRON_SHAPE.test(frequency.expr.trim()) ? null : "cron";
		case "event":
			if (frequency.by !== undefined && !Number.isFinite(Date.parse(frequency.by))) return "event";
			return scheduleEventProblem(frequency.event) ? "event" : null;
		default:
			return "interval";
	}
}

const CRON_FIELD = String.raw`(?:\*|\d+(?:-\d+)?)(?:\/\d+)?(?:,(?:\*|\d+(?:-\d+)?)(?:\/\d+)?)*`;
const CRON_SHAPE = new RegExp(`^${CRON_FIELD}(?:\\s+${CRON_FIELD}){4}$`);

/** Whether "only when" filters and picked fields keep their shape and limits; null when they do. */
function webhookFiltersProblem(event: { where?: WebhookWhere[]; contains?: string; pick?: string[] }): string | null {
	const limits = WEBHOOK_FILTER_LIMITS;
	const path = (text: unknown) =>
		typeof text === "string" && /^(?:body|headers)(?:[.[]|$)/.test(text) && text.length <= limits.path;
	const where = event.where ?? [];
	if (!Array.isArray(where) || where.length > limits.where) return `at most ${limits.where} where tests`;
	for (const test of where) {
		if (!path(test?.path)) return "a where path starts at body or headers";
		if (!WEBHOOK_WHERE_OPS.includes(test.op)) return `a where op is one of ${WEBHOOK_WHERE_OPS.join(", ")}`;
		const values = test.values ?? [];
		const needsValues = test.op !== "exists" && test.op !== "!exists";
		if (needsValues !== values.length > 0 || values.length > limits.values) return "a where test's values";
		if (!values.every(value => typeof value === "string" && value.length <= limits.value))
			return "a where value is short text";
	}
	if (event.contains !== undefined && (typeof event.contains !== "string" || !event.contains.trim()))
		return "contains is text";
	const pick = event.pick ?? [];
	if (!Array.isArray(pick) || pick.length > limits.pick || !pick.every(path)) return "pick names body or header paths";
	return null;
}

/** Whether an event trigger is malformed (English, for the agent and the log); null when it is sound. */
export function scheduleEventProblem(event: ScheduleEvent): string | null {
	switch (event?.source) {
		case "webhook":
			if (typeof event.key !== "string" || event.key.length < 16) return "a webhook needs its key";
			return webhookFiltersProblem(event);
		case "github":
			if (!GITHUB_REPO.test(event.repo ?? "")) return "repo is owner/name";
			if (!nonEmptySubset(event.events, GITHUB_EVENT_KINDS))
				return `events are some of ${GITHUB_EVENT_KINDS.join(", ")}`;
			if (
				event.from !== undefined &&
				!(
					Array.isArray(event.from) &&
					event.from.length > 0 &&
					event.from.every(login => GITHUB_LOGIN_PATTERN.test(login))
				)
			)
				return "from lists GitHub logins";
			return [event.contains, event.label].every(
				value => value === undefined || (typeof value === "string" && value.trim() && value.length <= 200),
			)
				? null
				: "contains and label are short text";
		case "files":
			return ABSOLUTE.test(event.path ?? "") ? null : "path must be absolute";
		case "git":
			if (!ABSOLUTE.test(event.repo ?? "")) return "repo must be an absolute folder";
			return BRANCH.test(event.branch ?? "") ? null : "branch is not a branch name";
		case "session":
			if (event.folder !== undefined && (typeof event.folder !== "string" || !event.folder.trim()))
				return "folder must be text";
			return nonEmptySubset(event.events, SESSION_EVENT_KINDS)
				? null
				: `events are some of ${SESSION_EVENT_KINDS.join(", ")}`;
		case "email": {
			if (typeof event.account !== "string" || !event.account.trim() || event.account.length > 200)
				return "account names a mail account (its label or id)";
			const filters = [event.from, event.subject, event.to];
			return filters.every(
				value => value === undefined || (typeof value === "string" && value.trim() && value.length <= 200),
			)
				? null
				: "from, subject and to are short text";
		}
		case "calendar":
			if (typeof event.url !== "string" || !event.url.startsWith("https://") || event.url.length > 2000)
				return "url is an https:// address of an ICS calendar feed";
			return Number.isInteger(event.leadMinutes) &&
				event.leadMinutes >= CALENDAR_LEAD_MINUTES_MIN &&
				event.leadMinutes <= CALENDAR_LEAD_MINUTES_MAX
				? null
				: `leadMinutes is a whole number from ${CALENDAR_LEAD_MINUTES_MIN} to ${CALENDAR_LEAD_MINUTES_MAX}`;
		default:
			return "unknown event source";
	}
}

function nonEmptySubset(values: unknown, allowed: readonly string[]): boolean {
	return Array.isArray(values) && values.length > 0 && values.every(value => allowed.includes(value));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** When a schedule starts, in English for agents and logs: "every 30 min", "Mon, Wed at 09:00", "on a webhook call". */
export function describeFrequency(frequency: ScheduleFrequency): string {
	switch (frequency.kind) {
		case "interval":
			return `every ${frequency.minutes} min`;
		case "daily": {
			const days = frequency.days.map(day => WEEKDAYS[day] ?? String(day));
			return `${days.length > 0 ? days.join(", ") : "daily"} at ${frequency.time}`;
		}
		case "once":
			return `once at ${frequency.at}`;
		case "cron":
			return `on cron "${frequency.expr}"`;
		case "event":
			return `${describeEvent(frequency.event)}${frequency.by ? `, once, by ${frequency.by} at the latest` : ""}`;
	}
}

function describeEvent(event: ScheduleEvent): string {
	switch (event.source) {
		case "webhook":
			return `on a webhook call${event.signedBy ? ` signed by ${WEBHOOK_SENDER_NAMES[event.signedBy]}` : ""}`;
		case "github": {
			const filters = [
				event.from?.length ? `from ${event.from.join(", ")}` : null,
				event.label ? `labeled ${event.label}` : null,
				event.contains ? `containing "${event.contains}"` : null,
			].filter(Boolean);
			return `on GitHub ${event.events.join("/")} in ${event.repo}${filters.length > 0 ? ` ${filters.join(", ")}` : ""}`;
		}
		case "files":
			return `when files change under ${event.path}`;
		case "git":
			return `on new commits to ${event.branch} in ${event.repo}`;
		case "session":
			return `when a session ${event.events.map(kind => (kind === "waiting" ? "waits for the owner" : kind === "done" ? "finishes a turn" : "fails a turn")).join(" or ")}${event.folder ? ` in a folder containing ${event.folder}` : ""}`;
		case "email": {
			const filters = [
				event.from ? `from ${event.from}` : null,
				event.to ? `to ${event.to}` : null,
				event.subject ? `with "${event.subject}" in the subject` : null,
			].filter(Boolean);
			return `on new mail in ${event.account}${filters.length > 0 ? ` ${filters.join(", ")}` : ""}`;
		}
		case "calendar":
			return `${event.leadMinutes} min before an event of the calendar ${event.url} starts`;
	}
}
