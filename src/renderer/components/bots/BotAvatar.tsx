/**
 * A bot's permanent id seeds its living face, with one corner mark for an exception only (Orca's
 * `bot-avatar-status-badge.tsx:53-103`, look S7): needs the person, failed or paused. The face acts out the same facts:
 * it waits on the person, droops when its newest chat failed, thinks while one of its chats runs (`working`). A working
 * bot shows its working mark at the row's end, never here. Decorative: the row says the state in words.
 */
import type { Bot } from "../../../shared/bots";
import type { FacePresence } from "../../lib/bot-face";
import { cx } from "../../lib/format";
import { BotFace, StatusDot, type StatusTone } from "../common";

export type BotMark = "needsYou" | "failed" | "paused" | null;

const MARK_TONE: Record<Exclude<BotMark, null>, StatusTone> = {
	needsYou: "attention",
	failed: "danger",
	paused: "neutral",
};

function presenceOf(mark: BotMark, working: boolean): FacePresence {
	if (mark === "paused") return "idle";
	if (mark === "needsYou") return "waiting";
	if (working) return "thinking";
	return mark === "failed" ? "troubled" : "idle";
}

export function BotAvatar({
	bot,
	size = 32,
	mark = null,
	working = false,
	className,
}: {
	bot: Pick<Bot, "name"> & { id?: string };
	size?: number;
	mark?: BotMark;
	/** One of its chats is running. */
	working?: boolean;
	className?: string;
}) {
	return (
		<span className={cx("relative inline-flex shrink-0", className)} data-bot-avatar>
			<BotFace presence={presenceOf(mark, working)} seed={bot.id ?? bot.name} size={size} />
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
