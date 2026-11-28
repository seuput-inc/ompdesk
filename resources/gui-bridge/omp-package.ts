/**
 * The stock modules the processes outside omp (stock helper workers, the stats host, boot model) load from the user's
 * omp package at `OMP_PACKAGE_ROOT`. Runtime-selected on purpose: the modules belong to whichever omp install main
 * resolved, never to this file's own resolver. Bridge code running inside omp imports `./omp/<subpath>` instead
 * (scripts/lint-omp-imports.mjs keeps both routes; scripts/omp-boundary lists each key's touchpoint).
 */
import * as path from "node:path";

/** Every key some process outside omp loads (`@oh-my-pi/<key>`); touchpoints.test.ts holds it to the call sites. */
export const OMP_PACKAGE_MODULES = [
	"omp-stats",
	"omp-stats/aggregator",
	"omp-stats/db",
	"omp-stats/live",
	"pi-ai",
	"pi-catalog/compat/auth",
	"pi-catalog/compat/providers",
	"pi-catalog/models",
	"pi-catalog/provider-models",
	"pi-coding-agent/cli/npm-registry",
	"pi-coding-agent/config/all-settings",
	"pi-coding-agent/config/model-roles",
	"pi-coding-agent/config/models-config-schema",
	"pi-coding-agent/config/settings",
	"pi-coding-agent/discovery",
	"pi-coding-agent/discovery/helpers",
	"pi-coding-agent/extensibility/plugins/git-url",
	"pi-coding-agent/extensibility/plugins/loader",
	"pi-coding-agent/extensibility/plugins/manager",
	"pi-coding-agent/extensibility/plugins/marketplace",
	"pi-coding-agent/extensibility/settings",
	"pi-coding-agent/extensibility/skills",
	"pi-coding-agent/judgment/standalone",
	"pi-coding-agent/mcp/config",
	"pi-coding-agent/mcp/oauth-flow",
	"pi-coding-agent/sdk",
	"pi-coding-agent/session/history-storage",
	"pi-coding-agent/session/session-listing",
	"pi-coding-agent/session/session-loader",
	"pi-coding-agent/session/session-manager",
	"pi-coding-agent/session/session-storage",
	"pi-coding-agent/session/session-title-slot",
	"pi-coding-agent/session/transcript/transcript-entry",
	"pi-coding-agent/skillshare/client",
	"pi-coding-agent/skillshare/installer",
	"pi-coding-agent/skillshare/manifest",
	"pi-coding-agent/task/settings",
	"pi-coding-agent/utils/image-input",
	"pi-coding-agent/utils/image-resize",
	"pi-natives",
	"pi-utils",
] as const;

export type OmpPackageModule = (typeof OMP_PACKAGE_MODULES)[number];

/** The file of `@oh-my-pi/<name>` in the omp at `OMP_PACKAGE_ROOT`. */
export function ompModuleFile(name: OmpPackageModule): string {
	const root = process.env.OMP_PACKAGE_ROOT;
	if (!root) throw new Error("OMP_PACKAGE_ROOT is required");
	try {
		return Bun.resolveSync(`@oh-my-pi/${name}`, path.join(root, "package.json"));
	} catch {
		throw new Error(`Installed omp has no @oh-my-pi/${name}`);
	}
}

/** `@oh-my-pi/<name>` from the user's omp, with each of `exports` checked present; `T` is the shape the caller reads. */
export async function loadOmpModule<T>(name: OmpPackageModule, ...exports: string[]): Promise<T> {
	const mod = (await import(ompModuleFile(name))) as Record<string, unknown>;
	for (const exported of exports) {
		if (mod[exported] === undefined) throw new Error(`Installed omp has no ${exported} in @oh-my-pi/${name}`);
	}
	// The caller names the shape it reads; the exports it needs were checked above.
	return mod as unknown as T;
}
