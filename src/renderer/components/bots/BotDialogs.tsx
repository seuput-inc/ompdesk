/**
 * The one open bot dialog (`useBotDialogs`). One swaps for another in place, never a dialog over a dialog.
 * Mounted with the other on-demand dialogs.
 */

import { type MouseEvent, useEffect, useRef, useState } from "react";
import type { BotDeletePreview } from "../../../shared/bots";
import { translate, useT } from "../../lib/i18n";
import { useBotsStore } from "../../stores/bots";
import { toastError } from "../../stores/toast";
import { ConfirmDialog } from "../common";
import { BotTemplatesDialog } from "./BotTemplatesDialog";
import { type BotDialog, useBotDialogs } from "./bot-launch";
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
					draft={dialog.draft}
					initialQuery={dialog.query}
					initialSelected={dialog.selected}
					key="templates"
					onClose={close}
				/>
			);
		case "import":
			return <ImportBotDialog key="import" onClose={close} />;
		case "delete":
			return <DeleteBotDialog dialog={dialog} key={dialog.bot.id} onClose={close} />;
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

type DeleteDialog = Extract<BotDialog, { kind: "delete" }>;
type Review = { dialog: DeleteDialog } & (
	| { phase: "ready" | "changed" | "deleting"; preview: BotDeletePreview }
	| { phase: "failed" }
);

function DeleteBotDialog({ dialog, onClose }: { dialog: DeleteDialog; onClose: () => void }) {
	const { bot } = dialog;
	const t = useT();
	const [review, setReview] = useState<Review>();
	const submitted = useRef<Review | undefined>(undefined);
	const warning = useRef<HTMLParagraphElement>(null);
	const current = review?.dialog === dialog ? review : undefined;
	const expected = current && "preview" in current ? current.preview : undefined;
	useEffect(() => {
		let open = true;
		void window.omp.bots.deletePreview({ id: bot.id }).then(
			preview => {
				if (open && useBotDialogs.getState().dialog === dialog) setReview({ dialog, phase: "ready", preview });
			},
			error => {
				if (!open || useBotDialogs.getState().dialog !== dialog) return;
				setReview({ dialog, phase: "failed" });
				toastError({ title: translate("bots.delete.previewFailed"), error });
			},
		);
		return () => {
			open = false;
			submitted.current = undefined;
		};
	}, [bot.id, dialog]);
	useEffect(() => {
		if (current?.phase === "changed") warning.current?.focus();
	}, [current]);

	function confirm(event: MouseEvent<HTMLButtonElement>) {
		if (!current || !expected || submitted.current === current || useBotDialogs.getState().dialog !== dialog) return;
		if (current.phase === "deleting" || event.detail > 1) return;
		submitted.current = current;
		setReview({ dialog, phase: "deleting", preview: expected });
		void useBotsStore
			.getState()
			.command({ action: "delete", id: bot.id, expected })
			.then(
				state => {
					if (submitted.current !== current || useBotDialogs.getState().dialog !== dialog) return;
					if (state.deleteChanged) {
						setReview({ dialog, phase: "changed", preview: state.deleteChanged });
						return;
					}
					onClose();
					dialog.onDeleted?.();
				},
				error => {
					if (submitted.current !== current || useBotDialogs.getState().dialog !== dialog) return;
					setReview({ dialog, phase: "failed" });
					toastError({ title: translate("bots.delete.failed"), error });
				},
			);
	}
	return (
		<ConfirmDialog
			busy={!current || current.phase === "deleting"}
			confirmLabel={t("bots.delete.confirm")}
			message={
				expected ? (
					<div className="space-y-2">
						{current?.phase === "changed" && (
							<p className="font-semibold" ref={warning} tabIndex={-1}>
								{t("bots.delete.changed")}
							</p>
						)}
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
					t(current?.phase === "failed" ? "bots.delete.checkAgain" : "bots.delete.checking")
				)
			}
			onCancel={
				current?.phase === "deleting"
					? null
					: () => {
							if ((!current || submitted.current !== current) && useBotDialogs.getState().dialog === dialog)
								onClose();
						}
			}
			onConfirm={expected ? confirm : undefined}
			open
			title={t("bots.delete.title", { name: bot.name })}
		/>
	);
}
