import { Folder, FolderOpen } from "lucide-react";
import type { HTMLAttributes } from "react";

/**
 * A project header's glyph: the emoji the person chose, else its folder (open while the project is), in the color
 * they chose (the device hues, components.css `[data-project-glyph]`). Orca's project identity: an icon, emoji or
 * color per repository (settings/repository/identity/RepositoryIconColorSection.tsx).
 */
export function ProjectGlyph({
	emoji,
	color,
	open = false,
	...rest
}: { emoji?: string; color?: string; open?: boolean } & HTMLAttributes<HTMLSpanElement>) {
	if (emoji)
		return (
			<span
				{...rest}
				aria-hidden
				className="w-(--sc-icon-sm) shrink-0 text-center text-sc-xs leading-none"
				data-project-emoji
			>
				{emoji}
			</span>
		);
	const Icon = open ? FolderOpen : Folder;
	return (
		<span {...rest} className="flex shrink-0" data-device-color={color} data-project-glyph>
			<Icon aria-hidden className="size-(--sc-icon-sm)" />
		</span>
	);
}
