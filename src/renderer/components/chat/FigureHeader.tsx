import type { ReactNode } from "react";

/**
 * The one-line header on the top edge of a box (code block, figure, visual): the
 * title on the left, optional quiet metadata beside it, icon actions on the right,
 * `--sc-control-sm` high.
 */
export function FigureHeader({ title, meta, children }: { title?: string; meta?: ReactNode; children?: ReactNode }) {
	return (
		<div
			className="omp-figure-header flex min-h-(--sc-control-sm) items-center justify-between gap-2 border-b border-(--sc-divider) ps-3 pe-1"
			data-figure-header
		>
			{title !== undefined && (
				<span className="min-w-0 truncate text-sc-xs font-medium text-(--sc-text-muted)" data-figure-title>
					{title}
				</span>
			)}
			{meta !== undefined && (
				<span
					className="omp-figure-meta shrink-0 text-sc-2xs tabular-nums text-(--sc-text-subtle)"
					data-figure-meta
				>
					{meta}
				</span>
			)}
			<div className="ms-auto flex shrink-0 items-center gap-0.5" data-figure-actions>
				{children}
			</div>
		</div>
	);
}
