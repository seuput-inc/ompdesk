/**
 * The OMPdesk control host tools (contract in `src/shared/agent-control.ts`): their stock `set_host_tools`
 * definitions and the argument schemas `service.ts` parses a call with. Usage guidance for the model lives in the
 * built-in skill `resources/omp-builtin/skills/ompdesk/SKILL.md`; each description here stays short because stock
 * lists every host tool in the session's xd:// device notice.
 */
import { z } from "zod";
import { ATTACHMENT_MAX_BYTES } from "../../../resources/gui-bridge/agent-control-contracts";
import { AUTOPILOT_AREAS } from "../../../resources/gui-bridge/modes/autopilot-contracts";
import { AGENT_SCHEDULE_PREFIX, type AgentControlToolName, AGENT_CONTROL_TOOLS as T } from "../../shared/agent-control";
import { LOOK_EVERY, LOOK_FOCUS_MAX } from "../../shared/bot-limits";
import { ITEM_STATUSES } from "../../shared/bots";
import type { HostToolDefinition } from "../../shared/rpc-types";
import {
	GITHUB_EVENT_KINDS,
	GITHUB_REPO,
	SCHEDULE_THINKING_LEVELS,
	SESSION_EVENT_KINDS,
	WEBHOOK_FILTER_LIMITS,
	WEBHOOK_WHERE_OPS,
} from "../../shared/schedules";
import { MAIL_KINDS } from "./mail";

/** An attachment as the tool takes it (exactly one field): a file where the caller's omp runs, or one of its conversation's pictures. */
export type Attachment = { path?: string; image?: number };

export type ReportArgs = {
	kind: (typeof MAIL_KINDS)[number];
	text: string;
	files?: string[];
	checks?: { command: string; passed: boolean }[];
	to?: string;
	dispatch?: string;
	id?: string;
	attachments?: Attachment[];
};

/** `ompdesk_session_result` waits at most this long by default, and never longer than the maximum. */
export const RESULT_WAIT_DEFAULT_SECONDS = 600;
export const RESULT_WAIT_MAX_SECONDS = 3600;
/** A returned answer is cut to this many characters (the session keeps the whole of it). */
export const RESULT_MAX_CHARS = 20_000;
/** With several sessions in one `ompdesk_session_result` call each answer is cut to this many characters. */
export const RESULT_TABLE_ANSWER_CHARS = 1_500;
/** `ompdesk_session_read` returns at most this many characters and this many messages per page. */
export const READ_MAX_CHARS = 16_000;
export const READ_DEFAULT_MESSAGES = 12;
export const READ_MAX_MESSAGES = 40;
/** A message another session receives is at most this long. */
export const MESSAGE_MAX_CHARS = 50_000;
/** A bot's name, at most (`NAME_MAX` in the core's `agentctl/service/work/bots.rs`). */
const BOT_NAME_MAX = 80;
/** An item's title, description and any other text, at most (`work/items.rs` checks the owner's own the same). */
const ITEM_TITLE_MAX = 200;
const ITEM_DESCRIPTION_MAX = 20_000;
const ITEM_TEXT_MAX = 8_000;
/** Questions one ask holds and one question's words, at most (`DECISIONS_MAX`, `DECISION_MAX` in the core). */
const ITEM_ASKS_MAX = 5;
const ITEM_ASK_MAX = 500;
/** One room post, at most (`POST_MAX` in the core's `work/rooms.rs`). */
const ROOM_POST_MAX = 20_000;

const SESSION = {
	type: "string",
	description:
		"The session: its saved id (ompdesk_sessions prints it as `saved id`, and a message from a session carries it as `session`; the same on every computer and after a relaunch), its tab id as ompdesk_sessions lists it (this app's own, different on another computer and new after a relaunch; an id it had before a relaunch still works here), a unique prefix of either, or its title (or a unique start of it; refused when several sessions hold it).",
} as const;
const DEVICE = {
	type: "string",
	description:
		'A paired device (Settings › Devices) by name or id; "local" is this computer. ompdesk_sessions lists them.',
} as const;
/** The pictures and files `ompdesk_session_send` and `ompdesk_report` carry (attachments.ts). */
const ATTACHMENTS = {
	type: "array",
	items: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "A file on the computer YOUR session runs on: absolute, or relative to your folder.",
			},
			image: {
				type: "integer",
				minimum: 1,
				description:
					"The n-th newest picture of YOUR conversation: 1 is the newest (the one the user just pasted, or a tool returned).",
			},
		},
		additionalProperties: false,
	},
	description: `Pictures and files to send along; each item is {path} or {image}, exactly one. A picture reaches the session inline, any other file is put on its computer and the message names its path there. Each at most ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MiB; any number of items; the same bytes twice go once; nothing is sent if one cannot be read.`,
} as const;

const PLACEMENT = ["focus", "split-right", "split-down"] as const;

const OPEN_ONE = {
	message: { type: "string", description: "First message; the session starts working on it at once." },
	folder: {
		type: "string",
		description:
			"Working folder (absolute, or relative to yours); default your own folder. On another device: absolute, default its workspace.",
	},
	device: {
		...DEVICE,
		description: `${DEVICE.description} Default: the device your own session runs on.`,
	},
	reopen: {
		type: "string",
		description:
			"Open a stored session again instead of a new one: its id from ompdesk_sessions scope stored. It opens in the folder it worked in: worktree and mode do not apply, and folder only when it names that same folder.",
	},
	restore: {
		type: "boolean",
		description:
			"With reopen: when the session's folder is gone and OMPdesk's disk care saved it, put that worktree back first (its branch, uncommitted work and archived files), then open the session there.",
	},
	model: {
		type: "string",
		description:
			"provider/id, an id from the model list, or one of the person's model roles (task, smol, plan, …), resolved to what that role runs on when the session opens; default the session's default model. A narrow, mechanical implementation: task.",
	},
	mode: {
		type: "string",
		enum: ["goal"],
		description:
			"goal: the message becomes the session's goal (needs message). Leave it out for a plain first message.",
	},
	worktree: {
		anyOf: [
			{ type: "boolean" },
			{
				type: "object",
				properties: {
					branch: { type: "string", description: "Branch name; default omp/agent/<slug>." },
					base: {
						type: "string",
						description:
							'Start ref: "HEAD" (default: the HEAD of your folder\'s repo), "default" (the remote\'s default branch), or any branch, tag or commit the repo resolves.',
					},
				},
				additionalProperties: false,
			},
		],
		description:
			"true: give the session its own git worktree and branch, so parallel sessions never edit the same files.",
	},
	throwaway: {
		type: "boolean",
		description:
			"true: a one-off session (a lookup, a check). Once its final answer ends with Result: ok and has reached you, OMPdesk closes it and deletes its saved session, on a paired device too. Not with reopen.",
	},
	item: {
		type: "string",
		description:
			"From a bot's chat: the item (its number or id) this session works on; it is linked to the item, and a planned item becomes working. A bot's chat opens with the bot's model unless model names one.",
	},
} as const;

export const AGENT_CONTROL_DEFINITIONS: readonly HostToolDefinition[] = [
	{
		name: T.list,
		label: "OMPdesk sessions",
		description:
			"List your open sessions, saved sessions and paired devices.\n" +
			"List sessions: those open in this OMPdesk window (default), in every window of this app (scope app, which includes sessions running on paired devices), or the saved sessions on this computer or a paired device (scope stored: closed ones too, with text search). Each with id, title, folder, device, state (running with its current step, waiting for the user's answer, idle), subagents, todos and the start of its last answer; also the paired devices. An open session's first id is its tab id, this app's own: it differs on another computer and changes when OMPdesk relaunches. Its `saved id` is the session's id everywhere and for good: give that one to another session, and answer a message by the `session` it carries. Sessions the user hid from agents show as private. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				scope: {
					type: "string",
					enum: ["window", "app", "stored"],
					description: "window (default), app (every window), or stored (saved sessions, open or not).",
				},
				device: { ...DEVICE, description: `${DEVICE.description} Only that device's sessions.` },
				folder: { type: "string", description: "Only sessions whose folder contains this text." },
				status: {
					type: "string",
					enum: ["running", "waiting", "idle"],
					description: "Open sessions only: running, waiting for the user, or idle.",
				},
				mine: { type: "boolean", description: "Only the sessions you opened." },
				query: {
					type: "string",
					description: "Text to find in titles (and, with scope stored, in the conversations).",
				},
				limit: { type: "integer", minimum: 1, maximum: 100, description: "Rows at most; default 30." },
			},
			additionalProperties: false,
		},
	},
	{
		name: T.open,
		label: "Open OMPdesk session",
		description: "Open new sessions (tabs) to work in parallel with you; returns ids.\nSee skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				...OPEN_ONE,
				sessions: {
					type: "array",
					items: {
						type: "object",
						properties: Object.fromEntries(
							Object.entries(OPEN_ONE).map(([key, { description: _, ...schema }]) => [key, schema]),
						),
						additionalProperties: false,
					},
					description:
						"For a batch, use this array instead of the single-session fields described above. Each item takes those same fields.",
				},
				show: {
					type: "string",
					enum: ["background", ...PLACEMENT],
					description:
						"background (default) keeps the user's view; focus switches to the first; split-* shows it beside.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: T.send,
		label: "Message OMPdesk session",
		description:
			"Send a message to another open session.\n" +
			'An idle session starts on it; a running one reads it at its next step, together with every other message waiting for it (it cuts no tool and leaves a question card the user has open, which it reads the message after). There is no way to hold a message until the turn ends. A session still starting gets it kept, and reads it once it is up: the call returns at once, so do not send it again. A session blocked in ompdesk_session_result with wait takes it at once: its wait returns early. The session sees it as sent by you, an agent: `<ompdesk-agent-message from="<your title>" session="<your saved id>">`, so it answers you by that saved id. The receipt names the session it reached (title, saved id, computer) and what it is doing, and what will actually happen to the message. Pictures and files go along in attachments. It cannot answer that session\'s pending question: only the user does. See skill://ompdesk.',
		parameters: {
			type: "object",
			properties: {
				session: {
					...SESSION,
					description: `${SESSION.description} Or a bot by name: "bot:<name>" (its home chat on this computer, opened if closed), "bot:<name>@<device>" (a bot on a paired computer, which takes it only when this computer is in the bot's reach).`,
				},
				sessions: {
					type: "array",
					items: { type: "string" },
					description:
						"Several sessions at once, instead of session: each gets the message and its own receipt line. @children names every open session you opened, @idle those of them that are idle (not running, no card waiting).",
				},
				item: {
					type: "string",
					description:
						"Instead of session(s): send text to this bot board item's current holder. Use its immutable id (or #number on a new board) and a request_id. Does not assign new work or answer a question.",
				},
				message: { type: "string" },
				request_id: {
					type: "string",
					description:
						"Your id for this message; sending again with the same id never delivers it twice (returns the first receipt).",
				},
				attachments: ATTACHMENTS,
			},
			required: ["message"],
			additionalProperties: false,
		},
	},
	{
		name: T.report,
		label: "Report to OMPdesk opener",
		description:
			"Report progress or results to the session that opened you.\n" +
			"Tell the session that opened you (or a sibling it opened) about your work, instead of waiting to be asked; or tell a session working in the same checkout (the <shared-checkout> section names it) what you are about to do, or ask it to commit or hold off. Every report reaches a working session between its steps (its tool calls are not cut, a `wait` returns on it). kind: progress (a short status; coalesced; never wakes an idle session), done (the work is finished: summary, changed files, checks you ran; wakes it when idle), question or blocked (you need its decision; wakes it when idle; do not guess meanwhile), review (ready for its review; wakes it when idle), note (to a sibling or a session in the same checkout: e.g. 'I am committing src/a.ts'; never wakes an idle session). A picture or file goes along in attachments. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["progress", "done", "blocked", "question", "review", "note"] },
				text: { type: "string", description: "What to tell; for done, the summary." },
				files: { type: "array", items: { type: "string" }, description: "done: files you changed." },
				attachments: ATTACHMENTS,
				checks: {
					type: "array",
					items: {
						type: "object",
						properties: { command: { type: "string" }, passed: { type: "boolean" } },
						required: ["command", "passed"],
						additionalProperties: false,
					},
					description: "done: the checks you ran and whether each passed.",
				},
				to: {
					type: "string",
					description:
						"A sibling's session id (opened by the same session), or a session working in the same checkout; default the session that opened you. \"bot:<name>\" names a bot's home chat (a session handed to a bot reports to it as its opener anyway).",
				},
				dispatch: {
					type: "string",
					description: "The dispatch id your task message named; a report for an older dispatch is ignored.",
				},
				id: {
					type: "string",
					description: "Your id for this report; a repeat with the same id is delivered once.",
				},
			},
			required: ["kind", "text"],
			additionalProperties: false,
		},
	},
	{
		name: T.result,
		label: "Read OMPdesk session result",
		description:
			"Read another session's last answer and state, optionally waiting for it.\n" +
			"Multiple results form a compact table. A wait also ends if a session needs the user's answer or the timeout expires. An incoming steer or report returns the wait early with a notice; read it before waiting again. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				session: SESSION,
				sessions: {
					type: "array",
					items: { type: "string" },
					description: `Several session ids; instead of session.`,
				},
				wait: { type: "boolean", description: "Wait for the state change first; default false." },
				until: {
					type: "string",
					enum: ["all", "any"],
					description: "With wait and several sessions: all finished (default) or the first one.",
				},
				timeout_seconds: {
					type: "integer",
					minimum: 1,
					maximum: RESULT_WAIT_MAX_SECONDS,
					description: `With wait: how long to wait; default ${RESULT_WAIT_DEFAULT_SECONDS}.`,
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: T.read,
		label: "Read OMPdesk session transcript",
		description:
			"Read another session's transcript, open or stored.\n" +
			"Returns a bounded page of the newest user messages, assistant messages and tool calls. Read-only. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				session: SESSION,
				limit: {
					type: "integer",
					minimum: 1,
					maximum: READ_MAX_MESSAGES,
					description: `Messages per page, 1 to ${READ_MAX_MESSAGES}; default ${READ_DEFAULT_MESSAGES}.`,
				},
				before: {
					type: "string",
					description:
						"The cursor a previous page returned, for the page before it. A cursor the session has outgrown (it wrote more since, or its tab closed) returns its newest page instead, saying so.",
				},
			},
			required: ["session"],
			additionalProperties: false,
		},
	},
	{
		name: T.focus,
		label: "Show OMPdesk session",
		description: "Show a session to the user: switch to its tab or open it as a split.",
		parameters: {
			type: "object",
			properties: { session: SESSION, how: { type: "string", enum: PLACEMENT, description: "Default focus." } },
			required: ["session"],
			additionalProperties: false,
		},
	},
	{
		name: T.notify,
		label: "Notify the user",
		description:
			"Show the user a system notification when work finishes or needs them.\n" +
			"Use while the user is looking elsewhere. Clicking the notification opens this session.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string" },
				body: { type: "string" },
			},
			required: ["title"],
			additionalProperties: false,
		},
	},
	{
		name: T.answer,
		label: "Answer OMPdesk session question",
		description:
			"Answer the question another session is waiting on.\n" +
			"Answer the question another session is waiting on (shown by ompdesk_sessions as waiting for the user's answer). The answer is marked as given by an agent. A tool approval is approved only if the user allowed agents to (Settings), else the user must; deny always works. A card a session raised for a bot's request comes to that bot's chat: only it answers it (a form too: answers, one entry per field), naming the card's request, or passes a choice only the owner can make on to them with escalate. attachments (a picture or file) reach that session first, as a note ahead of the answer; if one cannot be sent, nothing is. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				session: SESSION,
				attachments: ATTACHMENTS,
				request: {
					type: "string",
					description:
						"Request id when several wait; default the oldest. Required for a card that came to you as a bot (its card names it).",
				},
				choice: {
					type: "string",
					description:
						'The option to pick (select questions; a tool approval: Approve, Deny, or stock\'s "Approve <tool> for this session" when offered, which grants later like calls too).',
				},
				approve: {
					type: "boolean",
					description: "Yes/no for a confirmation, Approve/Deny for a tool approval.",
				},
				text: {
					type: "string",
					description:
						"Typed answer (input and editor prompts), or why a denied tool approval was denied (sent to the session after the denial).",
				},
				answers: {
					type: "array",
					description: "For a multi-question ask or a form: one entry per question or field.",
					items: {
						type: "object",
						properties: {
							id: { type: "string", description: "Question id." },
							selected: { type: "array", items: { type: "string" } },
							text: { type: "string", description: "Custom answer." },
						},
						additionalProperties: false,
					},
				},
				escalate: {
					type: "boolean",
					description:
						"A bot passes a card that came to it on to the owner: it shows in the bot's chat, and the owner's answer goes straight to that session.",
				},
			},
			required: ["session"],
			additionalProperties: false,
		},
	},
	{
		name: T.compare,
		label: "Compare OMPdesk sessions' work",
		description:
			"Compare and judge sessions' work: checks, branches, optional ranked verdict.\n" +
			"For each session, shows the final answer, the checks it ran (test, build, lint commands from its transcript, with their outcome) and, for a git worktree, branch, commits ahead, changed files with line counts and uncommitted work. With criteria, a judge model (your slow role) grades each against them and returns a ranked verdict with reasons and a winner. It runs no tests itself. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: {
				sessions: {
					type: "array",
					items: { type: "string" },
					description: `Session ids, open or stored; default every worktree session you opened.`,
				},
				criteria: {
					type: "array",
					items: { type: "string" },
					description: `Acceptance criteria to judge against; without them nothing is judged.`,
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: T.merge,
		label: "Merge an OMPdesk session's branch",
		description:
			"Merge a worktree session's branch into the parent checkout.\n" +
			"Targets the parent's current branch on the session's computer; creates a merge commit, never pushes. No card by default; the user confirms first only if they turned off \"Let agents manage other sessions\". A conflict aborts the merge and lists the files. The repository's .ompdesk/worktree-pre-merge (run in the worktree) must exit 0 before the merge starts, and .ompdesk/worktree-post-merge (run in the parent checkout) runs after it landed; a failing post-merge hook is reported and the merge stays. Refuses when the session or the parent has uncommitted changes. See skill://ompdesk.",
		parameters: {
			type: "object",
			properties: { session: SESSION },
			required: ["session"],
			additionalProperties: false,
		},
	},
	{
		name: T.schedule,
		label: "Schedule an OMPdesk run",
		description:
			"Create, list, change or cancel scheduled runs and routines: on a timer, once, or on an event.\n" +
			`Create, list, change or cancel a scheduled run: a prompt that OMPdesk runs as a fresh print-mode session in a folder, only while the app is open on that device (its Settings › Schedules shows it, marked ${AGENT_SCHEDULE_PREFIX.trim()}). device picks the computer it runs on (default: the one your session runs on). create needs name, prompt and exactly one start: every_minutes, daily_at (HH:MM, optional days 0-6), cron (five fields, local time), at or in_minutes (once), or on (an event: webhook, github, files, git, session, email, calendar; with by or within_minutes it is a wait that runs once, on the event or at the deadline). With target "self" the prompt is instead delivered into your own session each time (a routine of yours, or a follow-up to check later). results_to sends a fresh run's answer into this session or a notification, unless the run ends its answer with NO_REPLY. thinking sets a fresh run's thinking level and worktree starts each fresh run in a new worktree of the folder. precheck runs a shell command before each start and starts the run only when it succeeds; the user confirms every precheck. update changes an agent-made one by id; pause, resume and run (a test run now) act on one; runs shows its run history with failure reasons. No card by default; the user confirms a new one only if they turned off "Let agents manage other sessions". It never runs with auto-approve, and you can change or cancel only agent-made schedules. See skill://ompdesk.`,
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["create", "list", "cancel", "update", "pause", "resume", "run", "runs"] },
				name: { type: "string", description: "create, update: a short name." },
				prompt: {
					type: "string",
					description:
						"create, update: what each run is asked; a fresh run has no memory of this conversation. An event run is also told what fired it.",
				},
				folder: {
					type: "string",
					description:
						"create: absolute project folder on that device; default your own (required on another device).",
				},
				every_minutes: {
					type: "integer",
					description: "create, update: repeat every N minutes (at least 5).",
				},
				daily_at: { type: "string", description: "create, update: local time HH:MM, every day or on days." },
				days: {
					type: "array",
					items: { type: "integer" },
					description: "with daily_at: weekdays, 0 = Sunday.",
				},
				at: {
					type: "string",
					description:
						"create, update: once, at this moment (ISO 8601 with an offset, e.g. 2026-11-02T09:00:00+09:00); it then turns itself off.",
				},
				in_minutes: {
					type: "integer",
					description: "create, update: once, this many minutes from now (a follow-up); it then turns itself off.",
				},
				on: {
					type: "object",
					description:
						'create, update: start on an event instead of a clock. {"source":"webhook","where":[{"path":"body.action","op":"=","values":["opened"]}],"contains":"text","pick":["body.pull_request.title"]} (POST to this computer\'s OMPdesk web server, the answer gives the URL path and key; Mobile web must be on; where (paths start at body. or headers.; op =, !=, contains, exists, !exists), contains and pick are optional: only calls that match start it, and the run is quoted the picked fields with the whole body in a file; a signing secret is set only by the user in Settings, never by you); {"source":"github","repo":"owner/name","events":["pull_request"|"pr_merged"|"pr_closed"|"issue"|"issue_closed"|"comment"|"labeled"|"ci_failure"|"ci_passed"|"workflow_finished"|"release"|"push"],"from":["login"],"contains":"text","label":"name"} (asked with the user\'s gh every 5 min; from, contains and label are optional filters); {"source":"files","path":"/abs/path"} (a file or folder changed); {"source":"git","repo":"/abs/repo","branch":"main"} (new local commits); {"source":"session","events":["done"|"failed"|"waiting"],"folder":"text"} (another session on this computer finished, failed or waits for the user; never the session a "self" one wakes or ones it opened); {"source":"email","account":"label","from":"ann@example.com","subject":"text","to":"owner+ci@"} (new mail in a mailbox the user added in Settings › Schedules › Email accounts, by its label, checked every 2 min; subject and to are optional text the mail must contain; from is an optional address or domain, and matches only mail naming that one sender whose domain the mailbox\'s own server says passed DMARC; a reply sent from that mailbox or an automatic mail never starts it; this computer only); {"source":"calendar","url":"https://…/basic.ics","lead_minutes":10} (each event of an ICS calendar feed, lead_minutes (1-1440, default 10) before it starts; the feed is read every 5 min). Events during a run start one more run after it; a sender\'s retry of a webhook delivery runs once.',
					properties: {
						source: {
							type: "string",
							enum: ["webhook", "github", "files", "git", "session", "email", "calendar"],
						},
						repo: { type: "string" },
						events: { type: "array", items: { type: "string" } },
						path: { type: "string" },
						branch: { type: "string" },
						folder: { type: "string" },
						account: { type: "string" },
						from: {
							description: "email: text in the sender; github: logins.",
							anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
						},
						subject: { type: "string" },
						to: { type: "string" },
						url: { type: "string" },
						where: { type: "array", items: { type: "object" } },
						contains: { type: "string" },
						pick: { type: "array", items: { type: "string" } },
						label: { type: "string" },
						lead_minutes: { type: "integer" },
					},
					required: ["source"],
					additionalProperties: false,
				},
				by: {
					type: "string",
					description:
						"create, update, with on: a deadline (ISO 8601 with an offset). It runs once, on the first event or at the deadline with no event, then turns itself off: a wait.",
				},
				within_minutes: {
					type: "integer",
					description: "create, update, with on: the same deadline as minutes from now.",
				},
				precheck: {
					type: "string",
					description:
						"create, update: a shell command run in the folder before each start (60 s at most). The run starts only when it exits 0; otherwise it is recorded as skipped with the command's output. The user confirms every precheck. This computer only; empty removes it.",
				},
				results_to: {
					type: "string",
					enum: ["self", "notify"],
					description:
						'create, update: a fresh run\'s answer goes into THIS session as a note ("self") or into a notification ("notify"); a run that ends its answer with the line NO_REPLY sends nothing. Not with target.',
				},
				model: { type: "string", description: "create, update: provider/id; default omp's default model." },
				cron: {
					type: "string",
					description:
						'create, update: a start on five-field cron in local time ("minute hour day month weekday", e.g. "30 9 * * 1-5").',
				},
				thinking: {
					type: "string",
					enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
					description: "create, update: a fresh run's thinking level.",
				},
				worktree: {
					type: "boolean",
					description:
						"create, update: each fresh run starts in a new git worktree of the folder (seeded as a worktree tab's), not in the folder itself.",
				},
				device: {
					...DEVICE,
					description: `${DEVICE.description} The computer whose schedules these are. Default: the device your own session runs on.`,
				},
				id: {
					type: "string",
					description: "cancel, update, pause, resume, run, runs: the schedule id list shows.",
				},
				target: {
					type: "string",
					description:
						'create: "self" delivers the prompt into THIS session at each start, as a message that starts a turn (this session is opened in the background if no tab holds it), instead of running a fresh session: a routine or a follow-up of yours. Give the prompt as a note to yourself, since you keep this conversation. This computer\'s sessions only; no folder, model or device. A repeating or event one runs until you cancel it; a once one turns itself off. "bot:<name>" does the same into that bot\'s home chat on this computer, in its folder with its model (refused while it has no home chat).',
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: T.autopilot,
		label: "OMPdesk Autopilot",
		description:
			"Start, inspect or stop an unattended Autopilot run on a git repo.\n" +
			`Start, inspect or stop an Autopilot run: an unattended loop that keeps improving a git repo in its own worktree (cycles of audit, change, check, commit; it can push and release when the ship level allows). start opens the run as a new session of yours and returns its id; status reads its cycle, current item, red streak, last commit/push/release and why it paused or ended; stop ends it after the cycle in flight (now: true aborts the turn at once and pauses it). No card by default; the user confirms a start only if they turned off "Let agents manage other sessions", and always for ship release or the repo's default branch. See skill://ompdesk.`,
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["start", "status", "stop"] },
				folder: {
					type: "string",
					description:
						"start: absolute project folder on that device; default your own. On this computer it must be open in a session of this window; on a paired device a session there is opened for it when none has it open.",
				},
				device: {
					...DEVICE,
					description: `${DEVICE.description} start: where the run works (its worktree, checks and shipping run on that computer). Default: the device your own session runs on.`,
				},
				guide: {
					type: "string",
					description:
						"start: AUTOPILOT.md text to commit as the run branch's first commit when it differs (default: the repo's own, else one OMPdesk builds; a missing Release section is added from the project's facts).",
				},
				ship: {
					type: "string",
					enum: ["commit", "push", "release"],
					description: "start: how far the run may ship; default commit. release always asks the user.",
				},
				branch: {
					type: "object",
					properties: {
						kind: { type: "string", enum: ["new", "existing"] },
						name: { type: "string", description: "new: optional branch name; existing: the branch to work on." },
					},
					required: ["kind"],
					additionalProperties: false,
					description: "start: where the run commits; default a new autopilot/<date> branch.",
				},
				advanced: {
					type: "object",
					properties: {
						focus: {
							type: "array",
							items: { type: "string", enum: [...AUTOPILOT_AREAS] },
							description: "Areas the cycles favour; default all.",
						},
						cadence: {
							type: "integer",
							description: "With ship release: release every N cycles; default the run decides.",
						},
						remote: {
							type: "string",
							description: "Git remote a push goes to; default origin, else the only remote.",
						},
						limits: {
							type: "object",
							properties: {
								tokens: { type: "number" },
								minutes: { type: "number" },
								cycles: { type: "number" },
								usd: { type: "number" },
							},
							additionalProperties: false,
							description: "Ceilings that pause the run; default none.",
						},
					},
					additionalProperties: false,
					description: "start: optional tuning; anything omitted keeps the Autopilot sheet's defaults.",
				},
				session: {
					type: "string",
					description: "status, stop: the run's session id from start or ompdesk_sessions.",
				},
				now: {
					type: "boolean",
					description: "stop: true aborts the running turn at once (pauses the run); default false.",
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: T.stop,
		label: "Stop OMPdesk session",
		description:
			"Stop another session's work; optionally close or delete it.\n" +
			"Stop another session's running work; close: true also closes its tab (the session stays saved), delete: true also deletes the saved session (also one no tab holds: its stored id, or the id its tab had before it closed this launch, with device for a paired device's). Sessions you opened, closed ones included: no question asked. Other sessions: stop and close need no card by default (the user may turn that off); deleting one's saved session always asks the user first (a refusal is final). A session the user typed into, or one you did not open that the user looks at, is stopped, closed or deleted only in a turn the user's own message to you started; in a turn another agent's message, a report, a schedule or Autopilot started it is refused. A session you opened that the user only looks at is stopped, closed or deleted at once.",
		parameters: {
			type: "object",
			properties: {
				session: SESSION,
				close: { type: "boolean", description: "Also close the tab; default false." },
				delete: { type: "boolean", description: "Also delete the saved session; default false." },
				device: {
					...DEVICE,
					description: `${DEVICE.description} Where a stored session id is saved; default this computer or the last stored list.`,
				},
			},
			required: ["session"],
			additionalProperties: false,
		},
	},
	{
		name: T.appList,
		label: "OMPdesk app actions",
		description:
			"List the OMPdesk app actions you can take: settings, panels, usage, models.\n" +
			"List what you can do to OMPdesk itself (settings, side panel, usage, models, saved sessions, updates, sign-in starts) with each action's tier and argument schema. Filter by area or query. See skill://ompdesk/references/app-control.md.",
		parameters: {
			type: "object",
			properties: {
				area: { type: "string", description: "An area such as settings, ui, usage, models, sessions, updates." },
				query: { type: "string", description: "Words to match in an action's id or description." },
			},
			additionalProperties: false,
		},
	},
	{
		name: T.app,
		label: "OMPdesk app action",
		description:
			"Run one OMPdesk app action from ompdesk_app_list.\n" +
			"Do one OMPdesk app action from ompdesk_app_list: change a setting, open a panel, read usage, and so on. Changes are shown to the user with an undo; some actions ask the user first whatever their settings say (they erase data, install code, start a sign-in, change the proxy, expose the computer or end running work); some are never available. See skill://ompdesk/references/app-control.md.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", description: "Action id from ompdesk_app_list, e.g. settings.theme." },
				args: {
					type: "object",
					description: "The action's arguments as its schema says.",
					additionalProperties: true,
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: T.bot,
		label: "OMPdesk bot",
		description:
			"Make, list, pause or set up a bot: a folder whose sessions are its chats.\n" +
			"offer {name, text} proposes a bot instead of making it: the owner sees a card in this chat with its name, what it would do (text) and Create bot, and nothing is made until they press it. " +
			"rename {bot, name} renames it and tells its home chat to update its own files. A folder in ~/.omp/bots follows the new name's slug, with its chats and routines (once the chats there end their turns); a folder outside it never moves, nor one whose new name's folder is taken. " +
			"A bot is a folder on this computer (default ~/.omp/bots/<name>); every session in that folder is one of its chats, the first its home chat. create {name, folder?} makes the folder and sends nothing: the owner writes first (asks the user first only if they turned off \"Let agents manage other sessions\"). list shows each bot with its folder, home chat, pause, specialty (from its SOUL.md) and open and owner-waiting items. pause {bot} holds every message to it until resume {bot}, which hands each held one over once; a send to a paused bot is refused. set {bot, model?, auto_approve?, stale_days?, reach?} sets the model its new chats and routines use (\"\" for omp's default), whether its routines run without asking, after how many untouched days an open item reads stale (0 never), and the paired devices whose agents may message it. look_around {bot?, on?, every?, weekdays_only?, focus?} changes only what it names of its Look around: a read-only look in its home chat at the preset's hours (every-4h, the default, every-2h, twice-daily or mornings), weekdays unless weekdays_only is false, looking for focus (the owner's words); change it only when the owner asks. From a bot's chat, bot defaults to that bot. suggestions {bot?} lists what its Suggestions list holds, what the owner started lately and what they dismissed; suggest {suggestions: [{title, why, ask, link?}]} (a bot's chat only, at most 5) replaces that list with this look's next steps, an empty list clearing it. hand {bot?, session, text} hands a session to the bot: the bot's home chat becomes its opener and the text reaches it from the bot; from a bot's chat it takes the session over for that bot. From a bot's own chat: connectors lists where people can ask it (Slack, GitHub, Linear, Google) and who may; reply {to, text} answers someone who asked it there (to is the handle its run was told); offer_connector {service} shows the owner a Connect card for a service it lacks. Only the owner deletes a bot or picks how its chats are approved. See skill://ompdesk/references/bots.md.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"create",
						"offer",
						"list",
						"pause",
						"resume",
						"set",
						"rename",
						"look_around",
						"suggestions",
						"suggest",
						"hand",
						"connectors",
						"reply",
						"offer_connector",
					],
				},
				name: { type: "string", maxLength: BOT_NAME_MAX, description: "create, offer, rename: the bot's name." },
				folder: {
					type: "string",
					description: "create: an absolute folder for it; default ~/.omp/bots/<name>, made unique.",
				},
				bot: { type: "string", description: "The bot: its name or id." },
				model: { type: "string", description: 'set: provider/id for its chats and routines; "" clears it.' },
				auto_approve: { type: "boolean", description: "set: its routines run every tool without asking." },
				stale_days: {
					type: "integer",
					minimum: 0,
					maximum: 365,
					description: "set: days an open item may go untouched before it reads stale; 0 never.",
				},
				reach: {
					type: "array",
					items: { type: "string" },
					description: "set: paired devices (name or id) whose agents may message it; [] this computer only.",
				},
				on: { type: "boolean", description: "look_around: true turns it on, false off." },
				every: {
					type: "string",
					enum: [...LOOK_EVERY],
					description:
						"look_around: every-4h (8:00 to 20:00), every-2h, twice-daily (8:00, 13:00) or mornings (8:00).",
				},
				weekdays_only: { type: "boolean", description: "look_around: false looks every day." },
				focus: {
					type: "string",
					maxLength: LOOK_FOCUS_MAX,
					description: 'look_around: what to look for, in the owner\'s words; "" is anything waiting on them.',
				},
				suggestions: {
					type: "array",
					maxItems: 5,
					description: "suggest: this look's whole list of next steps.",
					items: {
						type: "object",
						properties: {
							title: { type: "string", maxLength: 80, description: "What to do." },
							why: { type: "string", maxLength: 400, description: "One sentence on why now." },
							ask: {
								type: "string",
								maxLength: 2000,
								description: "The message the owner would send the bot to do it, written as them.",
							},
							link: { type: "string", description: "The thread, issue or pull request it is about." },
						},
						required: ["title", "why", "ask"],
						additionalProperties: false,
					},
				},
				session: { ...SESSION, description: `hand: the session to hand over. ${SESSION.description}` },
				text: {
					type: "string",
					maxLength: MESSAGE_MAX_CHARS,
					description:
						"hand: what the bot asks of it, sent as its first message from the bot. offer: what the bot would do, one or two sentences. reply: the answer to post (Markdown).",
				},
				to: {
					type: "string",
					maxLength: 300,
					description:
						"reply: where to answer, the handle the run was told after 'reply with ompdesk_bot reply to' (slack:…, github:…, linear:…).",
				},
				service: {
					type: "string",
					enum: ["slack", "github", "linear", "google"],
					description: "offer_connector: the service to show the owner a Connect card for in this chat.",
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: T.item,
		label: "Bot item",
		description:
			"Manage a bot's items in its chat. A worker can only confirm its own board-issued assignment with claim {item: immutable id, generation}.\n" +
			"Items are what a bot works on for its owner and what it needs from them, numbered per bot; the owner sees them on the Bots page. add {title, description?, done_means?, status?} (status planned by default); set {item, …}: status (planned, working, waiting, needs_you, done, canceled), title, description, ask with options and recommended (a question only the owner can answer: the item waits on them, and their answer arrives here as a message that starts a turn), or asks (up to 5 questions at once, each with its options; ask is then the words around them), wait and until (what it waits on outside you and the owner), snooze_until (hidden until then; \"\" wakes it); comment {item, text}; done {item, note?} and cancel {item, note?} close it (a line goes into memory/journal/YYYY-MM.md in the bot's folder); link {item, url | file | session | pr}; list {status?} (open ones by default); show {item}. item is its number or id. The owner's changes reach you as notes, once each. See skill://ompdesk/references/bots.md.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"add",
						"set",
						"withdraw",
						"self_decide",
						"comment",
						"done",
						"cancel",
						"link",
						"list",
						"show",
						"claim",
					],
				},
				item: { type: "string", description: "Its number (3 or #3) or id." },
				generation: { type: "integer", minimum: 1, description: "claim: the generation assigned by the board." },
				question: {
					type: "integer",
					minimum: 0,
					description: "withdraw, self_decide: the question id shown on the item.",
				},
				title: { type: "string", maxLength: ITEM_TITLE_MAX, description: "add, set: a short title." },
				description: { type: "string", maxLength: ITEM_DESCRIPTION_MAX, description: "add, set: the details." },
				done_means: {
					type: "string",
					maxLength: ITEM_DESCRIPTION_MAX,
					description: "add, set: what done means for it.",
				},
				status: { type: "string", enum: [...ITEM_STATUSES], description: "add, set, list: its status." },
				ask: {
					type: "string",
					maxLength: ITEM_TEXT_MAX,
					description: "set: a question for the owner; the item becomes needs_you.",
				},
				options: {
					type: "array",
					items: { type: "string" },
					description: "set, with ask: quick answers the owner can pick.",
				},
				recommended: {
					type: "integer",
					minimum: 0,
					description: "set, with ask: the option you recommend (0-based).",
				},
				wait: {
					type: "string",
					maxLength: ITEM_TEXT_MAX,
					description: "set: what it waits on; the item becomes waiting.",
				},
				until: { type: "string", description: "set, with wait: until when (ISO 8601), if known." },
				snooze_until: { type: "string", description: 'set: hide it until then (ISO 8601); "" wakes it.' },
				text: { type: "string", maxLength: ITEM_TEXT_MAX, description: "comment: what to add." },
				note: {
					type: "string",
					maxLength: ITEM_TEXT_MAX,
					description: "withdraw, self_decide: required reason or decision; done, cancel: how it ended.",
				},
				url: { type: "string", description: "link: a web address." },
				file: { type: "string", description: "link: an absolute path." },
				session: { type: "string", description: "link: a session (id or tab id)." },
				pr: { type: "string", description: "link: a pull request URL or owner/repo#n." },
				asks: {
					type: "array",
					maxItems: ITEM_ASKS_MAX,
					description: "set: several questions for the owner at once; the item becomes needs_you.",
					items: {
						type: "object",
						properties: {
							question: { type: "string", maxLength: ITEM_ASK_MAX },
							options: { type: "array", maxItems: 8, items: { type: "string" } },
							recommended: { type: "integer", minimum: 0, description: "The option you recommend (0-based)." },
							multi: { type: "boolean", description: "The owner may pick several options." },
						},
						required: ["question"],
						additionalProperties: false,
					},
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: T.room,
		label: "Bot room",
		description:
			"Talk with the other bots of a group and its owner in the group's room (a bot's chat only).\n" +
			"A group is bots the owner put together; its room is where the owner posts and members answer. When the owner's post or another member's @mention asks you, a message says so: answer with post {room, text}, or post nothing when you have nothing to add. @Name in your post asks that member to answer too. list shows your groups; read {room, limit?} shows the newest posts (20 by default). room is its id or name. See skill://ompdesk/references/bots.md.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["list", "read", "post"] },
				room: { type: "string", description: "read, post: the room's id or its group's name." },
				text: { type: "string", maxLength: ROOM_POST_MAX, description: "post: what you say in the room." },
				limit: { type: "integer", minimum: 1, maximum: 200, description: "read: how many of the newest posts." },
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
];

const attachmentsArg = z.array(
	z
		.object({ path: z.string().trim().min(1).max(4096).optional(), image: z.number().int().min(1).optional() })
		.strict()
		.refine(item => (item.path === undefined) !== (item.image === undefined), {
			message: "an attachment is {path} or {image}, exactly one",
		}),
);

const sessionArg = z.string().trim().min(1).max(200);
const deviceArg = z.string().trim().min(1).max(200);
const placement = z.enum(PLACEMENT);

const positive = z.number().positive().finite();
const isoTime = z
	.string()
	.trim()
	.regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/, "an ISO 8601 time");

const autopilotBranch = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("new"), name: z.string().trim().min(1).max(200).optional() }).strict(),
	z.object({ kind: z.literal("existing"), name: z.string().trim().min(1).max(200) }).strict(),
]);

const autopilotAdvanced = z
	.object({
		focus: z.array(z.enum(AUTOPILOT_AREAS)).max(AUTOPILOT_AREAS.length).optional(),
		cadence: z.number().int().min(1).max(100).optional(),
		remote: z
			.string()
			.regex(/^[^\s-][^\s]{0,99}$/, "remote is a git remote name")
			.optional(),
		limits: z
			.object({
				tokens: positive.optional(),
				minutes: positive.optional(),
				cycles: positive.optional(),
				usd: positive.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const autopilotArgs = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("start"),
			folder: z.string().trim().min(1).max(4096).optional(),
			device: deviceArg.optional(),
			guide: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).optional(),
			ship: z.enum(["commit", "push", "release"]).optional(),
			branch: autopilotBranch.optional(),
			advanced: autopilotAdvanced.optional(),
		})
		.strict(),
	z.object({ action: z.literal("status"), session: sessionArg }).strict(),
	z.object({ action: z.literal("stop"), session: sessionArg, now: z.boolean().optional() }).strict(),
]);

const worktreeArg = z.union([
	z.boolean(),
	z
		.object({
			branch: z.string().trim().min(1).max(200).optional(),
			base: z.string().trim().min(1).max(200).optional(),
		})
		.strict(),
]);

const openFields = {
	message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).optional(),
	folder: z.string().trim().min(1).max(4096).optional(),
	device: deviceArg.optional(),
	reopen: sessionArg.optional(),
	restore: z.boolean().optional(),
	model: z.string().trim().min(1).max(200).optional(),
	mode: z
		.literal("goal", {
			error: 'Plan mode was removed from OMPdesk: open the session with mode "goal" (the message becomes its goal) or with no mode (a plain first message).',
		})
		.optional(),
	worktree: worktreeArg.optional(),
	throwaway: z.boolean().optional(),
	item: z.string().trim().min(1).max(100).optional(),
};

const goalNeedsMessage = [
	(args: { mode?: string; message?: string }) => args.mode !== "goal" || args.message !== undefined,
	{ message: "mode goal needs a message: it becomes the goal" },
] as const;
/** The session's own folder is checked where the session is known (`AgentControl.#openOne`). */
const reopenAlone = [
	(args: { reopen?: string; restore?: boolean; worktree?: unknown; mode?: string; throwaway?: boolean }) =>
		args.reopen === undefined
			? args.restore === undefined
			: args.worktree === undefined && args.mode === undefined && args.throwaway === undefined,
	{
		message:
			"reopen opens a stored session as it was, in the folder it worked in: give no worktree, mode or throwaway with it; restore goes only with reopen",
	},
] as const;

const openOne = z
	.object(openFields)
	.strict()
	.refine(...goalNeedsMessage)
	.refine(...reopenAlone);

export type OpenOne = z.infer<typeof openOne>;

export const ARGS = {
	[T.list]: z
		.object({
			scope: z.enum(["window", "app", "stored"]).optional(),
			device: deviceArg.optional(),
			folder: z.string().trim().min(1).max(4096).optional(),
			status: z.enum(["running", "waiting", "idle"]).optional(),
			mine: z.boolean().optional(),
			query: z.string().trim().min(1).max(500).optional(),
			limit: z.number().int().min(1).max(100).optional(),
		})
		.strict(),
	[T.open]: z
		.object({
			...openFields,
			sessions: z.array(openOne).min(1).optional(),
			show: z.enum(["background", ...PLACEMENT]).optional(),
		})
		.strict()
		.refine(
			args =>
				args.sessions === undefined ||
				Object.keys(openFields).every(key => args[key as keyof typeof openFields] === undefined),
			{ message: "give either the single-session fields or sessions, not both" },
		)
		.refine(...goalNeedsMessage)
		.refine(...reopenAlone),
	[T.send]: z
		.object({
			session: sessionArg.optional(),
			sessions: z.array(sessionArg).min(1).optional(),
			item: sessionArg.optional(),
			message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
			request_id: z.string().trim().min(1).max(200).optional(),
			attachments: attachmentsArg.optional(),
		})
		.strict()
		.refine(args => [args.session, args.sessions, args.item].filter(value => value !== undefined).length === 1, {
			message: "give exactly one of session, sessions or item",
		})
		.refine(args => args.item === undefined || (args.request_id !== undefined && args.attachments === undefined), {
			message: "item mail needs request_id and carries text only",
		}),
	[T.report]: z
		.object({
			kind: z.enum(MAIL_KINDS),
			text: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
			files: z.array(z.string().trim().min(1).max(1000)).optional(),
			checks: z
				.array(z.object({ command: z.string().trim().min(1).max(1000), passed: z.boolean() }).strict())
				.optional(),
			to: sessionArg.optional(),
			dispatch: z.string().trim().min(1).max(100).optional(),
			id: z.string().trim().min(1).max(200).optional(),
			attachments: attachmentsArg.optional(),
		})
		.strict(),
	[T.result]: z
		.object({
			session: sessionArg.optional(),
			sessions: z.array(sessionArg).min(1).optional(),
			wait: z.boolean().optional(),
			until: z.enum(["all", "any"]).optional(),
			timeout_seconds: z.number().int().min(1).max(RESULT_WAIT_MAX_SECONDS).optional(),
		})
		.strict()
		.refine(args => (args.session === undefined) !== (args.sessions === undefined), {
			message: "give session or sessions (one of them)",
		}),
	[T.read]: z
		.object({
			session: sessionArg,
			limit: z.number().int().min(1).max(READ_MAX_MESSAGES).optional(),
			before: z.string().min(1).max(500).optional(),
		})
		.strict(),
	[T.answer]: z
		.object({
			session: sessionArg,
			request: z.string().min(1).max(200).optional(),
			choice: z.string().min(1).max(500).optional(),
			approve: z.boolean().optional(),
			text: z.string().max(20_000).optional(),
			answers: z
				.array(
					z
						.object({
							id: z.string().min(1).max(200).optional(),
							selected: z.array(z.string().max(500)).optional(),
							text: z.string().max(20_000).optional(),
						})
						.strict(),
				)
				.optional(),
			attachments: attachmentsArg.optional(),
			escalate: z.boolean().optional(),
		})
		.strict(),
	[T.focus]: z.object({ session: sessionArg, how: placement.optional() }).strict(),
	[T.notify]: z
		.object({
			title: z.string().trim().min(1).max(200),
			body: z.string().max(2000).optional(),
		})
		.strict(),
	[T.stop]: z
		.object({
			session: sessionArg,
			close: z.boolean().optional(),
			delete: z.boolean().optional(),
			device: deviceArg.optional(),
		})
		.strict(),
	[T.compare]: z
		.object({
			sessions: z.array(sessionArg).min(1).optional(),
			criteria: z.array(z.string().trim().min(1).max(1000)).min(1).optional(),
		})
		.strict(),
	[T.merge]: z.object({ session: sessionArg }).strict(),
	// Zod checks fields (including Date.parse); the core checks their combination for the action.
	[T.schedule]: z
		.object({
			action: z.enum(["create", "list", "cancel", "update", "pause", "resume", "run", "runs"]),
			name: z.string().trim().min(1).max(60).optional(),
			prompt: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).optional(),
			folder: z.string().trim().min(1).max(4096).optional(),
			every_minutes: z
				.number()
				.int()
				.min(1)
				.max(7 * 24 * 60)
				.optional(),
			daily_at: z
				.string()
				.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "daily_at is HH:MM (24 hours)")
				.optional(),
			days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
			at: z
				.string()
				.trim()
				.refine(value => Number.isFinite(Date.parse(value)), "at is an ISO 8601 moment")
				.optional(),
			in_minutes: z
				.number()
				.int()
				.min(1)
				.max(7 * 24 * 60)
				.optional(),
			on: z
				.discriminatedUnion("source", [
					z
						.object({
							source: z.literal("webhook"),
							where: z
								.array(
									z
										.object({
											path: z.string().trim().min(1).max(WEBHOOK_FILTER_LIMITS.path),
											op: z.enum(WEBHOOK_WHERE_OPS),
											values: z
												.array(z.string().max(WEBHOOK_FILTER_LIMITS.value))
												.max(WEBHOOK_FILTER_LIMITS.values)
												.optional(),
										})
										.strict(),
								)
								.max(WEBHOOK_FILTER_LIMITS.where)
								.optional(),
							contains: z.string().trim().min(1).max(200).optional(),
							pick: z
								.array(z.string().trim().min(1).max(WEBHOOK_FILTER_LIMITS.path))
								.max(WEBHOOK_FILTER_LIMITS.pick)
								.optional(),
						})
						.strict(),
					z
						.object({
							source: z.literal("github"),
							repo: z.string().trim().regex(GITHUB_REPO, "repo is owner/name"),
							events: z.array(z.enum(GITHUB_EVENT_KINDS)).min(1).max(GITHUB_EVENT_KINDS.length),
							from: z.array(z.string().trim().min(1).max(39)).min(1).max(20).optional(),
							contains: z.string().trim().min(1).max(200).optional(),
							label: z.string().trim().min(1).max(200).optional(),
						})
						.strict(),
					z.object({ source: z.literal("files"), path: z.string().trim().min(1).max(4096) }).strict(),
					z
						.object({
							source: z.literal("git"),
							repo: z.string().trim().min(1).max(4096).optional(),
							branch: z.string().trim().min(1).max(250),
						})
						.strict(),
					z
						.object({
							source: z.literal("session"),
							events: z.array(z.enum(SESSION_EVENT_KINDS)).min(1).max(SESSION_EVENT_KINDS.length),
							folder: z.string().trim().min(1).max(4096).optional(),
						})
						.strict(),
					z
						.object({
							source: z.literal("email"),
							account: z.string().trim().min(1).max(200),
							from: z.string().trim().min(1).max(200).optional(),
							subject: z.string().trim().min(1).max(200).optional(),
							to: z.string().trim().min(1).max(200).optional(),
						})
						.strict(),
					z
						.object({
							source: z.literal("calendar"),
							url: z
								.string()
								.trim()
								.regex(/^https:\/\/\S+$/, "url is an https:// address of an ICS feed")
								.max(2000),
							lead_minutes: z.number().int().min(1).max(1440).optional(),
						})
						.strict(),
				])
				.optional(),
			by: z
				.string()
				.trim()
				.refine(value => Number.isFinite(Date.parse(value)), "by is an ISO 8601 moment")
				.optional(),
			within_minutes: z
				.number()
				.int()
				.min(1)
				.max(365 * 24 * 60)
				.optional(),
			precheck: z.string().trim().max(2000).optional(),
			results_to: z.enum(["self", "notify"]).optional(),
			model: z.string().trim().min(1).max(200).optional(),
			cron: z.string().trim().min(9).max(200).optional(),
			thinking: z.union([z.enum(SCHEDULE_THINKING_LEVELS), z.literal("")]).optional(),
			worktree: z.boolean().optional(),
			id: z.string().trim().min(1).max(200).optional(),
			device: deviceArg.optional(),
			target: z
				.string()
				.trim()
				.regex(/^(self|bot:\S.{0,199})$/, 'target is "self" or "bot:<name>"')
				.optional(),
		})
		.strict(),
	[T.autopilot]: autopilotArgs,
	[T.appList]: z
		.object({ area: z.string().trim().max(60).optional(), query: z.string().trim().max(200).optional() })
		.strict(),
	[T.app]: z
		.object({ action: z.string().trim().min(1).max(100), args: z.record(z.string(), z.unknown()).optional() })
		.strict(),
	[T.bot]: z
		.object({
			action: z.enum([
				"create",
				"offer",
				"list",
				"pause",
				"resume",
				"set",
				"rename",
				"look_around",
				"suggestions",
				"suggest",
				"hand",
				"connectors",
				"reply",
				"offer_connector",
			]),
			name: z.string().trim().min(1).max(BOT_NAME_MAX).optional(),
			folder: z.string().trim().min(1).max(4096).optional(),
			bot: z.string().trim().min(1).max(200).optional(),
			model: z.string().trim().max(200).optional(),
			auto_approve: z.boolean().optional(),
			stale_days: z.number().int().min(0).max(365).optional(),
			reach: z.array(deviceArg).max(50).optional(),
			on: z.boolean().optional(),
			every: z.enum(LOOK_EVERY).optional(),
			weekdays_only: z.boolean().optional(),
			focus: z.string().trim().max(LOOK_FOCUS_MAX).optional(),
			suggestions: z
				.array(
					z
						.object({
							title: z.string().trim().min(1).max(80),
							why: z.string().trim().max(400),
							ask: z.string().trim().min(1).max(2000),
							link: z.string().trim().max(2000).optional(),
						})
						.strict(),
				)
				.max(5)
				.optional(),
			session: sessionArg.optional(),
			text: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).optional(),
			to: z.string().trim().min(1).max(300).optional(),
			service: z.enum(["slack", "github", "linear", "google"]).optional(),
		})
		.strict(),
	[T.item]: z
		.object({
			action: z.enum([
				"add",
				"set",
				"withdraw",
				"self_decide",
				"comment",
				"done",
				"cancel",
				"link",
				"list",
				"show",
				"claim",
			]),
			generation: z.number().int().positive().optional(),
			question: z.number().int().nonnegative().optional(),
			item: z.string().trim().min(1).max(100).optional(),
			title: z.string().trim().min(1).max(ITEM_TITLE_MAX).optional(),
			description: z.string().max(ITEM_DESCRIPTION_MAX).optional(),
			done_means: z.string().max(ITEM_DESCRIPTION_MAX).optional(),
			status: z.enum(ITEM_STATUSES).optional(),
			ask: z.string().trim().min(1).max(ITEM_TEXT_MAX).optional(),
			options: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
			recommended: z.number().int().min(0).max(9).optional(),
			wait: z.string().trim().min(1).max(ITEM_TEXT_MAX).optional(),
			until: isoTime.optional(),
			snooze_until: z.union([z.literal(""), isoTime]).optional(),
			text: z.string().trim().min(1).max(ITEM_TEXT_MAX).optional(),
			note: z.string().max(ITEM_TEXT_MAX).optional(),
			url: z.string().trim().min(1).max(4096).optional(),
			file: z.string().trim().min(1).max(4096).optional(),
			session: sessionArg.optional(),
			pr: z.string().trim().min(1).max(4096).optional(),
			asks: z
				.array(
					z
						.object({
							question: z.string().trim().min(1).max(ITEM_ASK_MAX),
							options: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
							recommended: z.number().int().min(0).max(7).optional(),
							multi: z.boolean().optional(),
						})
						.strict(),
				)
				.min(1)
				.max(ITEM_ASKS_MAX)
				.optional(),
		})
		.strict(),
	[T.room]: z
		.object({
			action: z.enum(["list", "read", "post"]),
			room: z.string().trim().min(1).max(200).optional(),
			text: z.string().trim().min(1).max(ROOM_POST_MAX).optional(),
			limit: z.number().int().min(1).max(200).optional(),
		})
		.strict(),
} as const;

/** The slice of a tool's JSON schema `looseArgs` reads. */
interface LooseSchema {
	type?: string;
	anyOf?: readonly LooseSchema[];
	properties?: Record<string, LooseSchema>;
	items?: LooseSchema;
}

/** The part of `schema` that takes a value of `type` (the schema itself, or one of its `anyOf`). */
function branchOf(schema: LooseSchema, type: string): LooseSchema | undefined {
	return schema.type === type ? schema : schema.anyOf?.find(option => option.type === type);
}

function loosen(schema: LooseSchema | undefined, value: unknown): unknown {
	if (!schema) return value;
	if (typeof value === "string") {
		const takes = (type: string) => branchOf(schema, type) !== undefined;
		// A field that takes text, or says nothing of its type, keeps the text.
		if (takes("string") || (schema.type === undefined && schema.anyOf === undefined)) return value;
		const text = value.trim();
		if (takes("boolean") && (text === "true" || text === "false")) return text === "true";
		if ((takes("integer") || takes("number")) && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
		if ((takes("object") && text.startsWith("{")) || (takes("array") && text.startsWith("["))) {
			try {
				return loosen(schema, JSON.parse(text));
			} catch {
				return value;
			}
		}
		return value;
	}
	if (Array.isArray(value)) {
		const items = branchOf(schema, "array")?.items;
		return items ? value.map(item => loosen(items, item)) : value;
	}
	if (typeof value === "object" && value !== null) {
		const properties = branchOf(schema, "object")?.properties;
		if (!properties) return value;
		return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, loosen(properties[key], field)]));
	}
	return value;
}

/**
 * The arguments as the tool's schema types them, where a model wrote a boolean, a number, an object or an array as its
 * JSON text (`"true"`, `"{\"base\":\"main\"}"`; measured 10 Nov 2026: 4 of one session's 15 failed opens in a week): a field
 * whose schema takes no string reads that text as the value it spells. Everything else passes as it came, so the strict
 * parser (`ARGS`) still refuses what the schema does not take. One rule for every control tool and every nesting.
 * Keep Number/JSON.parse before Zod: overflowing numbers and escaped lone surrogates aren't Rust JSON values.
 */
export function looseArgs(tool: AgentControlToolName, raw: unknown): unknown {
	const definition = AGENT_CONTROL_DEFINITIONS.find(entry => entry.name === tool);
	return definition ? loosen(definition.parameters as LooseSchema, raw) : raw;
}

export type ListArgs = z.infer<(typeof ARGS)[typeof T.list]>;

export type AnswerArgs = z.infer<(typeof ARGS)[typeof T.answer]>;

export type ScheduleArgs = z.infer<(typeof ARGS)[typeof T.schedule]>;

export type AutopilotArgs = z.infer<typeof autopilotArgs>;
