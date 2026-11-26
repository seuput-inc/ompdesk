/**
 * A changed picture side by side (Orca's image diff, `diff/large-files/*`, FR82): the before side as git holds it at the
 * range's start (`get_git_image`: HEAD, or the base range's merge-base) and the after side as the Files viewer reads
 * the file on disk (`fs.readImage`, also on a paired host's tab). A side that does not exist says so.
 */
import { useEffect, useState } from "react";
import type { RpcGitImage } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import type { TabRpc } from "../../../lib/tab-rpc";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { Card, Skeleton, ZoomableImage } from "../../common";

type Sides = { before: string | null; after: string | null };

export function ImageDiff({
	rpc,
	root,
	path,
	oldPath,
	against,
}: {
	rpc: TabRpc;
	/** The checkout root the paths are relative to. */
	root: string;
	path: string;
	oldPath?: string;
	against?: string;
}) {
	const t = useT();
	const tabId = useRuntimeTabId();
	const [sides, setSides] = useState<Sides | null>(null);
	useEffect(() => {
		let active = true;
		setSides(null);
		const before = rpc
			.command({ type: "get_git_image", path: oldPath ?? path, ...(against ? { against } : {}) })
			.then(response => (response.success ? ((response.data as RpcGitImage).before ?? null) : null))
			.catch(() => null);
		const file = `${root.replace(/[\\/]+$/, "")}/${path}`;
		const after = (tabId ? window.omp.fs.readImage(file, tabId) : window.omp.fs.readImage(file))
			.then(result => (result.ok ? result.dataUrl : null))
			.catch(() => null);
		void Promise.all([before, after]).then(([beforeUrl, afterUrl]) => {
			if (active) setSides({ before: beforeUrl, after: afterUrl });
		});
		return () => {
			active = false;
		};
	}, [rpc, root, path, oldPath, against, tabId]);
	const side = (label: string, url: string | null | undefined, missing: string) => (
		<Card className="flex min-w-0 flex-1 flex-col gap-2" padding="sm">
			<span className="text-sc-xs text-(--sc-text-muted)">{label}</span>
			{url === undefined ? (
				<Skeleton className="h-32 w-full" />
			) : url ? (
				<ZoomableImage alt={`${label}: ${path}`} className="max-h-80 w-full object-contain" src={url} />
			) : (
				<p className="text-sc-sm text-(--sc-text-muted)">{missing}</p>
			)}
		</Card>
	);
	return (
		<div className="flex flex-wrap gap-2 p-3" data-image-diff>
			{side(t("scm.image.before"), sides ? sides.before : undefined, t("scm.image.noBefore"))}
			{side(t("scm.image.after"), sides ? sides.after : undefined, t("scm.image.noAfter"))}
		</div>
	);
}
