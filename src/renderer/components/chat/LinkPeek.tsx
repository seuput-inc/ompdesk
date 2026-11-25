/**
 * The card a conversation's link shows on hover or keyboard focus (Orca's link peek,
 * `native-chat/links/previews/NativeChatLinkPeek.tsx`, `NativeChatGitHubLinkPeek.tsx`, `NativeChatWebLinkPeek.tsx`,
 * MIT). A GitHub issue or pull request (github.com or an Enterprise host) shows its repository, number, state, title,
 * author and comment count, read with `item_peek` on the tab's computer; when that read fails (no `gh` sign-in for
 * the host) the card falls back to what the page says about itself. Any other https page shows its own title and
 * description, read by the core (`webPeek.get`). Answers are kept per URL for 10 minutes (`lib/link-peek.ts`).
 *
 * Every Markdown link wears this wrapper, so it stays light: the card's body (`LinkPeekCard.tsx`, with the reads) loads
 * the first time a card opens, which keeps the paired phone's first screen within its budget.
 */
import { type HTMLAttributes, lazy, type ReactElement, Suspense } from "react";
import type { GithubItemPeek } from "../../../shared/github";
import { githubItemLink, peekableWebUrl } from "../../../shared/session-links";
import { useT } from "../../lib/i18n";
import { HoverCard, Skeleton } from "../common";

const LinkPeekCard = lazy(() => import("./LinkPeekCard"));

/** GitHub's state in the tool card's words: a draft pull request that is open reads as a draft. */
export function githubItemState(item: Pick<GithubItemPeek, "state" | "isDraft">): string {
	return item.isDraft && item.state === "OPEN" ? "draft" : item.state.toLowerCase();
}

export function PeekSkeleton() {
	const t = useT();
	return (
		<div aria-label={t("linkPeek.loading")} className="space-y-1.5" role="status">
			<Skeleton className="h-3.5 w-11/12 rounded-(--sc-radius-xs)" />
			<Skeleton className="h-3 w-1/3 rounded-(--sc-radius-xs)" />
		</div>
	);
}

/** `children` (the link) with its card, or alone when `href` is no GitHub item and no https page. */
export function LinkPeek({
	href,
	children,
}: {
	href: string | undefined;
	children: ReactElement<HTMLAttributes<HTMLElement>>;
}) {
	if (!href || (!githubItemLink(href) && !peekableWebUrl(href))) return children;
	return (
		<HoverCard
			content={
				<Suspense fallback={<PeekSkeleton />}>
					<LinkPeekCard href={href} />
				</Suspense>
			}
		>
			{children}
		</HoverCard>
	);
}
