import { FilePlus, NotebookPen, Terminal as TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SCRATCH_TERMINAL_TAB } from "../../../shared/terminal-types";
import { uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, EmptyState, ListRow, SegmentedChoice, Sheet, TextEditor } from "../common";
import { TerminalSet } from "../panels/TerminalPanel";

/** How long an edit waits before the note is written (and each time the note or the sheet is left). */
const NOTE_SAVE_MS = 800;

/**
 * The quick terminal (Orca's floating terminal, `floating-terminal/FloatingTerminalPanelSurface.tsx`): this window's own
 * terminals in the home folder, kept by no session, over whatever the window shows, with the scratch notes beside them
 * (Orca's floating workspace notes, `FloatingTerminalEmptyState.tsx`). The keymap's `terminal.quick`, the palette and
 * Settings › SSH's Open terminal open it.
 */
export function QuickTerminal() {
	const t = useT();
	const open = useUiStore(s => s.quickTerminalOpen);
	const [view, setView] = useState<"terminal" | "notes">("terminal");
	const close = () => useUiStore.getState().setQuickTerminalOpen(false);
	return (
		<Sheet
			bodyClassName="flex h-[min(70dvh,40rem)] min-h-0 flex-col"
			kind="quick-terminal"
			onClose={close}
			open={open}
			placement="bottom"
			title={t("quickTerminal.title")}
		>
			<div className="flex shrink-0 items-center gap-2 px-3 pb-2">
				<SegmentedChoice
					aria-label={t("quickTerminal.title")}
					fit="content"
					onChange={setView}
					optionAttr="data-quick-terminal-view"
					options={[
						{ value: "terminal", label: t("panel.tabs.terminal"), icon: TerminalIcon },
						{ value: "notes", label: t("quickTerminal.notes"), icon: NotebookPen },
					]}
					value={view}
				/>
			</div>
			{view === "terminal" ? <TerminalSet scratch tabId={SCRATCH_TERMINAL_TAB} /> : <QuickNotes />}
		</Sheet>
	);
}

interface NoteFile {
	path: string;
	name: string;
}

/**
 * Scratch notes: Markdown files in `<userData>/notes` (main roots the quick terminal's files there), newest first, each
 * written a moment after it changes and when it is left.
 */
function QuickNotes() {
	const t = useT();
	const [notes, setNotes] = useState<NoteFile[] | null>(null);
	const [current, setCurrent] = useState<{ path: string; text: string } | null>(null);
	const pending = useRef<{ path: string; text: string } | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const list = useCallback(async () => {
		const listing = await window.omp.fs.list("", 1, 500, SCRATCH_TERMINAL_TAB).catch(() => null);
		const files = (listing?.entries ?? [])
			.filter(entry => entry.kind === "file" && entry.path.endsWith(".md"))
			.map(entry => ({ path: entry.path, name: entry.path.replace(/\.md$/, "") }))
			.sort((a, b) => b.name.localeCompare(a.name));
		setNotes(files);
		return files;
	}, []);
	const flush = useCallback(() => {
		clearTimeout(timer.current);
		const note = pending.current;
		pending.current = null;
		if (!note) return;
		void window.omp.fs
			// A note is this person's scratch, written last-wins: no other editor holds it to compare against.
			.mutate(
				{ op: "write", path: note.path, content: note.text, expectedMtimeMs: 0, force: true },
				SCRATCH_TERMINAL_TAB,
			)
			.then(result => {
				if (!result.ok) toastError({ title: t("quickTerminal.noteSaveFailed"), error: result.error });
			})
			.catch(error => toastError({ title: t("quickTerminal.noteSaveFailed"), error }));
	}, [t]);
	useEffect(() => {
		void list();
		return flush;
	}, [list, flush]);
	const openNote = async (path: string) => {
		flush();
		const read = await window.omp.fs.read(path, undefined, SCRATCH_TERMINAL_TAB).catch(() => null);
		setCurrent({ path, text: read?.ok ? read.content : "" });
	};
	const create = async () => {
		flush();
		const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
		const name = `note-${stamp}.md`;
		const made = await window.omp.fs
			.mutate({ op: "createFile", parent: "", name }, SCRATCH_TERMINAL_TAB)
			.catch(error => ({ ok: false as const, error: String(error) }));
		if (!made.ok) {
			toastError({ title: t("quickTerminal.noteSaveFailed"), error: made.error });
			return;
		}
		await list();
		setCurrent({ path: made.path ?? name, text: "" });
	};
	if (current)
		return (
			<div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
				<div className="flex shrink-0 items-center gap-2">
					<Button
						onClick={() => {
							flush();
							setCurrent(null);
							void list();
						}}
						size="sm"
						variant="ghost"
					>
						{t("quickTerminal.allNotes")}
					</Button>
					<span className="min-w-0 flex-1 truncate font-mono text-sc-xs text-(--sc-text-muted)">
						{current.path}
					</span>
				</div>
				<TextEditor
					ariaLabel={t("quickTerminal.noteEditor", { name: current.path })}
					autoFocus
					className="min-h-0 flex-1"
					language="markdown"
					onChange={text => {
						setCurrent({ path: current.path, text });
						pending.current = { path: current.path, text };
						clearTimeout(timer.current);
						timer.current = setTimeout(flush, NOTE_SAVE_MS);
					}}
					onSave={flush}
					value={current.text}
				/>
			</div>
		);
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3" data-quick-notes>
			<div className="flex shrink-0 justify-end">
				<Button icon={<FilePlus />} onClick={() => void create()} size="sm" variant="secondary">
					{t("quickTerminal.newNote")}
				</Button>
			</div>
			{notes?.length === 0 ? (
				<EmptyState icon={<NotebookPen />} size="sm" title={t("quickTerminal.noNotes")} />
			) : (
				<ul aria-label={t("quickTerminal.notes")} className="flex flex-col">
					{(notes ?? []).map(note => (
						<li key={note.path}>
							<ListRow
								meta={noteDate(note.name)}
								onClick={() => void openNote(note.path)}
								size="sm"
								title={note.name}
							/>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** The time a `note-YYYY-MM-DD-HH-MM-SS` name was made, in the page's language; nothing for another name. */
function noteDate(name: string): string | undefined {
	const match = /^note-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(name);
	if (!match) return undefined;
	const [, year, month, day, hour, minute] = match.map(Number);
	return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0)).toLocaleString(uiLocale(), {
		dateStyle: "medium",
		timeStyle: "short",
	});
}
