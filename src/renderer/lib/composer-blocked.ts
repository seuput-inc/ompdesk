/**
 * What the session waits on the user for, as the composer's placeholder wants to say it: a question (`ask`) or a
 * tool approval (`approval`). Derived from extension-ui's pending requests, so nothing new is tracked. The composer
 * stays usable meanwhile (typing adds a steer or a plain message); this only names what the card above is asking.
 */
import { type AwaitedInput, awaitedInput, useExtensionUiStore } from "../stores/extension-ui";

export type ComposerBlocker = "ask" | "approval";

/** Locale key of the placeholder for each blocker (`input.placeholder.blocked*`). */
export const COMPOSER_BLOCKED_PLACEHOLDER: Record<ComposerBlocker, string> = {
	ask: "input.placeholder.blockedAsk",
	approval: "input.placeholder.blockedApproval",
};

/** An approval beats a question: the turn cannot go on without it. */
export function composerBlockedBy(awaited: AwaitedInput | null): ComposerBlocker | null {
	if (awaited === "approval") return "approval";
	return awaited === "input" ? "ask" : null;
}

/** The pane's blocker, re-rendering the caller only when it changes. */
export function useComposerBlockedBy(): ComposerBlocker | null {
	return composerBlockedBy(useExtensionUiStore(awaitedInput));
}
