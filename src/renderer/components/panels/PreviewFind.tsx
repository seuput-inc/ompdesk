/**
 * Find in the Preview's page (Orca's `browser-pane/find/BrowserFind.tsx`; the Tauri host's Chromium has no
 * `findInPage`, so main's page tools find the text, `page-scripts.ts` `find`): as typed from the top, then step by
 * step; closing clears the page's selection. A row in the panel's flow, never over the page, which the host draws
 * above the window's own content.
 */
import { useEffect, useRef, useState } from "react";
import type { PreviewFindResult } from "../../../shared/preview";
import { useT } from "../../lib/i18n";
import { FindBar } from "../common";

export function PreviewFind({ onClose }: { onClose: () => void }) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [result, setResult] = useState<PreviewFindResult | null>(null);
	/** Answers to an older query or step never overwrite a newer one. */
	const asked = useRef(0);
	const find = (step: -1 | 0 | 1, text: string) => {
		const ask = ++asked.current;
		if (!text) {
			setResult(null);
			void window.omp.preview.page({ action: "findStop" }).catch(() => undefined);
			return;
		}
		window.omp.preview.page({ action: "find", query: text, step }).then(
			found => {
				if (ask === asked.current) setResult(found);
			},
			() => {
				if (ask === asked.current) setResult(null);
			},
		);
	};
	useEffect(
		() => () => {
			void window.omp.preview.page({ action: "findStop" }).catch(() => undefined);
		},
		[],
	);
	return (
		<FindBar
			autoFocus
			canStep={Boolean(result?.total)}
			className="flex min-w-0 shrink-0 items-center gap-1 border-b border-(--sc-divider) px-3 py-1.5"
			closeLabel={t("panel.preview.findClose")}
			data-preview-find
			label={t("panel.preview.findField")}
			nextLabel={t("panel.preview.findNext")}
			onClose={onClose}
			onQuery={text => {
				setQuery(text);
				find(0, text);
			}}
			onStep={direction => find(direction, query)}
			previousLabel={t("panel.preview.findPrevious")}
			query={query}
			status={
				!query
					? ""
					: result?.total
						? t("panel.preview.findCount", { active: result.active, total: result.total })
						: t("panel.preview.findNone")
			}
		/>
	);
}
