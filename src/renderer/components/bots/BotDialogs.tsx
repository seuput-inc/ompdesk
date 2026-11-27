/**
 * The one open bot dialog (`useBotDialogs`). One swaps for another in place, never a dialog over a dialog.
 * Mounted with the other on-demand dialogs.
 */

import { useEffect, useState } from "react";
import type { Bot, BotDeletePreview } from "../../../shared/bots";
import { translate, useT } from "../../lib/i18n";
import { useBotsStore } from "../../stores/bots";
import { toastError } from "../../stores/toast";
import { ConfirmDialog } from "../common";
import { BotTemplatesDialog } from "./BotTemplatesDialog";
import { useBotDialogs } from "./bot-launch";
import { HandToBotDialog } from "./HandToBotDialog";
import { ImportBotDialog } from "./ImportBotDialog";
import { NewBotDialog } from "./NewBotDialog";
import { GroupDialog } from "./rooms/GroupDialog";

export function BotDialogs() {
	const dialog = useBotDialogs(s => s.dialog);
	const close = useBotDialogs(s => s.close);
	const rooms = useBotsStore(s => s.state.rooms);
	if (!dialog) return null;
	switch (dialog.kind) {
		case "new":
			return <NewBotDialog draft={dialog.draft} key="new" onClose={close} />;
		case "templates":
			return (
				<BotTemplatesDialog
					initialQuery={dialog.query}
					initialSelected={dialog.selected}
					key="templates"
					onClose={close}
				/>
			);
		case "import":
			return <ImportBotDialog key="import" onClose={close} />;
		case "delete":
			return <DeleteBotDialog bot={dialog.bot} key={dialog.bot.id} onClose={close} onDeleted={dialog.onDeleted} />;
		case "hand":
			return <HandToBotDialog key="hand" onClose={close} tabId={dialog.tabId} title={dialog.title} />;
		case "group":
			return (
				<GroupDialog
					key={`group:${dialog.room ?? ""}`}
					onClose={close}
					room={rooms?.find(room => room.id === dialog.room)}
				/>
			);
	}
}

function DeleteBotDialog({ bot, onClose, onDeleted }: { bot: Bot; onClose: () => void; onDeleted?: () => void }) {
	const t = useT();
	const [expected, setExpected] = useState<BotDeletePreview | null>(null);
	useEffect(() => {
		let open = true;
		void window.omp.bots.deletePreview({ id: bot.id }).then(
			preview => {
				if (open) setExpected(preview);
			},
			error => {
				if (!open) return;
				onClose();
				toastError({ title: translate("bots.delete.previewFailed"), error });
			},
		);
		return () => {
			open = false;
		};
	}, [bot.id, onClose]);
	return (
		<ConfirmDialog
			busy={!expected}
			confirmLabel={t("bots.delete.confirm")}
			message={
				expected ? (
					<div className="space-y-2">
						<p>{t("bots.delete.message")}</p>
						{(["chats", "workers", "kept"] as const).map(kind =>
							expected[kind] > 0 ? (
								<p data-bot-delete-count={kind} key={kind}>
									{t(`bots.delete.${kind}`, { count: expected[kind] })}
								</p>
							) : null,
						)}
						{expected.kept > 0 && <p>{t("bots.delete.keptHint")}</p>}
						<p>{t("bots.delete.folder", { folder: bot.folder })}</p>
					</div>
				) : (
					t("bots.delete.checking")
				)
			}
			onCancel={onClose}
			onConfirm={() => {
				if (!expected) return;
				onClose();
				void useBotsStore
					.getState()
					.command({ action: "delete", id: bot.id, expected })
					.then(onDeleted, error => toastError({ title: t("bots.delete.failed"), error }));
			}}
			open
			title={t("bots.delete.title", { name: bot.name })}
		/>
	);
}
