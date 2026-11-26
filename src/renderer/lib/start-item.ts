import { useUiStore } from "../stores/ui";

/** What a session started on a work item opens the new task sheet with. */
export interface ItemStart {
	/** The worktree's name (`trackerWorktreeName`). */
	name: string;
	/** The first prompt: the ask, then the item fenced as data. */
	prompt: string;
	/** The exact branch the item names (a Linear issue's `branchName`); without it the sheet's prefix and name make one. */
	branch?: string;
}

/** Opens the new task sheet filled for a work item (a Linear or Jira issue, a project item, a merge request). */
export function startOnItem(start: ItemStart): void {
	useUiStore.getState().openWorktreeDialog(start.branch ? start : { name: start.name, prompt: start.prompt });
}
