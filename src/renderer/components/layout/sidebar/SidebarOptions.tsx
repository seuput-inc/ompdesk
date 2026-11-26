/**
 * The sidebar header's options, where Orca's header puts its Workspace options (sidebar/chrome/
 * sidebar-header-actions.tsx:117; items in worktree-list/controls/workspace-options-menu-items.tsx:151-163 Sort by and
 * :191 Hide sleeping): how every session list sorts and whether a project's sleeping rows fold under its "N sleeping"
 * line. Kept in the `sidebar` prefs (`crates/core/src/prefs/sidebar.rs`); every computer's lists this view shows
 * follow them.
 */
import { Moon, SlidersHorizontal } from "lucide-react";
import { SESSION_SORTS } from "../../../../shared/sidebar-prefs";
import { useT } from "../../../lib/i18n";
import { useSidebarPrefs } from "../../../stores/sidebar-prefs";
import { type ContextMenuItem, MenuButton } from "../../common";

export function SidebarOptions() {
	const t = useT();
	const sort = useSidebarPrefs(s => s.sessionSort);
	const hideSleeping = useSidebarPrefs(s => s.hideSleeping);
	const changed = sort !== "manual" || hideSleeping;
	return (
		<span className="contents" data-sidebar-options={changed ? "changed" : ""}>
			<MenuButton
				align="end"
				icon={<SlidersHorizontal />}
				items={[
					...SESSION_SORTS.map(
						(choice): ContextMenuItem => ({
							id: `sort-${choice}`,
							label: t(`sidebar.options.sort.${choice}`),
							tooltip:
								choice === "manual" || choice === "smart" ? t(`sidebar.options.sort.${choice}Hint`) : undefined,
							checked: sort === choice,
							onSelect: () => void useSidebarPrefs.getState().setSessionSort(choice),
						}),
					),
					{
						id: "hide-sleeping",
						label: t("sidebar.options.hideSleeping"),
						tooltip: t("sidebar.options.hideSleepingHint"),
						icon: Moon,
						checked: hideSleeping,
						separatorBefore: true,
						onSelect: () => void useSidebarPrefs.getState().setHideSleeping(!hideSleeping),
					},
				]}
				label={changed ? t("sidebar.options.labelChanged") : t("sidebar.options.label")}
				variant="ghost"
			/>
		</span>
	);
}
