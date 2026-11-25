/**
 * Review notes on screen (`stores/review-notes.ts`): the editor a note is written in, a note's card, and the notes
 * shelf of the Changes view (Orca's `source-control/notes/notes-shelf.tsx` and `diff-comments-list.tsx`, MIT: the
 * session's notes by file, each with its place, copy and delete; Send to an agent, copy all, clear all).
 *
 * Send hands every note, as one message (`lib/review-notes.ts`), to the composer of the session the person picks (this
 * one, another open one, a new one in this folder; `lib/composer-handoff.ts`), ahead of its draft and unsent; the notes
 * that left are removed, as Orca removes delivered notes. Clear asks first.
 */
import { MessageSquareText, MoreHorizontal, Pencil, Send, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { handToComposer } from "../../../lib/composer-handoff";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { formatFileNote, noteLabel, reviewNotesMessage } from "../../../lib/review-notes";
import { notesOf, notesOwner, type ReviewNote, useReviewNotesStore } from "../../../stores/review-notes";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { toast } from "../../../stores/toast";
import {
	Badge,
	Button,
	Collapse,
	ConfirmDialog,
	CopyButton,
	DisclosureButton,
	IconButton,
	LinkButton,
	MenuButton,
	TextArea,
} from "../../common";
import { composerTargetItems, useOtherSessionTargets } from "./composer-targets";

/** The panel's session and its notes key; null owner while the panel has no tab. */
export function useNotesOwner(): { tabId: string | null; owner: string | null } {
	const tabId = useRuntimeTabId();
	const tab = useTabsStore(state => state.tabs.find(entry => entry.id === tabId));
	return { tabId, owner: tab ? notesOwner(tab) : null };
}

/** The session's notes, oldest first. */
export function useSessionNotes(owner: string | null): ReviewNote[] {
	const notes = useReviewNotesStore(state => state.notes);
	return useMemo(() => (owner ? notesOf(notes, owner) : []), [notes, owner]);
}

/** A note being written: Save (⌘/Ctrl+Enter) keeps it, Cancel (Esc) drops it; an empty note cannot be saved. */
export function NoteEditor({
	initial = "",
	label,
	context,
	onSave,
	onCancel,
}: {
	initial?: string;
	/** Where the note goes, for its field's name ("Note on lines 3-5"). */
	label: string;
	/** What the note is on (a quoted passage), shown above the field. */
	context?: ReactNode;
	onSave: (body: string) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const [body, setBody] = useState(initial);
	const save = () => {
		if (body.trim()) onSave(body.trim());
	};
	return (
		<div className="flex flex-col gap-2 p-2" data-note-editor>
			{context}
			<TextArea
				aria-label={label}
				autoFocus
				autoGrow
				onChange={event => setBody(event.target.value)}
				onKeyDown={event => {
					if (isImeKeyEvent(event)) return;
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						save();
					} else if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						onCancel();
					}
				}}
				placeholder={t("reviewNotes.placeholder")}
				rows={2}
				value={body}
			/>
			<div className="flex justify-end gap-2">
				<Button onClick={onCancel} size="sm" variant="ghost">
					{t("common.cancel")}
				</Button>
				<Button disabled={!body.trim()} onClick={save} size="sm" variant="primary">
					{t("reviewNotes.save")}
				</Button>
			</div>
		</div>
	);
}

/** A saved note: its place, its text, Edit and Delete. `onOpen` shows where it sits. */
export function NoteCard({ note, onOpen, compact }: { note: ReviewNote; onOpen?: () => void; compact?: boolean }) {
	const t = useT();
	const [editing, setEditing] = useState(false);
	const store = useReviewNotesStore.getState;
	const label = noteLabel(t, note.anchor);
	if (editing) {
		return (
			<NoteEditor
				initial={note.body}
				label={t("reviewNotes.editLabel", { place: label })}
				onCancel={() => setEditing(false)}
				onSave={body => {
					store().update(note.id, { body });
					setEditing(false);
				}}
			/>
		);
	}
	return (
		<div
			className="group flex items-start gap-1.5 rounded-(--sc-radius-sm) px-1.5 py-1 hover:bg-(--sc-hover)"
			data-review-note={note.id}
		>
			<MessageSquareText aria-hidden className="mt-0.5 size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
			<div className="min-w-0 flex-1">
				{!compact && (
					<div className="flex min-w-0 items-center gap-1.5 text-sc-2xs text-(--sc-text-muted)">
						{onOpen ? (
							<LinkButton className="tabular-nums" onClick={onOpen} tone="muted">
								{label}
							</LinkButton>
						) : (
							<span className="tabular-nums">{label}</span>
						)}
						{note.anchor.kind === "text" && note.anchor.markdown && <Badge size="xs">MD</Badge>}
					</div>
				)}
				{note.anchor.kind === "text" && !compact && (
					<p className="truncate text-sc-xs text-(--sc-text-subtle)">“{note.anchor.excerpt.trim()}”</p>
				)}
				<p className="whitespace-pre-wrap break-words text-sc-sm text-(--sc-text)">{note.body}</p>
			</div>
			<div className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
				{note.anchor.kind !== "preview" && (
					<CopyButton label={t("reviewNotes.copyOne")} text={formatFileNote(note.anchor, note.body)} />
				)}
				<IconButton icon={<Pencil />} label={t("reviewNotes.edit")} onClick={() => setEditing(true)} size="sm" />
				<IconButton
					icon={<Trash2 />}
					label={t("reviewNotes.delete")}
					onClick={() => store().remove([note.id])}
					size="sm"
				/>
			</div>
		</div>
	);
}

/** The place a group of notes is shown under: the file's path, or the Preview page's title. */
function groupKey(note: ReviewNote): string {
	return note.anchor.kind === "preview" ? `preview:${note.anchor.page}` : `file:${note.anchor.path}`;
}

/** Send every note of `notes` to a session the menu offers, then drop them. */
export function NotesSendMenu({
	notes,
	tabId,
	label,
}: {
	notes: readonly ReviewNote[];
	tabId: string | null;
	/** The trigger's text; an icon alone when absent. */
	label?: string;
}) {
	const t = useT();
	const others = useOtherSessionTargets(tabId);
	const items = composerTargetItems(t, tabId, others, target => {
		const message = reviewNotesMessage(t, notes);
		const ids = notes.map(note => note.id);
		void handToComposer(target, { ...message, mode: "prepend" })
			.then(handed => {
				if (!handed) return;
				useReviewNotesStore.getState().remove(ids);
				toast({ variant: "success", message: t("reviewNotes.sent", { count: ids.length }) });
			})
			.catch(() => toast({ variant: "error", message: t("composerTarget.failed") }));
	});
	return label ? (
		<MenuButton disabled={notes.length === 0} items={items} label={t("reviewNotes.send")} size="sm" variant="primary">
			{label}
		</MenuButton>
	) : (
		<MenuButton disabled={notes.length === 0} icon={<Send />} items={items} label={t("reviewNotes.send")} size="sm" />
	);
}

/**
 * The session's notes at the top of the Changes view: a count that folds the list open, Send, Copy all and a menu
 * with Clear all. Nothing shows while the session has no note. `onOpen` shows a Changes note's file.
 */
export function NotesShelf({ onOpen }: { onOpen?: (note: ReviewNote) => void }) {
	const t = useT();
	const { tabId, owner } = useNotesOwner();
	const notes = useSessionNotes(owner);
	const [open, setOpen] = useState(false);
	const [clearing, setClearing] = useState(false);
	const groups = useMemo(() => {
		const byPlace = new Map<string, ReviewNote[]>();
		for (const note of notes) byPlace.set(groupKey(note), [...(byPlace.get(groupKey(note)) ?? []), note]);
		return [...byPlace.values()];
	}, [notes]);
	if (notes.length === 0) return null;
	const message = reviewNotesMessage(t, notes);
	return (
		<section aria-label={t("reviewNotes.title")} className="border-b border-(--sc-divider)" data-notes-shelf>
			<div className="flex min-w-0 items-center gap-1 px-3 py-1">
				<DisclosureButton
					className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sc-xs text-(--sc-text-muted)"
					onToggle={() => setOpen(value => !value)}
					open={open}
				>
					<span>{t("reviewNotes.title")}</span>
					<Badge size="xs">{notes.length}</Badge>
				</DisclosureButton>
				<NotesSendMenu label={t("reviewNotes.send")} notes={notes} tabId={tabId} />
				<CopyButton label={t("reviewNotes.copyAll")} text={message.text} />
				<MenuButton
					icon={<MoreHorizontal />}
					items={[
						{
							id: "clear",
							label: t("reviewNotes.clearAll"),
							icon: Trash2,
							danger: true,
							onSelect: () => setClearing(true),
						},
					]}
					label={t("reviewNotes.more")}
					size="sm"
				/>
			</div>
			<Collapse open={open}>
				<div className="flex max-h-72 flex-col gap-2 overflow-y-auto px-3 pb-2" data-notes-list>
					{groups.map(group => {
						const [first] = group;
						if (!first) return null;
						const anchor = first.anchor;
						return (
							<div key={groupKey(first)}>
								<p
									className="truncate text-sc-2xs font-medium text-(--sc-text-secondary)"
									title={anchor.kind === "preview" ? anchor.url : anchor.path}
								>
									{anchor.kind === "preview"
										? t("reviewNotes.previewPage", { page: anchor.title || anchor.url })
										: anchor.path}
								</p>
								{group.map(note => (
									<NoteCard
										key={note.id}
										note={note}
										onOpen={note.anchor.kind === "diff" && onOpen ? () => onOpen(note) : undefined}
									/>
								))}
							</div>
						);
					})}
				</div>
			</Collapse>
			<ConfirmDialog
				confirmLabel={t("reviewNotes.clearConfirm")}
				message={t("reviewNotes.clearBody", { count: notes.length })}
				onCancel={() => setClearing(false)}
				onConfirm={() => {
					setClearing(false);
					useReviewNotesStore.getState().remove(notes.map(note => note.id));
				}}
				open={clearing}
				title={t("reviewNotes.clearTitle")}
			/>
		</section>
	);
}
