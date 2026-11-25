import { resultText } from "../../../lib/format";
import { MarkdownRenderer } from "../../../lib/markdown";
import type { ToolRendererProps } from "../ToolCard";
import { ToolResultBody } from "./GenericRenderer";

/** The prose a note-like device write carries, whatever key its payload used. */
function noteText(args: Record<string, unknown>): string {
	for (const key of ["content", "plan", "text", "message", "body", "title", "report"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

/**
 * `propose` and `report_issue`, including old `xd://` writes: a proposal title (or legacy plan text)
 * as markdown, an issue report as text, then the tool's reply when stock includes it.
 */
export function DeviceNoteRenderer({
	args,
	result,
	isError,
	isPartial,
	markdown,
}: ToolRendererProps & { markdown?: boolean }) {
	const note = noteText(args);
	const reply = isPartial || result == null ? "" : resultText(result);
	return (
		<div className="flex flex-col gap-1.5" data-tool-device-note>
			{note &&
				(markdown ? (
					<div className="text-sc-sm">
						<MarkdownRenderer content={note} />
					</div>
				) : (
					<div className="whitespace-pre-wrap break-words text-sc-sm text-(--sc-text-secondary)">{note}</div>
				))}
			{reply.trim() && reply.trim() !== note.trim() && <ToolResultBody isError={isError} text={reply} />}
		</div>
	);
}
