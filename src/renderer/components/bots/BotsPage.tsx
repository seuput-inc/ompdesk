/**
 * The Bots page (Orca's bots, back by the owner's decision of 25 Nov 2026): the destination the sidebar's Bots row and
 * section open. Its frame only: the bots themselves (their records, homes and needs) come with the bots slice.
 */
import { Bot } from "lucide-react";
import { useT } from "../../lib/i18n";
import { EmptyState, PageLayout } from "../common";

export function BotsPage() {
	const t = useT();
	return (
		<PageLayout description={t("bots.page.description")} title={t("destination.bots")}>
			<div className="flex min-h-64 items-center justify-center" data-bots-page>
				<EmptyState description={t("bots.empty.description")} icon={<Bot />} title={t("bots.empty.title")} />
			</div>
		</PageLayout>
	);
}
