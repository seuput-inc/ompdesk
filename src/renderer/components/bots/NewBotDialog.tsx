import { LayoutTemplate } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BOT_PURPOSE_MAX, BOTS_FOLDER, type BotImportSource } from "../../../shared/bots";
import { useCurrentLang, useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { botTemplateWords } from "../../locales/bot-templates";
import { useBotsStore } from "../../stores/bots";
import { Banner, BotFace, Button, Checkbox, FieldLabel, Input, Modal, TextArea } from "../common";
import { ModelValueSelect } from "../settings/ModelValueSelect";
import { createBot, type NewBotDraft, openBotDialog } from "./bot-launch";
import { freeBotName } from "./bot-view";

const NUDGE_DISMISSED_KEY = "omp.bots.importNudgeDismissed";
/** The counter shows from here (Orca's `NewBotPurposeField`). */
const COUNTER_FROM = 160;

export function NewBotDialog({ draft, onClose }: { draft?: Partial<NewBotDraft>; onClose: () => void }) {
	const t = useT();
	const lang = useCurrentLang();
	const formId = useId();
	const bots = useBotsStore(s => s.state.bots).filter(bot => !bot.device);
	const localName = t("bots.new.local");
	const nameRef = useRef<HTMLInputElement>(null);
	const purposeRef = useRef<HTMLTextAreaElement>(null);
	const template = draft?.template;
	const [name, setName] = useState(
		() => draft?.name ?? (template ? freeBotName(botTemplateWords(lang, template.template.id).name, bots) : ""),
	);
	const [purpose, setPurpose] = useState(draft?.purpose ?? template?.line ?? "");
	const [model, setModel] = useState<string | null>(draft?.model ?? null);
	const [skills, setSkills] = useState<readonly string[]>(template?.template.skills ?? []);
	const [error, setError] = useState<string | null>(null);
	const [nameError, setNameError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [sources, setSources] = useState<BotImportSource[]>([]);

	// Only for the first bot here, and until the person says not again.
	const nudge =
		!draft?.handOver &&
		bots.length === 0 &&
		!draft?.importFrom &&
		!template &&
		localStorage.getItem(NUDGE_DISMISSED_KEY) !== "1";
	useEffect(() => {
		if (!nudge) return;
		window.omp.bots
			.importSources()
			.then(found => setSources(found.sources))
			.catch(() => {});
	}, [nudge]);
	const nudgeApp = useMemo(() => {
		const app = sources.find(source => source.app === "openclaw")?.app ?? sources[0]?.app;
		return app ? { app, count: sources.filter(source => source.app === app).length } : null;
	}, [sources]);

	const trimmed = name.trim();
	const duplicate = !!trimmed && bots.some(bot => bot.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
	const validName = !!trimmed && [...trimmed].length <= 80 && !duplicate;
	const typed = !!trimmed || !!purpose.trim();
	const tooLong = purpose.trim().length > BOT_PURPOSE_MAX;

	const submit = async () => {
		if (busy) return;
		if (!validName) {
			setNameError(t(duplicate ? "bots.new.nameTaken" : "bots.new.nameMissing"));
			nameRef.current?.focus();
			return;
		}
		if (tooLong) {
			purposeRef.current?.focus();
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await createBot({
				...draft,
				name,
				purpose,
				model,
				...(template
					? {
							template: {
								template: {
									...template.template,
									skills: template.template.skills.filter(id => skills.includes(id)),
								},
								line: template.line,
							},
						}
					: {}),
			});
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			description={draft?.handOver ? t("bots.new.forHandOver", { title: draft.handOver.title }) : undefined}
			footer={
				<>
					{!template && !typed && !draft?.importFrom && !draft?.handOver && (
						<Button
							className="mr-auto"
							icon={<LayoutTemplate />}
							disabled={busy}
							onClick={() => openBotDialog({ kind: "templates" })}
							type="button"
							variant="ghost"
						>
							{t("bots.new.templates")}
						</Button>
					)}
					<Button onClick={onClose} type="button" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button data-new-bot-create disabled={busy} form={formId} loading={busy} type="submit" variant="primary">
						{busy ? t("bots.new.creatingOn", { host: localName }) : t("bots.new.create")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="md"
			title={t("bots.new.title")}
		>
			<form
				className="flex flex-col gap-3"
				data-new-bot
				id={formId}
				onKeyDown={event => {
					if (isImeKeyEvent(event)) return;
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						void submit();
					}
				}}
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				{nudge && nudgeApp && (
					<Banner
						actions={
							<Button onClick={() => openBotDialog({ kind: "import" })} size="sm" variant="secondary">
								{nudgeApp.count > 1 ? t("bots.import.nudgeOne") : t("bots.import.nudgeIt")}
							</Button>
						}
						compact
						data-bot-import-nudge
						dismissLabel={t("bots.import.nudgeDismiss")}
						onDismiss={() => {
							localStorage.setItem(NUDGE_DISMISSED_KEY, "1");
							setSources([]);
						}}
						variant="neutral"
					>
						{t(nudgeApp.count > 1 ? "bots.import.nudgeMany" : "bots.import.nudge", {
							app: t(`bots.import.app.${nudgeApp.app}`),
							count: nudgeApp.count,
						})}
					</Banner>
				)}
				<div className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3">
					<BotFace color="var(--sc-text-muted)" seed={formId} size={40} />
					<Input
						autoFocus
						data-dialog-autofocus
						ref={nameRef}
						error={duplicate ? t("bots.new.nameTaken") : (nameError ?? undefined)}
						label={t("bots.new.name")}
						maxLength={80}
						onChange={event => {
							setName(event.target.value);
							setNameError(null);
						}}
						placeholder={t("bots.new.namePlaceholder")}
						value={name}
					/>
				</div>
				<TextArea
					autoGrow
					error={
						tooLong
							? t("bots.new.purposeTooLong", { count: purpose.trim().length, max: BOT_PURPOSE_MAX })
							: undefined
					}
					hint={
						!tooLong && purpose.length >= COUNTER_FROM && purpose !== (template?.line ?? "")
							? `${purpose.trim().length}/${BOT_PURPOSE_MAX}`
							: undefined
					}
					label={t("bots.new.purpose")}
					onChange={event => setPurpose(event.target.value)}
					placeholder={t("bots.new.purposePlaceholder")}
					ref={purposeRef}
					rows={2}
					value={purpose}
				/>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<div className="min-w-0">
						<FieldLabel as="span">{t("bots.new.computer")}</FieldLabel>
						<p className="text-sc-sm">{localName}</p>
					</div>
					<div className="min-w-0">
						<FieldLabel as="label" htmlFor={`${formId}-model`}>
							{t("bots.new.model")}
						</FieldLabel>
						<ModelValueSelect
							disabled={busy}
							id={`${formId}-model`}
							kind="model"
							onCommit={value => setModel(value || null)}
							placeholder={t("bots.new.modelDefault")}
							value={model ?? ""}
						/>
					</div>
				</div>
				<p className="min-w-0 wrap-anywhere font-mono text-sc-xs text-(--sc-text-muted)" data-new-bot-folder>
					{t("bots.new.folder", { host: localName, folder: `~/${BOTS_FOLDER}` })}
				</p>
				{template && template.template.skills.length > 0 && (
					<fieldset className="flex flex-col gap-1.5">
						<FieldLabel as="legend">{t("bots.new.skills")}</FieldLabel>
						{template.template.skills.map(id => (
							<label className="flex items-center gap-2 text-sc-sm" key={id}>
								<Checkbox
									checked={skills.includes(id)}
									onChange={event =>
										setSkills(current =>
											event.target.checked ? [...current, id] : current.filter(known => known !== id),
										)
									}
								/>
								<span className="font-mono text-sc-xs">{id}</span>
							</label>
						))}
					</fieldset>
				)}
				{error && (
					<p className="text-sc-sm text-(--sc-danger)" role="alert">
						{error}
					</p>
				)}
			</form>
		</Modal>
	);
}
