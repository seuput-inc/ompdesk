/**
 * A bot's Activity (Orca's `BotActivityPanel.tsx:191-251`): the first screen while a new bot starts, then what needs
 * the person, what it suggests, its automations and its memory's last tidy-up.
 *
 * - First screen (`BotFirstScreen.tsx:100-214`, FK-B45): Create bot, Start omp, First message, each with its state;
 *   a failed first message can be sent again.
 * - Needs you (`BotNeedsYouSection.tsx:38-422`, FK-B16): its chats' own prompts (approvals first, then questions,
 *   as their rows read them), then its items set to Needs you; five rows, then Show more. A chat's row opens the
 *   chat, an item's row its item page.
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
	CircleAlert,
	CircleDashed,
	Clock,
	ExternalLink,
	GitBranch,
	Play,
	Plus,
	RotateCcw,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	type Bot,
	type BotFile,
	type BotSuggestion,
	type BotWorker,
	type Item,
	itemsNeedingYou,
} from "../../../shared/bots";
import type { AskKind } from "../../lib/attention";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { openExternal } from "../../lib/open-external";
import { sessionRun } from "../../lib/session-run";
import { useBotsStore } from "../../stores/bots";
import { tabSummary, useHostedSessionsStore } from "../../stores/hosted-sessions";
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
import { type BotAutomation, botAutomations, turnedOffAfterFailures, useLocalSchedules } from "./bot-automations";
import { type LaunchStep, openBotChat, sendKickoff, useBotLaunch } from "./bot-launch";
import { openBotPage } from "./bot-page";
import { openItem } from "./items/item-store";
import { type MemoryLineChange, memoryLineChanges, undoMemoryLine } from "./memory-lines";

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
			<Suggestions bot={bot} />
			<Workers bot={bot} />
			<Automations bot={bot} />
			<TidyUp bot={bot} />
		</div>
	);
}

function StepMark({ step }: { step: LaunchStep }) {
	if (step === "done") return <Check aria-hidden className="size-4 text-(--sc-success)" />;
	if (step === "failed") return <CircleAlert aria-hidden className="size-4 text-(--sc-danger)" />;
	if (step === "running") return <Spinner size="sm" />;
	return <CircleDashed aria-hidden className="size-4 text-(--sc-text-subtle)" />;
}

/** While a bot made here starts: its steps, until its first chat exists and its first message went out. */
function BotFirstScreen({ bot }: { bot: Bot }) {
	const t = useT();
	const launch = useBotLaunch(s => s.launches[bot.id]);
	if (!launch || (bot.home && launch.first !== "failed" && launch.first !== "running")) return null;
	const steps: { label: string; step: LaunchStep }[] = [
		{ label: t("bots.first.create"), step: "done" },
		{ label: t("bots.first.start"), step: launch.start },
		...(launch.first === "skipped" ? [] : [{ label: t("bots.first.message"), step: launch.first }]),
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
			{launch.error && <p className="text-sc-xs text-(--sc-danger)">{launch.error}</p>}
			{launch.first === "failed" && launch.tabId && launch.kickoff && (
				<Button
					className="self-start"
					icon={<RotateCcw />}
					onClick={() => {
						if (launch.tabId && launch.kickoff) void sendKickoff(bot.id, launch.tabId, launch.kickoff);
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
	kind: AskKind | "item";
	title: string;
	detail: string;
	open: () => void;
}

function NeedsYou({ bot }: { bot: Bot }) {
	const t = useT();
	const items = useBotsStore(s => s.state.items);
	const tabs = useTabsStore(s => s.tabs);
	const summaries = useHostedSessionsStore(s => s.summaries);
	const [all, setAll] = useState(false);
	const chats = [bot.home, ...bot.sessions.filter(session => session !== bot.home)].filter(
		(session): session is string => Boolean(session),
	);
	const asks: NeedRow[] = chats.flatMap(session => {
		const tab = tabs.find(entry => entry.sessionPath === session && !entry.device);
		const run = sessionRun(tabSummary({ summaries }, tab ?? { id: "", sessionPath: session }), tab?.unreadDone);
		if (!run.ask) return [];
		const title = session === bot.home ? t("bots.chats.home") : (tab?.title ?? t("bots.chats.untitled"));
		return [
			{
				key: session,
				kind: run.ask,
				title,
				detail: run.ask === "approval" ? t("bots.needs.approval") : t("bots.needs.question"),
				open: () => void openBotChat(bot, session).catch(() => {}),
			},
		];
	});
	const rows: NeedRow[] = [
		...asks.toSorted((a, b) => Number(b.kind === "approval") - Number(a.kind === "approval")),
		...itemsNeedingYou(
			items.filter(item => item.bot === bot.id),
			null,
			Date.now(),
		).map(
			(item): NeedRow => ({
				key: item.id,
				kind: "item",
				title: item.title,
				detail: item.question?.text ?? t("bots.needs.item"),
				open: () => showItem(bot, item),
			}),
		),
	];
	// Approvals never fold away (Orca's BotNeedsYouSection).
	const approvals = rows.filter(row => row.kind === "approval").length;
	const shown = all ? rows : rows.slice(0, Math.max(ROWS, approvals));
	return (
		<section aria-label={t("bots.needs.title")} className="flex flex-col gap-1" data-bot-needs-you>
			<SectionLabel count={rows.length}>{t("bots.needs.title")}</SectionLabel>
			{rows.length === 0 ? (
				<EmptyState size="row" title={t("bots.needs.none")} />
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
				.command({ action: "runNow", id: bot.lookAround })
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
						{bot.lookAround ? t("bots.suggestions.lookNow") : t("bots.suggestions.turnOn")}
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
						data-bot-suggestion={item.id}
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
					data-bot-worker={worker.state}
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

function Automations({ bot }: { bot: Bot }) {
	const t = useT();
	const schedules = useLocalSchedules();
	const [all, setAll] = useState(false);
	const [deleting, setDeleting] = useState<BotAutomation | null>(null);
	const rows = botAutomations(bot, schedules);
	const own = rows.filter(row => row.own);
	const others = rows.filter(row => !row.own);
	const shown = [...own, ...(all ? others : others.slice(0, ROWS))];
	const run = (request: Parameters<typeof window.omp.schedules.command>[0], done?: string) =>
		void window.omp.schedules
			.command(request)
			.then(() => (done ? toast({ variant: "success", message: done }) : undefined))
			.catch((error: unknown) => toastError({ title: t("bots.automations.failed"), error }));
	const label = (row: BotAutomation) =>
		row.own === "lookAround"
			? t("bots.automations.lookAround")
			: row.own === "tidy"
				? t("bots.automations.tidy")
				: row.schedule.name.replace(`${bot.name}: `, "");
	return (
		<section aria-label={t("bots.automations.title")} className="flex flex-col gap-1" data-bot-automations>
			<SectionLabel
				action={
					<IconButton
						icon={<Plus />}
						label={t("bots.automations.new")}
						onClick={() => void openBotChat(bot, bot.home, t("bots.automations.draft")).catch(() => {})}
						size="sm"
					/>
				}
				count={rows.length}
			>
				{t("bots.automations.title")}
			</SectionLabel>
			{rows.length === 0 ? (
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
									onClick={() => run({ action: "runNow", id: row.schedule.id }, t("bots.automations.queued"))}
									size="sm"
								/>
								<IconButton
									icon={<ExternalLink />}
									label={t("bots.automations.open")}
									onClick={() => useUiStore.getState().openSettings("schedules")}
									size="sm"
								/>
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
		</section>
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
	const schedules = useLocalSchedules();
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
