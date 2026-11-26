/**
 * The bot templates (Orca's catalog, `shared/bots/bot-template-catalog/*.ts` and `bot-templates.ts:1-130`, written
 * anew): what each starts with. A template is copied once into the new bot and never updated: its soul (`SOUL.md`:
 * what it watches, does and reports), its skills (`.omp/skills`), its routines (saved off, in Settings › Schedules,
 * once its home chat exists) and the events and connectors its first chat offers to set up. Its words for the person
 * (name, line, first chat, example) are locale keys `bots.template.<id>.*`; what the bot reads stays English.
 *
 * Connectors (GitHub, Slack, Linear, Google) are named only: they come with the bots connectors slice, so the detail
 * says "Not connected" and the first chat sets up what it can locally (`gh`, an MCP server, an email account).
 */
import type { ScheduleFrequency } from "../../../shared/schedules";
import { BOT_TEMPLATE_SKILLS, type BotTemplateSkillId } from "./bot-template-skills";

export const BOT_TEMPLATE_CATEGORIES = ["coding", "releases", "support", "planning", "ops", "personal"] as const;
export type BotTemplateCategory = (typeof BOT_TEMPLATE_CATEGORIES)[number];

export type BotConnector = "github" | "slack" | "linear" | "google";

export interface BotTemplateRoutine {
	/** English: the schedule's name after the bot's ("<bot>: <label>") and what its run is asked. */
	label: string;
	frequency: ScheduleFrequency;
}

export interface BotTemplate {
	id: string;
	category: BotTemplateCategory;
	/** The face it starts with (`bot-mascots.ts`). */
	mascot: number;
	/** English, the bot's own words for itself: its soul's lines. */
	watches: string;
	does: string;
	reports: string;
	skills: BotTemplateSkillId[];
	routines: BotTemplateRoutine[];
	/** English: events its first chat offers to set up (`ompdesk_schedule` routines on an event). */
	events: string[];
	connectors: BotConnector[];
	/** It needs more than a click before it is useful (a connector OMPdesk does not have yet, a deploy hook). */
	needsSetup?: boolean;
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const daily = (time: string, days: number[] = []): ScheduleFrequency => ({ kind: "daily", time, days });

export const BOT_TEMPLATES: readonly BotTemplate[] = [
	{
		id: "pr-review",
		category: "coding",
		mascot: 0,
		watches: "Pull requests the owner is asked to review.",
		does: "Reads each one and lists the risky changes, with file and line.",
		reports: "One short review per pull request, worst risk first.",
		skills: ["pr-review-checklist"],
		routines: [],
		events: ["When the owner is asked to review a pull request: review it and post here."],
		connectors: ["github"],
	},
	{
		id: "bug-investigation",
		category: "coding",
		mascot: 1,
		watches: "Bugs the owner hands over or that get assigned to them.",
		does: "Reproduces the bug and finds where it starts.",
		reports: "Steps to reproduce, the cause with file and line, and a proposed fix.",
		skills: ["bug-reproduction"],
		routines: [],
		events: ["When an issue is assigned to the owner: investigate it."],
		connectors: ["github", "linear"],
	},
	{
		id: "dependency-updates",
		category: "coding",
		mascot: 2,
		watches: "The projects' dependencies.",
		does: "Checks for outdated and vulnerable packages and proposes upgrades.",
		reports: "A weekly list: what to upgrade, why, and how risky.",
		skills: ["dependency-upgrade"],
		routines: [{ label: "Dependency check", frequency: daily("09:00", [1]) }],
		events: [],
		connectors: ["github"],
	},
	{
		id: "unreviewed-work",
		category: "coding",
		mascot: 3,
		watches: "Agent sessions and branches that finished.",
		does: "Finds finished agent work nobody has looked at yet.",
		reports: "A daily list with a link to each.",
		skills: [],
		routines: [{ label: "Unreviewed work", frequency: daily("09:00", WEEKDAYS) }],
		events: [],
		connectors: [],
	},
	{
		id: "workspace-cleanup",
		category: "coding",
		mascot: 4,
		watches: "Worktrees and branches in the owner's projects.",
		does: "Finds finished or abandoned workspaces and offers to remove them.",
		reports: "A weekly list of what can go, never removing anything unasked.",
		skills: ["workspace-hygiene"],
		routines: [{ label: "Workspace cleanup", frequency: daily("16:00", [5]) }],
		events: [],
		connectors: ["github"],
	},
	{
		id: "security-check",
		category: "coding",
		mascot: 5,
		watches: "Changes merged into the main branches.",
		does: "Looks for leaked secrets and risky code.",
		reports: "Each finding with file, line and how bad it is.",
		skills: ["security-checklist"],
		routines: [{ label: "Security check", frequency: daily("09:00", [1]) }],
		events: ["When a pull request merges: check it."],
		connectors: ["github"],
	},
	{
		id: "release",
		category: "releases",
		mascot: 6,
		watches: "The next release: open pull requests, failing checks, open blockers.",
		does: "Tracks what blocks the next release.",
		reports: "A daily readiness note: ready, or what still blocks it.",
		skills: ["release-readiness"],
		routines: [{ label: "Release readiness", frequency: daily("09:00", WEEKDAYS) }],
		events: [],
		connectors: ["github"],
	},
	{
		id: "release-notes",
		category: "releases",
		mascot: 7,
		watches: "Pull requests merged since the last release.",
		does: "Drafts the next release's notes.",
		reports: "Notes in the project's own style, ready to paste.",
		skills: ["release-notes-style"],
		routines: [],
		events: [],
		connectors: ["github"],
	},
	{
		id: "ci-failures",
		category: "releases",
		mascot: 8,
		watches: "Failed CI checks.",
		does: "Explains each failure and keeps a list of flaky tests.",
		reports: "Whether a failure is flaky or real, and a weekly flaky list.",
		skills: ["ci-failure-triage"],
		routines: [{ label: "Flaky test list", frequency: daily("09:00", [1]) }],
		events: ["When a check fails: say whether it is flaky or real."],
		connectors: ["github"],
		needsSetup: true,
	},
	{
		id: "deploy-watch",
		category: "releases",
		mascot: 9,
		watches: "Deploys.",
		does: "Summarizes what changed in each deploy and flags failed ones.",
		reports: "One note per deploy.",
		skills: [],
		routines: [],
		events: ["When the deploy tool calls this computer's webhook: summarize the deploy."],
		connectors: ["github"],
		needsSetup: true,
	},
	{
		id: "support",
		category: "support",
		mascot: 10,
		watches: "Questions from users and teammates.",
		does: "Keeps a list of questions nobody has answered.",
		reports: "Every two hours on weekdays: what still waits for an answer.",
		skills: ["issue-triage"],
		routines: [{ label: "Unanswered questions", frequency: { kind: "interval", minutes: 120 } }],
		events: [],
		connectors: ["slack", "linear"],
	},
	{
		id: "feedback",
		category: "support",
		mascot: 11,
		watches: "Feedback from users.",
		does: "Groups feedback into themes.",
		reports: "A weekly list of themes with examples.",
		skills: ["feedback-themes"],
		routines: [{ label: "Feedback digest", frequency: daily("09:00", [1]) }],
		events: [],
		connectors: ["slack", "linear"],
	},
	{
		id: "bug-intake",
		category: "support",
		mascot: 12,
		watches: "Bug reports.",
		does: "Turns each into a tracked issue with steps to reproduce.",
		reports: "The drafted issue, for the owner to file.",
		skills: ["issue-triage"],
		routines: [],
		events: ["When someone reports a bug: draft an issue."],
		connectors: ["slack", "linear"],
	},
	{
		id: "issue-triage",
		category: "support",
		mascot: 13,
		watches: "New issues on the owner's repositories.",
		does: "Proposes labels, finds duplicates and asks for missing details.",
		reports: "One note per new issue.",
		skills: ["issue-triage"],
		routines: [],
		events: ["When an issue is opened: propose labels and duplicates."],
		connectors: ["github"],
	},
	{
		id: "briefing",
		category: "planning",
		mascot: 14,
		watches: "The projects the owner picks.",
		does: "Reads their week: merged work, open work, risks.",
		reports: "A weekly brief.",
		skills: ["status-brief"],
		routines: [{ label: "Project briefing", frequency: daily("15:00", [5]) }],
		events: [],
		connectors: ["github", "linear"],
	},
	{
		id: "docs-upkeep",
		category: "planning",
		mascot: 15,
		watches: "Docs and the code they describe.",
		does: "Flags docs that no longer match merged code.",
		reports: "A weekly list with the doc, the line and what changed.",
		skills: [],
		routines: [{ label: "Docs upkeep", frequency: daily("10:00", [3]) }],
		events: [],
		connectors: ["github"],
	},
	{
		id: "spec-drafts",
		category: "planning",
		mascot: 0,
		watches: "Discussions the owner hands over.",
		does: "Turns a discussion into a short spec.",
		reports: "A spec the owner can share.",
		skills: ["spec-format"],
		routines: [],
		events: [],
		connectors: ["slack", "google"],
	},
	{
		id: "backlog-cleanup",
		category: "planning",
		mascot: 1,
		watches: "The backlog.",
		does: "Finds stale, duplicate and unowned issues.",
		reports: "A monthly cleanup list.",
		skills: ["issue-triage"],
		routines: [],
		events: [],
		connectors: ["linear"],
	},
	{
		id: "incident-notes",
		category: "ops",
		mascot: 2,
		watches: "Incidents.",
		does: "Keeps a timeline and drafts the write-up.",
		reports: "The timeline as it grows, then the write-up.",
		skills: ["incident-timeline"],
		routines: [],
		events: ["When someone posts in an incident channel: add it to the timeline."],
		connectors: ["slack"],
	},
	{
		id: "oncall-handoff",
		category: "ops",
		mascot: 3,
		watches: "Alerts, incidents and open follow-ups of the week.",
		does: "Summarizes the on-call week.",
		reports: "A weekly handoff note.",
		skills: ["incident-timeline"],
		routines: [{ label: "On-call handoff", frequency: daily("16:00", [5]) }],
		events: [],
		connectors: ["slack", "linear"],
		needsSetup: true,
	},
	{
		id: "followup",
		category: "personal",
		mascot: 4,
		watches: "Conversations the owner takes part in.",
		does: "Notices replies the owner still owes.",
		reports: "A daily reminder.",
		skills: [],
		routines: [{ label: "Replies you owe", frequency: daily("16:00") }],
		events: [],
		connectors: ["slack", "linear"],
	},
	{
		id: "standup",
		category: "personal",
		mascot: 5,
		watches: "What the owner and their agents did.",
		does: "Writes standup notes: yesterday, today, blockers.",
		reports: "Notes every weekday morning.",
		skills: ["status-brief"],
		routines: [{ label: "Standup notes", frequency: daily("09:00", WEEKDAYS) }],
		events: [],
		connectors: ["github", "linear"],
	},
	{
		id: "email-digest",
		category: "personal",
		mascot: 6,
		watches: "The owner's email.",
		does: "Picks the emails that need a reply from the owner.",
		reports: "Twice a day, the list.",
		skills: [],
		routines: [
			{ label: "Email digest", frequency: daily("09:00", WEEKDAYS) },
			{ label: "Afternoon email digest", frequency: daily("14:00", WEEKDAYS) },
		],
		events: [],
		connectors: ["google"],
	},
	{
		id: "meeting-prep",
		category: "personal",
		mascot: 7,
		watches: "The owner's calendar.",
		does: "Before each meeting, gathers the issues, pull requests and docs it is about.",
		reports: "A prep note 15 minutes before.",
		skills: [],
		routines: [],
		events: ["15 minutes before a meeting (a calendar routine): a prep note."],
		connectors: ["google", "github", "linear"],
	},
];

/** The template's `SOUL.md`: who the bot is, in its own words, for its first turn to make its own. */
export function templateSoul(template: BotTemplate, name: string, line: string): string {
	return [
		`# ${name}`,
		"",
		line,
		"",
		"## What I watch",
		template.watches,
		"",
		"## What I do",
		template.does,
		"",
		"## What I report",
		template.reports,
	].join("\n");
}

/** Its skills as the create request seeds them. */
export function templateSkills(template: BotTemplate): { name: string; content: string }[] {
	return template.skills.map(id => ({ name: id, content: BOT_TEMPLATE_SKILLS[id] }));
}

/** The first message its home chat gets (Orca's template kickoff, `bot-templates.ts:127-130`). */
export function templateKickoff(template: BotTemplate): string {
	const steps = ["Read SOUL.md and your skills, and introduce yourself in two sentences."];
	if (template.routines.length > 0)
		steps.push(
			"Your routines are saved turned off in Settings › Schedules. Say what each does, and ask whether to turn them on.",
		);
	if (template.events.length > 0)
		steps.push(`Offer to set up these events with ompdesk_schedule, one question each: ${template.events.join(" ")}`);
	if (template.connectors.length > 0)
		steps.push(
			`You will want ${template.connectors.join(", ")}. Check what this computer already reaches (gh, MCP servers, email accounts) and say what is missing, without asking for secrets in chat.`,
		);
	return [
		"You were made from a template; your SOUL.md says who you are. Set yourself up now:",
		...steps.map((step, index) => `${index + 1}. ${step}`),
		"Keep it short, then wait for the owner.",
	].join("\n");
}

/** Whether every word of `query` is in the template's words (its name and line as shown, its category, connectors, skills). */
export function templateMatches(template: BotTemplate, shown: string, query: string): boolean {
	const haystack = [shown, template.category, ...template.connectors, ...template.skills]
		.join(" ")
		.toLocaleLowerCase();
	return query
		.toLocaleLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every(word => haystack.includes(word));
}
