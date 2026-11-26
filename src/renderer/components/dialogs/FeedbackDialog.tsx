/**
 * Feedback dialog: collects a bug/feature report and hands it to GitHub's
 * issue form (prefilled title/body/labels). Nothing is sent in-app — the user
 * reviews and posts on github.com, and diagnostics (environment, recent
 * runtime errors) are opt-in checkboxes with the exact text previewed.
 *
 * A picture (picked, pasted or dropped; one, scaled down past GitHub's 10 MB) cannot ride the issue URL: Continue
 * copies it to the clipboard and the body marks where to paste it. Orca's feedback attaches pictures it uploads to
 * its own server (sidebar/sidebar-feedback/feedback-image-attachments.ts:153, use-feedback-image-drop.ts); OMPdesk
 * sends nothing in-app.
 */

import { ExternalLink, ImagePlus } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { buildIssueUrl, FEEDBACK_KINDS, type FeedbackKind, formatErrorTail } from "../../../shared/feedback";
import type { SystemInfo } from "../../../shared/ipc-types";
import { formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { copyImageBlob, shrinkImage } from "../../lib/image-actions";
import { openExternal } from "../../lib/open-external";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Card, Checkbox, FieldLabel, Input, Modal, SegmentedChoice, SettingInfo, TextArea } from "../common";

const LOG_TAIL_LINES = 20;
/** GitHub's limit for a picture pasted into an issue. */
const PICTURE_MAX_BYTES = 10 * 1024 * 1024;

interface Picture {
	name: string;
	blob: Blob;
	url: string;
	/** The size it came in at, when it was scaled down to fit. */
	shrunkFrom?: number;
}

function firstImage(files: FileList | null | undefined): File | undefined {
	return [...(files ?? [])].find(file => file.type.startsWith("image/"));
}

export function FeedbackDialog() {
	const t = useT();
	const open = useUiStore(state => state.feedbackOpen);
	const prefill = useUiStore(state => state.feedbackPrefill);
	const close = useUiStore(state => state.closeFeedback);

	const [kind, setKind] = useState<FeedbackKind>("bug");
	const kindLabelId = useId();
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [includeEnv, setIncludeEnv] = useState(true);
	const [includeErrors, setIncludeErrors] = useState(true);
	const [info, setInfo] = useState<SystemInfo | null>(null);
	const [errorTail, setErrorTail] = useState<readonly string[]>([]);
	const [picture, setPicture] = useState<Picture | null>(null);
	const [pictureError, setPictureError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => () => (picture ? URL.revokeObjectURL(picture.url) : undefined), [picture]);

	const takePicture = useCallback(
		async (file: File) => {
			setPictureError(null);
			let blob: Blob = file;
			if (file.size > PICTURE_MAX_BYTES) {
				const smaller = await shrinkImage(file, PICTURE_MAX_BYTES).catch(() => null);
				if (!smaller) {
					setPictureError(t("feedback.pictureTooLarge"));
					return;
				}
				blob = smaller;
			}
			setPicture({
				name: file.name || "screenshot.png",
				blob,
				url: URL.createObjectURL(blob),
				...(blob === file ? {} : { shrunkFrom: file.size }),
			});
		},
		[t],
	);
	const onPaste = (event: ClipboardEvent) => {
		const file = firstImage(event.clipboardData.files);
		// A paste that carries text stays the text field's.
		if (!file || event.clipboardData.getData("text/plain")) return;
		event.preventDefault();
		void takePicture(file);
	};
	const onDrop = (event: DragEvent) => {
		const file = firstImage(event.dataTransfer.files);
		if (!file) return;
		event.preventDefault();
		void takePicture(file);
	};

	// Reload diagnostics and reset the draft every time the dialog opens.
	useEffect(() => {
		if (!open) return;
		setTitle(prefill?.title ?? "");
		setDescription(prefill?.description ?? "");
		setKind("bug");
		setIncludeEnv(true);
		setIncludeErrors(true);
		setInfo(null);
		setErrorTail([]);
		setPicture(null);
		setPictureError(null);
		window.omp.system
			.info()
			.then(setInfo)
			.catch(() => {});
		window.omp.runtime
			.logTail(LOG_TAIL_LINES)
			.then(setErrorTail)
			.catch(() => setErrorTail([]));
	}, [open, prefill]);

	const errorPreview = useMemo(() => formatErrorTail(errorTail), [errorTail]);
	const envLine = useMemo(
		() =>
			info
				? t("feedback.envLine", {
						version: info.appVersion,
						platform: info.platform,
						arch: info.arch,
						electron: info.electron,
					})
				: null,
		[info, t],
	);

	const canSubmit = description.trim().length > 0;
	const submit = useCallback(() => {
		if (!canSubmit) return;
		const url = buildIssueUrl({
			kind,
			title: title.trim() || description.trim().split("\n")[0].slice(0, 80),
			description,
			environment: includeEnv ? info : null,
			errors: includeErrors ? errorTail : [],
			prefillError: prefill?.error ?? null,
			picture: picture !== null,
		});
		// Started inside the click, before the browser takes focus.
		if (picture)
			copyImageBlob(picture.blob).catch((error: unknown) => {
				toastError({ title: t("feedback.pictureCopyFailed"), error });
			});
		openExternal(url);
		close();
	}, [canSubmit, kind, title, description, includeEnv, includeErrors, info, errorTail, prefill, picture, close, t]);

	return (
		<Modal
			onClose={close}
			open={open}
			size="lg"
			title={t("feedback.title")}
			footer={
				<>
					<Button onClick={close} size="sm" variant="ghost">
						{t("feedback.cancel")}
					</Button>
					<Button disabled={!canSubmit} icon={<ExternalLink />} onClick={submit} size="sm" variant="primary">
						{t("feedback.submit")}
					</Button>
				</>
			}
		>
			{/* Paste or drop a picture anywhere in the form. */}
			<div className="space-y-4" onDragOver={event => event.preventDefault()} onDrop={onDrop} onPaste={onPaste}>
				<div>
					<FieldLabel as="span" id={kindLabelId}>
						{t("feedback.kind")}
					</FieldLabel>
					<SegmentedChoice
						aria-labelledby={kindLabelId}
						fit="content"
						onChange={setKind}
						optionAttr="data-feedback-kind"
						options={FEEDBACK_KINDS.map(value => ({ value, label: t(`feedback.kind.${value}`) }))}
						value={kind}
					/>
				</div>

				<Input
					label={t("feedback.summary")}
					placeholder={t("feedback.summaryPlaceholder")}
					value={title}
					onChange={event => setTitle(event.target.value)}
					maxLength={120}
				/>

				{prefill?.error && (
					<div>
						<FieldLabel as="span">{t("feedback.capturedError")}</FieldLabel>
						<Card className="max-h-24 overflow-auto" padding="sm" surface="2">
							<pre className="whitespace-pre-wrap break-words font-mono text-sc-xs text-(--sc-danger)">
								{prefill.error}
							</pre>
						</Card>
					</div>
				)}

				<TextArea
					label={t("feedback.description")}
					placeholder={t("feedback.descriptionPlaceholder")}
					value={description}
					onChange={event => setDescription(event.target.value)}
					rows={6}
					required
				/>

				<div data-feedback-picture>
					<FieldLabel as="span">{t("feedback.picture")}</FieldLabel>
					{picture ? (
						<Card className="flex items-center gap-3" padding="sm">
							<img
								alt={picture.name}
								className="h-14 w-20 shrink-0 rounded-(--sc-radius-sm) object-cover"
								src={picture.url}
							/>
							<div className="min-w-0 flex-1 text-sc-xs text-(--sc-text-muted)">
								<div className="truncate text-sc-sm text-(--sc-text)">{picture.name}</div>
								{picture.shrunkFrom
									? t("feedback.pictureShrunk", {
											from: formatBytes(picture.shrunkFrom),
											to: formatBytes(picture.blob.size),
										})
									: formatBytes(picture.blob.size)}
							</div>
							<Button onClick={() => setPicture(null)} size="sm" variant="ghost">
								{t("feedback.pictureRemove")}
							</Button>
						</Card>
					) : (
						<div className="flex flex-wrap items-center gap-2">
							<Button
								icon={<ImagePlus />}
								onClick={() => fileInputRef.current?.click()}
								size="sm"
								variant="secondary"
							>
								{t("feedback.pictureAdd")}
							</Button>
							<span className="text-sc-xs text-(--sc-text-muted)">{t("feedback.pictureDrop")}</span>
						</div>
					)}
					{pictureError && (
						<p className="mt-1 text-sc-xs text-(--sc-danger)" role="alert">
							{pictureError}
						</p>
					)}
					{picture && <p className="mt-1 text-sc-xs text-(--sc-text-muted)">{t("feedback.pictureHint")}</p>}
					<input
						accept="image/*"
						className="hidden"
						onChange={event => {
							const file = firstImage(event.target.files);
							event.target.value = "";
							if (file) void takePicture(file);
						}}
						ref={fileInputRef}
						type="file"
					/>
				</div>

				<Card data-feedback-include className="space-y-2">
					<label className="flex items-start gap-2.5 text-sc-sm text-(--sc-text)">
						<Checkbox
							checked={includeEnv}
							onChange={event => setIncludeEnv(event.target.checked)}
							className="mt-0.5"
						/>
						<span>
							{t("feedback.includeEnv")}
							{includeEnv && envLine && (
								<span className="block font-mono text-sc-xs break-all text-(--sc-text-muted)">{envLine}</span>
							)}
						</span>
					</label>
					<div>
						<div className="flex items-center gap-1.5">
							<label className="flex items-start gap-2.5 text-sc-sm text-(--sc-text)">
								<Checkbox
									checked={includeErrors}
									onChange={event => setIncludeErrors(event.target.checked)}
									className="mt-0.5"
								/>
								<span>{t("feedback.includeErrors")}</span>
							</label>
							<SettingInfo text={t("feedback.includeErrorsInfo")} />
						</div>
						{/* Kept outside the label: clicking the preview to read/select text must not toggle the box. */}
						{includeErrors && (
							<details className="mt-1 ml-6">
								<summary className="cursor-pointer text-sc-sm text-(--sc-text-muted) hover:text-(--sc-text-secondary)">
									{t("feedback.errorsPreview", { count: errorTail.length })}
								</summary>
								<pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-(--sc-radius-md) bg-(--sc-surface-2) p-2 font-mono text-sc-xs text-(--sc-text-muted)">
									{errorPreview || t("feedback.errorsEmpty")}
								</pre>
							</details>
						)}
					</div>
				</Card>

				<p className="text-sc-sm leading-relaxed text-(--sc-text-muted)">{t("feedback.note")}</p>
			</div>
		</Modal>
	);
}
