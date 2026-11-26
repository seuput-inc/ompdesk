/**
 * The stack a pull request sits in (Orca `hosted-review/provider-actions/GitHubPRStackMap.tsx`): the PRs under it,
 * whose heads are the bases above them, and the open ones built on its head, top first as Orca draws them, each with
 * its state; a press opens that PR here. Nothing shows for a PR that stands alone.
 */
import { GitPullRequest } from "lucide-react";
import type { GithubStackEntry } from "../../../../shared/github";
import { useGithubLoad } from "../../../lib/github";
import { useT } from "../../../lib/i18n";
import { usePrCenterStore } from "../../../stores/pr-center";
import { Badge, Card, ListRow } from "../../common";

function stateKey(entry: GithubStackEntry): string {
	if (entry.state === "MERGED") return "merged";
	if (entry.state === "CLOSED") return "closed";
	return entry.isDraft ? "draft" : "open";
}

export function PrStack({ number }: { number: number }) {
	const t = useT();
	const load = useGithubLoad({ op: "pr_stack", number }, String(number));
	const entries = load.data ?? [];
	if (entries.length === 0) return null;
	return (
		<section aria-label={t("prCenter.stack.title")} className="flex flex-col gap-2" data-pr-stack>
			<h3 className="text-sc-md font-semibold text-(--sc-text)">
				{t("prCenter.stack.title")} <span className="font-normal text-(--sc-text-muted)">({entries.length})</span>
			</h3>
			<Card padding="sm">
				<ul className="flex flex-col gap-0.5">
					{[...entries].reverse().map(entry => (
						<li key={entry.number}>
							<ListRow
								description={`${entry.headRefName} → ${entry.baseRefName}`}
								leading={<GitPullRequest aria-hidden />}
								onClick={
									entry.current ? undefined : () => void usePrCenterStore.getState().select(entry.number)
								}
								selected={entry.current}
								size="sm"
								title={`#${entry.number} ${entry.title}`}
								trailing={<Badge size="xs">{t(`prCenter.stack.state.${stateKey(entry)}`)}</Badge>}
							/>
						</li>
					))}
				</ul>
			</Card>
		</section>
	);
}
