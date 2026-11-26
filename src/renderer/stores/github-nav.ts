/**
 * An issue another surface asked Agents › GitHub to show (a conversation link's card, Orca FG26
 * `NativeChatOpenedPullRequestCard.tsx:173-183`): the GitHub center switches to its repository's issues and the issue
 * list selects it once that repository's list is shown, then clears the ask.
 */
import { create } from "zustand";
import { useUiStore } from "./ui";

export interface IssueAsk {
	/** `OWNER/NAME`. */
	repo: string;
	number: number;
}

export const useGithubNav = create<{ issue: IssueAsk | null }>(() => ({ issue: null }));

/** Open Agents › GitHub on issue `number` of `repo` (github.com or the checkout's own host). */
export function showIssue(repo: string, number: number): void {
	useGithubNav.setState({ issue: { repo, number } });
	useUiStore.getState().openAgents("github");
}

export const sameRepo = (a: string | null | undefined, b: string | null | undefined) =>
	!!a && !!b && a.toLowerCase() === b.toLowerCase();
