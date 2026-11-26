/**
 * The body of a link's card (`LinkPeek.tsx`), loaded the first time a card opens so the conversation's first screen
 * carries only the hover wrapper. A GitHub issue or pull request reads `item_peek` and falls back to the page's own
 * words when that fails; any other https page shows its title and description (`webPeek.get`).
 */
import { CircleDot, GitPullRequest, Globe } from "lucide-react";
import { type GithubItemLink, githubItemLink, peekableWebUrl } from "../../../shared/session-links";
import { useT } from "../../lib/i18n";
import { githubPeekKey, peekGithubItem, peekWebPage, usePeek, webPeekKey } from "../../lib/link-peek";
import { Badge, type BadgeVariant } from "../common";
import { githubItemState, PeekSkeleton } from "./LinkPeek";

const STATE_BADGE: Record<string, BadgeVariant> = {
	open: "success",
	draft: "default",
	merged: "accent",
	closed: "muted",
};

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

/** The card for `href`: its GitHub item, else its page (LinkPeek only opens one for a link that has either). */
export default function LinkPeekCard({ href }: { href: string }) {
	const github = githubItemLink(href);
	if (github) return <GithubPeek href={href} link={github} />;
	const web = peekableWebUrl(href);
	return web ? <WebPeek url={web} /> : null;
}
