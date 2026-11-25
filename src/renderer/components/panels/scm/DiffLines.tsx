/**
 * Virtualized rows and the repository diff body shared by the Changes list
 * and the commit history: old/new gutters, add/remove tint and syntax colour
 * by the file's language (both sides highlighted as whole texts, so a block
 * comment or template string spanning lines keeps its colour).
 *
 * With `notes` (the Changes view's working-tree diff) a line of the new side takes a review note (Orca's diff comments,
 * `components/diff-comments/*`, MIT): its + opens the note's editor under it, Shift+click on another line's + or a drag
 * across the +s makes it a range, and the session's notes on this file show under their last line.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import type { HLJSApi } from "highlight.js";
import { Plus } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { DiffLine } from "../../../lib/diff";
import { cx, languageFromPath } from "../../../lib/format";
import {
	getLoadedHljs,
	HIGHLIGHT_CHAR_CAP,
	type HighlightToken,
	loadHljs,
	splitHighlightedLines,
} from "../../../lib/highlight";
import { useT } from "../../../lib/i18n";
import { noteLabel } from "../../../lib/review-notes";
import { type NoteLines, type ReviewNote, useReviewNotesStore } from "../../../stores/review-notes";
import { IconButton, LinkButton, Skeleton } from "../../common";
import { NoteCard, NoteEditor } from "../notes/ReviewNotes";

/**
 * Rows of a long list inside `scroller`, mounted only near its viewport. A
 * checkout's 1,000 changed files or a diff's thousands of lines, all mounted,
 * made one 65–180 ms frame when the list or the diff opened.
 */
export function VirtualRows<T>({
	items,
	scroller,
	estimate,
	itemKey,
	children,
}: {
	items: readonly T[];
	/** The scrolling ancestor; state, so the rows mount once it is attached. */
	scroller: HTMLElement | null;
	estimate: number;
	itemKey: (item: T, index: number) => string | number;
	children: (item: T, index: number) => ReactNode;
}) {
	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => scroller,
		estimateSize: () => estimate,
		getItemKey: index => itemKey(items[index] as T, index),
		// The overscan (12 rows, 240+ px) also covers what precedes the rows in the
		// scroller (a search field or the sticky header, under 60 px), so no scroll
		// margin is read from layout.
		overscan: 12,
		// Sizes come from the ResizeObserver entry, after layout: reading a row's
		// rect while its commit mounts it would lay out the whole window inside the
		// commit. A row under a hidden list (display: none) reports 0; it keeps its estimate.
		measureElement: (element, entry, instance) =>
			entry
				? entry.borderBoxSize[0]?.blockSize || estimate
				: (instance.measurementsCache[instance.indexFromElement(element)]?.size ?? estimate),
	});
	return (
		<div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
			{virtualizer.getVirtualItems().map(item => (
				<div
					data-index={item.index}
					key={item.key}
					ref={virtualizer.measureElement}
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						width: "100%",
						transform: `translateY(${item.start}px)`,
					}}
				>
					{children(items[item.index] as T, item.index)}
				</div>
			))}
		</div>
	);
}

/**
 * Tokens per diff line: the new side (context + added) and the old side
 * (removed) each highlighted as one text, then handed back line by line.
 * Null when the language is unknown or the diff is too large to colour.
 */
export function highlightDiffLines(
	lines: readonly DiffLine[],
	hljs: HLJSApi,
	language: string,
): (HighlightToken[] | undefined)[] | null {
	if (language === "plaintext" || !hljs.getLanguage(language)) return null;
	const sides = { new: [] as number[], old: [] as number[] };
	let size = 0;
	lines.forEach((line, index) => {
		(line.type === "remove" ? sides.old : sides.new).push(index);
		size += line.content.length + 1;
	});
	if (size > HIGHLIGHT_CHAR_CAP * 5) return null;
	const tokens: (HighlightToken[] | undefined)[] = new Array(lines.length);
	for (const indices of [sides.new, sides.old]) {
		if (indices.length === 0) continue;
		try {
			const code = indices.map(index => lines[index]!.content).join("\n");
			const perLine = splitHighlightedLines(hljs.highlight(code, { language, ignoreIllegals: true }).value);
			indices.forEach((lineIndex, k) => {
				tokens[lineIndex] = perLine[k];
			});
		} catch {
			// A grammar error leaves this side plain.
		}
	}
	return tokens;
}

const DIFF_SKELETON_WIDTHS = [90, 72, 84, 60, 78, 66, 88, 50] as const;

/** A diff on its way: code lines as flat bars, so the rows land where they were. */
export function DiffSkeleton({ label }: { label: string }) {
	return (
		<div aria-label={label} className="flex flex-col gap-2 p-3" role="status">
			{DIFF_SKELETON_WIDTHS.map((width, index) => (
				<Skeleton className="h-3" key={`${index}-${width}`} style={{ width: `${width}%` }} />
			))}
		</div>
	);
}

type DiffRow =
	| { kind: "line"; index: number }
	| { kind: "note"; note: ReviewNote }
	/** The note being written; `lines` null on the whole file. */
	| { kind: "draft"; lines: NoteLines | null }
	/** The row that adds a note on the whole file. */
	| { kind: "file" };

const inRange = (line: number | undefined, range: NoteLines | null) =>
	line !== undefined && range !== null && line >= range.start && line <= range.end;

/** The diff body: virtualized rows under `scroller` (the preview's scrolling ancestor). */
export function DiffLines({
	lines,
	path,
	scroller,
	notes,
}: {
	lines: readonly DiffLine[];
	/** File path the language comes from. */
	path: string;
	scroller: HTMLElement | null;
	/** The session (`notesOwner`) whose review notes the new side takes. */
	notes?: { owner: string };
}) {
	const t = useT();
	const language = languageFromPath(path);
	const [hljs, setHljs] = useState(getLoadedHljs);
	useEffect(() => {
		if (hljs || language === "plaintext") return;
		let cancelled = false;
		void loadHljs().then(loaded => {
			if (!cancelled) setHljs(loaded);
		});
		return () => {
			cancelled = true;
		};
	}, [hljs, language]);
	const tokens = useMemo(() => (hljs ? highlightDiffLines(lines, hljs, language) : null), [lines, hljs, language]);
	// Both gutters fit the longest line number, so a 4-digit number never wraps.
	const gutterDigits = String(
		lines.reduce((max, line) => Math.max(max, line.oldLine ?? 0, line.newLine ?? 0), 0),
	).length;
	const owner = notes?.owner ?? null;
	const allNotes = useReviewNotesStore(state => state.notes);
	const fileNotes = useMemo(
		() =>
			owner
				? allNotes.filter(note => note.owner === owner && note.anchor.kind === "diff" && note.anchor.path === path)
				: [],
		[allNotes, owner, path],
	);
	// The note being written: on lines, on the whole file, or none.
	const [draft, setDraft] = useState<NoteLines | "file" | null>(null);
	// What the person typed in the draft, kept here: the draft's row unmounts while it is scrolled out of view.
	const [draftBody, setDraftBody] = useState("");
	// A drag across the +s: where it started and the line under the pointer now.
	const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
	// The click that ends a drag over another + is not that range's click; it is dropped once, in this task.
	const dragged = useRef(false);
	useEffect(() => {
		if (!drag) return;
		const end = () => {
			if (drag.from !== drag.to) {
				dragged.current = true;
				// A release over another row clicks their common parent, not a +: nothing else clears the flag.
				window.setTimeout(() => {
					dragged.current = false;
				}, 0);
				setDraft({ start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) });
			}
			setDrag(null);
		};
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", end);
		return () => {
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
		};
	}, [drag]);
	// Another file's diff drops the note being written on this one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: path names the file the draft was on.
	useEffect(() => {
		setDraft(null);
		setDraftBody("");
	}, [path]);
	const rows = useMemo<DiffRow[]>(() => {
		// The whole file's notes lead, under the row that adds one; a line's notes follow its last line.
		const wholeFile = fileNotes.filter(note => note.anchor.kind === "diff" && !note.anchor.lines);
		const out: DiffRow[] = owner ? [{ kind: "file" }] : [];
		if (draft === "file") out.push({ kind: "draft", lines: null });
		for (const note of wholeFile) out.push({ kind: "note", note });
		const placed = new Set(wholeFile.map(note => note.id));
		lines.forEach((line, index) => {
			out.push({ kind: "line", index });
			if (line.newLine === undefined) return;
			for (const note of fileNotes) {
				if (note.anchor.kind === "diff" && note.anchor.lines?.end === line.newLine) {
					out.push({ kind: "note", note });
					placed.add(note.id);
				}
			}
			if (draft !== "file" && draft?.end === line.newLine) out.push({ kind: "draft", lines: draft });
		});
		// A note whose line this diff no longer shows (the file changed since) stays reachable at the end.
		for (const note of fileNotes) if (!placed.has(note.id)) out.push({ kind: "note", note });
		return out;
	}, [lines, fileNotes, draft, owner]);
	const marked = drag
		? { start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) }
		: draft === "file"
			? null
			: draft;
	return (
		<div
			className="omp-pane-diff font-mono text-sc-xs leading-(--sc-leading-relaxed)"
			data-highlighted={tokens ? "true" : undefined}
			data-language={language}
			style={{ "--omp-gutter-digits": gutterDigits } as CSSProperties}
		>
			<VirtualRows
				estimate={20}
				itemKey={row =>
					row.kind === "line"
						? row.index
						: row.kind === "note"
							? row.note.id
							: row.kind === "file"
								? "file"
								: "draft"
				}
				items={rows}
				scroller={scroller}
			>
				{row => {
					if (row.kind === "file") {
						return (
							<div className="px-2 py-0.5 font-sans">
								<LinkButton
									className="text-sc-xs"
									data-note-file
									onClick={() => setDraft(current => (current === "file" ? null : "file"))}
									tone="muted"
								>
									{t("reviewNotes.addOnFile")}
								</LinkButton>
							</div>
						);
					}
					if (row.kind === "note") {
						return (
							<div className="border-y border-(--sc-divider) bg-(--sc-surface-2) px-2 font-sans">
								<NoteCard note={row.note} />
							</div>
						);
					}
					if (row.kind === "draft") {
						const anchor = { kind: "diff", path, lines: row.lines } as const;
						const place = noteLabel(t, anchor);
						return (
							<div className="border-y border-(--sc-divider) bg-(--sc-surface-2) font-sans">
								<NoteEditor
									initial={draftBody}
									label={t("reviewNotes.newLabel", { place })}
									onCancel={() => {
										setDraft(null);
										setDraftBody("");
									}}
									onChange={setDraftBody}
									onSave={body => {
										if (owner) useReviewNotesStore.getState().add({ owner, anchor, body });
										setDraft(null);
										setDraftBody("");
									}}
								/>
							</div>
						);
					}
					const index = row.index;
					const line = lines[index] as DiffLine;
					const lineTokens = tokens?.[index];
					const lineNumber = line.newLine;
					return (
						<div
							className={cx(
								"group flex items-start px-2",
								line.type === "add" && "bg-(--sc-success-soft)",
								line.type === "remove" && "bg-(--sc-danger-soft)",
								inRange(lineNumber, marked) && "bg-(--sc-accent-soft)",
							)}
							data-note-marked={inRange(lineNumber, marked) || undefined}
							onPointerEnter={() => {
								if (drag && lineNumber !== undefined) setDrag({ ...drag, to: lineNumber });
							}}
						>
							{owner && (
								<span className="flex w-5 shrink-0 justify-center">
									{lineNumber !== undefined && (
										<IconButton
											className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
											data-note-add={lineNumber}
											icon={<Plus />}
											label={t("reviewNotes.addOnLine", { line: lineNumber })}
											onClick={event => {
												if (dragged.current) {
													dragged.current = false;
													return;
												}
												setDraft(current =>
													event.shiftKey && current && current !== "file"
														? {
																start: Math.min(current.start, lineNumber),
																end: Math.max(current.end, lineNumber),
															}
														: { start: lineNumber, end: lineNumber },
												);
											}}
											onPointerDown={event => {
												if (event.button !== 0 || event.shiftKey || event.pointerType === "touch") return;
												// The pointer moves over other rows: release it so their enter events fire.
												event.currentTarget.releasePointerCapture?.(event.pointerId);
												setDrag({ from: lineNumber, to: lineNumber });
											}}
											size="inline"
										/>
									)}
								</span>
							)}
							<span
								aria-hidden
								className="omp-pane-gutter shrink-0 select-none pr-2 text-right text-(--sc-text-subtle)"
							>
								{line.oldLine}
							</span>
							<span
								aria-hidden
								className="omp-pane-gutter shrink-0 select-none pr-2 text-right text-(--sc-text-subtle)"
							>
								{line.newLine}
							</span>
							<span aria-hidden className="shrink-0 pr-2 text-(--sc-text-subtle)">
								{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
							</span>
							<span className="min-w-0 whitespace-pre-wrap break-words text-(--sc-text)">
								{lineTokens
									? lineTokens.map((token, k) =>
											token.className ? (
												<span className={token.className} key={k}>
													{token.text}
												</span>
											) : (
												token.text
											),
										)
									: line.content}
							</span>
						</div>
					);
				}}
			</VirtualRows>
		</div>
	);
}
