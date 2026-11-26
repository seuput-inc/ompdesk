import { FolderMinus } from "lucide-react";
import { useState } from "react";
import { pathBaseName } from "../../../../shared/project-origin";
import { useT } from "../../../lib/i18n";
import { LOCAL_DEVICE } from "../../../lib/sidebar-memory";
import { useSidebarProjects } from "../../../stores/sidebar-projects";
import { Button } from "../../common/Button";
import { SidebarFoldButton } from "./SidebarFoldButton";

const NONE: readonly string[] = [];

/**
 * The projects the person deleted from one computer's list, folded at the list's end, each with Show (Orca's
 * `HiddenProjectsSection`, sidebar/hidden-projects/HiddenProjectsSection.tsx:29-141). Show adds the folder back as
 * opening it would (`add` clears the removal), so its sessions list under it again; nothing else changes. Newest
 * removal first. Absent while nothing was removed or a filter is on.
 */
export function SidebarRemovedProjects({ device, query }: { device?: string; query: string }) {
	const t = useT();
	const removed = useSidebarProjects(s => s.lists[device ?? LOCAL_DEVICE]?.removed) ?? NONE;
	const [open, setOpen] = useState(false);
	if (removed.length === 0 || query) return null;
	return (
		<section className="mt-3" data-sidebar-removed-projects={device ?? LOCAL_DEVICE}>
			<div className="omp-sidebar-head flex items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)">
				<SidebarFoldButton
					className="text-(--sc-text-muted)"
					folded={!open}
					icon={<FolderMinus aria-hidden className="size-(--sc-icon-sm) shrink-0" />}
					onClick={() => setOpen(!open)}
				>
					<span className="min-w-0 flex-1 truncate">
						{t("sidebar.removedProjects", { count: removed.length })}
					</span>
				</SidebarFoldButton>
			</div>
			{open && (
				<ul aria-label={t("sidebar.removedProjects.list")} className="space-y-px">
					{[...removed].reverse().map(path => {
						const name = pathBaseName(path) || path;
						return (
							<li
								className="group/removed flex h-7 min-w-0 items-center gap-1.5 rounded-(--sc-radius-md) pr-0.5 pl-6 hover:bg-(--sc-hover)"
								data-removed-project={path}
								key={path}
								title={path}
							>
								<span className="min-w-0 flex-1 truncate text-sc-sm text-(--sc-text-secondary)">{name}</span>
								<Button
									aria-label={t("sidebar.removedProjects.showOne", { name })}
									className="opacity-0 group-focus-within/removed:opacity-100 group-hover/removed:opacity-100 [@media(hover:none)]:opacity-100"
									onClick={() => void useSidebarProjects.getState().add(device, path)}
									size="sm"
									variant="ghost"
								>
									{t("sidebar.removedProjects.show")}
								</Button>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
