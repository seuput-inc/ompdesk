/**
 * Under a webhook routine in Settings › Schedules: its URL and key (masked, Reveal and Copy), Copy as curl, Rotate
 * key…, Signing secret… (Orca's WebhookSecretDialog: a sender, then a secret OMPdesk makes or one pasted from the
 * sender; a made one is shown only as a Copy button in that dialog's own state and is gone once it closes), Remove
 * signature, Send test call, and Recent calls (newest first, Orca's verdict words). The URL is the loopback one: a
 * tailnet caller uses Mobile web's link, whose secret prefix this page never shows.
 */
import { Eye, EyeOff, KeyRound, RotateCw, Send, ShieldCheck, Terminal } from "lucide-react";
import { useId, useState } from "react";
import {
	newWebhookSecret,
	type Schedule,
	type SchedulesRequest,
	WEBHOOK_SENDER_NAMES,
	WEBHOOK_SENDERS,
	type WebhookCall,
	type WebhookSender,
	webhookSenderMakesSecret,
	webhookSenderTakesSecret,
} from "../../../../shared/schedules";
import { copyText, formatClock, formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { webhookCallLine, webhookCurl, webhookUrl } from "../../../lib/schedule-text";
import { toast } from "../../../stores/toast";
import {
	Badge,
	type BadgeVariant,
	Button,
	ConfirmDialog,
	CopyButton,
	IconButton,
	Input,
	LinkButton,
	Modal,
	Radio,
	SectionLabel,
	SegmentedChoice,
	Select,
	Tooltip,
} from "../../common";

/** Sends one schedules command; true once it went through (a failure was already said). */
export type ScheduleSend = (request: SchedulesRequest) => Promise<boolean>;

const VERDICT_BADGE: Record<WebhookCall["verdict"], BadgeVariant> = {
	started: "success",
	queued: "info",
	ignored: "muted",
	duplicate: "muted",
	refused: "error",
	off: "warning",
};

export function WebhookPanel({
	schedule,
	calls,
	send,
	onShowRun,
}: {
	schedule: Schedule;
	calls: readonly WebhookCall[];
	send: ScheduleSend;
	/** Shows the run a call started (All runs, its log open). */
	onShowRun: (runId: string) => void;
}) {
	const t = useT();
	const [revealed, setRevealed] = useState(false);
	const [dialog, setDialog] = useState<"rotate" | "secret" | "unsign" | null>(null);
	const { frequency } = schedule;
	if (frequency.kind !== "event" || frequency.event.source !== "webhook") return null;
	const { key, previousKey, signedBy } = frequency.event;
	const url = webhookUrl(schedule.id);
	const oldUntil = previousKey && Date.parse(previousKey.until) > Date.now() ? previousKey.until : null;
	return (
		<div className="flex flex-col gap-2 pb-2 ps-6" data-webhook-panel={schedule.id}>
			<dl className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-sc-sm">
				<dt className="text-(--sc-text-muted)">{t("schedules.webhook.url")}</dt>
				<dd className="min-w-0 truncate font-mono text-(--sc-text)" data-webhook-url>
					{url}
				</dd>
				<dd>
					<CopyButton label={t("schedules.webhook.copyUrl")} text={url} />
				</dd>
				<dt className="text-(--sc-text-muted)">{t("schedules.webhook.key")}</dt>
				<dd className="min-w-0 truncate font-mono text-(--sc-text)" data-webhook-key>
					{revealed ? key : "•".repeat(16)}
				</dd>
				<dd className="flex items-center">
					<IconButton
						icon={revealed ? <EyeOff /> : <Eye />}
						label={revealed ? t("schedules.webhook.hideKey") : t("schedules.webhook.revealKey")}
						onClick={() => setRevealed(value => !value)}
						pressed={revealed}
						size="sm"
					/>
					<CopyButton label={t("schedules.webhook.copyKey")} text={key} />
				</dd>
			</dl>
			{oldUntil && (
				<p className="text-sc-xs text-(--sc-text-muted)" data-webhook-old-key>
					{t("schedules.webhook.oldKeyUntil", { time: formatClock(oldUntil) })}
				</p>
			)}
			{signedBy && (
				<p className="flex items-center gap-1.5 text-sc-xs text-(--sc-text-muted)" data-webhook-signed>
					<ShieldCheck aria-hidden className="size-(--sc-icon-sm)" />
					{t("schedules.webhook.signedBy", { sender: WEBHOOK_SENDER_NAMES[signedBy] })}
					<LinkButton onClick={() => setDialog("unsign")} tone="muted">
						{t("schedules.webhook.unsign")}
					</LinkButton>
				</p>
			)}
			<div className="flex flex-wrap gap-1.5" data-webhook-actions>
				<Button
					icon={<Terminal />}
					onClick={() =>
						void copyText(webhookCurl(schedule.id, key)).then(ok =>
							toast(
								ok
									? { variant: "success", message: t("schedules.webhook.curlCopied") }
									: { variant: "error", message: t("common.copyFailed") },
							),
						)
					}
					size="sm"
					variant="ghost"
				>
					{t("schedules.webhook.copyCurl")}
				</Button>
				<Button icon={<RotateCw />} onClick={() => setDialog("rotate")} size="sm" variant="ghost">
					{t("schedules.webhook.rotate")}
				</Button>
				<Button icon={<KeyRound />} onClick={() => setDialog("secret")} size="sm" variant="ghost">
					{t("schedules.webhook.secret")}
				</Button>
				<Button
					data-webhook-sample
					icon={<Send />}
					onClick={() => void send({ action: "sampleCall", id: schedule.id })}
					size="sm"
					variant="ghost"
				>
					{t("schedules.webhook.sample")}
				</Button>
			</div>
			<SectionLabel as="h4">{t("schedules.webhook.calls")}</SectionLabel>
			{calls.length === 0 ? (
				<p className="text-sc-xs text-(--sc-text-muted)">{t("schedules.webhook.noCalls")}</p>
			) : (
				<ul className="flex flex-col gap-1" data-webhook-calls>
					{calls.map(call => {
						const line = webhookCallLine(call);
						return (
							<li
								className="flex min-w-0 items-center gap-1.5 text-sc-xs"
								data-webhook-call={call.verdict}
								key={call.id}
							>
								<Badge size="xs" variant={VERDICT_BADGE[call.verdict]}>
									{line.label}
								</Badge>
								{call.verdict === "started" && call.run ? (
									<LinkButton onClick={() => onShowRun(call.run as string)} tone="muted">
										{t("schedules.call.viewRun")}
									</LinkButton>
								) : (
									line.detail && <span className="min-w-0 truncate text-(--sc-text-muted)">{line.detail}</span>
								)}
								{call.sample && (
									<Badge size="xs" variant="muted">
										{t("schedules.call.sample")}
									</Badge>
								)}
								<Tooltip content={formatClock(call.at)}>
									<span className="ms-auto shrink-0 text-(--sc-text-muted)" tabIndex={0}>
										{formatTimeAgo(call.at)}
									</span>
								</Tooltip>
							</li>
						);
					})}
				</ul>
			)}
			<RotateKeyDialog
				onClose={() => setDialog(null)}
				onRotate={keepOld => {
					setDialog(null);
					void send({ action: "rotateKey", id: schedule.id, keepOld });
				}}
				open={dialog === "rotate"}
			/>
			{/* Mounted per opening: a secret never outlives the dialog. */}
			{dialog === "secret" && (
				<SecretDialog onClose={() => setDialog(null)} schedule={schedule} sender={signedBy} send={send} />
			)}
			<ConfirmDialog
				confirmLabel={t("schedules.webhook.unsign")}
				message={t("schedules.webhook.unsignMessage", { name: schedule.name })}
				onCancel={() => setDialog(null)}
				onConfirm={() => {
					setDialog(null);
					void send({ action: "setSecret", id: schedule.id, sender: null });
				}}
				open={dialog === "unsign"}
				title={t("schedules.webhook.unsignTitle")}
			/>
		</div>
	);
}

function RotateKeyDialog({
	open,
	onClose,
	onRotate,
}: {
	open: boolean;
	onClose: () => void;
	onRotate: (keepOld: boolean) => void;
}) {
	const t = useT();
	const name = useId();
	const [keepOld, setKeepOld] = useState(true);
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button data-webhook-rotate-confirm onClick={() => onRotate(keepOld)} variant="primary">
						{t("schedules.webhook.rotateConfirm")}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="sm"
			title={t("schedules.webhook.rotateTitle")}
		>
			<fieldset className="flex flex-col gap-2">
				<legend className="sr-only">{t("schedules.webhook.rotateTitle")}</legend>
				<label className="flex items-start gap-2 text-sc-md text-(--sc-text)">
					<Radio checked={keepOld} name={name} onChange={() => setKeepOld(true)} value="keep" />
					{t("schedules.webhook.rotateKeep")}
				</label>
				<label className="flex items-start gap-2 text-sc-md text-(--sc-text)">
					<Radio checked={!keepOld} name={name} onChange={() => setKeepOld(false)} value="drop" />
					{t("schedules.webhook.rotateDrop")}
				</label>
			</fieldset>
		</Modal>
	);
}

function SecretDialog({
	schedule,
	sender: current,
	send,
	onClose,
}: {
	schedule: Schedule;
	sender: WebhookSender | undefined;
	send: ScheduleSend;
	onClose: () => void;
}) {
	const t = useT();
	const formId = useId();
	const [sender, setSender] = useState<WebhookSender>(current ?? "standard");
	const [mode, setMode] = useState<"generate" | "paste">("generate");
	const [pasted, setPasted] = useState("");
	const [saving, setSaving] = useState(false);
	// A made secret is only ever a Copy button here, and goes when this dialog unmounts.
	const [made, setMade] = useState<string | null>(null);
	const choosesMode = webhookSenderMakesSecret(sender) && webhookSenderTakesSecret(sender);
	const generates = webhookSenderMakesSecret(sender) && (!choosesMode || mode === "generate");
	const name = WEBHOOK_SENDER_NAMES[sender];

	const save = async () => {
		const secret = generates ? newWebhookSecret(sender, bytes => crypto.getRandomValues(bytes)) : pasted.trim();
		setSaving(true);
		const ok = await send({ action: "setSecret", id: schedule.id, sender, secret });
		setSaving(false);
		if (!ok) return;
		if (generates) setMade(secret);
		else onClose();
	};

	if (made !== null) {
		return (
			<Modal
				footer={
					<>
						<Button onClick={onClose} variant="ghost">
							{t("schedules.secret.done")}
						</Button>
						<Button
							data-webhook-secret-copy
							onClick={() =>
								void copyText(made).then(ok =>
									toast(
										ok
											? { variant: "success", message: t("schedules.secret.copied") }
											: { variant: "error", message: t("common.copyFailed") },
									),
								)
							}
							variant="primary"
						>
							{t("schedules.secret.copy")}
						</Button>
					</>
				}
				onClose={onClose}
				open
				size="sm"
				title={t("schedules.secret.madeTitle")}
			>
				<p className="text-sc-md text-(--sc-text)">{t("schedules.secret.madeNote", { sender: name })}</p>
			</Modal>
		);
	}

	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={!generates && !pasted.trim()}
						form={formId}
						loading={saving}
						type="submit"
						variant="primary"
					>
						{generates ? t("schedules.secret.generate") : t("schedules.save")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="sm"
			title={current ? t("schedules.secret.changeTitle") : t("schedules.secret.addTitle")}
		>
			<form
				className="flex flex-col gap-3"
				data-webhook-secret-form
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					void save();
				}}
			>
				<p className="text-sc-sm text-(--sc-text-muted)">{t("schedules.secret.note", { name: schedule.name })}</p>
				<Select
					label={t("schedules.secret.sender")}
					onChange={event => setSender(event.target.value as WebhookSender)}
					options={WEBHOOK_SENDERS.map(value => ({ value, label: WEBHOOK_SENDER_NAMES[value] }))}
					value={sender}
				/>
				{choosesMode && (
					<SegmentedChoice
						aria-label={t("schedules.secret.mode")}
						onChange={setMode}
						optionAttr="data-webhook-secret-mode"
						options={[
							{ value: "generate", label: t("schedules.secret.modeGenerate") },
							{ value: "paste", label: t("schedules.secret.modePaste") },
						]}
						value={mode}
					/>
				)}
				{generates ? (
					<p className="text-sc-xs text-(--sc-text-muted)">
						{t("schedules.secret.generateNote", { sender: name })}
					</p>
				) : (
					<Input
						autoComplete="off"
						label={t("schedules.secret.paste", { sender: name })}
						onChange={event => setPasted(event.target.value)}
						type="password"
						value={pasted}
					/>
				)}
			</form>
		</Modal>
	);
}
