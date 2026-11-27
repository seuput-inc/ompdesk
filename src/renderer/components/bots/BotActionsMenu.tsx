import { Copy, Download, MoreHorizontal, Pause, Play } from "lucide-react";
import { BOT_PACKAGE_SUFFIX } from "../../../shared/bot-limits";
import type { Bot } from "../../../shared/bots";
import { translate, useT } from "../../lib/i18n";
import { useBotsStore } from "../../stores/bots";
import { toast, toastError } from "../../stores/toast";
import { MenuButton } from "../common";

export function setBotPaused(bot: Bot, paused: boolean): void {
	void useBotsStore
		.getState()
		.command({ action: "update", id: bot.id, paused })
		.catch(error => toastError({ title: translate("bots.pause.failed"), error }));
}

export async function exportBot(bot: Bot): Promise<void> {
	try {
		const name =
			bot.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "") || "bot";
		const file: unknown = await window.omp.system.showSaveDialog(name + BOT_PACKAGE_SUFFIX, [
			{ name: translate("bots.settings.packageType"), extensions: ["json"] },
		]);
		if (typeof file !== "string" || !file) return;
		await window.omp.bots.exportPackage({ id: bot.id, file });
		toast({ variant: "success", message: translate("bots.settings.exported", { file }) });
	} catch (error) {
		toastError({ title: translate("bots.settings.exportFailed"), error });
	}
}

export function BotActionsMenu({ bot }: { bot: Bot }) {
	const t = useT();
	return (
		<MenuButton
			align="end"
			icon={<MoreHorizontal />}
			items={[
				{
					id: "pause",
					icon: bot.paused ? Play : Pause,
					label: t(bot.paused ? "bots.menu.resume" : "bots.menu.pause"),
					onSelect: () => setBotPaused(bot, !bot.paused),
				},
				...(!bot.device
					? [
							{
								id: "export",
								icon: Download,
								label: t("bots.settings.export"),
								onSelect: () => void exportBot(bot),
							},
						]
					: []),
				{
					id: "copy",
					icon: Copy,
					separatorBefore: true,
					label: t("bots.menu.copyPath"),
					onSelect: () =>
						void navigator.clipboard
							.writeText(bot.folder)
							.then(() => toast({ variant: "success", message: t("bots.menu.pathCopied") }))
							.catch(() => {}),
				},
			]}
			label={t("bots.pane.more")}
			size="sm"
		/>
	);
}
