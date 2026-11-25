/**
 * The card a conversation's link shows on hover or keyboard focus (Orca's link peek,
 * `native-chat/links/previews/NativeChatLinkPeek.tsx`, `NativeChatGitHubLinkPeek.tsx`, `NativeChatWebLinkPeek.tsx`,
 * MIT). A GitHub issue or pull request (github.com or an Enterprise host) shows its repository, number, state, title,
 * author and comment count, read with `item_peek` on the tab's computer; when that read fails (no `gh` sign-in for
 * the host) the card falls back to what the page says about itself. Any other https page shows its own title and
 * description, read by the core (`webPeek.get`). Answers are kept per URL for 10 minutes (`lib/link-peek.ts`).
 */
import { CircleDot, GitPullRequest, Globe } from "lucide-react";
import type { HTMLAttributes, ReactElement } from "react";
import type { GithubItemPeek } from "../../../shared/github";
import { useT } from "../../lib/i18n";
import {
	type GithubItemLink,
	githubItemLink,
	githubPeekKey,
	peekableWebUrl,
	peekGithubItem,
	peekWebPage,
	usePeek,
	webPeekKey,
} from "../../lib/link-peek";
import { Badge, type BadgeVariant, HoverCard, Skeleton } from "../common";

const STATE_BADGE: Record<string, BadgeVariant> = {
	open: "success",
	draft: "default",
	merged: "accent",
	closed: "muted",
};

/** GitHub's state in the tool card's words: a draft pull request that is open reads as a draft. */
export function githubItemState(item: Pick<GithubItemPeek, "state" | "isDraft">): string {
	return item.isDraft && item.state === "OPEN" ? "draft" : item.state.toLowerCase();
}

function PeekSkeleton() {
	const t = useT();
	return (
		<div aria-label={t("linkPeek.loading")} className="space-y-1.5" role="status">
			<Skeleton className="h-3.5 w-11/12 rounded-(--sc-radius-xs)" />
			<Skeleton className="h-3 w-1/3 rounded-(--sc-radius-xs)" />
		</div>
	);
}

function WebPeek({ url }: { url: string }) {
	const t = useT();
	const state = usePeek(webPeekKey(url), () => peekWebPage(url));
	const page = state.status === "ready" ? state.value : null;
	return (
		<div className="flex flex-col gap-1.5" data-link-peek="web">
			<div className="flex min-w-0 items-center gap-1.5 text-sc-xs text-(--sc-text-muted)">
				<Globe aria-hidden className="size-3.5 shrink-0" />
				<span className="min-w-0 truncate">{page?.siteName ?? new URL(url).hostname.replace(/^www\./, "")}</span>
			</div>
			{state.status === "loading" ? (
				<PeekSkeleton />
			) : page ? (
				<>
					{page.title && <div className="line-clamp-2 font-semibold">{page.title}</div>}
					{page.description && (
						<div className="line-clamp-3 text-sc-xs text-(--sc-text-secondary)">{page.description}</div>
					)}
				</>
			) : (
				<div className="text-sc-xs text-(--sc-text-muted)">{t("linkPeek.noPreview")}</div>
			)}
		</div>
	);
}

function GithubPeek({ link, href }: { link: GithubItemLink; href: string }) {
	const t = useT();
	const state = usePeek(githubPeekKey(link), () => peekGithubItem(link));
	if (state.status === "failed") {
		const web = peekableWebUrl(href);
		return web ? (
			<WebPeek url={web} />
		) : (
			<div className="text-sc-xs text-(--sc-text-muted)">{t("linkPeek.noPreview")}</div>
		);
	}
	const item = state.status === "ready" ? state.value : null;
	const Icon = (item ? item.isPr : /\/pull\//.test(href)) ? GitPullRequest : CircleDot;
	const word = item && githubItemState(item);
	return (
		<div className="flex flex-col gap-1.5" data-link-peek="github">
			<div className="flex min-w-0 items-center gap-1.5 text-sc-xs text-(--sc-text-muted)">
				<Icon aria-hidden className="size-3.5 shrink-0" />
				<span className="min-w-0 truncate">
					{link.host ? `${link.host}/` : ""}
					{link.repo}
				</span>
				<span className="shrink-0 font-mono">#{link.number}</span>
				{word && (
					<Badge className="ml-auto" size="xs" variant={STATE_BADGE[word] ?? "default"}>
						{t(`tools.github.state.${word}`)}
					</Badge>
				)}
			</div>
			{item ? (
				<>
					<div className="line-clamp-2 font-semibold">{item.title}</div>
					<div className="text-sc-xs text-(--sc-text-muted)">
						{[
							item.author && t("linkPeek.byAuthor", { author: item.author }),
							t("linkPeek.comments", { count: item.comments }),
						]
							.filter(Boolean)
							.join(" · ")}
					</div>
				</>
			) : (
				<PeekSkeleton />
			)}
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
	const github = href ? githubItemLink(href) : null;
	const web = href && !github ? peekableWebUrl(href) : null;
	const content = github && href ? <GithubPeek href={href} link={github} /> : web ? <WebPeek url={web} /> : null;
	return content ? <HoverCard content={content}>{children}</HoverCard> : children;
}
