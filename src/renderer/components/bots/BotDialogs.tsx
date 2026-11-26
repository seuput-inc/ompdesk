/**
 * The one open bot dialog (`useBotDialogs`): New bot, Templates, Import from another app, Hand to a bot, New group or
 * a group's members. One at a time, so one swaps for another in place, never a dialog over a dialog. Mounted with the
 * other on-demand dialogs.
 */

import { useBotsStore } from "../../stores/bots";
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
