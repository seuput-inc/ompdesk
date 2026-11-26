/** A group's faces and one-line preview: what the sidebar's group rows draw, kept apart from the room's view. */
import type { Bot, Room } from "../../../../shared/bots";
import { cx } from "../../../lib/format";
import { BotAvatar } from "../BotAvatar";

/** Up to three members' faces, overlapped (Orca's `BotGroupFaces.tsx:1-79`). */
export function GroupFaces({ bots, size = 20 }: { bots: readonly Bot[]; size?: number }) {
	const shown = bots.slice(0, 3);
	return (
		<span className="flex shrink-0 items-center" data-bot-group-faces>
			{shown.map((bot, index) => (
				<span className={cx(index > 0 && "-ml-1.5")} key={bot.id}>
					<BotAvatar bot={bot} size={size} />
				</span>
			))}
		</span>
	);
}

/** A room's members as bots, in member order. */
export function roomBots(room: Room, bots: readonly Bot[]): Bot[] {
	return room.members.flatMap(id => bots.find(bot => bot.id === id) ?? []);
}

/** A group row's second line: its newest post, who wrote it (Orca's `BotGroupLatestSchema`), or that it has none. */
export function roomPreview(room: Room, bots: readonly Bot[], t: (key: string) => string): string {
	const latest = room.messages.at(-1);
	if (!latest) return t("bots.groups.noPosts");
	const who =
		latest.author === "owner"
			? t("bots.items.activity.you")
			: (bots.find(bot => bot.id === latest.author)?.name ?? latest.name);
	return `${who}: ${latest.text.replace(/\s+/g, " ").slice(0, 120)}`;
}
