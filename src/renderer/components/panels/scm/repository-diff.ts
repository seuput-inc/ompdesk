import { parseDiff } from "../../../lib/diff";

/** A repository diff's lines without git's metadata (chrome, not source); the shared tool diff renderer is unchanged. */
export function parseRepositoryDiff(diff: string) {
	return parseDiff(
		diff
			.split("\n")
			.filter(
				line =>
					!/^(diff --git |index |(?:new|deleted) file mode |(?:old|new) mode |similarity index |rename (?:from|to) )/.test(
						line,
					),
			)
			.join("\n"),
	);
}

/** Where each change starts: the first changed line after an unchanged one (previous/next change). */
export function changeStarts(lines: readonly { type: string }[]): number[] {
	return lines.flatMap((line, index) =>
		line.type !== "context" && (index === 0 || lines[index - 1]?.type === "context") ? [index] : [],
	);
}
