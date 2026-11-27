/**
 * New group, and a group's members (Orca's `BotGroupMembersDialog.tsx:1-408`, `NewBotDialog`'s group path, MIT,
 * re-implemented; FK-B41): a name and the bots it holds, at least one. A bot with no home chat yet joins all the same;
 * the room says so when it asks it. Saving a new group opens its room.
 */
import { useId, useState } from "react";
import { ROOM_NAME_MAX, type Room } from "../../../../shared/bots";
import { useT } from "../../../lib/i18n";
import { useBotsStore } from "../../../stores/bots";
import { Button, Checkbox, Input, Modal } from "../../common";
import { BotAvatar } from "../BotAvatar";
import { BotOwner } from "../BotOwner";
import { openRoomPage } from "../bot-page";

export function GroupDialog({ room, onClose }: { room?: Room; onClose: () => void }) {
	const t = useT();
	const formId = useId();
	const bots = useBotsStore(s => s.state.bots);
	const command = useBotsStore(s => s.command);
	const [name, setName] = useState(room?.name ?? "");
	const [members, setMembers] = useState<readonly string[]>(room?.members ?? []);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ready = name.trim().length > 0 && members.length > 0;
	const submit = async () => {
		if (!ready || busy) return;
		setBusy(true);
		setError(null);
		try {
			if (room) {
				await command({ action: "roomUpdate", id: room.id, name: name.trim(), bots: [...members] });
			} else {
				const state = await command({ action: "roomCreate", name: name.trim(), bots: [...members] });
				const made = state.rooms?.find(entry => entry.name === name.trim());
				if (made) openRoomPage(made.id);
			}
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} type="button" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={!ready}
						disabledReason={members.length === 0 ? t("bots.groups.pickOne") : undefined}
						form={formId}
						loading={busy}
						type="submit"
						variant="primary"
					>
						{room ? t("common.save") : t("bots.groups.create")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="md"
			title={room ? t("bots.groups.membersTitle", { name: room.name }) : t("bots.groups.newTitle")}
		>
			<form
				className="flex flex-col gap-3"
				data-bot-group-dialog
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<p className="text-sc-sm text-(--sc-text-muted)">{t("bots.groups.description")}</p>
				<Input
					label={t("bots.groups.name")}
					maxLength={ROOM_NAME_MAX}
					onChange={event => setName(event.target.value)}
					placeholder={t("bots.groups.namePlaceholder")}
					value={name}
				/>
				<fieldset className="flex flex-col gap-1.5">
					<legend className="mb-1 text-sc-sm font-medium">{t("bots.groups.members")}</legend>
					{bots.map(bot => (
						<label className="flex items-center gap-2" data-bot-group-member={bot.id} key={bot.id}>
							<Checkbox
								checked={members.includes(bot.id)}
								onChange={event =>
									setMembers(
										event.target.checked ? [...members, bot.id] : members.filter(member => member !== bot.id),
									)
								}
							/>
							<BotAvatar bot={bot} size={28} />
							<span className="flex min-w-0 flex-col">
								<span className="flex min-w-0 items-baseline gap-1.5 text-sc-sm text-(--sc-text)">
									<span className="truncate">{bot.name}</span>
									<BotOwner device={bot.device} />
								</span>
								<span className="truncate text-sc-xs text-(--sc-text-muted)">
									{!bot.home ? t("bots.groups.noHome") : (bot.specialty ?? "")}
								</span>
							</span>
						</label>
					))}
				</fieldset>
				{error && (
					<p className="text-sc-sm text-(--sc-danger)" role="alert">
						{error}
					</p>
				)}
			</form>
		</Modal>
	);
}
