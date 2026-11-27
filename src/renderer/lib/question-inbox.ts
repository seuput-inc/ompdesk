import { isBotSchedule, waitingAskers } from "../../shared/bot-connectors";
import { type Bot, type BotsState, type Item, type ItemQuestion, itemsNeedingYou } from "../../shared/bots";
import { worktreeFolderSlug } from "../../shared/project-origin";
import type { ExtensionUIRequest } from "../../shared/rpc-types";
import type { ConnectorAsker, SchedulesState } from "../../shared/schedules";
import { isSessionDown, type SessionSummary, unsavedSessionKey } from "../../shared/session-summary";
import { APPROVAL_TITLE_PREFIX } from "../../shared/tool-approval";
import { type ExtensionUiStore, isApprovalRequest, isUserBlockingRequest } from "../stores/extension-ui";
import type { SessionTab } from "../stores/tabs";

type Translate = (key: string, params?: Record<string, string>) => string;
type QuestionSession = Pick<SessionSummary, "sessionPath" | "cwd" | "kind" | "title" | "autoTitle">;
type LocalQuestions = Pick<ExtensionUiStore, "pendingRequests" | "loginRequestIds" | "arrivedAt"> & {
	tabId: string;
	tab?: SessionTab;
};
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
		| { source: "ask" | "approval"; session: QuestionSession; requestId?: string; localTabId?: string }
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

/** A local prompt has its full question; a host summary carries only its safe headline. */
export function requestLabel(request: ExtensionUIRequest, t: Translate): string {
	switch (request.method) {
		case "select": {
			const tool = isApprovalRequest(request)
				? (request.title.slice(APPROVAL_TITLE_PREFIX.length).split("\n", 1)[0]?.trim() ?? "")
				: "";
			return tool ? t("workBoard.approve", { tool }) : request.title.trim() || t("workBoard.question");
		}
		case "confirm":
		case "input":
		case "editor":
			return request.title.trim() || t("workBoard.question");
		case "ask": {
			const first = request.questions[0];
			return first?.question.trim() || first?.header?.trim() || t("workBoard.question");
		}
		default:
			return t("workBoard.question");
	}
}

/** Existing item, request and schedule identities become display keys only. Answers always use the source's own id. */
export function questionRows(
	state: BotsState,
	computers: readonly QuestionComputer[],
	schedules: Pick<SchedulesState, "schedules" | "asking">,
	now: number,
	t: Translate,
	local?: LocalQuestions,
): QuestionRow[] {
	const rows: QuestionRow[] = [];
	const localPath = local && (local.tab?.sessionPath ?? unsavedSessionKey(local.tabId));
	let listed = false;
	function addSession(
		session: QuestionSession & Pick<SessionSummary, "ask" | "requests">,
		device: string | undefined,
		deviceName: string | undefined,
		current?: LocalQuestions,
	) {
		const bot = state.bots.find(
			b =>
				b.device === device &&
				(b.home === session.sessionPath || b.sessions.includes(session.sessionPath) || b.folder === session.cwd),
		);
		const title =
			session.title ||
			session.autoTitle ||
			(bot?.home === session.sessionPath ? t("bots.chats.home") : t("sidebar.untitled"));
		const project = worktreeFolderSlug(session.cwd);
		function add(
			requestId: string | undefined,
			source: "ask" | "approval",
			detail: string,
			askedAt: number | null,
			localTabId?: string,
		) {
			rows.push({
				key: JSON.stringify([device, session.sessionPath, "request", requestId]),
				project,
				asker: bot?.name ?? title,
				title,
				device,
				deviceName,
				bot,
				session,
				source,
				detail,
				askedAt,
				requestId,
				localTabId,
			});
		}
		const localIds = current && new Set(Object.keys(current.loginRequestIds));
		if (current && localIds) {
			for (const request of current.pendingRequests) {
				if (!isUserBlockingRequest(current, request)) continue;
				localIds.add(request.id);
				add(
					request.id,
					isApprovalRequest(request) ? "approval" : "ask",
					requestLabel(request, t),
					current.arrivedAt[request.id] ?? null,
					current.tabId,
				);
			}
		}
		if (!session.ask) return;
		const requests = session.requests ?? [{ id: undefined, kind: session.ask, label: "", askedAt: null }];
		for (const request of requests) {
			// Older hosts only report that a session waits, not the id of the prompt already in the dock.
			if (localIds && (request.id === undefined ? localIds.size > 0 : localIds.has(request.id))) continue;
			add(
				request.id,
				request.kind === "approval" ? "approval" : "ask",
				questionLabel(request.kind, request.label, t),
				request.askedAt,
			);
		}
	}
	for (const { device, name, summaries } of computers) {
		for (const session of summaries) {
			if (isSessionDown(session)) continue;
			const current = local?.tab?.device === device && session.sessionPath === localPath ? local : undefined;
			if (current) listed = true;
			if (session.ask || current?.pendingRequests.length) addSession(session, device, name, current);
		}
	}
	if (!listed && local && localPath && local.pendingRequests.length && !(local.tab && isSessionDown(local.tab))) {
		const tab = local.tab;
		addSession(
			{
				sessionPath: localPath,
				cwd: tab?.cwd ?? "",
				kind: tab?.kind ?? "agent",
				title: tab?.title,
				autoTitle: tab?.autoTitle ?? undefined,
			},
			tab?.device,
			computers.find(computer => computer.device === tab?.device)?.name,
			local,
		);
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
