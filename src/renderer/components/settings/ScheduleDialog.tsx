/**
 * Create or edit one scheduled run (Settings › Schedules): name, prompt, project folder, when it runs (an interval, a
 * time of day on chosen weekdays, a cron line, or a webhook call with its "Only when" filters), model, thinking, a
 * fresh worktree per run, --yolo, and whether it starts on. A one-time or other event-triggered schedule (made by an
 * agent) keeps its trigger: the dialog shows it in words and saving sends it back unchanged. A new webhook routine
 * saves an empty key (the core makes it); an edit sends its key back, and the core keeps its signature and old key.
 * Validation is the shared `scheduleDraftProblem`, the same check main applies before saving.
 */
import { FolderOpen } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	SCHEDULE_MAX_INTERVAL,
	SCHEDULE_THINKING_LEVELS,
	type Schedule,
	type ScheduleDraft,
	type ScheduleEvent,
	type ScheduleFrequency,
	type ScheduleThinking,
	scheduleDraftProblem,
} from "../../../shared/schedules";
import { useBotsAvailable } from "../../lib/bots-source";
import { useT } from "../../lib/i18n";
import { frequencySummary, weekdayNames } from "../../lib/schedule-text";
import { pickWorkspaceDirectory } from "../../lib/workspace-dirs";
import { ensureBots, useBotsStore } from "../../stores/bots";
import { Button, Checkbox, FieldLabel, Input, Modal, PathText, Select, SwitchField, TextArea } from "../common";
import { ModelValueSelect } from "./ModelValueSelect";
import { opTakesValues, WebhookFilterFields, type WebhookFilters } from "./schedules/WebhookFilterFields";

type IntervalUnit = "minutes" | "hours";
type TriggerKind = "interval" | "daily" | "cron" | "webhook";

/** What a template or an edited schedule brings into the form. */
export type ScheduleSeed = Pick<ScheduleDraft, "name" | "prompt" | "frequency"> & Partial<ScheduleDraft>;

interface Form {
	name: string;
	prompt: string;
	cwd: string;
	kind: TriggerKind;
	/** A one-time or event trigger the form cannot edit: saved back as it was. */
	fixed: ScheduleFrequency | null;
	every: string;
	unit: IntervalUnit;
	time: string;
	days: number[];
	cron: string;
	/** The webhook's key: empty for a new one (the core makes it), kept on an edit. */
	key: string;
	filters: WebhookFilters;
	model: string;
	thinking: ScheduleThinking | "";
	worktree: boolean;
	autoApprove: boolean;
	enabled: boolean;
	/** The session each start wakes (a bot's home chat, or one an agent set with `target: "self"`); "" = a fresh run. Model, thinking and worktree mean nothing to a wake. */
	wakeSession: string;
}

function formFor(seed: ScheduleSeed | null, cwd: string): Form {
	const frequency = seed?.frequency;
	const minutes = frequency?.kind === "interval" ? frequency.minutes : 60;
	const hours = minutes % 60 === 0;
	const webhook = frequency?.kind === "event" && frequency.event.source === "webhook" ? frequency.event : null;
	return {
		name: seed?.name ?? "",
		prompt: seed?.prompt ?? "",
		cwd: seed?.cwd ?? cwd,
		kind: webhook
			? "webhook"
			: frequency?.kind === "interval" || frequency?.kind === "cron"
				? frequency.kind
				: "daily",
		// A deadline wait on a webhook is an agent's one-time trigger: kept as it is.
		fixed:
			frequency?.kind === "once" || (frequency?.kind === "event" && (!webhook || frequency.by)) ? frequency : null,
		every: String(hours ? minutes / 60 : minutes),
		unit: hours ? "hours" : "minutes",
		time: frequency?.kind === "daily" ? frequency.time : "09:00",
		days: frequency?.kind === "daily" ? frequency.days : [],
		cron: frequency?.kind === "cron" ? frequency.expr : "0 9 * * 1-5",
		key: webhook?.key ?? "",
		filters: {
			where: (webhook?.where ?? []).map(test => ({
				path: test.path,
				op: test.op,
				values: (test.values ?? []).join(", "),
			})),
			contains: webhook?.contains ?? "",
			pick: (webhook?.pick ?? []).join(", "),
		},
		model: seed?.model ?? "",
		thinking: seed?.thinking ?? "",
		worktree: seed?.worktree ?? false,
		autoApprove: seed?.autoApprove ?? false,
		enabled: seed?.enabled ?? true,
		wakeSession: seed?.wakeSession ?? "",
	};
}

function commaList(text: string): string[] {
	return text
		.split(",")
		.map(item => item.trim())
		.filter(Boolean);
}

function webhookEvent(form: Form): ScheduleEvent {
	const where = form.filters.where
		.filter(row => row.path.trim())
		.map(row => ({
			path: row.path.trim(),
			op: row.op,
			...(opTakesValues(row.op) ? { values: commaList(row.values) } : {}),
		}));
	const contains = form.filters.contains.trim();
	const pick = commaList(form.filters.pick);
	return {
		source: "webhook",
		key: form.key,
		...(where.length > 0 ? { where } : {}),
		...(contains ? { contains } : {}),
		...(pick.length > 0 ? { pick } : {}),
	};
}

function frequencyOf(form: Form): ScheduleFrequency {
	if (form.fixed) return form.fixed;
	const every = Number(form.every);
	switch (form.kind) {
		case "interval":
			return { kind: "interval", minutes: form.unit === "hours" ? every * 60 : every };
		case "daily":
			return { kind: "daily", time: form.time, days: form.days.toSorted() };
		case "cron":
			return { kind: "cron", expr: form.cron.trim() };
		case "webhook":
			return { kind: "event", event: webhookEvent(form) };
	}
}

function draftOf(form: Form): ScheduleDraft {
	return {
		name: form.name.trim(),
		prompt: form.prompt,
		cwd: form.cwd,
		frequency: frequencyOf(form),
		model: form.model.trim() || null,
		autoApprove: form.autoApprove,
		enabled: form.enabled,
		...(form.wakeSession
			? { wakeSession: form.wakeSession }
			: { thinking: form.thinking || null, worktree: form.worktree }),
	};
}

/** The draft as the core checks it: a new webhook's empty key is the core's to fill, so it stands in for one here. */
function problemOf(draft: ScheduleDraft) {
	const { frequency } = draft;
	if (frequency.kind === "event" && frequency.event.source === "webhook" && frequency.event.key === "")
		return scheduleDraftProblem({
			...draft,
			frequency: { ...frequency, event: { ...frequency.event, key: "0".repeat(16) } },
		});
	return scheduleDraftProblem(draft);
}

export function ScheduleDialog({
	open,
	schedule,
	template = null,
	defaultCwd,
	device,
	onClose,
	onSave,
}: {
	open: boolean;
	/** The schedule to edit; null creates one. */
	schedule: Schedule | null;
	/** What a new schedule starts from (a template); ignored while editing. */
	template?: ScheduleSeed | null;
	defaultCwd: string;
	/** The paired host the schedule runs on (its folders); absent = this computer. */
	device?: string;
	onClose: () => void;
	/** Resolves once main saved it; a rejection keeps the dialog open with the reason. */
	onSave: (draft: ScheduleDraft) => Promise<void>;
}) {
	const t = useT();
	const formId = useId();
	const seed = schedule ?? template;
	const [form, setForm] = useState<Form>(() => formFor(seed, defaultCwd));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [touched, setTouched] = useState(false);
	// Each opening starts from the schedule it edits (or a template, or a blank one).
	useEffect(() => {
		if (!open) return;
		setForm(formFor(seed, defaultCwd));
		setError(null);
		setTouched(false);
	}, [open, seed, defaultCwd]);

	const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(current => ({ ...current, [key]: value }));
	const draft = draftOf(form);
	const problem = problemOf(draft);
	const days = weekdayNames();
	// A schedule aimed at a bot (Orca's AutomationBotTargetFields, FK-A16): it wakes the bot's home chat in its folder.
	const botsAvailable = useBotsAvailable();
	const bots = useBotsStore(state => state.state.bots).filter(bot => bot.home);
	useEffect(() => {
		if (botsAvailable) ensureBots();
	}, [botsAvailable]);
	// A saved wake cannot become a fresh run again (the core keeps a wake a save leaves out), so it offers no "fresh".
	const botOptions = [
		...(schedule?.wakeSession ? [] : [{ value: "", label: t("schedules.field.runsFresh") }]),
		...bots.map(bot => ({ value: bot.home ?? "", label: t("schedules.field.runsInBot", { name: bot.name }) })),
		...(form.wakeSession && !bots.some(bot => bot.home === form.wakeSession)
			? [{ value: form.wakeSession, label: t("schedules.field.runsInSession") }]
			: []),
	];

	const submit = async () => {
		setTouched(true);
		if (problem) return;
		setSaving(true);
		setError(null);
		try {
			await onSave(draft);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button form={formId} loading={saving} type="submit" variant="primary">
						{schedule ? t("schedules.save") : t("schedules.create")}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="md"
			title={schedule ? t("schedules.dialog.edit") : t("schedules.dialog.new")}
		>
			<form
				className="flex flex-col gap-4"
				data-schedule-form
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<Input
					autoFocus
					error={touched && problem === "name" ? t("schedules.problem.name") : undefined}
					label={t("schedules.field.name")}
					onChange={event => set("name", event.target.value)}
					value={form.name}
				/>
				<TextArea
					error={touched && problem === "prompt" ? t("schedules.problem.prompt") : undefined}
					hint={t("schedules.field.promptHint")}
					label={t("schedules.field.prompt")}
					onChange={event => set("prompt", event.target.value)}
					rows={4}
					value={form.prompt}
				/>
				{botsAvailable && !device && (bots.length > 0 || form.wakeSession) && (
					<Select
						hint={t("schedules.field.runsInHint")}
						label={t("schedules.field.runsIn")}
						onChange={event => {
							const home = event.target.value;
							const bot = bots.find(known => known.home === home);
							setForm(current => ({ ...current, wakeSession: home, ...(bot ? { cwd: bot.folder } : {}) }));
						}}
						options={botOptions}
						value={form.wakeSession}
					/>
				)}
				{/* The folder is a path and a picker button, so the label names their group, never the button. */}
				<div aria-labelledby={`${formId}-cwd-label`} role="group">
					<FieldLabel as="span" id={`${formId}-cwd-label`}>
						{t("schedules.field.project")}
					</FieldLabel>
					<div className="flex min-w-0 items-center gap-2">
						<span className="flex min-w-0 flex-1 text-sc-sm" data-schedule-cwd>
							{form.cwd ? (
								<PathText path={form.cwd} />
							) : (
								<span className="text-(--sc-text-muted)">{t("schedules.field.noFolder")}</span>
							)}
						</span>
						<Button
							icon={<FolderOpen />}
							onClick={async () => {
								const picked = await pickWorkspaceDirectory({ title: t("schedules.field.project"), device });
								if (picked) set("cwd", picked);
							}}
							size="sm"
							variant="secondary"
						>
							{t("schedules.field.chooseFolder")}
						</Button>
					</div>
					{touched && problem === "cwd" && (
						<span className="mt-1.5 block text-sc-sm text-(--sc-danger)" role="alert">
							{t("schedules.problem.cwd")}
						</span>
					)}
				</div>
				<div aria-labelledby={`${formId}-repeat-label`} role="group">
					<FieldLabel as="span" id={`${formId}-repeat-label`}>
						{t("schedules.field.repeat")}
					</FieldLabel>
					{form.fixed ? (
						<div className="flex flex-col gap-0.5" data-schedule-fixed-trigger>
							<span className="text-sc-md text-(--sc-text)">{frequencySummary(form.fixed)}</span>
							<span className="text-sc-xs text-(--sc-text-muted)">{t("schedules.field.triggerFixed")}</span>
						</div>
					) : (
						<div className="flex flex-col gap-2">
							<Select
								aria-label={t("schedules.field.repeat")}
								data-schedule-repeat
								onChange={event => set("kind", event.target.value as TriggerKind)}
								options={[
									{ value: "daily", label: t("schedules.repeat.daily") },
									{ value: "interval", label: t("schedules.repeat.interval") },
									{ value: "cron", label: t("schedules.repeat.cron") },
									{ value: "webhook", label: t("schedules.repeat.webhook") },
								]}
								value={form.kind}
							/>
							{form.kind === "webhook" ? (
								<>
									{!form.key && (
										<p className="text-sc-xs text-(--sc-text-muted)">{t("schedules.field.webhookHint")}</p>
									)}
									<WebhookFilterFields
										error={touched && problem === "event" ? t("schedules.problem.webhook") : undefined}
										filters={form.filters}
										idPrefix={formId}
										onChange={filters => set("filters", filters)}
									/>
								</>
							) : form.kind === "cron" ? (
								<Input
									data-schedule-cron
									error={touched && problem === "cron" ? t("schedules.problem.cron") : undefined}
									hint={t("schedules.field.cronHint")}
									label={t("schedules.field.cron")}
									mono
									onChange={event => set("cron", event.target.value)}
									placeholder="0 9 * * 1-5"
									value={form.cron}
								/>
							) : form.kind === "interval" ? (
								<div className="flex items-end gap-2">
									<Input
										className="w-24"
										error={touched && problem === "interval" ? t("schedules.problem.interval") : undefined}
										inputMode="numeric"
										label={t("schedules.field.every")}
										max={form.unit === "hours" ? SCHEDULE_MAX_INTERVAL / 60 : SCHEDULE_MAX_INTERVAL}
										min={1}
										onChange={event => set("every", event.target.value)}
										type="number"
										value={form.every}
									/>
									<Select
										aria-label={t("schedules.field.every")}
										onChange={event => set("unit", event.target.value === "hours" ? "hours" : "minutes")}
										options={[
											{ value: "minutes", label: t("schedules.unit.minutes") },
											{ value: "hours", label: t("schedules.unit.hours") },
										]}
										value={form.unit}
									/>
								</div>
							) : (
								<div className="flex flex-col gap-2">
									<Input
										className="w-32"
										error={touched && problem === "time" ? t("schedules.problem.time") : undefined}
										label={t("schedules.field.time")}
										onChange={event => set("time", event.target.value)}
										type="time"
										value={form.time}
									/>
									<fieldset className="flex flex-col gap-1.5">
										<legend className="mb-1.5 text-sc-sm font-medium text-(--sc-text-secondary)">
											{t("schedules.field.days")}
										</legend>
										<div className="flex flex-wrap gap-1">
											{days.map((label, day) => {
												const on = form.days.includes(day);
												return (
													<Button
														aria-pressed={on}
														data-schedule-day={day}
														key={label}
														onClick={() =>
															set(
																"days",
																on ? form.days.filter(item => item !== day) : [...form.days, day],
															)
														}
														size="sm"
														variant={on ? "secondary" : "ghost"}
													>
														{label}
													</Button>
												);
											})}
										</div>
										<p className="text-sc-xs text-(--sc-text-muted)">{t("schedules.field.daysHint")}</p>
									</fieldset>
								</div>
							)}
						</div>
					)}
				</div>
				<div>
					<FieldLabel htmlFor={`${formId}-model`}>{t("schedules.field.model")}</FieldLabel>
					<ModelValueSelect
						id={`${formId}-model`}
						kind="model"
						onCommit={value => set("model", value)}
						placeholder={t("schedules.field.modelHint")}
						value={form.model}
					/>
				</div>
				{!form.wakeSession && (
					<>
						<Select
							label={t("schedules.field.thinking")}
							onChange={event => set("thinking", event.target.value as ScheduleThinking | "")}
							options={[
								{ value: "", label: t("schedules.field.thinkingDefault") },
								...SCHEDULE_THINKING_LEVELS.map(level => ({
									value: level,
									label: t(`input.thinking.name.${level}`),
								})),
							]}
							value={form.thinking}
						/>
						<label className="flex items-center gap-2 text-sc-md text-(--sc-text)">
							<Checkbox
								checked={form.worktree}
								data-schedule-worktree
								onChange={event => set("worktree", event.target.checked)}
							/>
							{t("schedules.field.worktree")}
						</label>
					</>
				)}
				<SwitchField
					checked={form.autoApprove}
					description={t("schedules.field.autoApproveDesc")}
					label={t("schedules.field.autoApprove")}
					onCheckedChange={checked => set("autoApprove", checked)}
				/>
				<SwitchField
					checked={form.enabled}
					label={t("schedules.field.enabled")}
					onCheckedChange={checked => set("enabled", checked)}
				/>
				{error && (
					<p className="text-sc-sm text-(--sc-danger)" role="alert">
						{error}
					</p>
				)}
			</form>
		</Modal>
	);
}
