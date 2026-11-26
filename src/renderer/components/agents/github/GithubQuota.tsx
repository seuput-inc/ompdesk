/**
 * The GitHub API quota of the chosen host (Orca `github/github-rate-limit-display.tsx`,
 * `source-control/GitProviderApiBudgetPane.tsx`): REST, GraphQL and search, each as left of its limit and when it
 * resets. Read when the popover opens (`gh api rate_limit`, which spends nothing), never on a timer.
 */
import { Gauge } from "lucide-react";
import { useRef, useState } from "react";
import type { GithubRateResource, GithubTarget } from "../../../../shared/github";
import { formatClock, uiLocale } from "../../../lib/format";
import { github } from "../../../lib/github";
import { useT } from "../../../lib/i18n";
import { Button, ErrorDetail, Popover, ProgressBar, SkeletonRows } from "../../common";

export function GithubQuota({ target }: { target: GithubTarget }) {
	const t = useT();
	const anchor = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [rows, setRows] = useState<GithubRateResource[] | null>(null);
	const [error, setError] = useState<unknown>(null);
	const read = () => {
		setOpen(true);
		setError(null);
		github({ op: "rate_limit", ...(target.host ? { host: target.host } : {}) }).then(setRows, setError);
	};
	const number = (value: number) => value.toLocaleString(uiLocale());
	return (
		<>
			<Button icon={<Gauge />} onClick={read} ref={anchor} size="sm" variant="ghost">
				{t("github.quota.open")}
			</Button>
			<Popover anchorRef={anchor} ariaLabel={t("github.quota.title")} onClose={() => setOpen(false)} open={open}>
				<div className="flex w-72 flex-col gap-3" data-github-quota>
					<p className="text-sc-sm font-semibold text-(--sc-text)">{t("github.quota.title")}</p>
					{error ? (
						<ErrorDetail error={error} />
					) : !rows ? (
						<SkeletonRows label={t("github.quota.reading")} widths={[90, 90, 90]} />
					) : (
						rows.map(row => (
							<div className="flex flex-col gap-1" key={row.name}>
								<ProgressBar
									label={t(`github.quota.${row.name}`)}
									labelCase="keep"
									value={row.limit > 0 ? row.remaining / row.limit : 0}
									valueText={t("github.quota.left", { left: number(row.remaining), limit: number(row.limit) })}
								/>
								<span className="text-sc-xs text-(--sc-text-muted)">
									{t("github.quota.resets", { time: formatClock(row.reset * 1000) })}
								</span>
							</div>
						))
					)}
				</div>
			</Popover>
		</>
	);
}
