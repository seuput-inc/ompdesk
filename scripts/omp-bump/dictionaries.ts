/**
 * The dictionaries OMPdesk keeps for stock omp items, held against what an omp says it has (`StockFacts`). One table:
 * each dictionary names the keys stock needs from it, the keys OMPdesk lists, and whether a missing key fails
 * (`required`). The completeness tests (schema-ko-stock.test.ts, provider-marks.test.tsx) assert the required
 * dictionaries' `missing` on the installed omp, and `bun scripts/omp-bump/extract.ts --check` fails on the same set
 * for any omp, so the two never disagree.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HIDDEN_ROLES, ROLE_ORDER } from "../../resources/gui-bridge/model-role-contracts";
import { VISUALS_TEMPLATE_VARIABLES } from "../../resources/gui-bridge/modes/visuals-core";
import { OMPDESK_ROLES } from "../../resources/gui-bridge/ompdesk-role-contracts";
import {
	FALLBACK_PROVIDER_IDS,
	PROVIDER_BRANDS,
} from "../../src/renderer/components/settings/providers/provider-marks";
import { KO_ROLE_NAMES, modelRoleName } from "../../src/renderer/components/settings/schema-i18n";
import { KO_GROUP_TITLES, KO_SETTINGS } from "../../src/renderer/components/settings/schema-ko";
import { KO_SCHEMA_OPTION_TEXT } from "../../src/renderer/components/settings/schema-option-ko";
import { isSettingSupportedInGui } from "../../src/renderer/components/settings/settings-schema-utils";
import { en } from "../../src/renderer/locales/en";
import { ko } from "../../src/renderer/locales/ko";
import type { StockFacts, StockSettingFacts } from "./stock-facts";

/** The global Bun install of omp, which the completeness tests and CI read. */
export const INSTALLED_OMP_ROOT = path.join(
	homedir(),
	".bun",
	"install",
	"global",
	"node_modules",
	"@oh-my-pi",
	"pi-coding-agent",
);

/** The facts of the omp package at `root`, read by Bun in a child process (stock's modules do not load in Node). */
export function readStockFacts(root: string): StockFacts {
	const script = fileURLToPath(new URL("./stock-facts.ts", import.meta.url));
	const output = execFileSync("bun", [script], {
		encoding: "utf8",
		env: { ...process.env, OMP_PACKAGE_ROOT: root },
		timeout: 60_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	return JSON.parse(output) as StockFacts;
}

/** A key stock needs, with stock's English text when the key is not that text. */
export interface Needed {
	key: string;
	text?: string;
}

interface Dictionary {
	id: string;
	/** Where OMPdesk keeps it (repo path). */
	file: string;
	/** A missing key fails the check and the completeness test; otherwise the GUI has a generic fallback. */
	required: boolean;
	needs(facts: StockFacts): Needed[];
	/** Every key this omp has (a key OMPdesk lists outside it is stale); the needed keys when absent. */
	has?(facts: StockFacts): string[];
	covers(key: string): boolean;
	listed: readonly string[];
}

export interface DictionaryDiff {
	id: string;
	file: string;
	required: boolean;
	/** What stock has that OMPdesk lacks. */
	missing: Needed[];
	/** What OMPdesk lists that stock dropped. */
	stale: string[];
}

/** The settings Settings lists; a terminal-only row or a stock memory backend needs no words (same filter as the GUI). */
const shown = (facts: StockFacts) => facts.settings.filter(s => isSettingSupportedInGui({ path: s.id, tab: s.tab }));
const optionTexts = (settings: StockSettingFacts[]) =>
	settings.flatMap(s => s.options.flatMap(o => [o.label, o.description])).filter((t): t is string => !!t);
const ownRoleIds = new Set(OMPDESK_ROLES.map(role => role.id));
const ownRoleNames = new Set(OMPDESK_ROLES.map(role => role.name));
const keyed = (keys: readonly string[]): Needed[] => keys.map(key => ({ key }));

/** `modelRoles.<family>.<id>` in both locales (locales.test.ts keeps their key sets equal; this reads both anyway). */
function roleLocale(family: "use" | "fallback"): Dictionary {
	const prefix = `modelRoles.${family}.`;
	return {
		id: `roles.${family}`,
		file: "src/renderer/locales/en.ts, src/renderer/locales/ko.ts",
		required: false,
		needs: facts => keyed(facts.roleIds.filter(id => !(id in HIDDEN_ROLES))),
		has: facts => facts.roleIds,
		covers: id => `${prefix}${id}` in en && `${prefix}${id}` in ko,
		listed: Object.keys(en)
			.filter(key => key.startsWith(prefix))
			.map(key => key.slice(prefix.length))
			.filter(id => !ownRoleIds.has(id)),
	};
}

export const DICTIONARIES: readonly Dictionary[] = [
	{
		id: "settings.label",
		file: "src/renderer/components/settings/schema-ko.ts",
		required: true,
		needs: facts => shown(facts).map(s => ({ key: s.id, text: s.label })),
		has: facts => facts.settings.map(s => s.id),
		covers: id => !!KO_SETTINGS[id]?.label,
		listed: Object.keys(KO_SETTINGS),
	},
	{
		id: "settings.description",
		file: "src/renderer/components/settings/schema-ko.ts",
		required: true,
		needs: facts => shown(facts).flatMap(s => (s.description ? [{ key: s.id, text: s.description }] : [])),
		covers: id => !!KO_SETTINGS[id]?.description,
		// OMPdesk also describes settings stock leaves undescribed (its Advanced rows): only a dropped setting is stale.
		has: facts => facts.settings.map(s => s.id),
		listed: Object.keys(KO_SETTINGS).filter(id => KO_SETTINGS[id]?.description),
	},
	{
		id: "settings.group",
		file: "src/renderer/components/settings/schema-ko.ts",
		required: true,
		needs: facts => keyed(shown(facts).flatMap(s => (s.group ? [s.group] : []))),
		has: facts => facts.settings.flatMap(s => (s.group ? [s.group] : [])),
		covers: group => !!KO_GROUP_TITLES[group],
		listed: Object.keys(KO_GROUP_TITLES),
	},
	{
		id: "settings.option",
		file: "src/renderer/components/settings/schema-option-ko.ts",
		required: true,
		needs: facts => keyed(optionTexts(shown(facts))),
		has: facts => optionTexts(facts.settings),
		covers: text => !!KO_SCHEMA_OPTION_TEXT[text],
		listed: Object.keys(KO_SCHEMA_OPTION_TEXT),
	},
	{
		id: "roles.name",
		file: "src/renderer/components/settings/schema-i18n.ts",
		required: true,
		needs: facts => keyed(facts.roleNames),
		covers: name => modelRoleName("ko", name) !== name,
		listed: Object.keys(KO_ROLE_NAMES).filter(name => !ownRoleNames.has(name)),
	},
	roleLocale("use"),
	roleLocale("fallback"),
	{
		id: "roles.place",
		file: "resources/gui-bridge/model-role-contracts.ts",
		required: false,
		needs: facts => keyed(facts.roleIds),
		covers: id => ROLE_ORDER.includes(id) || id in HIDDEN_ROLES,
		listed: [...ROLE_ORDER, ...Object.keys(HIDDEN_ROLES)],
	},
	{
		id: "providers.mark",
		file: "src/renderer/components/settings/providers/provider-marks.ts",
		required: true,
		needs: facts => keyed(facts.providerIds),
		covers: id => id in PROVIDER_BRANDS || FALLBACK_PROVIDER_IDS.includes(id),
		listed: [...Object.keys(PROVIDER_BRANDS), ...FALLBACK_PROVIDER_IDS],
	},
	{
		id: "visuals.variables",
		file: "resources/gui-bridge/modes/visuals-core.ts",
		required: false,
		needs: facts => keyed(facts.visualsVariables),
		covers: name => VISUALS_TEMPLATE_VARIABLES.includes(name),
		listed: VISUALS_TEMPLATE_VARIABLES,
	},
];

export function diffDictionaries(facts: StockFacts): DictionaryDiff[] {
	return DICTIONARIES.map(dictionary => {
		const missing = new Map<string, Needed>();
		for (const need of dictionary.needs(facts)) if (!dictionary.covers(need.key)) missing.set(need.key, need);
		const has = new Set(dictionary.has?.(facts) ?? dictionary.needs(facts).map(need => need.key));
		return {
			id: dictionary.id,
			file: dictionary.file,
			required: dictionary.required,
			missing: [...missing.values()].sort((a, b) => a.key.localeCompare(b.key)),
			stale: [...new Set(dictionary.listed.filter(key => !has.has(key)))].sort(),
		};
	});
}

/** One line per missing key of the required dictionaries (all of them, or those named): what the check fails with. */
export function missingStrings(diffs: readonly DictionaryDiff[], ids?: readonly string[]): string[] {
	return diffs
		.filter(diff => diff.required && (!ids || ids.includes(diff.id)))
		.flatMap(diff =>
			diff.missing.map(({ key, text }) => `${diff.id} (${diff.file}): ${key}${text ? ` "${text}"` : ""}`),
		);
}
