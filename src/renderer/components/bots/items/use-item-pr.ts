/**
 * A linked pull request's state as fresh as this window knows it (Orca's `use-bot-item-live-pr.ts:1-105`, MIT,
 * re-implemented; C2-38): the newer of two reads. One is the item page's own read of the PR (`item_peek` on this
 * computer's `gh`, read again each minute while the page shows, so its PRs count as visible for refresh); the other is
 * the PR center's branch reads (`stores/branch-prs.ts`), which keep the PR's checks too. Whichever read it later
 * wins, so a PR merged since one read shows merged, not its last CI result.
 */
import { useEffect, useMemo, useState } from "react";
import type { GithubItemPeek } from "../../../../shared/github";
import { githubItemLink } from "../../../../shared/session-links";
import { peekGithubItem } from "../../../lib/link-peek";
import { pollWhileVisible } from "../../../lib/visible-poll";
import { useBranchPrs } from "../../../stores/branch-prs";

export interface LivePr {
	url: string;
	repo: string;
	number: number;
	title: string | null;
	state: "open" | "draft" | "merged" | "closed" | null;
	/** Only once its checks have an outcome. */
	checks: "success" | "failure" | "pending" | null;
}

/** `owner/repo#41` or a GitHub pull request URL as its repository, number and address; null for anything else. */
export function parsePrRef(ref: string): { repo: string; number: number; url: string } | null {
	const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref.trim());
	if (short?.[1] && short[2])
		return { repo: short[1], number: Number(short[2]), url: `https://github.com/${short[1]}/pull/${short[2]}` };
	try {
		const link = githubItemLink(ref.trim());
		if (link && !link.host) return { repo: link.repo, number: link.number, url: ref.trim() };
	} catch {
		// Not a URL.
	}
	return null;
}

const PEEK_FRESH_MS = 60_000;

function peekState(peek: GithubItemPeek): LivePr["state"] {
	if (peek.state === "MERGED") return "merged";
	if (peek.state === "CLOSED") return "closed";
	return peek.isDraft ? "draft" : "open";
}

export function useItemPr(ref: string): LivePr | null {
	const parsed = useMemo(() => parsePrRef(ref), [ref]);
	const [peek, setPeek] = useState<{ at: number; value: GithubItemPeek } | null>(null);
	const repo = parsed?.repo;
	const number = parsed?.number;
	useEffect(() => {
		if (!repo || !number) return;
		let live = true;
		const read = () =>
			void peekGithubItem({ repo, number }, { freshMs: PEEK_FRESH_MS, background: true })
				.then(value => {
					if (live) setPeek({ at: Date.now(), value });
				})
				.catch(() => {});
		read();
		const stop = pollWhileVisible(read, PEEK_FRESH_MS);
		return () => {
			live = false;
			stop();
		};
	}, [repo, number]);
	const url = parsed?.url.toLowerCase() ?? "";
	// The branch read of this PR read last: its key, then its PR and read time.
	const known = useBranchPrs(state => {
		let best: string | null = null;
		for (const [key, pr] of Object.entries(state.prs))
			if (
				pr &&
				pr.url.toLowerCase() === url &&
				(best === null || (state.readAt[key] ?? 0) > (state.readAt[best] ?? 0))
			)
				best = key;
		return best;
	});
	const branchPr = useBranchPrs(state => (known ? (state.prs[known] ?? null) : null));
	const branchAt = useBranchPrs(state => (known ? (state.readAt[known] ?? 0) : 0));
	if (!parsed) return null;
	const fromBranch = branchPr
		? {
				at: branchAt,
				title: branchPr.title,
				state: (branchPr.state === "MERGED"
					? "merged"
					: branchPr.state === "CLOSED"
						? "closed"
						: branchPr.isDraft
							? "draft"
							: "open") as LivePr["state"],
				checks: (branchPr.checks.failure > 0
					? "failure"
					: branchPr.checks.pending > 0
						? "pending"
						: branchPr.checks.success > 0
							? "success"
							: null) as LivePr["checks"],
			}
		: null;
	const fromPeek = peek ? { at: peek.at, title: peek.value.title, state: peekState(peek.value) } : null;
	const newest = fromBranch && (!fromPeek || fromBranch.at >= fromPeek.at) ? fromBranch : fromPeek;
	return {
		...parsed,
		title: newest?.title ?? null,
		state: newest?.state ?? null,
		// The checks are the branch read's alone: kept while a newer peek only moved the state.
		checks: fromBranch?.checks ?? null,
	};
}
