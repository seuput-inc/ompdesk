/**
 * The bots in the command palette (Orca's `bot-palette-source.tsx:59-269` and
 * `templates/bot-template-palette-source.tsx:13-75`; FK-B44, C2-42): each bot is a row of the Bots section (its
 * purpose found too) that opens its home chat; a typed query also finds the templates, each opening the templates
 * on it. Paused bots still list: their home chat opens and says so.
 */
import type { Bot } from "../../../shared/bots";
import type { CommandMenuItem } from "../../lib/command-registry";
import type { Lang } from "../../lib/i18n";
import { botTemplateWords } from "../../locales/bot-templates";
import { openBotDialog, openBotHome } from "./bot-launch";
import { BOT_TEMPLATES } from "./bot-templates";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function botPaletteItems(bots: readonly Bot[], t: Translate): CommandMenuItem[] {
	return bots.map(bot => ({
		name: `bot:${bot.id}`,
		label: bot.name,
		description: bot.paused ? t("bots.row.paused") : (bot.specialty ?? t("bots.palette.openHome")),
		category: "bots",
		aliases: [bot.specialty ?? "", "bot"].filter(Boolean),
		affordance: { kind: "window", open: () => openBotHome(bot) },
	}));
}

/** The templates, for a typed query only (an empty palette stays short). */
export function botTemplatePaletteItems(t: Translate, lang: Lang): CommandMenuItem[] {
	return BOT_TEMPLATES.map(template => ({
		name: `bot-template:${template.id}`,
		label: botTemplateWords(lang, template.id).name,
		description: t("bots.palette.template"),
		category: "bots",
		// English still finds a translated name.
		aliases: [template.id.replaceAll("-", " "), botTemplateWords(lang, template.id).line],
		affordance: { kind: "window", open: () => openBotDialog({ kind: "templates", selected: template.id }) },
	}));
}
