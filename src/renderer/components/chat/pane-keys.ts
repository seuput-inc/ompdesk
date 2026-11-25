import { type KeymapPlatform, PLATFORM } from "../../lib/keymap";

/**
 * Keys meant for the conversation, wherever focus sits in a session pane: a
 * printable key (or an IME composition start) typed while focus is on the
 * transcript or tool chrome moves focus to the composer first, so the
 * character lands there; Backspace/Delete there only focus it (nothing is
 * deleted), and the paste chord (⌘V, Ctrl+V or Shift+Insert) focuses it
 * before the native paste arrives, so the paste lands in the composer (Orca's
 * `native-chat-root-key-routing.ts:30-45`); PageUp/PageDown in the composer page
 * the transcript unless a completion list or the composer's own scrollback
 * takes them. Dialogs, menus, listboxes and prompt cards (1–9 pick a row) keep
 * their keys.
 */
export function installPaneKeys(
	pane: HTMLElement,
	page: (direction: "up" | "down", event: KeyboardEvent) => void,
	platform: KeymapPlatform = PLATFORM,
): () => void {
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.defaultPrevented) return;
		const target = event.target instanceof HTMLElement ? event.target : null;
		if (!target || target.closest('[role="dialog"], [role="menu"], [role="listbox"], [data-prompt-card]')) return;
		const composer = pane.querySelector<HTMLTextAreaElement>(".omp-composer-input");
		if (!composer) return;
		const paste = isPasteChord(event, platform);
		if ((event.ctrlKey || event.metaKey || event.altKey) && !paste) return;
		if (target === composer) {
			if (event.key !== "PageUp" && event.key !== "PageDown") return;
			if (pane.querySelector('.omp-composer-anchor [role="listbox"]')) return;
			const up = event.key === "PageUp";
			if (up ? composer.scrollTop > 0 : composer.scrollTop + composer.clientHeight < composer.scrollHeight) return;
			page(up ? "up" : "down", event);
			return;
		}
		const editing = !event.shiftKey && (event.key === "Backspace" || event.key === "Delete");
		const printable = (event.key.length === 1 && event.key !== " ") || event.key === "Process";
		if (!(printable || editing || paste) || target.isContentEditable || target.closest("input, textarea, select"))
			return;
		if (composer.disabled) return;
		composer.focus({ preventScroll: true });
	};
	pane.addEventListener("keydown", onKeyDown, true);
	return () => pane.removeEventListener("keydown", onKeyDown, true);
}

/** The platform's paste chord: ⌘V on a Mac; Ctrl+V or Shift+Insert elsewhere. */
function isPasteChord(event: KeyboardEvent, platform: KeymapPlatform): boolean {
	if (event.altKey || event.isComposing) return false;
	if (platform === "mac") return event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "v";
	return (
		(event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "v") ||
		(event.shiftKey && !event.ctrlKey && !event.metaKey && event.key === "Insert")
	);
}
