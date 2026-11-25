/**
 * How a completed plugin mutation reaches a live session, decided by diffing the effective plugin list on
 * each side. Pure: the one stock fact (does a manifest ship extensions/tools/hooks, which bind only at
 * session creation) is injected, so the bridge (`extensions/shared.ts`) and the extensions helper worker
 * (`stock-helper/extensions.ts`) use this one body without it importing any stock module.
 */
export type PluginActivation = "live" | "restart-required";

/**
 * Manifest entry kinds that bind only at session creation (extensions, tools, hooks); commands and skills
 * hot-reload.
 */
export const RESTART_ENTRY_KEYS = ["extensions", "tools", "hooks"] as const;
export type RestartEntryKey = (typeof RESTART_ENTRY_KEYS)[number];

/**
 * Whether a manifest ships executable entry points (extensions/tools/hooks) on the base manifest or on a
 * feature that would load; `resolveEntries` is stock's `resolvePluginManifestEntries`, injected so this
 * module needs no stock import.
 */
export function pluginRequiresRestart<P>(
	plugin: P,
	resolveEntries: (plugin: P, key: RestartEntryKey) => readonly unknown[],
): boolean {
	return RESTART_ENTRY_KEYS.some(key => resolveEntries(plugin, key).length > 0);
}

/** One manifest section (the base, or a feature), as untrusted JSON: any field may be of any type. */
type EntrySection = Partial<Record<RestartEntryKey | "features", unknown>>;

/** Every `<key> <entry>` a manifest declares under extensions/tools/hooks, on its base and on every feature. */
function restartEntries(manifest: unknown): string[] {
	if (typeof manifest !== "object" || manifest === null) return [];
	const features = (manifest as EntrySection).features;
	const sections: unknown[] = [manifest, ...(typeof features === "object" && features ? Object.values(features) : [])];
	return sections.flatMap(section =>
		typeof section === "object" && section
			? RESTART_ENTRY_KEYS.flatMap(key =>
					[(section as EntrySection)[key]]
						.flat()
						.filter(entry => entry !== undefined && entry !== null)
						.map(entry => `${key} ${typeof entry === "string" ? entry : JSON.stringify(entry)}`),
				)
			: [],
	);
}

/**
 * The extension, tool and hook entries (`<key> <entry>`, sorted) a candidate manifest declares that the
 * installed one does not. Every feature counts, enabled or not, since one can be turned on later. The extension
 * updater (the core's `tools/ext.rs`) holds an upgrade that adds any for the person's approval. Manifest JSON is
 * untrusted: either side may be missing or malformed.
 */
export function addedRestartEntries(installed: unknown, candidate: unknown): string[] {
	const have = new Set(restartEntries(installed));
	return [...new Set(restartEntries(candidate))].filter(entry => !have.has(entry)).sort();
}

/** The fields of stock's `ScopedInstalledPlugin` the diff compares. */
export interface ActivationPlugin {
	name: string;
	path: string;
	version: string;
	enabledFeatures: string[] | null;
}

function sameFeatures(left: string[] | null, right: string[] | null): boolean {
	if (left === null || right === null) return left === right;
	if (left.length !== right.length) return false;
	const rightSet = new Set(right);
	return left.every(feature => rightSet.has(feature));
}

/**
 * Classify a completed plugin mutation by diffing the effective runtime state on each side. Commands and
 * skills hot-reload; a changed plugin that ships extensions, tools or hooks (`requiresRestart`) needs a
 * sidecar restart.
 */
export function classifyActivation<P extends ActivationPlugin>(
	before: readonly P[],
	after: readonly P[],
	requiresRestart: (plugin: P) => boolean,
): PluginActivation {
	const beforeByName = new Map(before.map(plugin => [plugin.name, plugin]));
	const afterByName = new Map(after.map(plugin => [plugin.name, plugin]));
	for (const name of new Set([...beforeByName.keys(), ...afterByName.keys()])) {
		const previous = beforeByName.get(name);
		const next = afterByName.get(name);
		if (
			previous &&
			next &&
			previous.path === next.path &&
			previous.version === next.version &&
			sameFeatures(previous.enabledFeatures, next.enabledFeatures)
		) {
			continue;
		}
		if ((previous && requiresRestart(previous)) || (next && requiresRestart(next))) return "restart-required";
	}
	return "live";
}
