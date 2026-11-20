import { fileURLToPath } from "node:url";
import { createMarketplaceManager } from "./extensions/shared";
import { getProviderInfo, registerProvider } from "./omp/pi-coding-agent/capability";
import { scanSkillsFromDir } from "./omp/pi-coding-agent/discovery/helpers";

const providerId = "ompdesk-ponytail";
const dir = fileURLToPath(new URL("../omp-builtin/ponytail/skills", import.meta.url));

export default function ponytail(): void {
	// Stock rebinds extension factories for subagents, but its discovery providers belong to the process.
	if (getProviderInfo(providerId)) return;
	registerProvider("skills", {
		id: providerId,
		displayName: "OMPdesk Ponytail",
		description: "Bundled Ponytail skills",
		priority: 0,
		async load(ctx) {
			const manager = await createMarketplaceManager(ctx.cwd);
			// Even a disabled install owns the choice. Different versions otherwise survive as namespaced aliases.
			const installed = await manager.listInstalledPlugins();
			if (installed.some(plugin => plugin.id === "ponytail@ponytail" && plugin.entries.length > 0))
				return { items: [] };
			return scanSkillsFromDir(ctx, { dir, providerId, level: "user", requireDescription: true });
		},
	});
}
