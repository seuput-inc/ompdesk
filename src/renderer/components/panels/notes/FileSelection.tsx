/**
 * What a passage selected in the Files viewer offers: "Add to chat" in every text view (Orca's
 * `native-chat-workspace-selection.ts`), and in a Markdown or code view "Add note" (Orca's Markdown review notes,
 * `markdown-preview/review/*`, MIT), which keeps the passage as the note's excerpt and, in a view that numbers its
 * lines (`data-line` rows of `CodeView`), the lines it covers.
 */
import { MessageSquarePlus } from "lucide-react";
import { type RefObject, useState } from "react";
import { useT } from "../../../lib/i18n";
import { quoteExcerpt } from "../../../lib/review-notes";
import { type NoteLines, useReviewNotesStore } from "../../../stores/review-notes";
import { useTabsStore } from "../../../stores/tabs";
import { Modal, type SelectionAction, SelectionActions } from "../../common";
import { workspaceRelativePath } from "../FilesPanel";
import { useAddToChat } from "./AddToChat";
import { NoteEditor, useNotesOwner } from "./ReviewNotes";

function lineOf(node: Node): number | null {
	const element = node instanceof Element ? node : node.parentElement;
	const value = element?.closest<HTMLElement>("[data-line]")?.dataset.line;
	return value ? Number(value) : null;
}

/** The numbered lines a selection covers; null where the view does not number them (rendered Markdown). */
export function selectedLines(range: Range): NoteLines | null {
	const start = lineOf(range.startContainer);
	let end = lineOf(range.endContainer);
	if (start === null || end === null) return null;
	// A selection that ends at the very start of a line (a triple click) does not take that line.
	if (end > start && range.endOffset === 0) end -= 1;
	return { start: Math.min(start, end), end: Math.max(start, end) };
}

export function FileSelectionActions({
	rootRef,
	path,
	notes,
}: {
	rootRef: RefObject<HTMLElement | null>;
	path: string;
	/** Offer "Add note"; `markdown` marks the note's source. */
	notes?: { markdown: boolean };
}) {
	const t = useT();
	const { tabId, owner } = useNotesOwner();
	const cwd = useTabsStore(state => state.tabs.find(tab => tab.id === tabId)?.cwd ?? "");
	const addToChat = useAddToChat(tabId);
	const [noting, setNoting] = useState<{ excerpt: string; lines: NoteLines | null } | null>(null);
	const actions: SelectionAction[] = [addToChat.action];
	if (notes && owner) {
		actions.unshift({
			id: "note",
			label: t("reviewNotes.addNote"),
			icon: <MessageSquarePlus />,
			run: (text, _button, range) => setNoting({ excerpt: text, lines: selectedLines(range) }),
		});
	}
	return (
		<>
			<SelectionActions actions={actions} rootRef={rootRef} />
			{addToChat.menu}
			<Modal
				bodyClassName="p-0"
				onClose={() => setNoting(null)}
				open={noting !== null}
				title={t("reviewNotes.noteOnSelection")}
			>
				{noting && notes && owner && (
					<NoteEditor
						context={
							<blockquote className="max-h-32 overflow-y-auto whitespace-pre-wrap border-l-2 border-(--sc-border) pl-2 text-sc-sm text-(--sc-text-muted)">
								{quoteExcerpt(noting.excerpt).replace(/^> ?/gm, "")}
							</blockquote>
						}
						label={t("reviewNotes.noteOnSelection")}
						onCancel={() => setNoting(null)}
						onSave={body => {
							useReviewNotesStore.getState().add({
								owner,
								anchor: {
									kind: "text",
									path: workspaceRelativePath(path, cwd) || path,
									markdown: notes.markdown,
									lines: noting.lines,
									excerpt: noting.excerpt,
								},
								body,
							});
							setNoting(null);
						}}
					/>
				)}
			</Modal>
		</>
	);
}
