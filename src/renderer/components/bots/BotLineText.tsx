/**
 * A bot's second line in words (`BotLine`, Orca's `BotRowActivityLine.tsx:215-253`): the sidebar row, the bot page's
 * header and the palette say it alike. What waits on the person carries the attention mark.
 */
import { AlertTriangle } from "lucide-react";
import type { Bot } from "../../../shared/bots";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { BotLine } from "./bot-view";

export function botLineText(
	line: BotLine,
	bot: Pick<Bot, "name">,
	t: (key: string, params?: Record<string, string | number>) => string,
): string {
	switch (line.kind) {
		case "paused":
			return t("bots.row.paused");
		case "waiting":
			return `${line.label} · ${line.chat}`;
		case "needsYou":
			return t("bots.row.needsYou", { count: line.count });
		case "working":
			return t("bots.row.working", { chat: line.chat });
		case "failed":
			return t("bots.row.failed", { chat: line.chat });
		case "done":
			return t("bots.row.done", { chat: line.chat });
		case "purpose":
			return line.text;
		case "hello":
			return t("bots.row.hello", { name: bot.name });
		case "idle":
			return t("bots.row.idle");
	}
}

export function BotLineText({ bot, line, className }: { bot: Pick<Bot, "name">; line: BotLine; className?: string }) {
	const t = useT();
	const attention = line.kind === "waiting" || line.kind === "needsYou";
	return (
		<span
			className={cx(
				"flex min-w-0 items-center gap-1 truncate",
				attention ? "text-(--sc-attention)" : line.kind === "failed" ? "text-(--sc-danger)" : undefined,
				className,
			)}
			data-bot-line={line.kind}
		>
			{attention && <AlertTriangle aria-hidden className="size-3 shrink-0" />}
			<span className="min-w-0 truncate">{botLineText(line, bot, t)}</span>
		</span>
	);
}
