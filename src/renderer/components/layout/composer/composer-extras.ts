/**
 * The composer's helpers a person reaches only by acting (the `@` menu's sessions, links kept in a paste), kept off the
 * phone's first screen. They load in an idle moment after start (AppShell) and when the composer takes focus
 * (AppShell's `preloadForIntent`), so they are in place before the first `@` or paste; until then the `@` menu lists
 * files only and a paste goes in as plain text.
 */
import type * as MentionSessions from "./mention-sessions";
import type * as PastedLinks from "./pasted-links";

type ComposerExtras = typeof MentionSessions & typeof PastedLinks;

let loaded: ComposerExtras | undefined;
let loading: Promise<void> | undefined;

/** Loads the helpers once; a failed load (a dropped link) is tried again on the next call. */
export function preloadComposerExtras(): Promise<void> {
	loading ??= Promise.all([import("./mention-sessions"), import("./pasted-links")]).then(
		([mentions, links]) => {
			loaded = { ...mentions, ...links };
		},
		() => {
			loading = undefined;
		},
	);
	return loading;
}

/** The helpers once loaded. */
export function composerExtras(): ComposerExtras | undefined {
	return loaded;
}
