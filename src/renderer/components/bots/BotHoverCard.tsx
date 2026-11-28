/**
 * What hovering a bot's row shows (Orca's `BotHoverDetails.tsx:42-140` and `BotHoverNeedsYou.tsx:76-149`): its face,
 * name and what it is for, its state, its second line, and up to three things that need the person (its chats'
 * questions and approvals as the row counts them, then its items set to Needs you). A `HoverCard`'s content: words only.
 */
import { Inbox, Laptop } from "lucide-react";
import { type Bot, itemsNeedingYou } from "../../../shared/bots";
import { useT } from "../../lib/i18n";
import { listedBotItems, useBotsStore } from "../../stores/bots";
import { BotAvatar } from "./BotAvatar";
import { botLineText } from "./BotLineText";
import type { BotFacts } from "./bot-view";

const SHOWN_ASKS = 3;

export function BotHoverCard({ bot, facts }: { bot: Bot; facts: BotFacts }) {
	const t = useT();
	const listed = useBotsStore(s => s.state);
	const asks = itemsNeedingYou(listedBotItems(listed, bot.device, bot.id), null, Date.now());
	const state = bot.paused ? t("bots.row.paused") : facts.working ? t("bots.hover.working") : t("bots.row.idle");
	return (
		<div className="flex w-72 flex-col gap-2 text-sc-sm" data-bot-hover={bot.id}>
			<div className="flex items-center gap-2.5">
				<BotAvatar bot={bot} size={40} />
				<div className="min-w-0">
					<p className="truncate font-semibold text-(--sc-text)">{bot.name}</p>
					<p className="flex items-center gap-1 text-sc-xs text-(--sc-text-muted)">
						<Laptop aria-hidden className="size-3" />
						{t("bots.hover.here")} · {state}
					</p>
				</div>
			</div>
			{bot.specialty && <p className="line-clamp-3 text-(--sc-text-muted)">{bot.specialty}</p>}
			{facts.line.kind !== "purpose" && (
				<p className="line-clamp-3 text-(--sc-text)">{botLineText(facts.line, bot, t)}</p>
			)}
			{facts.needsYou > 0 && (
				<div className="flex flex-col gap-1 border-t border-(--sc-border-subtle) pt-2">
					<p className="font-medium text-(--sc-attention)">
						{t("bots.hover.needsYou", { count: facts.needsYou })}
					</p>
					{asks.slice(0, SHOWN_ASKS).map(item => (
						<p className="flex items-center gap-1.5 truncate text-sc-xs text-(--sc-text)" key={item.id}>
							<Inbox aria-hidden className="size-3 shrink-0 text-(--sc-text-muted)" />
							<span className="truncate">{item.title}</span>
						</p>
					))}
					{asks.length > SHOWN_ASKS && (
						<p className="text-sc-xs text-(--sc-text-muted)">
							{t("bots.hover.more", { count: asks.length - SHOWN_ASKS })}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
