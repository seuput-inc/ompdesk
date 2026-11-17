/**
 * What an installed omp says about the items OMPdesk keeps dictionaries for: its settings' words (as Settings shows
 * them, `settingText`), its model roles, its provider ids and the variables of its system prompt's Visuals section.
 * Runs under Bun on the omp at `OMP_PACKAGE_ROOT` (stock's modules need Bun); `bun scripts/omp-bump/stock-facts.ts`
 * prints the facts as JSON, which is how a Node test reads them (`readStockFacts` in dictionaries.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { templateVariables, visualsTemplate } from "../../resources/gui-bridge/modes/visuals-core";
import { loadOmpModule } from "../../resources/gui-bridge/omp-package";
import { type StockSettingWords, settingText } from "../../resources/gui-bridge/settings-core";

export interface StockSettingFacts {
	id: string;
	tab?: string;
	label: string;
	description?: string;
	group?: string;
	options: { label: string; description?: string }[];
}

export interface StockFacts {
	/** The omp package's own version. */
	version: string;
	settings: StockSettingFacts[];
	/** `MODEL_ROLE_IDS`. */
	roleIds: string[];
	/** Every built-in role's English `name` (`MODEL_ROLES`). */
	roleNames: string[];
	/** The `/login` auth policies' ids plus the model catalog's provider ids. */
	providerIds: string[];
	/** The variables the Visuals section of `system/system-prompt.md` reads. */
	visualsVariables: string[];
}

interface AllSettings {
	orderedSettings(): StockSettingWords[];
}
interface ModelRoles {
	MODEL_ROLE_IDS: readonly string[];
	MODEL_ROLES: Record<string, { name: string }>;
}
interface Auth {
	authProviders(): readonly { id: string }[];
}
interface Providers {
	providerEntries(): Readonly<Record<string, unknown>>;
}

export async function collectStockFacts(): Promise<StockFacts> {
	const root = process.env.OMP_PACKAGE_ROOT;
	if (!root) throw new Error("OMP_PACKAGE_ROOT is required");
	const [settings, roles, auth, providers] = await Promise.all([
		loadOmpModule<AllSettings>("pi-coding-agent/config/all-settings", "orderedSettings"),
		loadOmpModule<ModelRoles>("pi-coding-agent/config/model-roles", "MODEL_ROLE_IDS", "MODEL_ROLES"),
		loadOmpModule<Auth>("pi-catalog/compat/auth", "authProviders"),
		loadOmpModule<Providers>("pi-catalog/compat/providers", "providerEntries"),
	]);
	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string };
	const systemPrompt = readFileSync(path.join(root, "src", "prompts", "system", "system-prompt.md"), "utf8");
	return {
		version: pkg.version ?? "unknown",
		// JSON drops the undefined fields, so the facts carry only the words stock has.
		settings: settings.orderedSettings().map(setting => {
			const text = settingText(setting);
			return {
				id: setting.id,
				tab: text.tab,
				label: text.label,
				description: text.description,
				group: text.group,
				options: (text.options ?? []).map(option => ({ label: option.label, description: option.description })),
			};
		}),
		roleIds: [...roles.MODEL_ROLE_IDS],
		roleNames: Object.values(roles.MODEL_ROLES).map(role => role.name),
		providerIds: [
			...new Set([
				...auth.authProviders().map(provider => provider.id),
				...Object.keys(providers.providerEntries()),
			]),
		],
		visualsVariables: templateVariables(visualsTemplate(systemPrompt)),
	};
}

if (import.meta.main) process.stdout.write(JSON.stringify(await collectStockFacts()));
