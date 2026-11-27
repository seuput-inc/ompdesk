/**
 * What a schedule's trigger says, in the UI language: one summary for every place that lists schedules, so the same
 * trigger reads the same everywhere. English text for agents and logs is `describeFrequency` in `shared/schedules.ts`.
 */
import { MOBILE_WEB_PORT } from "../../shared/mobile-web";
import {
	type GithubEventKind,
	type ScheduleEvent,
	type ScheduleFrequency,
	type ScheduleRunStatus,
	type ScheduleRunUsage,
	type SessionEventKind,
	WEBHOOK_SENDER_NAMES,
	type WebhookCall,
} from "../../shared/schedules";
import type { BadgeVariant } from "../components/common";
import { basename, formatClock, formatTokens, formatUsd, uiLocale } from "./format";
import { translate } from "./i18n";

/** "12.3k tokens · $0.01": what a fresh run's model replies used. */
export function runUsageText(usage: ScheduleRunUsage): string {
	return translate("schedules.usage", {
		tokens: formatTokens(usage.input + usage.output + usage.cacheRead + usage.cacheWrite, { trimZero: true }),
		cost: formatUsd(usage.cost),
	});
}

/** The badge a run's status wears, on every list of runs. */
export const RUN_STATUS_BADGE: Record<ScheduleRunStatus, BadgeVariant> = {
	running: "info",
	succeeded: "success",
	failed: "error",
	stopped: "muted",
	skipped: "warning",
};

/** Short weekday names in the UI language, Sunday first (2026-10-18 is a Sunday). */
export function weekdayNames(): string[] {
	const format = new Intl.DateTimeFormat(uiLocale(), { weekday: "short" });
	return Array.from({ length: 7 }, (_, day) => format.format(new Date(2026, 9, 18 + day)));
}

const GITHUB_KIND_KEY: Record<GithubEventKind, string> = {
	pull_request: "schedules.github.pull_request",
	pr_merged: "schedules.github.pr_merged",
	pr_closed: "schedules.github.pr_closed",
	issue: "schedules.github.issue",
	issue_closed: "schedules.github.issue_closed",
	comment: "schedules.github.comment",
	labeled: "schedules.github.labeled",
	ci_failure: "schedules.github.ci_failure",
	ci_passed: "schedules.github.ci_passed",
	workflow_finished: "schedules.github.workflow_finished",
	release: "schedules.github.release",
	push: "schedules.github.push",
};

const SESSION_KIND_KEY: Record<SessionEventKind, string> = {
	done: "schedules.session.done",
	failed: "schedules.session.failed",
	waiting: "schedules.session.waiting",
};

function list(items: string[], type: "conjunction" | "disjunction"): string {
	return new Intl.ListFormat(uiLocale(), { style: "long", type }).format(items);
}

/**
 * "Every 2 h" / "Every day at 09:30" / "Mon, Wed at 09:30" / "Once at 09:30" / "On a webhook call" / "GitHub pull
 * requests in owner/name" / "When files change under src" / "New commits on main" / "When a session finishes a turn".
 */
export function frequencySummary(frequency: ScheduleFrequency): string {
	switch (frequency.kind) {
		case "interval":
			return frequency.minutes % 60 === 0
				? translate("schedules.every.hours", { count: frequency.minutes / 60 })
				: translate("schedules.every.minutes", { count: frequency.minutes });
		case "daily": {
			if (frequency.days.length === 0 || frequency.days.length === 7) {
				return translate("schedules.daily", { time: frequency.time });
			}
			const names = weekdayNames();
			return translate("schedules.weekly", {
				days: frequency.days.map(day => names[day]).join(", "),
				time: frequency.time,
			});
		}
		case "once":
			return translate("schedules.once", { time: formatClock(frequency.at) });
		case "cron":
			return translate("schedules.cron", { expr: frequency.expr });
		case "event": {
			const by = frequency.by ? translate("schedules.event.by", { time: formatClock(frequency.by) }) : "";
			return `${eventSummary(frequency.event)}${by}`;
		}
	}
}

function eventSummary(event: ScheduleEvent): string {
	switch (event.source) {
		case "webhook":
			return event.signedBy
				? translate("schedules.event.webhookSigned", { sender: WEBHOOK_SENDER_NAMES[event.signedBy] })
				: translate("schedules.event.webhook");
		case "github":
			return [
				translate("schedules.event.github", {
					events: list(
						event.events.map(kind => translate(GITHUB_KIND_KEY[kind])),
						"conjunction",
					),
					repo: event.repo,
				}),
				event.from?.length ? translate("schedules.event.githubFrom", { from: event.from.join(", ") }) : "",
				event.label ? translate("schedules.event.githubLabel", { label: event.label }) : "",
				event.contains ? translate("schedules.event.githubContains", { text: event.contains }) : "",
			].join("");
		case "files":
			return translate("schedules.event.files", { path: basename(event.path) || event.path });
		case "git":
			return translate("schedules.event.git", { branch: event.branch });
		case "session": {
			const what = list(
				event.events.map(kind => translate(SESSION_KIND_KEY[kind])),
				"disjunction",
			);
			return event.folder
				? translate("schedules.event.sessionIn", { what, folder: basename(event.folder) || event.folder })
				: translate("schedules.event.session", { what });
		}
		case "email":
			return [
				translate("schedules.event.email", { account: event.account }),
				event.from ? translate("schedules.event.emailFrom", { from: event.from }) : "",
				event.to ? translate("schedules.event.emailTo", { to: event.to }) : "",
				event.subject ? translate("schedules.event.emailSubject", { subject: event.subject }) : "",
			].join("");
		case "calendar":
			return translate("schedules.event.calendar", { minutes: event.leadMinutes });
		case "slack":
			return translate("schedules.event.slack");
		case "linear":
			return translate("schedules.event.linear", { handle: event.handle });
		case "google":
			return translate("schedules.event.google", { minutes: event.leadMinutes });
	}
}

/** Where a webhook routine is called on the computer it runs on (loopback; a tailnet caller adds Mobile web's prefix). */
export function webhookUrl(id: string): string {
	return `http://127.0.0.1:${MOBILE_WEB_PORT}/hooks/${id}`;
}

/** A webhook routine's call as a shell line, for a first try. */
export function webhookCurl(id: string, key: string): string {
	return `curl -X POST ${webhookUrl(id)} -H 'Authorization: Bearer ${key}' -H 'Content-Type: application/json' -d '{}'`;
}

/** One Recent calls line: what became of the call, then why (Orca's webhook-call-copy). */
export function webhookCallLine(call: WebhookCall): { label: string; detail: string } {
	const count = call.count ?? 1;
	switch (call.verdict) {
		case "started":
			return { label: translate("schedules.call.started"), detail: "" };
		case "queued":
			return { label: translate("schedules.call.queued"), detail: translate("schedules.call.queuedDetail") };
		case "ignored":
			return { label: translate("schedules.call.ignored"), detail: translate("schedules.call.ignoredDetail") };
		case "duplicate":
			return {
				label:
					count > 1 ? translate("schedules.call.duplicateMany", { count }) : translate("schedules.call.duplicate"),
				detail: translate("schedules.call.duplicateDetail"),
			};
		case "refused":
			return {
				label: count > 1 ? translate("schedules.call.refusedMany", { count }) : translate("schedules.call.refused"),
				detail: call.reason ?? translate("schedules.call.refusedDetail"),
			};
		case "off":
			return { label: translate("schedules.call.off"), detail: translate("schedules.call.offDetail") };
	}
}
