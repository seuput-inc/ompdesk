import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { MAX_COMMAND_LABEL, MAX_COMMAND_TEXT, type TerminalCommand } from "../../../shared/terminal-commands";
import { useT } from "../../lib/i18n";
import { useTerminalCommandsStore } from "../../stores/terminal-commands";
import { toastError } from "../../stores/toast";
import { Button, Checkbox, EmptyState, IconButton, Input, ListRow, Modal, TextArea } from "../common";

const NEW_DRAFT = { label: "", command: "", everywhere: false };

/**
 * The saved terminal commands (Orca's quick commands, `TerminalQuickCommandDialog.tsx`): each with its project folder or
 * every project, edited and deleted here, saved with a label and the text a terminal runs.
 */
export function TerminalCommandsDialog({
	open,
	onClose,
	folder,
}: {
	open: boolean;
	onClose: () => void;
	/** The tab's folder a new command belongs to; absent (the quick terminal): every project. */
	folder: string | undefined;
}) {
	const t = useT();
	const formId = useId();
	const commands = useTerminalCommandsStore(state => state.commands);
	const [draft, setDraft] = useState<{ id?: string; label: string; command: string; everywhere: boolean }>(NEW_DRAFT);
	useEffect(() => {
		if (open) setDraft({ ...NEW_DRAFT, everywhere: !folder });
	}, [open, folder]);
	const save = async (next: TerminalCommand[]) => {
		try {
			await useTerminalCommandsStore.getState().save(next);
		} catch (error) {
			toastError({ title: t("panel.terminal.commands.saveFailed"), error });
		}
	};
	const submit = async () => {
		const label = draft.label.trim();
		const command = draft.command.trimEnd();
		if (!label || !command.trim()) return;
		const saved: TerminalCommand = {
			id: draft.id ?? crypto.randomUUID(),
			label,
			command,
			...(!draft.everywhere && folder ? { folder } : {}),
		};
		await save(draft.id ? commands.map(item => (item.id === draft.id ? saved : item)) : [...commands, saved]);
		setDraft({ ...NEW_DRAFT, everywhere: !folder });
	};
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} type="button" variant="ghost">
						{t("common.close")}
					</Button>
					<Button
						disabled={!draft.label.trim() || !draft.command.trim()}
						form={formId}
						type="submit"
						variant="primary"
					>
						{draft.id ? t("panel.terminal.commands.update") : t("panel.terminal.commands.add")}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="md"
			title={t("panel.terminal.commands.title")}
		>
			<div className="flex flex-col gap-4">
				{commands.length === 0 ? (
					<EmptyState size="sm" title={t("panel.terminal.commands.empty")} />
				) : (
					<ul aria-label={t("panel.terminal.commands.title")} className="flex flex-col" data-terminal-commands>
						{commands.map(item => (
							<li key={item.id}>
								<ListRow
									actionCount={2}
									actions={
										<>
											<IconButton
												icon={<Pencil />}
												label={t("panel.terminal.commands.edit", { name: item.label })}
												onClick={() =>
													setDraft({
														id: item.id,
														label: item.label,
														command: item.command,
														everywhere: !item.folder,
													})
												}
												size="sm"
											/>
											<IconButton
												icon={<Trash2 />}
												label={t("panel.terminal.commands.delete", { name: item.label })}
												onClick={() => void save(commands.filter(other => other.id !== item.id))}
												size="sm"
											/>
										</>
									}
									description={item.command}
									meta={
										item.folder ? item.folder.split(/[\\/]/).at(-1) : t("panel.terminal.commands.everywhere")
									}
									size="sm"
									title={item.label}
								/>
							</li>
						))}
					</ul>
				)}
				<form
					className="flex flex-col gap-3"
					id={formId}
					onSubmit={event => {
						event.preventDefault();
						void submit();
					}}
				>
					<Input
						label={t("panel.terminal.commands.label")}
						maxLength={MAX_COMMAND_LABEL}
						onChange={event => setDraft(current => ({ ...current, label: event.target.value }))}
						placeholder={t("panel.terminal.commands.labelExample")}
						value={draft.label}
					/>
					<TextArea
						autoGrow
						label={t("panel.terminal.commands.command")}
						maxLength={MAX_COMMAND_TEXT}
						mono
						onChange={event => setDraft(current => ({ ...current, command: event.target.value }))}
						placeholder="bun run dev"
						rows={2}
						value={draft.command}
					/>
					<label className="flex items-center gap-2 text-sc-sm text-(--sc-text-secondary)">
						<Checkbox
							checked={draft.everywhere || !folder}
							disabled={!folder}
							onChange={event => setDraft(current => ({ ...current, everywhere: event.target.checked }))}
						/>
						{t("panel.terminal.commands.everywhereLabel")}
					</label>
				</form>
			</div>
		</Modal>
	);
}
