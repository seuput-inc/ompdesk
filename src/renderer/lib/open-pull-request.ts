import type { GithubItemLink } from "../../shared/session-links";
import { usePrCenterStore } from "../stores/pr-center";
import { useUiStore } from "../stores/ui";
import type { FocusedScope } from "./focused-scope";
import { openExternal } from "./open-external";

/**
 * Show a pull request in the PR Center when it is the scope repository's (Orca FG26, `NativeChatOpenedPullRequestCard`
 * `173-183`); else, or for an Enterprise host, open `url` in the browser. A PR Center not read yet for this folder
 * opens and decides once its own read names the repository.
 */
export function openPullRequest(
	scope: FocusedScope,
	link: Pick<GithubItemLink, "repo" | "number" | "host">,
	url: string,
) {
	const same = (repo: string) => repo.toLowerCase() === link.repo.toLowerCase();
	usePrCenterStore.getState().enter(scope);
	const here = usePrCenterStore.getState().repo;
	if (link.host || here?.available === false || (here?.available && !same(here.repo))) {
		openExternal(url);
		return;
	}
	useUiStore.getState().openAgents("prs");
	if (here) {
		void usePrCenterStore.getState().select(link.number);
		return;
	}
	const stop = usePrCenterStore.subscribe(state => {
		if (!state.repo && !state.error) return;
		stop();
		if (state.repo?.available && same(state.repo.repo)) void state.select(link.number);
		else openExternal(url);
	});
}
