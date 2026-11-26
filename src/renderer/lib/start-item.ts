import { useUiStore } from "../stores/ui";

/** What a session started on a work item opens the new task sheet with. */
export interface ItemStart {
	/** The worktree's name (`trackerWorktreeName`). */
	name: string;
	/** The first prompt: the ask, then the item fenced as data. */
	prompt: string;
}

/** Opens the new task sheet filled for a work item (a Linear or Jira issue, a project item, a merge request). */
export function startOnItem(start: ItemStart): void {
	// shortcut: the sheet's name and prompt fields land with orca-worktree-create; drop this cast when they are on main.
	useUiStore
		.getState()
		.openWorktreeDialog(start as Parameters<ReturnType<typeof useUiStore.getState>["openWorktreeDialog"]>[0]);
}
