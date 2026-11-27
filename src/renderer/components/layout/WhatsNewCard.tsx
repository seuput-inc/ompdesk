/**
 * The update notice: one quiet row in the shell's main column, between the title bar and the session
 * view (like the update-failure banner). It sits in the layout flow, so the workspace simply starts below it:
 * it never covers a pane's transcript, composer, Send, queue tray, goal dock or toasts (top-right), in a single
 * session, a split or with the side panel open (a sibling column). It is a polite live region and
 * focusable; Esc (focus inside it) dismisses.
 *
 * It stays until dismissed or opened, or until it has been on screen for `AUTO_HIDE_MS` of focused, unpaused
 * time: a card that vanished while the window sat unfocused would be a notice the user never saw. The version
 * counts as seen once the card is up (lib/whats-new), and the Help menu's "What's new" stays reachable.
 */

import { Suspense, useRef } from "react";
import { lazyChunk } from "../../lib/chunk-load";
import { useUiStore } from "../../stores/ui";
import { Collapse } from "../common/Collapse";

const WhatsNewCardBody = lazyChunk(() => import("./WhatsNewCardBody"));

/**
 * Mounted once in the shell's main column under the title bar; renders the card while the ui store holds one. It
 * grows in when one arrives and folds away with its last text when dismissed (`Collapse`: the row is in the layout
 * flow, so the workspace below follows it).
 */
export function WhatsNewCard() {
	const card = useUiStore(state => state.whatsNewCard);
	const held = useRef(card);
	if (card) held.current = card;
	const shown = held.current;
	return (
		<div aria-atomic="true" aria-live="polite" className="shrink-0" role="status">
			<Collapse open={card !== null}>
				{shown && (
					<Suspense fallback={null}>
						<WhatsNewCardBody key={shown.version} since={shown.since} version={shown.version} />
					</Suspense>
				)}
			</Collapse>
		</div>
	);
}
