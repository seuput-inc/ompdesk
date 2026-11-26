/**
 * One session on the all-sessions board (after Orca's kanban card, stablyai/orca
 * `components/dashboard/board/AgentKanbanCard.tsx:195-325`, MIT; re-implemented): its status lane mark and title (a
 * press shows what it did, the peek), what it last said, then its project, the computer it runs on, its subagents at
 * work and its age, with Open and, for a tab of this window that is not busy, Close.
 */
import { ExternalLink, X } from "lucide-react";
import { memo, useMemo } from "react";
import { ATTENTION_LABEL_KEY } from "../../lib/attention";
import { useT } from "../../lib/i18n";
import { readLastExchange } from "../../lib/last-exchange";
import { laneState } from "../../lib/session-lane";
import type { TitleParts } from "../../lib/session-title";
import { Badge, Button, Card, IconButton, SessionTitle, TimeAgo } from "../common";
import { sessionLive } from "../layout/SessionLiveTitle";
import { SessionStatusLane } from "../layout/sidebar/SessionStatusLane";
import type { BoardCard } from "./board-cards";

/** What a card says under its title: the last exchange this window holds of an active session, else its first message. */
export function cardLine(card: BoardCard): string | undefined {
	if (card.lane !== "idle") {
		const exchange = readLastExchange({
			tabId: card.tab?.id,
			sessionPath: card.sessionPath,
			device: card.device,
			stamp: card.info?.modified,
		});
		if (exchange) return exchange.reply ?? exchange.prompt;
	}
	return card.info?.firstMessage.replace(/\s+/g, " ").trim() || undefined;
}

export const BoardCardView = memo(function BoardCardView({
	card,
	title,
	project,
	onPeek,
	onOpen,
	onClose,
}: {
	card: BoardCard;
	title: TitleParts;
	project: string;
	onPeek: (card: BoardCard) => void;
	onOpen: (card: BoardCard) => void;
	onClose: (card: BoardCard) => void;
}) {
	const t = useT();
	const { run } = card;
	const line = useMemo(() => cardLine(card), [card]);
	const lane = laneState({
		run,
		attention: run.ask,
		live: sessionLive({
			running: run.running,
			settling: run.settling,
			waiting: false,
			opened: 0,
			agents: card.agents,
		}),
		stopped: card.tab?.lastRun?.stopReason === "aborted",
		pullRequest: false,
		open: card.tab !== undefined,
	});
	const closable = card.tab !== undefined && !run.running && !run.waiting;
	const at = card.at > 0 ? new Date(card.at).toISOString() : undefined;
	return (
		<Card
			as="li"
			className={card.lane === "needs" ? "bg-(--sc-attention-soft)" : undefined}
			data-board-card={card.lane}
			data-board-device={card.device}
			data-session-path={card.sessionPath}
			padding="none"
			surface="1"
		>
			<Button
				aria-label={t("board.card.peek", { title: title.title })}
				className="h-auto w-full justify-start gap-2 px-2.5 pt-2 pb-1 text-left"
				data-board-peek
				onClick={() => onPeek(card)}
				variant="ghost"
			>
				<SessionStatusLane state={lane} />
				<SessionTitle className="min-w-0 flex-1 text-sc-sm" parts={title} titleClassName="font-medium" />
			</Button>
			{/* Under the title, past the status lane's column. */}
			<div className="pr-2.5 pb-1.5 pl-9">
				{run.ask ? (
					<Badge variant="attention">{t(ATTENTION_LABEL_KEY[run.ask])}</Badge>
				) : (
					line && <p className="line-clamp-2 text-sc-xs text-(--sc-text-secondary) break-words">{line}</p>
				)}
				{run.failed && run.reason && (
					<p className="line-clamp-2 text-sc-xs text-(--sc-danger) break-words">{run.reason}</p>
				)}
			</div>
			<div className="flex items-center gap-1.5 border-t border-(--sc-border-subtle) px-2.5 py-1 text-sc-xs text-(--sc-text-muted)">
				<span className="min-w-0 truncate" title={card.cwd}>
					{project}
				</span>
				{card.deviceName && (
					<Badge className="shrink-0" variant="muted">
						{card.deviceName}
					</Badge>
				)}
				{card.agents > 0 && (
					<span className="shrink-0 tabular-nums">{t("board.card.agents", { count: card.agents })}</span>
				)}
				<span className="ml-auto flex shrink-0 items-center gap-0.5">
					{at && <TimeAgo className="pr-1 tabular-nums" iso={at} />}
					<IconButton
						icon={<ExternalLink />}
						label={t("board.card.open")}
						onClick={() => onOpen(card)}
						size="sm"
					/>
					{closable && (
						<IconButton icon={<X />} label={t("board.card.close")} onClick={() => onClose(card)} size="sm" />
					)}
				</span>
			</div>
		</Card>
	);
});
