/**
 * A bot's Activity (Orca's `BotActivityPanel.tsx:191-251`): the first screen while a new bot starts, then what needs
 * the person, what it suggests, its automations and its memory's last tidy-up.
 *
 * - First screen (`BotFirstScreen.tsx:100-214`, FK-B45): Create bot, Start omp, First message (the core's kickoff),
 *   each with its state; a first message whose turn ended without a word has Try again (`bot-kickoff-retry.ts`).
 * - Needs you (`BotNeedsYouSection.tsx:38-422`, FK-B16): its chats' own prompts (approvals first, then questions,
 *   as their rows read them), then its items set to Needs you; five rows, then Show more. A chat's row opens the
 *   chat, an item's row its item page. Above them, people asking through one of its connectors without being on
 *   its list (Orca's Request access, `bot-access-request.ts:95-107`), each with Allow (they join the list) and Decline.
 * - Suggestions (`BotUpNextSection.tsx:263-340`, Orca's `shared/bots/bot-look-around.ts:142-176`): what its looks
 *   suggested, apart from its items, with a New mark on what came since the owner last saw the list; Start puts its
 *   ask in the home chat's message box, Dismiss keeps it out for 30 days; Look now runs its Look around (or turns it
 *   on).
 * - Workers (`bot-work-store.ts`): the sessions its chats opened or were handed, what each does and its branch.
 * - Automations (`BotUpcomingSection.tsx`, FK-B19): its schedules ranked failed, running, soonest (`botAutomations`);
 *   pause or resume, Run now, open in Settings › Schedules, Delete (asks first); five rows plus its own routines;
 *   "+" opens its home chat with "Set up an automation that " to finish.
 * - Memory (`BotTidyUpReview.tsx:20-160`, FK-B20, FK-B22): the last memory upkeep's changes, one Undo that puts
 *   MEMORY.md back as it was before it, and an Undo per line it took out or put in (Orca's memory History rows); a
 *   notice with Turn on when the upkeep turned itself off after 3 failed runs. Its memory files open from Settings.
 */
import {
	Check,
	ChevronRight,
	CircleAlert,
	CircleDashed,
	Clock,
	ExternalLink,
	Eye,
	GitBranch,
	ListChecks,
	Moon,
	Play,
	Plus,
	RotateCcw,
	Settings,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	type Bot,
	type BotFile,
	type BotSuggestion,
	type BotWorker,
	type Item,
	itemsNeedingYou,
} from "../../../shared/bots";
import { openInboxRow, useQuestionInbox } from "../../hooks/use-question-inbox";
import { handToTab } from "../../lib/composer-handoff";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { openExternal } from "../../lib/open-external";
import type { QuestionRow } from "../../lib/question-inbox";
import { useBotsStore } from "../../stores/bots";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import {
	Badge,
	Banner,
	Button,
	ConfirmDialog,
	EmptyState,
	IconButton,
	ListRow,
	Modal,
	SectionLabel,
	Spinner,
	StatusDot,
} from "../common";
import { BotActionsMenu } from "./BotActionsMenu";
import { BotAvatar } from "./BotAvatar";
import { BotLineText } from "./BotLineText";
import { type BotAutomation, botAutomations, turnedOffAfterFailures, useSchedulesOf } from "./bot-automations";
import { type LaunchStep, openBotChat, retryKickoff, useBotLaunch } from "./bot-launch";
import { openBotPage } from "./bot-page";
import { openItem } from "./items/item-store";
import { type MemoryLineChange, memoryLineChanges, undoMemoryLine } from "./memory-lines";
import { useBotFacts } from "./use-bot-facts";

/** The item's own page, under the bot's Items tab. */
function showItem(bot: Bot, item: Item): void {
	openBotPage(bot.id, "items");
	openItem(bot.id, item.id);
}

const ROWS = 5;

export function BotActivity({ bot }: { bot: Bot }) {
	return (
		<div className="flex flex-col gap-5 p-4" data-bot-activity={bot.id}>
			<BotFirstScreen bot={bot} />
			<NeedsYou bot={bot} />
			{!bot.device && <Suggestions bot={bot} />}
			{!bot.device && <Workers bot={bot} />}
			<Automations bot={bot} />
			<TidyUp bot={bot} />
		</div>
	);
}

export function BotInspectorHome({ bot }: { bot: Bot }) {
	const t = useT();
	const items = useBotsStore(s => s.state.items);
	const open = items.filter(item => item.bot === bot.id && item.device === bot.device && !item.closedAt);
	const selected = useMemo(() => [bot], [bot]);
	const facts = useBotFacts(selected).get(bot.id);
	const mark = bot.paused ? "paused" : facts?.needsYou ? "needsYou" : facts?.failed ? "failed" : null;
	return (
		<div className="flex min-w-0 flex-col gap-3.5 overflow-auto py-3 pr-2 pl-3.5" data-inspector-bot={bot.id}>
			<header className="flex items-center gap-1.5 px-2 py-1">
				<BotAvatar bot={bot} mark={mark} size={36} working={facts?.working} />
				<div className="min-w-0 flex-1">
					<div className="truncate text-sc-md leading-5 font-semibold">{bot.name}</div>
					<BotLineText
						bot={bot}
						className="text-sc-xs leading-4 text-(--sc-text-muted)"
						line={facts?.line ?? { kind: "idle" }}
					/>
				</div>
				<IconButton
					icon={<Settings />}
					label={t("bots.menu.settings")}
					onClick={() => openBotPage(bot.id, "settings")}
					size="md"
				/>
				<BotActionsMenu bot={bot} />
			</header>
			{open.length ? (
				<ul aria-label={t("bots.pane.items")}>
					{open.map(item => (
						<li key={item.id}>
							<Button onClick={() => showItem(bot, item)} size="sm" variant="ghost">
								{item.title}
							</Button>
						</li>
					))}
				</ul>
			) : (
				<EmptyState
					className="mt-3.5 gap-2 px-6 py-12 [&>span]:size-5 [&>span]:bg-transparent [&>span>svg]:size-5"
					size="sm"
					description={t("panel.inspector.emptyItems", { name: bot.name })}
					icon={<ListChecks />}
					title={t("bots.items.empty.title")}
				/>
			)}
			<Automations bot={bot} inspector />
		</div>
	);
}

function StepMark({ step }: { step: LaunchStep }) {
	if (step === "done") return <Check aria-hidden className="size-4 text-(--sc-success)" />;
	if (step === "failed") return <CircleAlert aria-hidden className="size-4 text-(--sc-danger)" />;
	if (step === "running") return <Spinner size="sm" />;
	return <CircleDashed aria-hidden className="size-4 text-(--sc-text-subtle)" />;
}

/**
 * While a new bot's first run starts: its steps, until its home chat exists and its first message (the core's kickoff)
 * went out; and whenever that first message got no word, with Try again.
 */
function BotFirstScreen({ bot }: { bot: Bot }) {
	const t = useT();
	const launch = useBotLaunch(s => (bot.device ? undefined : s.launches[bot.id]));
	const [retrying, setRetrying] = useState(false);
	const sent = (bot.kickoffs?.length ?? 0) > 0;
	const silent = bot.kickoffSilent === true;
	if (!bot.firstRun || (!silent && (!launch || (bot.home && sent)))) return null;
	const steps: { label: string; step: LaunchStep }[] = [
		{ label: t("bots.first.create"), step: "done" },
		{ label: t("bots.first.start"), step: launch?.start ?? "done" },
		{
			label: t("bots.first.message"),
			step: silent ? "failed" : sent ? "done" : bot.home ? "running" : "pending",
		},
	];
	return (
		<section aria-label={t("bots.first.title")} className="flex flex-col gap-2" data-bot-first-screen>
			<SectionLabel>{t("bots.first.title")}</SectionLabel>
			<ol className="flex flex-col gap-1.5">
				{steps.map(({ label, step }) => (
					<li className="flex items-center gap-2 text-sc-sm" data-step={step} key={label}>
						<StepMark step={step} />
						<span>{label}</span>
					</li>
				))}
			</ol>
			{launch?.error && <p className="text-sc-xs text-(--sc-danger)">{launch.error}</p>}
			{silent && <p className="text-sc-xs text-(--sc-text-muted)">{t("bots.first.silent")}</p>}
			{silent && !bot.device && (
				<Button
					className="self-start"
					data-bot-kickoff-retry
					icon={<RotateCcw />}
					loading={retrying}
					onClick={() => {
						setRetrying(true);
						void retryKickoff(bot.id).finally(() => setRetrying(false));
					}}
					size="sm"
					variant="secondary"
				>
					{t("bots.first.retry")}
				</Button>
			)}
		</section>
	);
}

interface NeedRow {
	key: string;
	kind: QuestionRow["source"];
	title: string;
	detail: string;
	open: () => void;
}

function NeedsYou({ bot }: { bot: Bot }) {
	const t = useT();
	const items = useBotsStore(s => s.state.items);
	const inbox = useQuestionInbox().filter(row => row.bot?.id === bot.id && row.device === bot.device);
	const [all, setAll] = useState(false);
	const askers = inbox.filter(row => row.source === "access");
	const rows: NeedRow[] = inbox
		.filter(row => row.source !== "access")
		.map(row => ({
			key: row.key,
			kind: row.source,
			title: row.title,
			detail: row.detail,
			open: () => void openInboxRow(row),
		}));
	// An item can be marked Needs you without a question. Keep it here, not in the question inbox.
	for (const item of itemsNeedingYou(items, null, Date.now())) {
		if (!item.question && !item.closedAt && item.bot === bot.id && item.device === bot.device)
			rows.push({
				key: item.id,
				kind: "item",
				title: item.title,
				detail: t("bots.needs.item"),
				open: () => showItem(bot, item),
			});
	}
	rows.sort(
		(a, b) =>
			Number(b.kind === "approval") - Number(a.kind === "approval") ||
			Number(a.kind === "item") - Number(b.kind === "item"),
	);
	// Approvals never fold away (Orca's BotNeedsYouSection).
	const approvals = rows.filter(row => row.kind === "approval").length;
	const shown = all ? rows : rows.slice(0, Math.max(ROWS, approvals));
	return (
		<section aria-label={t("bots.needs.title")} className="flex flex-col gap-1" data-bot-needs-you>
			<SectionLabel count={rows.length + askers.length}>{t("bots.needs.title")}</SectionLabel>
			{askers.map(row => (
				<AccessAsk key={row.key} row={row} />
			))}
			{rows.length === 0 ? (
				askers.length === 0 && <EmptyState size="row" title={t("bots.needs.none")} />
			) : (
				<>
					{shown.map(row => (
						<ListRow
							actions={
								<Button onClick={row.open} size="sm" variant="ghost">
									{t("bots.needs.open")}
								</Button>
							}
							actionsOnHover
							description={row.detail}
							key={row.key}
							leading={<StatusDot decorative tone="attention" />}
							onClick={row.open}
							size="sm"
							title={row.title}
						/>
					))}
					{rows.length > shown.length && (
						<Button className="self-start" onClick={() => setAll(true)} size="sm" variant="ghost">
							{t("bots.showMore", { count: rows.length - shown.length })}
						</Button>
					)}
				</>
			)}
		</section>
	);
}

/** Suggestions shown before "Show N more" (Orca's `SUGGESTION_LIMITS.shown`). */
const SUGGESTIONS_SHOWN = 3;

/** Someone who asked the bot through a connector without being on its list: Allow adds them, Decline stops asking. */
function AccessAsk({ row }: { row: Extract<QuestionRow, { source: "access" }> }) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const { person: asker, scheduleId } = row;
	const service = t(`bots.connectors.service.${row.service}`);
	const answer = (allow: boolean) => {
		setBusy(true);
		window.omp.schedules
			.command({ action: "answerAsker", id: scheduleId, person: asker.person, allow })
			.then(() => {
				setBusy(false);
				if (allow) toast({ variant: "success", message: t("bots.needs.accessAllowed", { name: asker.name }) });
			})
			.catch((error: unknown) => {
				setBusy(false);
				toastError({ title: t("bots.needs.accessFailed"), error });
			});
	};
	return (
		<ListRow
			actions={
				<>
					{asker.link && (
						<IconButton
							icon={<ExternalLink />}
							label={t("bots.needs.accessOpen", { service })}
							onClick={() => openExternal(asker.link ?? "")}
							size="sm"
						/>
					)}
					<Button disabled={busy} onClick={() => answer(false)} size="sm" variant="ghost">
						{t("bots.needs.accessDecline")}
					</Button>
					<Button disabled={busy} onClick={() => answer(true)} size="sm" variant="primary">
						{t("bots.needs.accessAllow")}
					</Button>
				</>
			}
			description={row.detail}
			leading={<StatusDot decorative tone="attention" />}
			rowProps={{ "data-bot-access-ask": row.service }}
			size="sm"
			title={row.title}
		/>
	);
}

function Suggestions({ bot }: { bot: Bot }) {
	const t = useT();
	const looks = useBotsStore(s => s.state.looks?.find(look => look.bot === bot.id));
	const command = useBotsStore(s => s.command);
	const [all, setAll] = useState(false);
	const items = looks?.items ?? [];
	const seenAt = looks?.seenAt ?? 0;
	// What was new when the list came into view keeps its mark while it stays in view.
	const [newSince] = useState(seenAt);
	const unseen = items.filter(item => item.createdAt > seenAt).length;
	useEffect(() => {
		if (unseen > 0) void command({ action: "looksSeen", id: bot.id }).catch(() => {});
	}, [bot.id, command, unseen]);
	const on = bot.lookSetting?.on ?? bot.lookAround !== null;
	const act = (item: BotSuggestion, how: "start" | "dismiss") =>
		void command({ action: "suggestion", id: bot.id, suggestion: item.id, act: how })
			.then(() => (how === "start" ? openBotChat(bot, bot.home, item.ask) : undefined))
			.catch((error: unknown) => toastError({ title: t("bots.suggestions.failed"), error }));
	const lookNow = () => {
		if (bot.lookAround)
			void window.omp.schedules
				.command({ action: "runNow", id: bot.lookAround }, bot.device)
				.then(() => toast({ variant: "success", message: t("bots.suggestions.looking") }))
				.catch((error: unknown) => toastError({ title: t("bots.suggestions.lookFailed"), error }));
		else
			void command({ action: "update", id: bot.id, lookAround: { on: true } }).catch((error: unknown) =>
				toastError({ title: t("bots.suggestions.lookFailed"), error }),
			);
	};
	const shown = all ? items : items.slice(0, SUGGESTIONS_SHOWN);
	return (
		<section aria-label={t("bots.suggestions.title")} className="flex flex-col gap-1" data-bot-suggestions>
			<SectionLabel
				action={
					<Button disabled={!bot.home || bot.paused} onClick={lookNow} size="sm" variant="ghost">
						{on ? t("bots.suggestions.lookNow") : t("bots.suggestions.turnOn")}
					</Button>
				}
				count={items.length}
			>
				{t("bots.suggestions.title")}
			</SectionLabel>
			{looks?.lastLookedAt ? (
				<p className="text-sc-xs text-(--sc-text-muted)" data-bot-looked>
					{t("bots.suggestions.looked", { when: formatClock(looks.lastLookedAt) })}
				</p>
			) : null}
			{items.length === 0 ? (
				<EmptyState size="row" title={on ? t("bots.suggestions.none") : t("bots.suggestions.off")} />
			) : (
				shown.map(item => (
					<ListRow
						actions={
							<>
								{item.link && (
									<IconButton
										icon={<ExternalLink />}
										label={t("bots.suggestions.openLink")}
										onClick={() => openExternal(item.link ?? "")}
										size="sm"
									/>
								)}
								<IconButton
									icon={<Play />}
									label={t("bots.suggestions.start")}
									onClick={() => act(item, "start")}
									size="sm"
								/>
								<IconButton
									icon={<X />}
									label={t("bots.suggestions.dismiss")}
									onClick={() => act(item, "dismiss")}
									size="sm"
								/>
							</>
						}
						actionCount={item.link ? 3 : 2}
						actionsOnHover
						rowProps={{ "data-bot-suggestion": item.id }}
						description={item.why}
						key={item.id}
						meta={
							item.createdAt > newSince ? (
								<Badge data-bot-suggestion-new size="xs" variant="info">
									{t("bots.suggestions.new")}
								</Badge>
							) : undefined
						}
						onClick={() => act(item, "start")}
						size="sm"
						title={item.title}
						tooltip={t("bots.suggestions.startHint")}
					/>
				))
			)}
			{items.length > shown.length && (
				<Button className="self-start" onClick={() => setAll(true)} size="sm" variant="ghost">
					{t("bots.showMore", { count: items.length - shown.length })}
				</Button>
			)}
		</section>
	);
}

/** The sessions its chats opened or were handed (Orca's `bot-work-store.ts` rows): what each does, and its branch. */
function Workers({ bot }: { bot: Bot }) {
	const t = useT();
	const [all, setAll] = useState(false);
	const workers = [...(bot.workers ?? [])].reverse();
	if (workers.length === 0) return null;
	const shown = all ? workers : workers.slice(0, ROWS);
	const open = (worker: BotWorker) => {
		useUiStore.getState().closeDestination();
		const tabs = useTabsStore.getState();
		if (worker.tabId) void tabs.switchTab(worker.tabId).catch(() => {});
		else if (worker.session.includes("/") || worker.session.includes("\\"))
			void tabs.openTab({ cwd: worker.cwd, sessionPath: worker.session, kind: "agent" }).catch(() => {});
	};
	return (
		<section aria-label={t("bots.workers.title")} className="flex flex-col gap-1" data-bot-workers>
			<SectionLabel count={workers.length}>{t("bots.workers.title")}</SectionLabel>
			{shown.map(worker => (
				<ListRow
					rowProps={{ "data-bot-worker": worker.state }}
					description={
						<span className="flex min-w-0 items-center gap-1">
							{worker.branch && <GitBranch aria-hidden className="size-3 shrink-0" />}
							<span className="truncate">{worker.branch ?? worker.cwd}</span>
						</span>
					}
					key={worker.session}
					leading={
						<StatusDot
							decorative
							tone={worker.state === "working" ? "working" : worker.state === "idle" ? "success" : "neutral"}
						/>
					}
					meta={
						<Badge size="xs" variant={worker.state === "closed" ? "muted" : "default"}>
							{t(`bots.workers.state.${worker.state}`)}
						</Badge>
					}
					onClick={
						worker.tabId || worker.session.includes("/") || worker.session.includes("\\")
							? () => open(worker)
							: undefined
					}
					size="sm"
					title={worker.title || t("bots.chats.untitled")}
				/>
			))}
			{workers.length > shown.length && (
				<Button className="self-start" onClick={() => setAll(true)} size="sm" variant="ghost">
					{t("bots.showMore", { count: workers.length - shown.length })}
				</Button>
			)}
		</section>
	);
}

function Automations({ bot, inspector = false }: { bot: Bot; inspector?: boolean }) {
	const t = useT();
	const schedules = useSchedulesOf(bot.device);
	const [all, setAll] = useState(false);
	const [deleting, setDeleting] = useState<BotAutomation | null>(null);
	const rows = botAutomations(bot, schedules);
	const own = rows.filter(row => row.own);
	const others = rows.filter(row => !row.own);
	const shown = [...own, ...(all ? others : others.slice(0, ROWS))];
	const run = (request: Parameters<typeof window.omp.schedules.command>[0], done?: string) =>
		void window.omp.schedules
			.command(request, bot.device)
			.then(() => (done ? toast({ variant: "success", message: done }) : undefined))
			.catch((error: unknown) => toastError({ title: t("bots.automations.failed"), error }));
	const label = (row: BotAutomation) =>
		row.own === "lookAround"
			? t("bots.automations.lookAround")
			: row.own === "tidy"
				? t("bots.automations.tidy")
				: row.schedule.name.replace(`${bot.name}: `, "");
	const tabId = useRuntimeTabId();
	const startDraft = () => {
		const text = t("bots.automations.draft");
		if (inspector && tabId) handToTab(tabId, { text, mode: "append" });
		else
			void openBotChat(bot, bot.home, text).catch(error =>
				toastError({ title: t("bots.automations.failed"), error }),
			);
	};
	const add = <IconButton icon={<Plus />} label={t("bots.automations.new")} onClick={startDraft} size="sm" />;
	const Section = inspector ? "details" : "section";
	return (
		<div className={inspector ? "group/automation-header relative" : undefined}>
			<Section
				aria-label={t("bots.automations.title")}
				className={inspector ? "group/automation" : "flex flex-col gap-1"}
				data-bot-automations
				open={inspector || undefined}
			>
				{inspector ? (
					<summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-md pr-8 pl-2 text-sc-xs leading-4 font-semibold text-(--sc-text-muted)">
						<ChevronRight aria-hidden className="size-3.5 group-open/automation:rotate-90" />
						{t("bots.automations.title")}
					</summary>
				) : (
					<SectionLabel action={add} count={rows.length}>
						{t("bots.automations.title")}
					</SectionLabel>
				)}
				{inspector &&
					(["tidy", "lookAround"] as const)
						.filter(kind => !own.some(row => row.own === kind))
						.map(kind => (
							<Button
								key={kind}
								className="w-full justify-start gap-2 border-0 px-2 text-sc-sm leading-5 font-normal"
								icon={kind === "tidy" ? <Moon /> : <Eye />}
								onClick={() => openBotPage(bot.id, "settings")}
								size="sm"
								variant="ghost"
							>
								{t(kind === "tidy" ? "bots.automations.tidy" : "bots.automations.lookAround")}
							</Button>
						))}
				{!inspector && rows.length === 0 ? (
					<EmptyState size="row" title={t("bots.automations.none")} />
				) : (
					shown.map(row => (
						<ListRow
							actionCount={3}
							actions={
								<>
									<IconButton
										icon={<Play />}
										label={t("bots.automations.runNow")}
										onClick={() =>
											run({ action: "runNow", id: row.schedule.id }, t("bots.automations.queued"))
										}
										size="sm"
									/>
									{/* Settings › Schedules is this computer's: a paired host's bot's schedules are listed here only. */}
									{!bot.device && (
										<IconButton
											icon={<ExternalLink />}
											label={t("bots.automations.open")}
											onClick={() => useUiStore.getState().openSettings("schedules")}
											size="sm"
										/>
									)}
									<IconButton
										icon={<Trash2 />}
										label={t("bots.automations.delete")}
										onClick={() => setDeleting(row)}
										size="sm"
									/>
								</>
							}
							actionsOnHover
							data-bot-automation={row.state}
							description={
								row.state === "failed"
									? (row.last?.error ?? t("bots.automations.lastFailed"))
									: row.next
										? t("bots.automations.next", { when: formatClock(row.next) })
										: undefined
							}
							key={row.schedule.id}
							leading={
								row.state === "failed" ? (
									<CircleAlert aria-hidden className="size-4 text-(--sc-danger)" />
								) : row.state === "running" ? (
									<Spinner size="sm" />
								) : (
									<Clock aria-hidden className="size-4 text-(--sc-text-muted)" />
								)
							}
							meta={
								<Badge
									size="xs"
									variant={row.state === "paused" ? "muted" : row.state === "failed" ? "error" : "default"}
								>
									{t(`bots.automations.state.${row.state}`)}
								</Badge>
							}
							onClick={() => run({ action: "setEnabled", id: row.schedule.id, enabled: !row.schedule.enabled })}
							size="sm"
							title={label(row)}
							tooltip={row.schedule.enabled ? t("bots.automations.pause") : t("bots.automations.resume")}
						/>
					))
				)}
				{inspector && (
					<Button
						className="h-auto w-full justify-start py-1 pr-2 pl-8 text-left text-(--sc-text-muted)"
						onClick={startDraft}
						size="sm"
						variant="ghost"
					>
						<span className="min-w-0 whitespace-normal text-sc-xs leading-4 font-normal">
							{t("bots.automations.ask", { name: bot.name })}
						</span>
					</Button>
				)}
				{!all && others.length > ROWS && (
					<Button className="self-start" onClick={() => setAll(true)} size="sm" variant="ghost">
						{t("bots.automations.all", { count: rows.length })}
					</Button>
				)}
				<ConfirmDialog
					confirmLabel={t("bots.automations.delete")}
					message={t("bots.automations.deleteMessage", { name: deleting ? label(deleting) : "" })}
					onCancel={() => setDeleting(null)}
					onConfirm={() => {
						if (deleting) run({ action: "delete", id: deleting.schedule.id });
						setDeleting(null);
					}}
					open={deleting !== null}
					title={t("bots.automations.deleteTitle")}
				/>
			</Section>
			{inspector && (
				<div className="absolute top-0 right-1 opacity-0 group-hover/automation-header:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
					{add}
				</div>
			)}
		</div>
	);
}

/** The newest memory upkeep run in `history`: its copy of MEMORY.md and its change list (`<stamp>.changes.md`). */
export function lastTidy(history: readonly string[]): { stamp: string; copy: string; changes: string } | null {
	const changes = history
		.filter(name => name.endsWith(".changes.md"))
		.toSorted()
		.at(-1);
	if (!changes) return null;
	const stamp = changes.slice(0, -".changes.md".length);
	return { stamp, copy: `${stamp}.md`, changes };
}

function TidyUp({ bot }: { bot: Bot }) {
	const t = useT();
	const schedules = useSchedulesOf(bot.device);
	const [memory, setMemory] = useState<BotFile | null>(null);
	const [lines, setLines] = useState<string[] | null>(null);
	const [copy, setCopy] = useState<string | null>(null);
	const [reviewing, setReviewing] = useState(false);
	const [undone, setUndone] = useState(false);
	const run = memory ? lastTidy(memory.history) : null;
	const turnedOff = bot.tidy ? turnedOffAfterFailures(schedules, bot.tidy) : null;
	useEffect(() => {
		let live = true;
		window.omp.bots
			.file({ id: bot.id, file: "MEMORY.md" })
			.then(read => {
				if (live) setMemory(read);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [bot.id]);
	const changesFile = run?.changes;
	useEffect(() => {
		if (!changesFile) return;
		let live = true;
		window.omp.bots
			.file({ id: bot.id, file: `memory/history/${changesFile}` })
			.then(read => {
				if (live)
					setLines(
						read.content
							.split("\n")
							.map(line => line.trim())
							.filter(Boolean),
					);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [bot.id, changesFile]);
	const copyFile = run?.copy;
	useEffect(() => {
		if (!reviewing || !copyFile) return;
		let live = true;
		window.omp.bots
			.file({ id: bot.id, file: `memory/history/${copyFile}` })
			.then(read => {
				if (live) setCopy(read.exists ? read.content : null);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [bot.id, copyFile, reviewing]);
	// One change undone: MEMORY.md as it is now, with that line put back or taken out; a file changed meanwhile is kept.
	const undoLine = async (change: MemoryLineChange) => {
		if (!memory || copy === null) return;
		try {
			const written = await window.omp.bots.file({
				id: bot.id,
				file: "MEMORY.md",
				content: undoMemoryLine(memory.content, copy, change),
				expectedMtimeMs: memory.mtimeMs,
			});
			setMemory(written);
			if (written.changed) toast({ variant: "warning", message: t("bots.tidy.changedMeanwhile") });
		} catch (error) {
			toastError({ title: t("bots.tidy.undoFailed"), error });
		}
	};
	const lineChanges = memory && copy !== null ? memoryLineChanges(copy, memory.content) : [];
	const undo = async () => {
		if (!run) return;
		try {
			const copy = await window.omp.bots.file({ id: bot.id, file: `memory/history/${run.copy}` });
			if (!copy.exists) throw new Error(t("bots.tidy.copyGone"));
			await window.omp.bots.file({ id: bot.id, file: "MEMORY.md", content: copy.content, force: true });
			setUndone(true);
		} catch (error) {
			toastError({ title: t("bots.tidy.undoFailed"), error });
		}
	};
	const groups = ["Learned", "Merged", "Replaced", "Filed", "Archived"] as const;
	return (
		<section aria-label={t("bots.tidy.title")} className="flex flex-col gap-1" data-bot-tidy>
			<SectionLabel
				action={
					<Button onClick={() => openBotPage(bot.id, "settings")} size="sm" variant="ghost">
						{t("bots.tidy.memory")}
					</Button>
				}
			>
				{t("bots.tidy.section")}
			</SectionLabel>
			{turnedOff !== null && (
				<Banner
					actions={
						<Button
							onClick={() =>
								void window.omp.schedules
									.command({ action: "setEnabled", id: bot.tidy ?? "", enabled: true })
									.catch((error: unknown) => toastError({ title: t("bots.automations.failed"), error }))
							}
							size="sm"
							variant="secondary"
						>
							{t("bots.tidy.turnOn")}
						</Button>
					}
					data-bot-tidy-off
					variant="warning"
				>
					{t("bots.tidy.turnedOff", { error: turnedOff || t("bots.tidy.noReason") })}
				</Banner>
			)}
			{run && lines ? (
				<ListRow
					description={t("bots.tidy.changes", { count: lines.length })}
					onClick={() => setReviewing(true)}
					size="sm"
					title={t("bots.tidy.tidied", { stamp: run.stamp })}
				/>
			) : (
				<EmptyState size="row" title={bot.tidy ? t("bots.tidy.notYet") : t("bots.tidy.off")} />
			)}
			{reviewing && run && lines && (
				<Modal
					footer={
						<>
							<Button disabled={undone} icon={<RotateCcw />} onClick={() => void undo()} variant="ghost">
								{t("bots.tidy.undo")}
							</Button>
							<Button data-dialog-autofocus onClick={() => setReviewing(false)} variant="primary">
								{t("common.done")}
							</Button>
						</>
					}
					onClose={() => setReviewing(false)}
					open
					size="md"
					title={t("bots.tidy.reviewTitle")}
				>
					<div className="flex flex-col gap-3 text-sc-sm" data-bot-tidy-review>
						<p className="text-sc-xs text-(--sc-text-muted)">
							{run.stamp} · {t("bots.tidy.changes", { count: lines.length })}
						</p>
						{groups.map(group => {
							const of = lines.filter(line => line.replace(/^[-*]\s*/, "").startsWith(`${group}:`));
							if (of.length === 0) return null;
							return (
								<div key={group}>
									<SectionLabel as="h4">{t(`bots.tidy.group.${group.toLowerCase()}`)}</SectionLabel>
									<ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5">
										{of.map(line => (
											<li key={line}>
												{line
													.replace(/^[-*]\s*/, "")
													.slice(group.length + 1)
													.trim()}
											</li>
										))}
									</ul>
								</div>
							);
						})}
						{lineChanges.length > 0 && (
							<div data-bot-tidy-lines>
								<SectionLabel as="h4">{t("bots.tidy.lines")}</SectionLabel>
								<ul className="mt-1 flex flex-col gap-0.5">
									{lineChanges.map(change => (
										<li className="flex min-w-0 items-center gap-2" key={`${change.kind}:${change.line}`}>
											<Badge size="xs" variant={change.kind === "added" ? "success" : "muted"}>
												{t(`bots.tidy.line.${change.kind}`)}
											</Badge>
											<span className="min-w-0 flex-1 truncate" title={change.line}>
												{change.line}
											</span>
											<IconButton
												icon={<RotateCcw />}
												label={t("bots.tidy.undoLine")}
												onClick={() => void undoLine(change)}
												size="sm"
											/>
										</li>
									))}
								</ul>
							</div>
						)}
						<p className="text-sc-xs text-(--sc-text-muted)">
							{undone ? t("bots.tidy.undone") : t("bots.tidy.undoNote")}
						</p>
					</div>
				</Modal>
			)}
		</section>
	);
}
