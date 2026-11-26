/**
 * New bot (Orca's `NewBotDialog.tsx:300-436`, `NewBotPurposeField.tsx`, `BotPicturePicker.tsx`): its picture, name,
 * purpose (what it is for, `BOT_PURPOSE_MAX` characters: the create request carries it, and it becomes the first
 * paragraph of its SOUL.md) and model; from a template, the template's skills it keeps. Where it runs is this computer:
 * a bot's folder is on the computer that runs it. ⌘/Ctrl+Enter creates; a picture pasted or dropped anywhere in the
 * dialog is its picture. With nothing typed, "Templates" swaps this dialog for the templates.
 *
 * The first bot on a computer where another app's bots are found offers to bring one over (Orca's `BotImportNudge`).
 */
import { ChevronLeft, ChevronRight, ImageUp, LayoutTemplate, X } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { BOT_PURPOSE_MAX, type BotImportSource } from "../../../shared/bots";
import { useCurrentLang, useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { botTemplateWords } from "../../locales/bot-templates";
import { useBotsStore } from "../../stores/bots";
import { Banner, BotFace, Button, Checkbox, FieldLabel, IconButton, Input, Modal, TextArea } from "../common";
import { ModelValueSelect } from "../settings/ModelValueSelect";
import { BotAvatar } from "./BotAvatar";
import { createBot, type NewBotDraft, openBotDialog } from "./bot-launch";
import { BOT_MASCOT_COUNT, mascotUri, rasterizePicture } from "./bot-mascots";
import { freeBotName } from "./bot-view";

const NUDGE_DISMISSED_KEY = "omp.bots.importNudgeDismissed";
/** The counter shows from here (Orca's `NewBotPurposeField`). */
const COUNTER_FROM = 160;

export function NewBotDialog({ draft, onClose }: { draft?: Partial<NewBotDraft>; onClose: () => void }) {
	const t = useT();
	const lang = useCurrentLang();
	const formId = useId();
	const bots = useBotsStore(s => s.state.bots);
	const template = draft?.template;
	const [name, setName] = useState(
		() => draft?.name ?? (template ? freeBotName(botTemplateWords(lang, template.template.id).name, bots) : ""),
	);
	const [purpose, setPurpose] = useState(draft?.purpose ?? template?.line ?? "");
	const [model, setModel] = useState<string | null>(draft?.model ?? null);
	// A face from the carousel (its index), an uploaded picture, or its own drawn face (-1), which it gets from its id
	// once made: until then the dialog shows that face's shape uncoloured.
	const [face, setFace] = useState(() => (template ? template.template.mascot : -1));
	const [upload, setUpload] = useState<string | null>(draft?.picture ?? null);
	const [skills, setSkills] = useState<readonly string[]>(template?.template.skills ?? []);
	const [error, setError] = useState<string | null>(null);
	const [nameError, setNameError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [sources, setSources] = useState<BotImportSource[]>([]);
	const fileRef = useRef<HTMLInputElement>(null);

	// Only for the first bot here, and until the person says not again.
	const nudge =
		bots.length === 0 && !draft?.importFrom && !template && localStorage.getItem(NUDGE_DISMISSED_KEY) !== "1";
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

	const picture = upload ?? (face >= 0 ? mascotUri(face) : undefined);
	const typed = name.trim().length > 0 || purpose.trim().length > 0;
	const tooLong = purpose.trim().length > BOT_PURPOSE_MAX;

	const takePicture = async (file: File | undefined | null) => {
		if (!file?.type.startsWith("image/")) return;
		try {
			setUpload(await rasterizePicture(file));
		} catch {
			setError(t("bots.picture.unreadable"));
		}
	};

	const submit = async () => {
		if (busy) return;
		if (!name.trim()) {
			setNameError(t("bots.new.nameMissing"));
			return;
		}
		if (tooLong) return;
		setBusy(true);
		setError(null);
		try {
			const saved = picture ? await rasterizePicture(picture).catch(() => undefined) : undefined;
			await createBot({
				...draft,
				name,
				purpose,
				model,
				...(saved ? { picture: saved } : {}),
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
					{!template && !typed && !draft?.importFrom && (
						<Button
							className="mr-auto"
							icon={<LayoutTemplate />}
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
					<Button
						data-new-bot-create
						disabled={tooLong}
						form={formId}
						loading={busy}
						type="submit"
						variant="primary"
					>
						{t("bots.new.create")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="md"
			title={t("bots.new.title")}
		>
			<form
				className="flex flex-col gap-4"
				data-new-bot
				id={formId}
				onDragOver={(event: DragEvent) => event.preventDefault()}
				onDrop={(event: DragEvent) => {
					event.preventDefault();
					void takePicture(event.dataTransfer.files[0]);
				}}
				onKeyDown={event => {
					if (isImeKeyEvent(event)) return;
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						void submit();
					}
				}}
				onPaste={(event: ClipboardEvent) => {
					const file = [...event.clipboardData.files].find(item => item.type.startsWith("image/"));
					if (!file) return;
					event.preventDefault();
					void takePicture(file);
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
				<div className="flex items-center gap-3">
					<div aria-label={t("bots.picture.label")} className="flex items-center gap-1" role="group">
						<IconButton
							icon={<ChevronLeft />}
							label={t("bots.picture.previous")}
							onClick={() => {
								setUpload(null);
								setFace(current => (current <= 0 ? BOT_MASCOT_COUNT - 1 : current - 1));
							}}
							size="sm"
						/>
						{picture ? (
							<BotAvatar bot={{ name: name || "?", picture }} size={64} />
						) : (
							<BotFace color="var(--sc-text-muted)" seed={formId} size={64} />
						)}
						<IconButton
							icon={<ChevronRight />}
							label={t("bots.picture.next")}
							onClick={() => {
								setUpload(null);
								setFace(current => (current + 1) % BOT_MASCOT_COUNT);
							}}
							size="sm"
						/>
					</div>
					<div className="flex min-w-0 flex-col items-start gap-1">
						<Button
							icon={<ImageUp />}
							onClick={() => fileRef.current?.click()}
							size="sm"
							type="button"
							variant="ghost"
						>
							{t("bots.picture.upload")}
						</Button>
						{(upload || face >= 0) && (
							<Button
								icon={<X />}
								onClick={() => {
									setUpload(null);
									setFace(-1);
								}}
								size="sm"
								type="button"
								variant="ghost"
							>
								{t("bots.picture.none")}
							</Button>
						)}
						<span className="text-sc-xs text-(--sc-text-muted)">{t("bots.picture.hint")}</span>
						<input
							accept="image/png,image/jpeg,image/webp,image/gif"
							aria-hidden
							className="hidden"
							onChange={event => void takePicture(event.target.files?.[0])}
							ref={fileRef}
							tabIndex={-1}
							type="file"
						/>
					</div>
				</div>
				<Input
					autoFocus
					data-dialog-autofocus
					error={nameError ?? undefined}
					label={t("bots.new.name")}
					maxLength={80}
					onChange={event => {
						setName(event.target.value);
						setNameError(null);
					}}
					placeholder={t("bots.new.namePlaceholder")}
					value={name}
				/>
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
					rows={4}
					value={purpose}
				/>
				<div className="flex flex-col gap-1.5">
					<FieldLabel as="label" htmlFor={`${formId}-model`}>
						{t("bots.new.model")}
					</FieldLabel>
					<ModelValueSelect
						id={`${formId}-model`}
						kind="model"
						onCommit={value => setModel(value || null)}
						placeholder={t("bots.new.modelDefault")}
						value={model ?? ""}
					/>
					<span className="text-sc-xs text-(--sc-text-muted)">{t("bots.new.runsHere")}</span>
				</div>
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
