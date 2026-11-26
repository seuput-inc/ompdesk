/**
 * Settings › Schedules: prompts main runs as stock `omp -p` in a project folder
 * on a timer while OMPdesk is open (src/main/schedules.ts). Two views: Schedules
 * lists each schedule, found by a search over name, prompt and folder and grouped
 * by project folder, with its trigger, next start and last outcome; a master
 * switch holds them all, each has its own switch, Run now / Stop, Edit and Delete,
 * and a webhook routine opens its URL, key, signature and recent calls. New
 * schedules start blank or from a template. Recent runs show their status, length
 * and captured log. All runs is one table of every kept run. While the focused tab
 * runs on a paired host the section is that host's (SECTION_SCOPE `host`): every
 * read and change goes to its own ScheduleService and its pushes keep it live.
 */
import {
	CalendarClock,
	CalendarPlus,
	ChevronDown,
	ChevronRight,
	LayoutTemplate,
	MoreHorizontal,
	Pencil,
	Play,
	Plus,
	RefreshCw,
	Square,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Schedule, ScheduleDraft, ScheduleRun, SchedulesRequest, SchedulesState } from "../../../shared/schedules";
import { basename, durationBetween, formatClock, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { frequencySummary, RUN_STATUS_BADGE, runUsageText } from "../../lib/schedule-text";
import { useFocusedTabDevice } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { toastError } from "../../stores/toast";
import {
	Badge,
	Banner,
	Button,
	Collapse,
	ConfirmDialog,
	ErrorDetail,
	IconButton,
	MenuButton,
	SearchField,
	SectionLabel,
	SkeletonRows,
	Switch,
	Tabs,
	Tooltip,
} from "../common";
import { openPeer } from "../layout/work-board/open-peer";
import { MailAccounts } from "./MailAccounts";
import { ScheduleDialog, type ScheduleSeed } from "./ScheduleDialog";
import { SettingsRow, SettingsSection } from "./SettingsLayout";
import { RunLog } from "./schedules/RunLog";
import { RunsTable } from "./schedules/RunsTable";
import { SCHEDULE_TEMPLATES } from "./schedules/templates";
import { WebhookPanel } from "./schedules/WebhookPanel";

/** Runs listed before "Show all". */
const RUNS_SHOWN = 20;

/** Schedules whose name, prompt or folder holds `query` (case aside), grouped by folder in their listed order. */
function groupsOf(schedules: readonly Schedule[], query: string): [string, Schedule[]][] {
	const needle = query.trim().toLowerCase();
	const groups = new Map<string, Schedule[]>();
	for (const schedule of schedules) {
		if (needle && ![schedule.name, schedule.prompt, schedule.cwd].some(text => text.toLowerCase().includes(needle)))
			continue;
		groups.set(schedule.cwd, [...(groups.get(schedule.cwd) ?? []), schedule]);
	}
	return [...groups];
}

export function SchedulesSection() {
	const t = useT();
	const cwd = useSessionStore(state => state.cwd);
	// A tab on a paired host shows and edits that host's schedules: they run on the host, in its folders.
	const device = useFocusedTabDevice();
	const [state, setState] = useState<SchedulesState | null>(null);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [editing, setEditing] = useState<{ schedule: Schedule | null; template?: ScheduleSeed } | null>(null);
	const [deleting, setDeleting] = useState<Schedule | null>(null);
	const [openLog, setOpenLog] = useState<string | null>(null);
	const [showAllRuns, setShowAllRuns] = useState(false);
	const [view, setView] = useState<"schedules" | "runs">("schedules");
	const [query, setQuery] = useState("");
	const [openHook, setOpenHook] = useState<string | null>(null);
	const masterId = useId();

	// Main pushes every change (`onState`) and also answers the command that caused it with the state at that moment.
	// A run that ends right after Stop (a wait for memory cancelled, a process that exits at once) pushes "stopped"
	// before a slow reply with "running" arrives: that reply is older than the push, and applying it left the row on
	// "Running 61 ms" for good (nightlies 41622973444, 41817431850, 41921143051). A push seen while a command was in
	// flight stands; the reply then only repeats what it already says.
	const pushes = useRef(0);
	const pushed = useCallback((next: SchedulesState) => {
		pushes.current++;
		setState(next);
	}, []);
	const settle = useCallback(async (reply: Promise<SchedulesState>) => {
		const seen = pushes.current;
		const next = await reply;
		if (pushes.current === seen) setState(next);
	}, []);
	const load = useCallback(async () => {
		setLoadError(null);
		try {
			await settle(window.omp.schedules.command({ action: "get" }, device));
		} catch (error) {
			setLoadError(error);
		}
	}, [device, settle]);
	useEffect(() => {
		// Another machine's schedules never paint over this one's while it loads.
		setState(null);
		setOpenLog(null);
		const unsubscribe =
			device === undefined
				? window.omp.schedules.onState(pushed)
				: window.omp.schedules.onHostState((from, next) => {
						if (from === device) pushed(next);
					});
		void load();
		return unsubscribe;
	}, [load, device, pushed]);

	const send = async (request: SchedulesRequest): Promise<boolean> => {
		try {
			await settle(window.omp.schedules.command(request, device));
			return true;
		} catch (error) {
			toastError({ title: t("schedules.actionFailed"), error });
			return false;
		}
	};
	const save = async (draft: ScheduleDraft) => {
		const id = editing?.schedule?.id;
		await settle(
			window.omp.schedules.command(id ? { action: "save", id, draft } : { action: "save", draft }, device),
		);
		setEditing(null);
	};
	const fromTemplate = (id: (typeof SCHEDULE_TEMPLATES)[number]["id"]) => {
		const template = SCHEDULE_TEMPLATES.find(item => item.id === id);
		if (!template) return;
		setEditing({
			schedule: null,
			template: {
				name: t(`schedules.template.${id}.name`),
				prompt: t(`schedules.template.${id}.prompt`),
				frequency: template.frequency,
			},
		});
	};
	const showRun = (runId: string) => {
		setView("runs");
		setOpenLog(runId);
	};

	if (!state) {
		return (
			<SettingsSection>
				{loadError ? (
					<Banner
						actions={
							<Button icon={<RefreshCw />} onClick={() => void load()} size="sm">
								{t("common.retry")}
							</Button>
						}
						live
						title={t("schedules.loadFailed")}
						variant="danger"
					>
						<ErrorDetail error={loadError} />
					</Banner>
				) : (
					<SkeletonRows label={t("schedules.loading")} widths={[70, 52, 64]} />
				)}
			</SettingsSection>
		);
	}

	const running = new Map(state.runs.filter(run => run.status === "running").map(run => [run.scheduleId, run]));
	const lastRun = (id: string) => state.runs.find(run => run.scheduleId === id && run.status !== "running");
	const names = new Map(state.schedules.map(schedule => [schedule.id, schedule.name]));
	// A running run stays here too (its log, trigger and start); its Stop lives on the schedule's row only.
	const runs = showAllRuns ? state.runs : state.runs.slice(0, RUNS_SHOWN);
	const groups = groupsOf(state.schedules, query);
	const toggleLog = (runId: string) => setOpenLog(current => (current === runId ? null : runId));
	const newButton = (
		<Button
			data-schedule-new
			icon={<Plus />}
			onClick={() => setEditing({ schedule: null })}
			size="sm"
			variant="secondary"
		>
			{t("schedules.new")}
		</Button>
	);
	const templateItems = SCHEDULE_TEMPLATES.map(template => ({
		id: template.id,
		label: t(`schedules.template.${template.id}.name`),
		description: frequencySummary(template.frequency),
		onSelect: () => fromTemplate(template.id),
	}));

	const scheduleRow = (schedule: Schedule) => {
		const active = running.get(schedule.id);
		const last = lastRun(schedule.id);
		const next = state.nextRuns[schedule.id];
		const hook = schedule.frequency.kind === "event" && schedule.frequency.event.source === "webhook";
		const hookOpen = openHook === schedule.id;
		return (
			<li className="flex flex-col" data-schedule={schedule.id} key={schedule.id}>
				<div className="flex items-center gap-2 py-1.5">
					<CalendarClock aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)" />
					<div className="flex min-w-0 flex-1 flex-col">
						<span className="omp-sched-name truncate text-sc-md font-medium text-(--sc-text)">
							{schedule.name}
						</span>
						<span className="omp-sched-meta flex min-w-0 items-center gap-1.5 text-sc-xs text-(--sc-text-muted)">
							{active ? (
								<Badge dot pulse variant="info">
									{t("schedules.status.running")}
								</Badge>
							) : (
								last && (
									<Badge variant={RUN_STATUS_BADGE[last.status]}>{t(`schedules.status.${last.status}`)}</Badge>
								)
							)}
							<span className="omp-sched-detail min-w-0 truncate">
								{frequencySummary(schedule.frequency)}
								{schedule.model ? ` · ${schedule.model}` : ""}
							</span>
							<span className="shrink-0" data-schedule-next>
								{!schedule.enabled
									? t("schedules.nextOff")
									: state.paused
										? t("schedules.nextPaused")
										: next
											? t("schedules.next", { time: formatClock(next) })
											: ""}
							</span>
						</span>
					</div>
					<div className="flex shrink-0 items-center gap-0.5">
						{hook && (
							<IconButton
								aria-expanded={hookOpen}
								data-schedule-webhook-toggle
								icon={hookOpen ? <ChevronDown /> : <ChevronRight />}
								label={t("schedules.webhook.toggle", { name: schedule.name })}
								onClick={() => setOpenHook(hookOpen ? null : schedule.id)}
								size="sm"
							/>
						)}
						{/* Every switch in Settings stands in the right column; this one leads the row's actions. */}
						<Switch
							checked={schedule.enabled}
							className="me-1.5"
							label={t("schedules.enabled", { name: schedule.name })}
							onCheckedChange={enabled => void send({ action: "setEnabled", id: schedule.id, enabled })}
						/>
						{active ? (
							<IconButton
								icon={<Square />}
								label={t("schedules.stop", { name: schedule.name })}
								onClick={() => void send({ action: "stop", runId: active.id })}
								size="sm"
							/>
						) : (
							<IconButton
								data-schedule-run
								icon={<Play />}
								label={t("schedules.runNow", { name: schedule.name })}
								onClick={() => void send({ action: "runNow", id: schedule.id })}
								size="sm"
							/>
						)}
						<MenuButton
							align="end"
							icon={<MoreHorizontal />}
							items={[
								{
									id: "edit",
									label: t("schedules.edit"),
									icon: Pencil,
									onSelect: () => setEditing({ schedule }),
								},
								{
									id: "delete",
									label: t("schedules.delete"),
									icon: Trash2,
									danger: true,
									onSelect: () => setDeleting(schedule),
								},
							]}
							label={t("schedules.menu", { name: schedule.name })}
							size="sm"
						/>
					</div>
				</div>
				{hook && (
					<Collapse open={hookOpen}>
						<WebhookPanel
							calls={state.calls?.[schedule.id] ?? []}
							onShowRun={showRun}
							schedule={schedule}
							send={send}
						/>
					</Collapse>
				)}
			</li>
		);
	};

	return (
		<>
			<Tabs
				activeId={view}
				ariaLabel={t("schedules.view")}
				className="mb-3"
				data-schedules-view
				onChange={id => setView(id === "runs" ? "runs" : "schedules")}
				tabs={[
					{ id: "schedules", label: t("schedules.view.schedules") },
					{ id: "runs", label: t("schedules.view.runs"), badge: state.runs.length || undefined },
				]}
				variant="segmented"
			/>
			{view === "runs" ? (
				<SettingsSection id="settings-schedules-all-runs">
					<RunsTable
						device={device}
						onOpenSession={run => {
							if (run.session)
								void openPeer({ kind: "path", sessionPath: run.session, ...(device ? { device } : {}) });
						}}
						onRunAgain={id => void send({ action: "runNow", id })}
						onToggleLog={toggleLog}
						openLog={openLog}
						runs={state.runs}
						schedules={state.schedules}
					/>
				</SettingsSection>
			) : (
				<>
					{/* No title of its own: the page's heading already reads "Schedules", and a second region of that name beside the
					    page's would break the landmarks' unique names (axe landmark-unique). */}
					<SettingsSection
						actions={
							state.schedules.length > 0 ? (
								<div className="flex items-center gap-1">
									{newButton}
									<MenuButton
										align="end"
										icon={<LayoutTemplate />}
										items={templateItems}
										label={t("schedules.templates")}
										size="sm"
									/>
								</div>
							) : undefined
						}
						id="settings-schedules-list"
					>
						{/* The "only while OMPdesk is open" rule sits behind the master row's info glyph, not as a paragraph. */}
						<SettingsRow
							compactControl
							control={
								<Switch
									checked={!state.paused}
									data-schedules-master
									id={masterId}
									onCheckedChange={checked => void send({ action: "setPaused", paused: !checked })}
								/>
							}
							description={`${t("schedules.note")} ${t("schedules.masterDesc")}`}
							htmlFor={masterId}
							icon={<CalendarClock />}
							label={t("schedules.master")}
							tipOnly
						/>
						{state.schedules.length === 0 ? (
							<>
								<SettingsRow
									compactControl
									control={newButton}
									icon={<CalendarPlus />}
									id="settings-schedules-empty"
									label={<span className="text-(--sc-text-muted)">{t("schedules.empty")}</span>}
								/>
								<div className="flex flex-wrap items-center gap-1.5 py-1" data-schedule-templates>
									<span className="text-sc-xs text-(--sc-text-muted)">{t("schedules.templatesLead")}</span>
									{SCHEDULE_TEMPLATES.map(template => (
										<Button
											data-schedule-template={template.id}
											key={template.id}
											onClick={() => fromTemplate(template.id)}
											size="sm"
											variant="ghost"
										>
											{t(`schedules.template.${template.id}.name`)}
										</Button>
									))}
								</div>
							</>
						) : (
							<div className="flex flex-col gap-2" data-schedule-list>
								<SearchField
									controlSize="sm"
									data-schedule-search
									label={t("schedules.search")}
									onValueChange={setQuery}
									placeholder={t("schedules.search")}
									value={query}
								/>
								{groups.length === 0 ? (
									<p className="py-1 text-sc-sm text-(--sc-text-muted)">{t("schedules.noMatch")}</p>
								) : (
									groups.map(([folder, items]) => (
										<div data-schedule-group={folder} key={folder}>
											<SectionLabel as="h3" count={items.length}>
												<span title={folder}>{basename(folder) || folder}</span>
											</SectionLabel>
											<ul className="flex flex-col divide-y divide-(--sc-divider) border-t border-(--sc-divider)">
												{items.map(scheduleRow)}
											</ul>
										</div>
									))
								)}
							</div>
						)}
					</SettingsSection>

					<MailAccounts device={device} />

					{state.runs.length > 0 && (
						<SettingsSection id="settings-schedules-runs" title={t("schedules.runs")}>
							<ul className="flex flex-col" data-schedule-runs>
								{runs.map(run => (
									<RunRow
										key={run.id}
										name={names.get(run.scheduleId) ?? t("schedules.deletedSchedule")}
										onToggleLog={() => toggleLog(run.id)}
										open={openLog === run.id}
										run={run}
										device={device}
										onResend={device ? undefined : () => void send({ action: "resend", runId: run.id })}
									/>
								))}
							</ul>
							{state.runs.length > RUNS_SHOWN && (
								<Button
									aria-expanded={showAllRuns}
									onClick={() => setShowAllRuns(value => !value)}
									size="sm"
									variant="ghost"
								>
									{showAllRuns
										? t("schedules.runsFewer")
										: t("schedules.runsAll", { count: state.runs.length })}
								</Button>
							)}
						</SettingsSection>
					)}
				</>
			)}

			<ScheduleDialog
				defaultCwd={cwd ?? ""}
				device={device}
				onClose={() => setEditing(null)}
				onSave={save}
				open={editing !== null}
				schedule={editing?.schedule ?? null}
				template={editing?.template ?? null}
			/>
			<ConfirmDialog
				confirmLabel={t("schedules.delete")}
				message={t("schedules.deleteMessage", { name: deleting?.name ?? "" })}
				onCancel={() => setDeleting(null)}
				onConfirm={() => {
					const target = deleting;
					setDeleting(null);
					if (target) void send({ action: "delete", id: target.id });
				}}
				open={deleting !== null}
				title={t("schedules.deleteTitle")}
			/>
		</>
	);
}

function RunRow({
	run,
	name,
	open,
	onToggleLog,
	device,
	onResend,
}: {
	run: ScheduleRun;
	name: string;
	open: boolean;
	onToggleLog: () => void;
	device: string | undefined;
	/** "Send again" for a run that could not start; this computer's own runs only. */
	onResend?: () => void;
}) {
	const t = useT();
	const duration = run.status === "skipped" ? null : durationBetween(run.startedAt, run.endedAt);
	const Chevron = open ? ChevronDown : ChevronRight;
	return (
		<li className="border-b border-(--sc-divider) last:border-b-0" data-schedule-run-row={run.id}>
			<div className="omp-run-head flex min-w-0 items-center gap-2 py-2">
				<Badge variant={RUN_STATUS_BADGE[run.status]}>{t(`schedules.status.${run.status}`)}</Badge>
				{run.repeats && run.repeats > 1 ? (
					<span className="shrink-0 text-sc-xs text-(--sc-text-muted)" data-schedule-run-repeats>
						{t("schedules.repeats", { count: run.repeats })}
					</span>
				) : null}
				<span className="omp-run-name min-w-0 flex-1 truncate text-sc-sm text-(--sc-text)">
					{name}
					{run.trigger !== "schedule" && (
						<span className="text-(--sc-text-muted)"> · {t(`schedules.trigger.${run.trigger}`)}</span>
					)}
				</span>
				<Tooltip content={formatClock(run.startedAt)}>
					<span className="shrink-0 text-sc-xs text-(--sc-text-muted)" tabIndex={0}>
						{formatTimeAgo(run.startedAt)}
						{duration ? ` · ${duration}` : ""}
						{run.usage ? ` · ${runUsageText(run.usage)}` : ""}
					</span>
				</Tooltip>
				{run.notStarted && !run.resentAs && onResend && (
					<Button onClick={onResend} size="sm" variant="ghost">
						{t("schedules.resend")}
					</Button>
				)}
				{run.status !== "skipped" && (
					<Button aria-expanded={open} icon={<Chevron />} onClick={onToggleLog} size="sm" variant="ghost">
						{open ? t("schedules.hideLog") : t("schedules.showLog")}
					</Button>
				)}
			</div>
			{(run.error || (run.status === "failed" && run.exitCode !== null)) && (
				<p className="pb-2 text-sc-xs text-(--sc-text-muted)">
					{run.error ?? t("schedules.exitCode", { code: run.exitCode ?? "" })}
				</p>
			)}
			{run.detail && (
				<p className="pb-2 text-sc-xs whitespace-pre-wrap text-(--sc-text-muted)" data-schedule-run-detail>
					{run.detail}
				</p>
			)}
			{open && <RunLog device={device} run={run} />}
		</li>
	);
}
