import { LayoutTemplate } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BOT_PURPOSE_MAX, type BotImportSource } from "../../../shared/bots";
import { useCurrentLang, useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { botTemplateWords } from "../../locales/bot-templates";
import { useBotsStore } from "../../stores/bots";
import { usePairedHosts, useRemoteStore } from "../../stores/remote";
import { Banner, BotFace, Button, Checkbox, FieldLabel, Input, Modal, Select, TextArea } from "../common";
import { ModelValueSelect } from "../settings/ModelValueSelect";
import { createBot, type NewBotDraft, openBotDialog } from "./bot-launch";
import { freeBotName } from "./bot-view";
import { botCreateFailure, botHostRows, failedHostProbe, type HostState } from "./new-bot-hosts";

const NUDGE_DISMISSED_KEY = "omp.bots.importNudgeDismissed";
/** The counter shows from here (Orca's `NewBotPurposeField`). */
const COUNTER_FROM = 160;

export function NewBotDialog({ draft, onClose }: { draft?: Partial<NewBotDraft>; onClose: () => void }) {
	const t = useT();
	const lang = useCurrentLang();
	const formId = useId();
	const [device, setDevice] = useState(
		draft?.importFrom ? undefined : draft?.handOver ? draft.handOver.device : draft?.device,
	);
	const allBots = useBotsStore(s => s.state.bots);
	const bots = allBots.filter(bot => (bot.device ?? undefined) === device);
	const hosts = usePairedHosts();
	const localName = useRemoteStore(s => s.state?.host.name) || t("bots.new.local");
	const disconnected = useRemoteStore(s => s.awaitingReconnectState);
	const [platform, setPlatform] = useState<string>();
	useEffect(() => {
		void window.omp.system
			.info()
			.then(info => setPlatform(info.platform))
			.catch(() => {});
	}, []);
	const origin = draft?.importFrom ? null : draft?.handOver ? (draft.handOver.device ?? null) : undefined;
	const online = JSON.stringify(
		disconnected
			? []
			: [
					"",
					...hosts
						.filter(h => h.state === "online")
						.map(h => h.deviceId)
						.sort(),
				].filter(id => origin === undefined || id === (origin ?? "")),
	);
	const [probe, setProbe] = useState({
		online: "",
		states: new Map<string, HostState>(),
		roots: new Map<string, string>(),
	});
	useEffect(() => {
		let active = true;
		setProbe({ online, states: new Map(), roots: new Map() });
		for (const id of JSON.parse(online) as string[]) {
			const record = (state: HostState, root?: string) => {
				if (active)
					setProbe(prev => ({
						online,
						states: new Map(prev.states).set(id, state),
						roots: root ? new Map(prev.roots).set(id, root) : prev.roots,
					}));
			};
			void window.omp.bots.createFolder("", id || undefined).then(
				result =>
					record(id && result?.peerCreate !== true ? "update" : result?.folder ? "ready" : "busy", result?.folder),
				err => record(failedHostProbe(err)),
			);
		}
		return () => {
			active = false;
		};
	}, [online]);
	const rows = botHostRows(
		{ name: localName, platform },
		hosts,
		probe.online === online ? probe.states : new Map(),
		disconnected,
		origin,
		device,
	);
	const host = rows.find(row => row.device === (device ?? null));
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
		!device &&
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
	const duplicateError = duplicate
		? t("bots.new.error.name", { host: host?.name ?? localName, name: trimmed })
		: undefined;
	const validName = !!trimmed && [...trimmed].length <= 80 && !duplicate;
	const [preview, setPreview] = useState<{ device?: string; name: string; folder: string }>();
	useEffect(() => {
		setPreview(undefined);
		if (host?.state !== "ready" || !validName) return;
		let active = true;
		const timer = setTimeout(() => {
			void window.omp.bots
				.createFolder(trimmed, device)
				.then(({ folder }) => {
					if (active) setPreview({ device, name: trimmed, folder });
				})
				.catch(() => {});
		}, 120);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [device, trimmed, validName, host?.state]);
	const folder =
		host?.state !== "ready"
			? undefined
			: !trimmed
				? probe.roots.get(device ?? "")
				: validName && preview?.device === device && preview?.name === trimmed
					? preview.folder
					: undefined;
	const tooLong = purpose.trim().length > BOT_PURPOSE_MAX;

	const submit = async () => {
		if (busy) return;
		if (!validName) {
			setNameError(duplicateError ?? t("bots.new.nameMissing"));
			nameRef.current?.focus();
			return;
		}
		if (tooLong) {
			purposeRef.current?.focus();
			return;
		}
		if (host?.state !== "ready") return;
		setBusy(true);
		setError(null);
		try {
			await createBot({
				...draft,
				device,
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
			if (device) {
				const { kind, detail } = botCreateFailure(failure);
				const message = t(`bots.new.error.${kind}`, { host: host.name, name: trimmed });
				setError(kind === "refused" || kind === "unconfirmed" ? `${message} ${detail}` : message);
				if (kind === "name") nameRef.current?.focus();
			} else {
				setError(failure instanceof Error ? failure.message : String(failure));
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			description={draft?.handOver ? t("bots.new.forHandOver", { title: draft.handOver.title }) : undefined}
			footer={
				<>
					{!template && !draft?.importFrom && (
						<Button
							className="mr-auto"
							icon={<LayoutTemplate />}
							disabled={busy}
							onClick={() =>
								openBotDialog({
									kind: "templates",
									draft: { ...draft, device, model, name: name || undefined, purpose: purpose || undefined },
								})
							}
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
						disabled={busy || host?.state !== "ready"}
						form={formId}
						loading={busy}
						type="submit"
						variant="primary"
					>
						{busy ? t("bots.new.creatingOn", { host: host?.name ?? device ?? localName }) : t("bots.new.create")}
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
						error={duplicateError ?? nameError ?? undefined}
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
					<Select
						className="truncate"
						label={t("bots.new.computer")}
						disabled={busy || !!draft?.handOver || !!draft?.importFrom}
						value={device ?? ""}
						onChange={event => {
							const next = event.target.value || undefined;
							if (template && name === freeBotName(botTemplateWords(lang, template.template.id).name, bots)) {
								setName(
									freeBotName(
										botTemplateWords(lang, template.template.id).name,
										allBots.filter(bot => (bot.device ?? undefined) === next),
									),
								);
							}
							setDevice(next);
							setModel(null);
							setNameError(null);
							setError(null);
						}}
					>
						{(["ready", "unavailable"] as const).map(group => {
							const choices = rows.filter(row => (row.state === "ready") === (group === "ready"));
							return (
								choices.length > 0 && (
									<optgroup key={group} label={t(`bots.new.group.${group}`)}>
										{choices.map(row => (
											<option
												key={row.device ?? ""}
												value={row.device ?? ""}
												disabled={row.state !== "ready"}
											>
												{[
													row.name,
													row.platform === "darwin"
														? "macOS"
														: row.platform === "win32"
															? "Windows"
															: row.platform === "linux"
																? "Linux"
																: row.platform,
													t(`bots.new.host.${row.reason}`),
												]
													.filter(Boolean)
													.join(" · ")}
											</option>
										))}
									</optgroup>
								)
							);
						})}
					</Select>
					<div className="min-w-0">
						<FieldLabel as="label" htmlFor={`${formId}-model`}>
							{t("bots.new.model")}
						</FieldLabel>
						<ModelValueSelect
							key={device ?? ""}
							device={device ?? null}
							disabled={busy || host?.state !== "ready"}
							id={`${formId}-model`}
							kind="model"
							onCommit={value => setModel(value || null)}
							placeholder={t("bots.new.modelDefault")}
							value={model ?? ""}
						/>
					</div>
				</div>
				{folder && host && (
					<p
						className="min-w-0 wrap-anywhere font-mono text-sc-xs text-(--sc-text-muted)"
						data-new-bot-folder
						title={folder}
					>
						{t("bots.new.folder", { host: host.name, folder })}
					</p>
				)}
				{device && host && !!template?.template.routines.length && (
					<p className="text-sc-xs text-(--sc-text-muted)">
						{t("bots.new.activateRoutines", { host: host.name })}
					</p>
				)}
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
