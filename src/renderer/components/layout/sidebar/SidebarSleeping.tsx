/**
 * A project's sleeping rows (`RowGroup.sleeping`, the sidebar header's Hide sleeping) folded under one quiet line,
 * "3 sleeping", that opens them in place. Orca's Hide sleeping filter removes them from the list
 * (shared/workspace-view/workspace-row-filters.ts:118-125); here the line keeps them one click away. This computer's
 * projects and a paired computer's alike; folded again on each launch.
 */
import { Moon } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../../lib/i18n";
import { Collapse, DisclosureButton } from "../../common";

export function SidebarSleeping({
	count,
	open,
	onToggle,
	rovingKey,
	children,
}: {
	count: number;
	open: boolean;
	onToggle: () => void;
	/** The line's place in the list's roving focus. */
	rovingKey: string;
	/** The sleeping rows, drawn while open. */
	children: ReactNode;
}) {
	const t = useT();
	if (count === 0) return null;
	return (
		<div data-sidebar-sleeping={count}>
			<DisclosureButton
				className="omp-sidebar-head gap-1.5 rounded-(--sc-radius-md) pr-1 pl-2 text-sc-xs text-(--sc-text-subtle) hover:bg-(--sc-hover) hover:text-(--sc-text)"
				data-roving-item={rovingKey}
				data-sidebar-sleeping-toggle
				onToggle={onToggle}
				open={open}
				tabIndex={-1}
			>
				<Moon aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				<span className="min-w-0 truncate">{t("sidebar.sleeping", { count })}</span>
			</DisclosureButton>
			<Collapse open={open}>
				<div className="space-y-px">{children}</div>
			</Collapse>
		</div>
	);
}
