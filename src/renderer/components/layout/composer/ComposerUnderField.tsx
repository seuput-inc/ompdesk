/** The quiet row between the field and the toolbar that never covers the draft: the dictation bar, or the error a take ended in. */
import { useRef } from "react";
import type { DictationTake } from "../../../hooks/use-dictation-take";
import { Collapse } from "../../common";
import { DictationFailureNotice, DictationOverlay } from "./DictationOverlay";

export function ComposerUnderField({
	dictation,
}: {
	dictation: Pick<
		DictationTake,
		"phase" | "levels" | "startedAt" | "preparing" | "words" | "failure" | "dismissFailure"
	>;
}) {
	const bar =
		dictation.phase !== "idle"
			? {
					phase: dictation.phase,
					levels: dictation.levels,
					startedAt: dictation.startedAt,
					preparing: dictation.preparing,
					words: dictation.words,
				}
			: null;
	// The bar folds away with its last content (`Collapse` keeps it mounted for that).
	const held = useRef(bar);
	if (bar) held.current = bar;
	return (
		<>
			<Collapse open={bar !== null}>
				{held.current && (
					<DictationOverlay
						levels={held.current.levels}
						phase={held.current.phase}
						preparing={held.current.preparing}
						startedAt={held.current.startedAt}
						words={held.current.words}
					/>
				)}
			</Collapse>
			{bar === null && dictation.failure && (
				<DictationFailureNotice failure={dictation.failure} onDismiss={dictation.dismissFailure} />
			)}
		</>
	);
}
