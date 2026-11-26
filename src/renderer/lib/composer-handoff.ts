/**
 * Hand text to a session's composer without sending it: review notes (`stores/review-notes.ts`), a quoted selection
 * (Orca's "Add to chat", `native-chat-workspace-selection.ts`: the quote is added, unsent, to the chat the person
 * picks, and that chat is shown), a failure for the agent to fix, into the session the person picks
 * (`components/panels/notes/composer-targets.ts`).
 *
 * A session on screen takes the text through `omp:fill-composer` (its composer glows and takes focus); a hidden one's
 * draft takes it in its composer store, which the composer reads when its session shows.
 */
import type { ImageContent } from "../../shared/rpc-types";
import { appendToDraft, type ComposerStore, prependToDraft } from "../stores/composer";
import { sessionRuntimeStore } from "../stores/session-runtime-context";
import { ensureTabRuntime } from "../stores/tab-runtime";
import { useTabsStore, visibleTabIds } from "../stores/tabs";

export interface ComposerHandOff {
	text: string;
	images?: ImageContent[];
	/** `prepend`: ahead of the draft (notes, a fix request); `append`: after it (a quote). */
	mode: "prepend" | "append";
}

/** A session to hand text to: an open tab, or a new session where `from` works. */
export type ComposerTarget = { tabId: string } | { newSessionFrom: string };

/** Tabs whose composer is mounted and listens for `omp:fill-composer` (`use-composer-events.ts`). */
const listening = new Map<string, number>();

/** A mounted composer of `tabId` says it listens; the returned call says it stopped. */
export function composerListening(tabId: string): () => void {
	listening.set(tabId, (listening.get(tabId) ?? 0) + 1);
	return () => {
		const left = (listening.get(tabId) ?? 1) - 1;
		if (left > 0) listening.set(tabId, left);
		else listening.delete(tabId);
	};
}

/**
 * Put the text into `tabId`'s composer and show that session. A composer that is not mounted yet (a hidden tab, or one
 * `openTab` just made active, before React drew it) takes the text in its store, so nothing is lost to an event no one hears.
 */
export function handToTab(tabId: string, message: ComposerHandOff): void {
	const tabs = useTabsStore.getState();
	if (listening.has(tabId) && visibleTabIds(tabs).includes(tabId)) {
		window.dispatchEvent(
			new CustomEvent("omp:fill-composer", {
				detail: {
					text: message.text,
					images: message.images,
					prepend: message.mode === "prepend",
					append: message.mode === "append",
					tabId,
				},
			}),
		);
		if (tabs.activeTabId !== tabId) void tabs.switchTab(tabId);
		return;
	}
	ensureTabRuntime(tabId);
	const composer = sessionRuntimeStore<ComposerStore>(tabId, "composer")?.getState();
	if (!composer) return;
	composer.setDraft(current =>
		message.mode === "prepend" ? prependToDraft(message.text, current) : appendToDraft(message.text, current),
	);
	if (message.images?.length) {
		const added = message.images.map(content => ({
			content,
			preview: `data:${content.mimeType};base64,${content.data}`,
		}));
		composer.setImages(current => [...current, ...added]);
	}
	void tabs.switchTab(tabId);
}

/** Hand the text to `target`; false when a new session could not be opened. */
export async function handToComposer(target: ComposerTarget, message: ComposerHandOff): Promise<boolean> {
	if ("tabId" in target) {
		handToTab(target.tabId, message);
		return true;
	}
	const from = useTabsStore.getState().tabs.find(tab => tab.id === target.newSessionFrom);
	const tabId = await useTabsStore
		.getState()
		.openTab(from ? { cwd: from.cwd, ...(from.device === undefined ? {} : { device: from.device }) } : {});
	if (!tabId) return false;
	handToTab(tabId, message);
	return true;
}
