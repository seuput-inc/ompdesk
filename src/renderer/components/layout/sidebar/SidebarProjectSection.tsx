import { Layers, MoreHorizontal, Pencil, Ungroup } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { renameProjectGroup } from "../../../stores/sidebar-entries";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { openProjectDialog } from "../../../stores/sidebar-request";
import { MenuButton } from "../../common";
import { SidebarFoldButton } from "./SidebarFoldButton";

/** The fold key of a project group, which no folder path can be. */
export const projectSectionFold = (device: string | undefined, name: string) => `\u0000section:${device ?? ""}:${name}`;

export function isProjectSectionFold(key: string): boolean {
	return key.startsWith("\u0000section:");
}

/**
 * A project group's header over the projects filed under it (Orca's project group rows,
 * sidebar/worktree-list/rows/ProjectGroupDialogs.tsx and the group header's menu): it folds them, and its ⋯ renames
 * the group or ungroups its projects (nothing else moves; Orca's Delete group without its projects). Drawn the same on
 * this computer's list and a paired host's (`device`).
 */
export function SidebarProjectSection({ device, name, count }: { device?: string; name: string; count: number }) {
	const t = useT();
	const fold = projectSectionFold(device, name);
	const folded = useSidebarFolds(s => s.groups[fold] === true);
	return (
		<div
			className="omp-sidebar-head group/head mt-2 flex items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)"
			data-project-section={name}
		>
			<SidebarFoldButton
				className="text-(--sc-text-muted)"
				folded={folded}
				icon={<Layers aria-hidden className="size-(--sc-icon-sm) shrink-0" />}
				onClick={() => useSidebarFolds.getState().setGroupFolded(fold, !folded)}
			>
				<span className="min-w-0 flex-1 truncate">{name}</span>
				<span className="shrink-0 text-(--sc-text-subtle) tabular-nums">{count}</span>
			</SidebarFoldButton>
			<span className="relative flex shrink-0 items-center pr-1">
				<MenuButton
					className="pointer-events-none opacity-0 group-focus-within/head:pointer-events-auto group-focus-within/head:opacity-100 group-hover/head:pointer-events-auto group-hover/head:opacity-100 aria-expanded:pointer-events-auto aria-expanded:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
					icon={<MoreHorizontal />}
					items={[
						{
							id: "section-rename",
							label: t("sidebar.group.rename"),
							icon: Pencil,
							onSelect: () => openProjectDialog({ kind: "rename", device, group: name }),
						},
						{
							id: "section-ungroup",
							label: t("sidebar.group.ungroup"),
							icon: Ungroup,
							onSelect: () => void renameProjectGroup(device, name, null),
						},
					]}
					label={t("sidebar.group.menu", { name })}
					size="sm"
					variant="ghost"
				/>
			</span>
		</div>
	);
}

/** Whether a project group folds its projects away. */
export function useSectionFolded(device: string | undefined, name: string | undefined): boolean {
	return useSidebarFolds(s => (name ? s.groups[projectSectionFold(device, name)] === true : false));
}
