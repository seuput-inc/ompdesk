/**
 * All sessions in one place (Orca's agent dashboard and activity page, stablyai/orca
 * `components/dashboard/board/AgentKanbanBoard.tsx:120-294`, `AgentDashboardToolbar.tsx:90-221`,
 * `activity/ActivityPrototypePage.tsx` and `activity/thread-list/activity-thread-grouping.ts`, MIT; re-implemented):
 * every session of this computer and of each online paired computer, as a board of four lanes (Needs you, Working,
 * Done, Idle; `board-cards.ts`) or as one inbox list by latest activity, optionally grouped. Search and the project and
 * computer chips narrow both. A card's press shows what it did (`SessionPeekSheet`), Open goes to it.
 *
 * No setting: Idle is always a lane, its newest `IDLE_SHOWN` cards listed and the rest found by search (the
 * minimal-settings rule; Orca's "show idle" toggle is not ported). The inbox's grouping is this page's view state, not a
 * preference, and never reaches the sidebar, whose code sessions are always grouped by project.
 */
import { ExternalLink } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { useProjectNames } from "../../lib/project-origin";
import { laneState } from "../../lib/session-lane";
import { sessionDisplayParts, type TitleParts } from "../../lib/session-title";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { type BoardView, useUiStore } from "../../stores/ui";
import { webRuntime } from "../../web/runtime";
import {
	Badge,
	Button,
	Chip,
	EmptyState,
	ListRow,
	PageLayout,
	SearchField,
	SectionLabel,
	SegmentedChoice,
	SessionTitle,
	Tabs,
	TimeAgo,
} from "../common";
import { sessionLive } from "../layout/SessionLiveTitle";
import { SessionStatusLane } from "../layout/sidebar/SessionStatusLane";
import { useFirstVisitTour } from "../onboarding/surface-tours";
import { BoardCardView, cardLine } from "./BoardCard";
import {
	BOARD_LANES,
	type BoardCard,
	type BoardFilter,
	type BoardLane,
	boardCards,
	boardLanes,
	matchesBoard,
} from "./board-cards";
import { ResourcesView } from "./ResourcesView";
import { SessionPeekSheet } from "./SessionPeekSheet";
import { useBoardComputers } from "./use-board";

/** Idle cards listed before "N more": the rest are found by search. */
const IDLE_SHOWN = 30;
/** Inbox rows listed at most. */
const INBOX_SHOWN = 200;
/** Project chips offered at most, the busiest first. */
const PROJECT_CHIPS = 8;

const LANE_KEY: Record<BoardLane, string> = {
	needs: "board.lane.needs",
	working: "board.lane.working",
	done: "board.lane.done",
	idle: "board.lane.idle",
};

type InboxGroup = "none" | "lane" | "project" | "computer";

const NO_FILTER: BoardFilter = { query: "", projects: [], computers: [] };

function toggled(values: readonly string[], value: string): string[] {
	return values.includes(value) ? values.filter(candidate => candidate !== value) : [...values, value];
}

/** Go to a card's session: the tab of this window that holds it, else a new tab on the computer that runs it. */
function openCard(card: BoardCard, failed: string): void {
	useUiStore.getState().closeDestination();
	const tabs = useTabsStore.getState();
	if (card.tab) {
		void tabs.switchTab(card.tab.id);
		return;
	}
	tabs
		.openTab({
			cwd: card.cwd,
			sessionPath: card.sessionPath,
			kind: card.chat ? "chat" : "agent",
			...(card.device === undefined ? {} : { device: card.device }),
		})
		.catch((error: unknown) => toastError({ title: failed, error }));
}

export function BoardPage() {
	const t = useT();
	useFirstVisitTour("board");
	const view = useUiStore(state => state.boardView);
	const openBoard = useUiStore(state => state.openBoard);
	const computers = useBoardComputers();
	const tabs = useTabsStore(state => state.tabs);
	const archived = useSidebarPrefs(state => state.archivedSessions);
	const cards = useMemo(() => boardCards(computers, tabs, new Set(archived)), [computers, tabs, archived]);
	const projectNames = useProjectNames(useMemo(() => [...new Set(cards.map(card => card.cwd))], [cards]));
	const projectOf = useCallback((cwd: string) => projectNames(cwd).name, [projectNames]);
	const [filter, setFilter] = useState<BoardFilter>(NO_FILTER);
	const [group, setGroup] = useState<InboxGroup>("none");
	const [peekKey, setPeekKey] = useState<string | null>(null);
	const untitled = t("sidebar.untitled");
	const titleOf = useCallback(
		(card: BoardCard): TitleParts =>
			card.info
				? sessionDisplayParts(
						{
							...card.info,
							...(card.summary?.title ? { title: card.summary.title } : {}),
							...(card.summary ? { autoTitle: card.summary.autoTitle } : {}),
						},
						untitled,
					)
				: { title: card.summary?.title || card.tab?.task || t("sidebar.newSession") },
		[t, untitled],
	);
	const shown = useMemo(
		() => cards.filter(card => matchesBoard(card, filter, projectOf, titleOf(card).title)),
		[cards, filter, projectOf, titleOf],
	);
	const projects = useMemo(() => {
		const counts = new Map<string, number>();
		for (const card of cards) counts.set(projectOf(card.cwd), (counts.get(projectOf(card.cwd)) ?? 0) + 1);
		return [...counts]
			.sort((a, b) => b[1] - a[1])
			.slice(0, PROJECT_CHIPS)
			.map(([name]) => name);
	}, [cards, projectOf]);
	const remote = computers.filter(computer => computer.device !== undefined);
	const peek = peekKey ? cards.find(card => card.key === peekKey) : undefined;
	const openFailed = t("tabs.newFailed");
	const open = useCallback(
		(card: BoardCard) => {
			setPeekKey(null);
			openCard(card, openFailed);
		},
		[openFailed],
	);
	const close = useCallback((card: BoardCard) => {
		if (card.tab) void useTabsStore.getState().closeTab(card.tab.id);
	}, []);
	const peekCard = useCallback((card: BoardCard) => setPeekKey(card.key), []);
	const openWindow = () =>
		window.omp.sessions.openBoardWindow().then(
			ok => {
				if (!ok) toast({ variant: "error", message: t("board.openWindowFailed") });
			},
			(error: unknown) => toastError({ title: t("board.openWindowFailed"), error }),
		);

	return (
		<PageLayout
			actions={
				// A phone's or a paired browser's page is one window.
				webRuntime() === null && (
					<Button data-board-window icon={<ExternalLink />} onClick={() => void openWindow()} variant="secondary">
						{t("board.openWindow")}
					</Button>
				)
			}
			body="fill"
			description={t("board.description")}
			tabs={
				<Tabs
					activeId={view}
					ariaLabel={t("destination.board")}
					onChange={id => openBoard(id as BoardView)}
					tabs={[
						{ id: "board", label: t("board.view.board") },
						{ id: "inbox", label: t("board.view.inbox") },
						{ id: "resources", label: t("board.view.resources") },
					]}
					variant="underline"
				/>
			}
			title={t("destination.board")}
		>
			<div className="flex min-h-0 flex-1 flex-col" data-board-page={view}>
				{view === "resources" ? (
					<ResourcesView
						titleOf={use => {
							const card = cards.find(
								entry => entry.device === undefined && entry.sessionPath === use.sessionPath,
							);
							return card ? titleOf(card).title : projectOf(use.cwd);
						}}
					/>
				) : (
					<>
						<div className="flex shrink-0 flex-wrap items-center gap-2 px-6 py-3 min-[1280px]:px-10">
							<div className="w-64 max-w-full">
								<SearchField
									label={t("board.search")}
									onValueChange={query => setFilter(current => ({ ...current, query }))}
									placeholder={t("board.search")}
									value={filter.query}
								/>
							</div>
							<div
								className="flex flex-wrap items-center gap-1 [--hit-gap-x:2px] [--hit-gap-y:2px]"
								data-board-chips
							>
								{projects.map(name => (
									<Chip
										data-board-chip="project"
										key={`project:${name}`}
										onPressedChange={() =>
											setFilter(current => ({ ...current, projects: toggled(current.projects, name) }))
										}
										pressed={filter.projects.includes(name)}
									>
										{name}
									</Chip>
								))}
								{remote.length > 0 &&
									[{ device: "", name: t("board.thisComputer") }, ...remote].map(computer => (
										<Chip
											data-board-chip="computer"
											key={`computer:${computer.device}`}
											onPressedChange={() =>
												setFilter(current => ({
													...current,
													computers: toggled(current.computers, computer.device ?? ""),
												}))
											}
											pressed={filter.computers.includes(computer.device ?? "")}
										>
											{computer.name}
										</Chip>
									))}
							</div>
							{view === "inbox" && (
								<SegmentedChoice
									aria-label={t("board.group.label")}
									className="ml-auto"
									fit="content"
									onChange={setGroup}
									optionAttr="data-board-group"
									options={[
										{ value: "none", label: t("board.group.none") },
										{ value: "lane", label: t("board.group.lane") },
										{ value: "project", label: t("board.group.project") },
										...(remote.length > 0
											? [{ value: "computer" as const, label: t("board.group.computer") }]
											: []),
									]}
									value={group}
								/>
							)}
						</div>
						{cards.length === 0 ? (
							<EmptyState size="md" title={t("board.noSessions")} />
						) : view === "board" ? (
							<BoardLanes
								cards={shown}
								onClose={close}
								onOpen={open}
								onPeek={peekCard}
								projectOf={projectOf}
								titleOf={titleOf}
							/>
						) : (
							<InboxList cards={shown} group={group} onPeek={peekCard} projectOf={projectOf} titleOf={titleOf} />
						)}
					</>
				)}
			</div>
			{peek && <SessionPeekSheet card={peek} onClose={() => setPeekKey(null)} onOpen={open} title={titleOf(peek)} />}
		</PageLayout>
	);
}

interface ListProps {
	cards: readonly BoardCard[];
	projectOf: (cwd: string) => string;
	titleOf: (card: BoardCard) => TitleParts;
	onPeek: (card: BoardCard) => void;
}

function BoardLanes({
	cards,
	projectOf,
	titleOf,
	onPeek,
	onOpen,
	onClose,
}: ListProps & { onOpen: (card: BoardCard) => void; onClose: (card: BoardCard) => void }) {
	const t = useT();
	const lanes = useMemo(() => boardLanes(cards), [cards]);
	return (
		<div className="min-h-0 flex-1 overflow-auto px-6 pb-6 min-[1280px]:px-10" data-board-lanes>
			{/* Lanes wrap rather than scroll sideways: a lane cut at the edge hides the cards it holds. */}
			<div className="grid min-h-full grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-3">
				{BOARD_LANES.map(lane => {
					const listed = lanes[lane];
					const capped = lane === "idle" ? listed.slice(0, IDLE_SHOWN) : listed;
					return (
						<section
							aria-label={t(LANE_KEY[lane])}
							className="flex min-h-0 flex-col gap-2 rounded-(--sc-radius-lg) bg-(--sc-surface-2) p-2"
							data-board-lane={lane}
							key={lane}
						>
							<SectionLabel as="h3" className="px-1 pt-1" count={listed.length}>
								{t(LANE_KEY[lane])}
							</SectionLabel>
							{capped.length === 0 ? (
								<p className="px-1 text-sc-xs text-(--sc-text-muted)">{t("board.empty")}</p>
							) : (
								<ul className="flex flex-col gap-2">
									{capped.map(card => (
										<BoardCardView
											card={card}
											key={card.key}
											onClose={onClose}
											onOpen={onOpen}
											onPeek={onPeek}
											project={projectOf(card.cwd)}
											title={titleOf(card)}
										/>
									))}
								</ul>
							)}
							{listed.length > capped.length && (
								<p className="px-1 text-sc-xs text-(--sc-text-muted)" data-board-more>
									{t("board.moreIdle", { count: listed.length - capped.length })}
								</p>
							)}
						</section>
					);
				})}
			</div>
		</div>
	);
}

/** The inbox: every session by latest activity (Orca's activity list), grouped as the person picks for this view. */
function InboxList({ cards, projectOf, titleOf, onPeek, group }: ListProps & { group: InboxGroup }) {
	const t = useT();
	const groups = useMemo(() => {
		const rows = cards.slice(0, INBOX_SHOWN);
		if (group === "none") return [{ key: "", label: "", rows }];
		const byKey = new Map<string, { key: string; label: string; rows: BoardCard[] }>();
		const keyOf = (card: BoardCard): [string, string] =>
			group === "lane"
				? [card.lane, t(LANE_KEY[card.lane])]
				: group === "project"
					? [projectOf(card.cwd), projectOf(card.cwd)]
					: [card.device ?? "", card.deviceName ?? t("board.thisComputer")];
		for (const card of rows) {
			const [key, label] = keyOf(card);
			const held = byKey.get(key) ?? { key, label, rows: [] };
			held.rows.push(card);
			byKey.set(key, held);
		}
		const listed = [...byKey.values()];
		// Lanes keep the board's order; the other groups follow their newest session.
		return group === "lane"
			? listed.sort((a, b) => BOARD_LANES.indexOf(a.key as BoardLane) - BOARD_LANES.indexOf(b.key as BoardLane))
			: listed;
	}, [cards, group, projectOf, t]);
	if (cards.length === 0) return <EmptyState size="md" title={t("board.empty")} />;
	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 min-[1280px]:px-10" data-board-inbox>
			{groups.map(section => (
				<section className="flex flex-col gap-0.5 pb-3" data-board-inbox-group={section.key} key={section.key}>
					{section.label && (
						<SectionLabel as="h3" className="px-2.5 py-1" count={section.rows.length}>
							{section.label}
						</SectionLabel>
					)}
					{section.rows.map(card => {
						const { run } = card;
						const title = titleOf(card);
						const at = card.at > 0 ? new Date(card.at).toISOString() : undefined;
						const line = cardLine(card);
						return (
							<ListRow
								data-board-inbox-row={card.lane}
								description={line}
								key={card.key}
								leading={
									<SessionStatusLane
										state={laneState({
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
										})}
									/>
								}
								onClick={() => onPeek(card)}
								secondary={
									<span className="flex min-w-0 items-center gap-1.5">
										<span className="min-w-0 truncate">{projectOf(card.cwd)}</span>
										{card.deviceName && <Badge variant="muted">{card.deviceName}</Badge>}
										{at && <TimeAgo className="ml-auto shrink-0 tabular-nums" iso={at} />}
									</span>
								}
								title={<SessionTitle parts={title} />}
								titleText={[title.title, line].filter(Boolean).join("\n")}
							/>
						);
					})}
				</section>
			))}
		</div>
	);
}
