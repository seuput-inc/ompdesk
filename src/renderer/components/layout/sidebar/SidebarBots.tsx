/**
 * The sidebar's Bots section (Orca's bots section above the projects; the owner's decision of 25 Nov 2026): one quiet
 * header like the Chats section's, then the bots' rows (`BotRow`), or one quiet line while there is none. Mounted only
 * while the bots feature is available (`useBotsAvailable`, lib/bots-source.ts); the bots slice hands it its rows.
 */
import { BotMessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../../lib/i18n";

export function SidebarBots({ children }: { children?: ReactNode }) {
	const t = useT();
	return (
		<section aria-label={t("destination.bots")} className="mb-1" data-sidebar-bots>
			<div className="omp-sidebar-head flex items-center gap-1.5 px-2 text-sc-xs font-semibold text-(--sc-text-muted)">
				<BotMessageSquare aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				<span className="min-w-0 flex-1 truncate">{t("destination.bots")}</span>
			</div>
			<div className="space-y-px" data-bot-lane>
				{children ?? <p className="omp-sidebar-empty-line">{t("bots.empty.title")}</p>}
			</div>
		</section>
	);
}
