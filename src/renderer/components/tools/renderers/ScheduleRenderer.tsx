/**
 * `ompdesk_schedule` in the transcript (direct or as `write xd://ompdesk_schedule`): a create or update reads as one
 * line, "Schedule saved: <name> · <when>" with when told from its arguments; a run "Run started"; a cancel "Schedule
 * cancelled". A create or update that makes a webhook routine adds a card with the hook's URL path (from the answer's
 * webhook line) and Copy URL. The key the answer carries is never shown or copied here: Settings › Schedules has it.
 * Any other action, and every failure, keeps the generic view.
 */
import { CalendarClock, Webhook } from "lucide-react";
import {
	GITHUB_EVENT_KINDS,
	type ScheduleEvent,
	type ScheduleFrequency,
	SESSION_EVENT_KINDS,
} from "../../../../shared/schedules";
import { useT } from "../../../lib/i18n";
import { frequencySummary, webhookUrl } from "../../../lib/schedule-text";
import { asArray, asRecord } from "../../../lib/wire-value";
import { CopyButton } from "../../common";
import type { ToolRendererProps } from "../ToolCard";
import { GenericRenderer } from "./GenericRenderer";
import { resultBodyText } from "./result";

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/** The known kinds an agent's `events` names; anything else is left out. */
function kindsOf<K extends string>(value: unknown, allowed: readonly K[]): K[] {
	return asArray(value).filter((kind): kind is K => allowed.includes(kind as K));
}

/** The trigger an agent's `on` names, as the shared event shape (enough of it to say in words). */
function eventOf(on: Record<string, unknown>): ScheduleEvent | null {
	switch (on.source) {
		case "webhook":
			return { source: "webhook", key: "" };
		case "github": {
			const from = typeof on.from === "string" ? on.from.split(",").map(login => login.trim()) : undefined;
			return {
				source: "github",
				repo: text(on.repo) ?? "",
				events: kindsOf(on.events, GITHUB_EVENT_KINDS),
				...(from?.length ? { from } : {}),
				...(text(on.label) ? { label: on.label as string } : {}),
				...(text(on.contains) ? { contains: on.contains as string } : {}),
			};
		}
		case "files":
			return { source: "files", path: text(on.path) ?? "" };
		case "git":
			return { source: "git", repo: text(on.repo) ?? "", branch: text(on.branch) ?? "" };
		case "session":
			return { source: "session", events: kindsOf(on.events, SESSION_EVENT_KINDS), folder: text(on.folder) };
		case "email":
			return {
				source: "email",
				account: text(on.account) ?? "",
				from: text(on.from),
				subject: text(on.subject),
				to: text(on.to),
			};
		case "calendar":
			return {
				source: "calendar",
				url: text(on.url) ?? "",
				leadMinutes: typeof on.lead_minutes === "number" ? on.lead_minutes : 10,
			};
		default:
			return null;
	}
}

/** When the call says the schedule starts, in the UI language; "" when its arguments name no start. */
function whenOf(args: Record<string, unknown>, inMinutes: (count: number) => string): string {
	const on = asRecord(args.on);
	const event = on ? eventOf(on) : null;
	const frequency: ScheduleFrequency | null = event
		? { kind: "event", event, ...(text(args.by) ? { by: args.by as string } : {}) }
		: typeof args.every_minutes === "number"
			? { kind: "interval", minutes: args.every_minutes }
			: text(args.daily_at)
				? {
						kind: "daily",
						time: args.daily_at as string,
						days: asArray(args.days).filter((day): day is number => typeof day === "number"),
					}
				: text(args.cron)
					? { kind: "cron", expr: args.cron as string }
					: text(args.at)
						? { kind: "once", at: args.at as string }
						: null;
	if (frequency) return frequencySummary(frequency);
	return typeof args.in_minutes === "number" ? inMinutes(args.in_minutes) : "";
}

export function ScheduleRenderer(props: ToolRendererProps) {
	const { args, result, isError, isPartial, partialResult } = props;
	const t = useT();
	const action = args.action;
	if (isError || (action !== "create" && action !== "update" && action !== "run" && action !== "cancel"))
		return <GenericRenderer {...props} />;
	if (action === "run" || action === "cancel") {
		return (
			<div className="flex items-center gap-1.5 text-omp-sm text-[var(--omp-text)]" data-tool-schedule={action}>
				<CalendarClock className="shrink-0 text-[var(--omp-muted)]" size={12} />
				{action === "run" ? t("tools.schedule.run") : t("tools.schedule.cancel")}
			</div>
		);
	}
	const when = whenOf(args, count => t("tools.schedule.inMinutes", { count }));
	// The answer's webhook line: "Webhook: POST /hooks/<id> on that computer's OMPdesk web server … Bearer <key>".
	const hook = /POST \/hooks\/([A-Za-z0-9_-]+)/.exec(resultBodyText(isPartial ? partialResult : result))?.[1];
	return (
		<div className="flex flex-col gap-1.5" data-tool-schedule={action}>
			<div className="flex min-w-0 items-center gap-1.5 text-omp-sm text-[var(--omp-text)]">
				<CalendarClock className="shrink-0 text-[var(--omp-muted)]" size={12} />
				<span className="min-w-0 truncate">
					{t("tools.schedule.saved", { name: text(args.name) ?? "", when }).replace(/ · $/, "")}
				</span>
			</div>
			{hook && (
				<div
					className="flex min-w-0 items-center gap-1.5 rounded border border-[var(--omp-border)] px-2 py-1 text-omp-sm"
					data-tool-schedule-webhook
				>
					<Webhook className="shrink-0 text-[var(--omp-muted)]" size={12} />
					<span className="shrink-0 text-[var(--omp-muted)]">{t("tools.schedule.webhook")}</span>
					<code className="min-w-0 flex-1 truncate font-mono text-[var(--omp-text)]">/hooks/{hook}</code>
					<CopyButton label={t("tools.schedule.copyUrl")} text={webhookUrl(hook)} />
				</div>
			)}
		</div>
	);
}
