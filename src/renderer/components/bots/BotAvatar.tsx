/**
 * A bot's face: its picture (`Bot.picture`), else its name's letter on its hue (`ProjectArtwork`), with one corner mark
 * for an exception only (Orca's `bot-avatar-status-badge.tsx:53-103`, look S7): needs the person, failed or paused. A
 * working bot shows its working mark at the row's end, never here. Decorative: the row says the state in words.
 */
import type { Bot } from "../../../shared/bots";
import { cx } from "../../lib/format";
import { ProjectArtwork, StatusDot, type StatusTone } from "../common";

export type BotMark = "needsYou" | "failed" | "paused" | null;

const MARK_TONE: Record<Exclude<BotMark, null>, StatusTone> = {
	needsYou: "attention",
	failed: "danger",
	paused: "neutral",
};

export function BotAvatar({
	bot,
	size = 32,
	mark = null,
	className,
}: {
	bot: Pick<Bot, "name" | "picture">;
	size?: number;
	mark?: BotMark;
	className?: string;
}) {
	return (
		<span className={cx("relative inline-flex shrink-0", className)} data-bot-avatar>
			<ProjectArtwork name={bot.name} size={size} src={bot.picture ?? null} />
			{mark && (
				<StatusDot
					className="absolute -right-0.5 -bottom-0.5 ring-2 ring-(--omp-sidebar-bg)"
					data-bot-mark={mark}
					decorative
					ring={mark === "paused"}
					size="md"
					tone={MARK_TONE[mark]}
				/>
			)}
		</span>
	);
}
