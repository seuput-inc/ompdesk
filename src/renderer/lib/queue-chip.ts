/** Stock's legacy picture-only chip marker, used only when restoring old stock entries. */
import { translate } from "./i18n";

export const IMAGE_ONLY_CHIP = "[Image]";

/**
 * What a queued or held message shows as its text: its own text, or for a picture-only message the UI language's
 * word (with the count when the renderer knows more than one picture went with it).
 */
export function queueChipLabel(text: string, imageCount = 0): string {
	if (text !== "") return text;
	if (imageCount > 1) return translate("composerQueue.imageOnlyMany", { count: imageCount });
	return translate("composerQueue.imageOnly");
}
