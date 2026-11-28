/**
 * Chat turn markdown wrapper that keeps ordinary replies on the exact `MarkdownRenderer`
 * fast path while interleaving lazy-loaded sandboxed HTML visuals (`::orca-visual{...}`,
 * `::momo-visual{...}`, or fenced `orca-visual`/`momo-visual` blocks) on demand.
 */

import { lazy, Suspense, useMemo } from "react";
import { MarkdownRenderer } from "../../lib/markdown";
import { Skeleton } from "../common";
import { hasVisualDirective, splitMarkdownVisualSegments } from "./inline-visual-directive";

const LazyInlineVisualCard = lazy(() => import("./InlineVisualCard"));

export interface ChatMarkdownProps {
	content: string;
	streaming?: boolean;
	userText?: boolean;
}

export function ChatMarkdown({ content, streaming, userText }: ChatMarkdownProps) {
	const hasVisual = !userText && hasVisualDirective(content);
	const segments = useMemo(() => (hasVisual ? splitMarkdownVisualSegments(content) : null), [content, hasVisual]);

	if (!segments) {
		return <MarkdownRenderer content={content} streaming={streaming} userText={userText} />;
	}

	return (
		<>
			{segments.map((segment, index) =>
				segment.kind === "markdown" ? (
					<MarkdownRenderer
						content={segment.content}
						key={`md-${index}`}
						streaming={streaming && index === segments.length - 1}
					/>
				) : (
					<Suspense
						fallback={<Skeleton className="my-2 h-48 w-full rounded-(--sc-radius-lg)" />}
						key={`vis-${index}-${segment.spec.kind === "file" ? segment.spec.file : "inline"}`}
					>
						<LazyInlineVisualCard spec={segment.spec} />
					</Suspense>
				),
			)}
		</>
	);
}
