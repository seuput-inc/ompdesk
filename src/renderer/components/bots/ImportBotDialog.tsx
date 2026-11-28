/**
 * Import from another app (Orca's `ImportBotDialog.tsx`, `ImportBotSourceList.tsx:59-110`, `bot-import.ts:1-129`):
 * the bots of OpenClaw, Hermes and OpenBot found on this computer, or "Another app…", whose bot first saves itself as
 * files (the prompt to paste, copied here) and whose folder the owner then picks. Create makes a new bot whose first
 * turn reads that folder and sets itself up from it: no parser, the bot reads the files. Keys and logins stay behind.
 * "From a bot file" reads an OMPdesk bot package (`sharing/bot-package-archive.ts`, `BOT_PACKAGE_SUFFIX`) and makes
 * the bot it holds at once.
 */
import { ArrowRight, FileUp, FolderOpen, PackageOpen } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { BotImportSource } from "../../../shared/bots";
import { useT } from "../../lib/i18n";
import { useBotsStore } from "../../stores/bots";
import { toast } from "../../stores/toast";
import { Button, CopyButton, Input, Modal, PathText, Radio, Spinner } from "../common";
import { BotAvatar } from "./BotAvatar";
import { type BotImportPick, createBot, IMPORT_EXPORT_PROMPT } from "./bot-launch";
import { freeBotName } from "./bot-view";

const OTHER = "other";

export function ImportBotDialog({ onClose }: { onClose: () => void }) {
	const t = useT();
	const formId = useId();
	const bots = useBotsStore(s => s.state.bots).filter(bot => !bot.device);
	const command = useBotsStore(s => s.command);
	const [sources, setSources] = useState<BotImportSource[] | null>(null);
	const [picked, setPicked] = useState<string | null>(null);
	const [otherFolder, setOtherFolder] = useState("");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		window.omp.bots
			.importSources()
			.then(found => {
				setSources(found.sources);
				const first = found.sources[0];
				if (first) {
					setPicked(first.folder);
					setName(
						freeBotName(
							first.name,
							useBotsStore.getState().state.bots.filter(bot => !bot.device),
						),
					);
				} else setPicked(OTHER);
			})
			.catch(() => {
				setSources([]);
				setPicked(OTHER);
			});
	}, []);

	const source: BotImportPick | null =
		picked === OTHER
			? otherFolder.trim()
				? { app: "other", folder: otherFolder.trim(), name: name.trim() || otherFolder.trim() }
				: null
			: (sources?.find(found => found.folder === picked) ?? null);

	const submit = async () => {
		if (!source || !name.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			await createBot({ name, importFrom: source });
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};

	// A bot package file: the core makes the bot it holds (its name made unique) and the dialog closes.
	const importFile = async () => {
		setError(null);
		try {
			const selectionId = await window.omp.bots.pickPackage(t("bots.settings.packageType"));
			if (!selectionId) return;
			setBusy(true);
			await command({ action: "importPackage", selectionId });
			toast({ variant: "success", message: t("bots.import.fileDone") });
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			description={t("bots.import.description")}
			footer={
				<>
					<Button onClick={onClose} type="button" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={!source || !name.trim()}
						disabledReason={!source ? t("bots.import.pickFirst") : undefined}
						form={formId}
						loading={busy}
						type="submit"
						variant="primary"
					>
						{name.trim() ? t("bots.import.createNamed", { name: name.trim() }) : t("bots.new.create")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="md"
			title={t("bots.import.title")}
		>
			<form
				className="flex flex-col gap-3"
				data-bot-import
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<div aria-hidden className="flex items-center justify-center gap-3 py-1">
					<BotAvatar bot={{ name: source?.name ?? "?" }} size={40} />
					<ArrowRight className="size-4 text-(--sc-text-muted)" />
					<BotAvatar bot={{ name: name || "?" }} size={40} />
				</div>
				<fieldset className="flex flex-col gap-1">
					<legend className="mb-1 text-sc-sm font-medium text-(--sc-text)">
						{sources === null ? (
							<span className="inline-flex items-center gap-2">
								<Spinner size="sm" />
								{t("bots.import.looking")}
							</span>
						) : (
							t("bots.import.found", { count: sources.length })
						)}
					</legend>
					{(sources ?? []).map(found => (
						<label className="flex items-center gap-2" key={found.folder}>
							<Radio
								checked={picked === found.folder}
								name={`${formId}-source`}
								onChange={() => {
									setPicked(found.folder);
									setName(freeBotName(found.name, bots));
								}}
							/>
							<PackageOpen aria-hidden className="size-4 shrink-0 text-(--sc-text-muted)" />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="text-sc-sm text-(--sc-text)">
									{found.name}
									<span className="text-(--sc-text-muted)"> · {t(`bots.import.app.${found.app}`)}</span>
								</span>
								<PathText className="text-sc-xs text-(--sc-text-muted)" path={found.folder} />
							</span>
						</label>
					))}
					<label className="flex items-center gap-2">
						<Radio checked={picked === OTHER} name={`${formId}-source`} onChange={() => setPicked(OTHER)} />
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="text-sc-sm text-(--sc-text)">{t("bots.import.other")}</span>
							<span className="text-sc-xs text-(--sc-text-muted)">{t("bots.import.otherHint")}</span>
						</span>
					</label>
				</fieldset>
				<div className="flex items-center gap-2" data-bot-import-file>
					<span className="min-w-0 flex-1 text-sc-xs text-(--sc-text-muted)">{t("bots.import.fileHint")}</span>
					<Button
						disabled={busy}
						icon={<FileUp />}
						onClick={() => void importFile()}
						size="sm"
						type="button"
						variant="secondary"
					>
						{t("bots.import.file")}
					</Button>
				</div>
				{picked === OTHER && (
					<div className="flex flex-col gap-2 rounded-(--sc-radius-md) border border-(--sc-border-subtle) p-3">
						<p className="text-sc-sm text-(--sc-text)">{t("bots.import.exportStep")}</p>
						<div className="flex items-start gap-2">
							<p className="min-w-0 flex-1 font-mono text-sc-xs text-(--sc-text-muted)">
								{IMPORT_EXPORT_PROMPT}
							</p>
							<CopyButton label={t("bots.import.copyPrompt")} text={IMPORT_EXPORT_PROMPT} />
						</div>
						<div className="flex items-end gap-2">
							<Input
								className="min-w-0 flex-1"
								label={t("bots.import.folder")}
								mono
								onChange={event => setOtherFolder(event.target.value)}
								placeholder="~/Downloads/<name>-export"
								value={otherFolder}
							/>
							<Button
								icon={<FolderOpen />}
								onClick={() => {
									window.omp.system
										.showOpenDialog([], { directory: true })
										.then(paths => {
											const first = Array.isArray(paths) ? paths[0] : undefined;
											if (typeof first === "string") setOtherFolder(first);
										})
										.catch(() => {});
								}}
								type="button"
								variant="secondary"
							>
								{t("bots.import.pickFolder")}
							</Button>
						</div>
					</div>
				)}
				<Input
					label={t("bots.import.name")}
					maxLength={80}
					onChange={event => setName(event.target.value)}
					placeholder={t("bots.import.namePlaceholder")}
					value={name}
				/>
				<p className="text-sc-xs text-(--sc-text-muted)">{t("bots.import.keysStay")}</p>
				{error && (
					<p className="text-sc-sm text-(--sc-danger)" role="alert">
						{error}
					</p>
				)}
			</form>
		</Modal>
	);
}
