/**
 * The desktop status bar (Orca's 24 px bar under the whole window, the owner's decision of 25 Nov 2026): a desktop
 * window only (this computer's and a paired computer's view); a phone or tablet page has none. The bar itself is on the
 * first frame (its height never arrives late); its items come with their own chunk (`StatusBarSegments`).
 */
import { type ComponentType, useEffect, useState } from "react";
import { useShellMode } from "../../../hooks/use-shell-mode";
import { loadChunk } from "../../../lib/chunk-load";
import { useT } from "../../../lib/i18n";

type SegmentsComponent = ComponentType<{ sessionStats: boolean }>;
let loaded: SegmentsComponent | null = null;

export function StatusBar({ sessionStats }: { sessionStats: boolean }) {
	const t = useT();
	const desktop = useShellMode() === null;
	const [Segments, setSegments] = useState<SegmentsComponent | null>(() => loaded);
	useEffect(() => {
		if (!desktop || Segments) return;
		let live = true;
		loadChunk(() => import("./StatusBarSegments"))
			.then(module => {
				loaded = module.StatusBarSegments;
				if (live) setSegments(() => module.StatusBarSegments);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [desktop, Segments]);
	if (!desktop) return null;
	return (
		<footer
			aria-label={t("statusBar.label")}
			className="omp-status-bar flex h-(--sc-statusbar-h) shrink-0 items-center border-t border-(--sc-divider) bg-(--sc-surface-1) px-3"
			data-status-bar
		>
			{Segments && <Segments sessionStats={sessionStats} />}
		</footer>
	);
}
