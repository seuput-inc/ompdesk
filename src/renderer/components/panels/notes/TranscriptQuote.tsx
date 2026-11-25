/**
 * "Add to chat" over a session's transcript (Orca's `NativeChatSelectionQuote.tsx`, MIT). Loaded lazily by
 * `ChatStream`, so the phone's first screen does not carry it.
 */
import type { RefObject } from "react";
import { SelectionActions } from "../../common";
import { useAddToChat } from "./AddToChat";

export default function TranscriptQuote({
	rootRef,
	tabId,
}: {
	rootRef: RefObject<HTMLElement | null>;
	tabId: string | null;
}) {
	const addToChat = useAddToChat(tabId);
	return (
		<>
			<SelectionActions actions={[addToChat.action]} rootRef={rootRef} />
			{addToChat.menu}
		</>
	);
}
