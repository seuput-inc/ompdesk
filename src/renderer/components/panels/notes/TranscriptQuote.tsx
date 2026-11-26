/**
 * "Add to chat" and "Copy" over a session's transcript (Orca's `NativeChatSelectionQuote.tsx` and
 * `SelectedTextCopyMenu.tsx`, MIT). Loaded lazily by `ChatStream`, so the phone's first screen does not carry it.
 */
import type { RefObject } from "react";
import { SelectionActions, useCopySelectionAction } from "../../common";
import { useAddToChat } from "./AddToChat";

export default function TranscriptQuote({
	rootRef,
	tabId,
}: {
	rootRef: RefObject<HTMLElement | null>;
	tabId: string | null;
}) {
	const addToChat = useAddToChat(tabId);
	const copy = useCopySelectionAction();
	return (
		<>
			<SelectionActions actions={[addToChat.action, copy]} rootRef={rootRef} />
			{addToChat.menu}
		</>
	);
}
