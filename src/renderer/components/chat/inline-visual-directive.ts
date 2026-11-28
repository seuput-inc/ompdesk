/**
 * Inline visual directive & fenced-block parser (Orca's `native-chat-visual-directive.ts` +
 * `native-chat-visual-markdown-syntax.ts`, MIT).
 *
 * Supports:
 * 1. Standalone directive lines outside fenced code blocks:
 *    `::orca-visual{file="chart.html" title="Latency Comparison"}`
 *    `::momo-visual{file="chart.html" title="Latency Comparison"}`
 * 2. Fenced inline HTML visuals for self-contained interactive snippets:
 *    ```orca-visual title="Latency Comparison"
 *    <div>...</div>
 *    ```
 *    (and ```momo-visual ... ```)
 *
 * Kept tiny and dependency-free so the eager chat stream bundle stays well within budget;
 * the heavy iframe shell and card UI load lazily only when a message contains a visual.
 */

export const MAX_VISUAL_DIRECTIVES_PER_MESSAGE = 8;
export const MAX_VISUAL_DIRECTIVE_LINE_LENGTH = 512;
export const MAX_VISUAL_FILE_LENGTH = 128;
export const MAX_VISUAL_TITLE_LENGTH = 120;

export type VisualDirectivePrefix = "orca" | "momo";

export interface FileVisualSpec {
	kind: "file";
	prefix: VisualDirectivePrefix;
	file: string;
	title?: string;
	raw: string;
}

export interface InlineHtmlVisualSpec {
	kind: "inline";
	prefix: VisualDirectivePrefix;
	html: string;
	title?: string;
	raw: string;
}

export type InlineVisualSpec = FileVisualSpec | InlineHtmlVisualSpec;

export type MarkdownVisualSegment = { kind: "markdown"; content: string } | { kind: "visual"; spec: InlineVisualSpec };

const DIRECTIVE_LINE_RE = /^::(orca|momo)-visual\{([^{}\r\n]*)\}$/;
const ATTR_TOKEN_RE = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"\r\n\\]*)"/g;
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/;
const FENCE_VISUAL_INFO_RE = /^(orca|momo)-visual(?:\s+(.*))?$/;
const PENDING_DIRECTIVE_TAIL_RE =
	/^ {0,3}:(?::(?:o(?:r(?:c(?:a(?:-visual(?:\{[^}\r\n]*)?)?)?)?)?|m(?:o(?:m(?:o(?:-visual(?:\{[^}\r\n]*)?)?)?)?)?)?)?$/;

/** Fast substring guard so regular chat turns never allocate or scan line-by-line. */
export function hasVisualDirective(text: string): boolean {
	if (!text) return false;
	return (
		text.includes("::orca-visual{") ||
		text.includes("::momo-visual{") ||
		text.includes("```orca-visual") ||
		text.includes("```momo-visual") ||
		text.includes("~~~orca-visual") ||
		text.includes("~~~momo-visual")
	);
}

/** Validate a visual file basename: flat `.html` filename only, no traversal or device names. */
export function isValidVisualFileName(file: string): boolean {
	if (!file || file.length > MAX_VISUAL_FILE_LENGTH) return false;
	if (file !== file.trim()) return false;
	if (file.includes("/") || file.includes("\\") || file.includes("..")) return false;
	if (/[\x00-\x1f\x7f]/.test(file)) return false;
	if (!/\.html$/i.test(file) || file.length <= 5) return false;
	if (file.startsWith(".")) return false;
	if (WINDOWS_RESERVED_RE.test(file)) return false;
	return true;
}

function normalizeVisualTitle(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const collapsed = raw.replace(/\s+/g, " ").trim();
	if (!collapsed) return undefined;
	return collapsed.length > MAX_VISUAL_TITLE_LENGTH ? collapsed.slice(0, MAX_VISUAL_TITLE_LENGTH) : collapsed;
}

/** Parse strict `key="value"` attributes inside `{...}` or a fenced visual info string. */
function parseVisualAttributes(input: string): Record<string, string> | null {
	const trimmed = input.trim();
	if (!trimmed) return {};
	const attrs: Record<string, string> = {};
	let cursor = 0;
	ATTR_TOKEN_RE.lastIndex = 0;
	while (cursor < trimmed.length) {
		while (cursor < trimmed.length && (trimmed[cursor] === " " || trimmed[cursor] === "\t")) cursor++;
		if (cursor >= trimmed.length) break;
		ATTR_TOKEN_RE.lastIndex = cursor;
		const match = ATTR_TOKEN_RE.exec(trimmed);
		if (!match || match.index !== cursor) return null;
		const key = match[1];
		const value = match[2];
		if (!key || value === undefined || key in attrs) return null;
		attrs[key] = value;
		cursor = match.index + match[0].length;
		if (cursor < trimmed.length && trimmed[cursor] !== " " && trimmed[cursor] !== "\t") return null;
	}
	return attrs;
}

/** Parse a single standalone `::orca-visual{...}` / `::momo-visual{...}` directive line. */
export function parseVisualDirectiveLine(line: string): FileVisualSpec | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed.length > MAX_VISUAL_DIRECTIVE_LINE_LENGTH) return null;
	const match = DIRECTIVE_LINE_RE.exec(trimmed);
	if (!match) return null;
	const prefix = match[1] as VisualDirectivePrefix;
	const attrs = parseVisualAttributes(match[2] ?? "");
	if (!attrs) return null;
	for (const key of Object.keys(attrs)) {
		if (key !== "file" && key !== "title") return null;
	}
	const file = attrs.file ?? "";
	if (!isValidVisualFileName(file)) return null;
	const title = normalizeVisualTitle(attrs.title);
	return { kind: "file", prefix, file, ...(title ? { title } : {}), raw: trimmed };
}

function isClosingFence(line: string, char: string, minLength: number): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	if (!match) return false;
	const run = match[1] ?? "";
	return run[0] === char && run.length >= minLength;
}

/**
 * Split markdown into alternating prose and inline visual segments while respecting
 * CommonMark fenced code blocks (example directives inside normal fences stay literal).
 */
export function splitMarkdownVisualSegments(markdown: string): MarkdownVisualSegment[] {
	if (!hasVisualDirective(markdown)) return markdown ? [{ kind: "markdown", content: markdown }] : [];

	const lines = markdown.split(/\r?\n/);
	const segments: MarkdownVisualSegment[] = [];
	const markdownLines: string[] = [];
	let visualCount = 0;

	let fence: { char: string; length: number } | null = null;
	let inlineVisual: {
		char: string;
		length: number;
		prefix: VisualDirectivePrefix;
		title?: string;
		openLine: string;
		body: string[];
	} | null = null;

	const flushMarkdown = () => {
		if (markdownLines.length === 0) return;
		const content = markdownLines.join("\n").replace(/^\n+|\n+$/g, "");
		markdownLines.length = 0;
		if (content.trim().length > 0) {
			segments.push({ kind: "markdown", content });
		}
	};

	for (const line of lines) {
		if (inlineVisual) {
			if (isClosingFence(line, inlineVisual.char, inlineVisual.length)) {
				const html = inlineVisual.body.join("\n").trim();
				if (html && visualCount < MAX_VISUAL_DIRECTIVES_PER_MESSAGE) {
					flushMarkdown();
					visualCount++;
					segments.push({
						kind: "visual",
						spec: {
							kind: "inline",
							prefix: inlineVisual.prefix,
							html,
							...(inlineVisual.title ? { title: inlineVisual.title } : {}),
							raw: [inlineVisual.openLine, ...inlineVisual.body, line].join("\n"),
						},
					});
				} else {
					markdownLines.push(inlineVisual.openLine, ...inlineVisual.body, line);
				}
				inlineVisual = null;
				continue;
			}
			inlineVisual.body.push(line);
			continue;
		}

		if (fence) {
			markdownLines.push(line);
			if (isClosingFence(line, fence.char, fence.length)) {
				fence = null;
			}
			continue;
		}

		const fenceMatch = FENCE_OPEN_RE.exec(line);
		if (fenceMatch) {
			const run = fenceMatch[1] ?? "```";
			const info = (fenceMatch[2] ?? "").trim();
			const visualInfo = FENCE_VISUAL_INFO_RE.exec(info);
			if (visualInfo && visualCount < MAX_VISUAL_DIRECTIVES_PER_MESSAGE) {
				const attrs = parseVisualAttributes(visualInfo[2] ?? "");
				const validAttrKeys = attrs !== null && Object.keys(attrs).every(key => key === "title");
				if (validAttrKeys) {
					inlineVisual = {
						char: run[0] ?? "`",
						length: run.length,
						prefix: visualInfo[1] as VisualDirectivePrefix,
						title: normalizeVisualTitle(attrs?.title),
						openLine: line,
						body: [],
					};
					continue;
				}
			}
			fence = { char: run[0] ?? "`", length: run.length };
			markdownLines.push(line);
			continue;
		}

		if (visualCount < MAX_VISUAL_DIRECTIVES_PER_MESSAGE) {
			const directive = parseVisualDirectiveLine(line);
			if (directive) {
				flushMarkdown();
				visualCount++;
				segments.push({ kind: "visual", spec: directive });
				continue;
			}
		}

		markdownLines.push(line);
	}

	if (inlineVisual) {
		// Unclosed inline visual fence (e.g. mid-stream): keep as plain markdown until closed.
		markdownLines.push(inlineVisual.openLine, ...inlineVisual.body);
	}
	flushMarkdown();
	return segments;
}

/**
 * While streaming, hold back a trailing incomplete `::orca-visual{...` or `::momo-visual{...`
 * line outside code fences so raw directive syntax does not flash before the closing `}`.
 */
export function withoutPendingVisualDirectiveTail(text: string): string {
	if (!text) return text;
	const lines = text.split(/\r?\n/);
	let fence: { char: string; length: number } | null = null;
	for (let i = 0; i < lines.length - 1; i++) {
		const line = lines[i] ?? "";
		if (fence) {
			if (isClosingFence(line, fence.char, fence.length)) fence = null;
			continue;
		}
		const match = FENCE_OPEN_RE.exec(line);
		if (match) {
			const run = match[1] ?? "```";
			fence = { char: run[0] ?? "`", length: run.length };
		}
	}
	if (fence) return text;
	const lastLine = lines[lines.length - 1] ?? "";
	if (PENDING_DIRECTIVE_TAIL_RE.test(lastLine)) {
		return lines.slice(0, -1).join("\n");
	}
	return text;
}

/** Strip standalone valid visual directives when copying a message as plain text. */
export function stripVisualDirectiveLines(text: string): string {
	if (!hasVisualDirective(text)) return text;
	const lines = text.split(/\r?\n/);
	const kept: string[] = [];
	let fence: { char: string; length: number } | null = null;
	for (const line of lines) {
		if (fence) {
			kept.push(line);
			if (isClosingFence(line, fence.char, fence.length)) fence = null;
			continue;
		}
		const match = FENCE_OPEN_RE.exec(line);
		if (match) {
			const run = match[1] ?? "```";
			fence = { char: run[0] ?? "`", length: run.length };
			kept.push(line);
			continue;
		}
		if (parseVisualDirectiveLine(line)) continue;
		kept.push(line);
	}
	return kept
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
