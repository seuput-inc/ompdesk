/**
 * The words Settings shows for one stock setting (an `orderedSettings()` entry of config/all-settings): label,
 * description, tab, group and options, with stock's fallbacks (no `ui.label` reads as the id, no `ui.options` as the
 * enum values). No omp imports: settings.ts builds the live schema with it and scripts/omp-bump/stock-facts.ts reads
 * a stock tree's words with it, so the Korean completeness check sees exactly the text the GUI shows.
 */
import { asRecord } from "./params";

/** The part of a stock setting the words come from. */
export interface StockSettingWords {
	id: string;
	enumValues?: readonly string[];
	ui?: Record<string, unknown>;
}

export interface SettingOption {
	value: string;
	label: string;
	description?: string;
}

export interface SettingText {
	label: string;
	description: string | undefined;
	tab: string | undefined;
	group: string | undefined;
	options: SettingOption[] | undefined;
}

function settingOptions(setting: StockSettingWords): SettingOption[] | undefined {
	const uiOptions = setting.ui?.options;
	if (Array.isArray(uiOptions)) {
		return uiOptions.map(raw => {
			const option = asRecord(raw);
			return {
				value: String(option.value),
				label: String(option.label ?? option.value),
				...(typeof option.description === "string" ? { description: option.description } : {}),
			};
		});
	}
	return setting.enumValues?.map(value => ({ value, label: value }));
}

export function settingText(setting: StockSettingWords): SettingText {
	const ui = setting.ui;
	return {
		label: typeof ui?.label === "string" ? ui.label : setting.id,
		description: typeof ui?.description === "string" ? ui.description : undefined,
		tab: typeof ui?.tab === "string" ? ui.tab : undefined,
		group: typeof ui?.group === "string" ? ui.group : undefined,
		options: settingOptions(setting),
	};
}
