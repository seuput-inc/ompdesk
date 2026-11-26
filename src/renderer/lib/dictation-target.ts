/**
 * Where a take started from the `voice.dictate` key lands when focus is not in a composer: the focused text field,
 * an editable region, or a terminal (Orca's `dictation-insertion-target.ts`, commit 02cecc98). The target is caught
 * when the take starts, so words that arrive after focus moved still land where the person was typing; one whose
 * field is gone goes to the clipboard.
 */

/** Sent to the focused terminal's element with the words; its panel pastes them and marks the event handled. */
export const DICTATION_TEXT_EVENT = "omp:dictation-text";

export type DictationTarget =
	| { kind: "composer" }
	| { kind: "terminal"; element: HTMLElement }
	| { kind: "text"; element: HTMLInputElement | HTMLTextAreaElement }
	| { kind: "editable"; element: HTMLElement };

/** Input types a person types words into (a checkbox or a range is not one). */
const TEXT_INPUT_TYPES: Record<string, true> = {
	text: true,
	search: true,
	url: true,
	email: true,
	tel: true,
	"": true,
};

/** The focused place a take's words go: the composer (also when nothing that takes text has focus), else that place. */
export function dictationTarget(active: Element | null): DictationTarget {
	if (!active || active.closest(".omp-composer-box")) return { kind: "composer" };
	// xterm's hidden field: its panel takes the words as a paste.
	if (active.classList.contains("xterm-helper-textarea") && active instanceof HTMLElement)
		return { kind: "terminal", element: active };
	if (active instanceof HTMLTextAreaElement && !active.readOnly && !active.disabled)
		return { kind: "text", element: active };
	if (active instanceof HTMLInputElement && TEXT_INPUT_TYPES[active.type] && !active.readOnly && !active.disabled)
		return { kind: "text", element: active };
	if (active instanceof HTMLElement && active.isContentEditable) return { kind: "editable", element: active };
	return { kind: "composer" };
}

/** A space between the words and the text on either side, where neither side already has one. */
function spaced(text: string, before: string, after: string): string {
	const leading = before && !/\s$/u.test(before) ? " " : "";
	const trailing = after && !/^\s/u.test(after) ? " " : "";
	return `${leading}${text}${trailing}`;
}

/**
 * Put `text` into `target`; false when it could not land there (the field is gone, the terminal closed), so the
 * caller hands it to the clipboard. A field is typed into with `insertText`, so its own undo and its React state
 * follow as if the person typed.
 */
export function insertDictation(target: Exclude<DictationTarget, { kind: "composer" }>, text: string): boolean {
	const element = target.element;
	if (!element.isConnected) return false;
	if (target.kind === "terminal") {
		// One line: a program that did not ask for bracketed paste would run a line at each newline.
		const line = text.replace(/\s*[\r\n]+\s*/g, " ");
		const event = new CustomEvent(DICTATION_TEXT_EVENT, { detail: line, bubbles: true, cancelable: true });
		element.dispatchEvent(event);
		return event.defaultPrevented;
	}
	element.focus();
	if (target.kind === "text") {
		const field = target.element;
		const start = field.selectionStart ?? field.value.length;
		const end = field.selectionEnd ?? start;
		return document.execCommand(
			"insertText",
			false,
			spaced(text, field.value.slice(0, start), field.value.slice(end)),
		);
	}
	return document.execCommand("insertText", false, spaced(text, " ", ""));
}
