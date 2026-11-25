/** Main-side worker: stock models.yml schemas/catalog need Bun, not Electron's Node runtime. */
import { ompModuleFile } from "../omp-package";

interface Schema {
	assert(value: unknown): unknown;
	get(...keys: Array<string | number>): Schema;
	ir: unknown;
}
async function stockSchema(): Promise<Schema> {
	// Runtime-selected: the schema belongs to the user's resolved omp installation.
	const module = await import(ompModuleFile("pi-coding-agent/config/models-config-schema"));
	const schema = module.ModelsConfigSchema as Schema;
	if (typeof schema?.assert !== "function" || typeof schema.get !== "function") {
		throw new Error("Installed omp has no ModelsConfigSchema");
	}
	return schema;
}
function literals(ir: unknown): string[] {
	if (!ir || typeof ir !== "object") return [];
	const node = ir as Record<string, unknown>;
	if (node.k === "lit" && typeof node.v === "string") return [node.v];
	if (node.k === "union" && Array.isArray(node.members)) return node.members.flatMap(literals);
	if (node.k === "sub" && node.schema && typeof node.schema === "object") {
		return literals((node.schema as Record<string, unknown>).ir);
	}
	return [];
}
export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	"catalog.roster": async () => {
		const schema = await stockSchema();
		// Runtime-selected: catalog modules belong to the resolved omp installation.
		const [providers, auth] = await Promise.all([
			import(ompModuleFile("pi-catalog/compat/providers")),
			import(ompModuleFile("pi-catalog/compat/auth")),
		]);
		if (typeof providers.providerEntries !== "function" || typeof auth.authProviders !== "function") {
			throw new Error("Installed omp cannot determine built-in providers");
		}
		const provider = schema.get("providers", "_gui");
		const options = (...keys: Array<string | number>) => literals(provider.get(...keys).ir);
		return {
			builtinProviders: [
				...new Set([
					...Object.keys(providers.providerEntries()),
					...auth.authProviders().map((entry: { id: string }) => entry.id),
				]),
			],
			apis: options("api"),
			auth: options("auth"),
			discovery: options("discovery", "type"),
			thinkingModes: options("models", 0, "thinking", "mode"),
			efforts: options("models", 0, "thinking", "efforts", 0),
		};
	},
	// Stock reads models.yml with Bun.YAML (config-file.ts), so the core's editor checks every text it reads or
	// writes against this parse: `raw` as parsed, `config` as ModelsConfigSchema normalizes it.
	"models.validate": async params => {
		const schema = await stockSchema();
		if (!params || typeof params !== "object" || !("text" in params) || typeof params.text !== "string") {
			throw new Error("text is required");
		}
		let raw: unknown;
		try {
			raw = Bun.YAML.parse(params.text) ?? {};
		} catch (error) {
			return { error: `models.yml: ${error instanceof Error ? error.message : String(error)}` };
		}
		try {
			return { raw, config: schema.assert(structuredClone(raw)) };
		} catch {
			// Schema errors may include credential values: never send or log those values.
			return { error: "models.yml does not satisfy stock omp ModelsConfigSchema" };
		}
	},
};
