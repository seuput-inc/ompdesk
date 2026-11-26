/**
 * The one message review notes leave in (`stores/review-notes.ts`). A file's notes use Orca's quote-safe block
 * (`shared/file-review/diff-comments-format.ts` `formatDiffComment`, MIT): `File:`, the place (`Line:`, `Lines:` or
 * `Scope: file`), a Files-viewer passage's `Excerpt:` (its line numbers go stale once the file changes; the text still
 * finds it, so it is always sent) and the comment as one escaped JSON-like string, so a note cannot break out of its
 * block. A Preview page's notes keep the Preview's numbered list under the page's header, region screenshots as images.
 */
import type { ImageContent } from "../../shared/rpc-types";
import type { NoteLines, ReviewNote, ReviewNoteAnchor } from "../stores/review-notes";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type PreviewAnchor = Extract<ReviewNoteAnchor, { kind: "preview" }>;
type FileAnchor = Exclude<ReviewNoteAnchor, PreviewAnchor>;

/** Excerpt lines sent whole; a longer passage keeps its first and last four around "...". */
const EXCERPT_LINES = 8;

export function escapeNoteBody(body: string): string {
	return body.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

/** `> ` before every line of the passage, at most `EXCERPT_LINES` of them. */
export function quoteExcerpt(text: string): string {
	const lines = text.trim().split(/\r\n|\r|\n/);
	const kept =
		lines.length <= EXCERPT_LINES
			? lines
			: [...lines.slice(0, EXCERPT_LINES / 2), "...", ...lines.slice(-EXCERPT_LINES / 2)];
	return kept.map(line => `> ${line}`).join("\n");
}

function placeLabel(lines: NoteLines | null): string {
	if (!lines) return "Scope: file";
	return lines.start === lines.end ? `Line: ${lines.start}` : `Lines: ${lines.start}-${lines.end}`;
}

export function formatFileNote(anchor: FileAnchor, body: string): string {
	const parts = [`File: ${anchor.path}`];
	if (anchor.kind === "text") {
		if (anchor.markdown) parts.push("Source: markdown");
		if (anchor.lines) parts.push(placeLabel(anchor.lines));
		if (anchor.excerpt.trim()) parts.push(`Excerpt:\n${quoteExcerpt(anchor.excerpt)}`);
	} else {
		parts.push(placeLabel(anchor.lines));
	}
	parts.push(`User comment: "${escapeNoteBody(body)}"`);
	return parts.join("\n");
}

/** A Preview page's lines: its header, then each note numbered as its pin. Images are appended to `images`. */
export function previewPageLines(
	t: Translate,
	page: { title: string; url: string },
	notes: readonly { anchor: Pick<PreviewAnchor, "n" | "pick" | "elements" | "image">; body: string }[],
	images: ImageContent[],
): string[] {
	const lines = [t("panel.preview.feedback.header", { title: page.title || page.url, url: page.url })];
	for (const { anchor, body } of [...notes].sort((a, b) => a.anchor.n - b.anchor.n)) {
		const comment = body.trim() ? ` — ${body.trim()}` : "";
		if (anchor.pick === "element") {
			const [element] = anchor.elements;
			const text = element?.text ? ` "${element.text}"` : "";
			lines.push(`${anchor.n}. <${element?.tag}> \`${element?.selector}\`${text}${comment}`);
		} else {
			if (anchor.image) images.push({ type: "image", data: anchor.image, mimeType: "image/png" });
			const shown = anchor.elements.map(element => `\`${element.selector}\``).join(", ");
			lines.push(
				`${anchor.n}. ${t("panel.preview.feedback.regionLine", { image: images.length, elements: shown || "—" })}${comment}`,
			);
		}
	}
	return lines;
}

/** Every note in one message: the files' notes by path and line, then each Preview page's. */
export function reviewNotesMessage(
	t: Translate,
	notes: readonly ReviewNote[],
): { text: string; images: ImageContent[] } {
	const files: { anchor: FileAnchor; body: string; createdAt: number }[] = [];
	const pages = new Map<string, { anchor: PreviewAnchor; body: string }[]>();
	for (const note of notes) {
		if (note.anchor.kind === "preview") {
			const group = pages.get(note.anchor.page) ?? [];
			group.push({ anchor: note.anchor, body: note.body });
			pages.set(note.anchor.page, group);
		} else files.push({ anchor: note.anchor, body: note.body, createdAt: note.createdAt });
	}
	files.sort(
		(a, b) =>
			a.anchor.path.localeCompare(b.anchor.path) ||
			(a.anchor.lines?.start ?? 0) - (b.anchor.lines?.start ?? 0) ||
			a.createdAt - b.createdAt,
	);
	const blocks: string[] = [];
	if (files.length > 0) {
		blocks.push(
			[t("reviewNotes.message.header"), ...files.map(file => formatFileNote(file.anchor, file.body))].join("\n\n"),
		);
	}
	const images: ImageContent[] = [];
	for (const group of pages.values()) {
		const [first] = group;
		if (first) blocks.push(previewPageLines(t, first.anchor, group, images).join("\n"));
	}
	return { text: blocks.join("\n\n"), images };
}

/** A note's place in a few words for its card: the file and line, or the Preview page and pin. */
export function noteLabel(t: Translate, anchor: ReviewNoteAnchor): string {
	if (anchor.kind === "preview")
		return t("reviewNotes.place.preview", { n: anchor.n, page: anchor.title || anchor.url });
	if (!anchor.lines) return t("reviewNotes.place.file");
	return anchor.lines.start === anchor.lines.end
		? t("reviewNotes.place.line", { line: anchor.lines.start })
		: t("reviewNotes.place.lines", { start: anchor.lines.start, end: anchor.lines.end });
}
