import { isBotSchedule, waitingAskers } from "../../shared/bot-connectors";
import { type Bot, type BotsState, type Item, type ItemQuestion, itemsNeedingYou } from "../../shared/bots";
import { worktreeFolderSlug } from "../../shared/project-origin";
import type { ConnectorAsker, SchedulesState } from "../../shared/schedules";
import { isSessionDown, type SessionSummary } from "../../shared/session-summary";
import { APPROVAL_TITLE_PREFIX } from "../../shared/tool-approval";

type Translate = (key: string, params?: Record<string, string>) => string;
interface Row {
	key: string;
	project: string;
	asker: string;
	title: string;
	detail: string;
	askedAt: number | null;
	device?: string;
	deviceName?: string;
	bot?: Bot;
}

export type QuestionRow = Row &
	(
		| { source: "item"; item: Item & { question: ItemQuestion } }
		| { source: "ask" | "approval"; session: SessionSummary; requestId?: string }
		| { source: "access"; bot: Bot; scheduleId: string; service: string; person: ConnectorAsker }
	);

export interface QuestionComputer {
	device?: string;
	name?: string;
	summaries: readonly SessionSummary[];
}

function time(value?: string): number | null {
	const at = value ? Date.parse(value) : NaN;
	return Number.isFinite(at) ? at : null;
}

function openItemQuestion(item: Item): item is Item & { question: ItemQuestion } {
	return !item.closedAt && !!item.question;
}

export function questionAttentionKind(row: QuestionRow): "approval" | "question" {
	return row.source === "approval" || row.source === "access" ? "approval" : "question";
}

export function questionLabel(kind: "input" | "approval", headline: string, t: Translate): string {
	if (kind === "approval" && headline.startsWith(APPROVAL_TITLE_PREFIX)) {
		const tool = headline.slice(APPROVAL_TITLE_PREFIX.length).trim();
		if (tool) return t("workBoard.approve", { tool });
	}
	return headline || t(kind === "approval" ? "bots.needs.approval" : "bots.needs.question");
}

/** Existing item, request and schedule identities become display keys only. Answers always use the source's own id. */
export function questionRows(
	state: BotsState,
	computers: readonly QuestionComputer[],
	schedules: Pick<SchedulesState, "schedules" | "asking">,
	now: number,
	t: Translate,
): QuestionRow[] {
	const rows: QuestionRow[] = [];
	for (const { device, name: deviceName, summaries } of computers) {
		for (const session of summaries) {
			if (!session.ask || isSessionDown(session)) continue;
			const bot = state.bots.find(
				b =>
					b.device === device &&
					(b.home === session.sessionPath || b.sessions.includes(session.sessionPath) || b.folder === session.cwd),
			);
			const sessionTitle =
				session.title ||
				session.autoTitle ||
				(bot?.home === session.sessionPath ? t("bots.chats.home") : t("sidebar.untitled"));
			const requests = session.requests ?? [{ id: undefined, kind: session.ask, label: "", askedAt: null }];
			for (const request of requests) {
				rows.push({
					key: JSON.stringify([device, session.sessionPath, "request", request.id]),
					source: request.kind === "approval" ? "approval" : "ask",
					project: worktreeFolderSlug(session.cwd),
					asker: bot?.name ?? sessionTitle,
					title: sessionTitle,
					detail: questionLabel(request.kind, request.label, t),
					askedAt: request.askedAt,
					device,
					deviceName,
					bot,
					session,
					requestId: request.id,
				});
			}
		}
	}
	for (const item of itemsNeedingYou(state.items, null, now)) {
		if (!openItemQuestion(item)) continue;
		const bot = state.bots.find(b => b.id === item.bot && b.device === item.device);
		const asked = item.events.findLast(
			e => e.kind === "asked" && (item.question?.id === undefined || e.id === item.question.id),
		);
		rows.push({
			key: JSON.stringify([item.device, "item", item.id]),
			source: "item",
			item,
			project: worktreeFolderSlug(bot?.folder ?? ""),
			asker: bot?.name ?? item.bot,
			title: item.title,
			detail: item.question.text,
			askedAt: time(asked?.at),
			device: item.device,
			deviceName:
				state.remote?.find(host => host.device === item.device)?.name ??
				computers.find(c => c.device === item.device)?.name,
			bot,
		});
	}
	for (const { connector, asker } of waitingAskers(schedules.schedules, schedules.asking)) {
		const bot = state.bots.find(b => !b.device && isBotSchedule(b, connector.schedule));
		if (!bot) continue;
		const service = t(`bots.connectors.service.${connector.service}`);
		rows.push({
			key: JSON.stringify(["access", connector.schedule.id, asker.person]),
			source: "access",
			bot,
			project: worktreeFolderSlug(bot.folder),
			asker: bot.name,
			askedAt: time(asker.at),
			title: t("bots.needs.access", { name: asker.name, service }),
			detail: t("bots.needs.accessDetail", { service, name: bot.name }),
			scheduleId: connector.schedule.id,
			service: connector.service,
			person: asker,
		});
	}
	return rows.sort(
		(a, b) =>
			a.project.localeCompare(b.project) ||
			a.asker.localeCompare(b.asker) ||
			(a.askedAt ?? Infinity) - (b.askedAt ?? Infinity) ||
			a.key.localeCompare(b.key),
	);
}

/** The builder orders projects, askers, then oldest known ask. This projection preserves that order. */
export function groupQuestions(rows: readonly QuestionRow[]) {
	const projects = new Map<
		string,
		{ project: string; askers: Map<string, { key: string; asker: string; rows: QuestionRow[] }> }
	>();
	for (const row of rows) {
		const session = "session" in row ? row.session : undefined;
		const folder = session?.cwd ?? row.bot?.folder ?? "";
		const projectKey = JSON.stringify([row.device, folder]);
		let project = projects.get(projectKey);
		if (!project) {
			project = { project: row.project, askers: new Map() };
			projects.set(projectKey, project);
		}
		const botId = row.bot?.id ?? (row.source === "item" ? row.item.bot : undefined);
		const key = JSON.stringify([row.device, botId ? "bot" : "session", botId ?? session?.sessionPath]);
		let group = project.askers.get(key);
		if (!group) {
			group = { key, asker: row.asker, rows: [] };
			project.askers.set(key, group);
		}
		group.rows.push(row);
	}
	return Array.from(projects, ([key, { project, askers }]) => ({ key, project, askers: [...askers.values()] }));
}
