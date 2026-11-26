import { focusedTabDevice } from "../../../stores/remote";
import { useSidebarProjects } from "../../../stores/sidebar-projects";
import { CloneDialog } from "../../agents/github/GithubRepos";

/**
 * The palette's Clone repository…: the GitHub center's clone, for a repository the person names, on the computer the
 * focused tab runs on (its GitHub command runs there); the new folder joins that computer's projects (Orca's
 * add-project clone, sidebar/project-admission/dialog/useAddRepoCloneFlow.ts). Loaded on first use.
 */
export default function SidebarCloneDialog({ onClose }: { onClose: () => void }) {
	const device = focusedTabDevice();
	return (
		<CloneDialog
			host={undefined}
			onClose={onClose}
			onCloned={path => void useSidebarProjects.getState().add(device, path)}
		/>
	);
}
