/**
 * The Changes panel's files as a folder tree (Orca's list/tree toggle, `header-overflow-menu.tsx`, FR22): folders open
 * by default, each file with its status mark; a click shows its diff, the row menu (right click) stages, unstages and
 * discards as the list's does.
 */
import { useMemo, useState } from "react";
import type { RpcGitChanges } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { type ContextMenuAnchor, type TreeNode, TreeView } from "../../common";
import { ChangeStatus, type ChangeStatusName } from "../PanelChrome";
import { FileIcon } from "../viewers/FileViewer";

type ChangedFile = RpcGitChanges["files"][number];

interface Folder {
	folders: Map<string, Folder>;
	files: ChangedFile[];
}

export function ChangeTree({
	files,
	selected,
	statusOf,
	onSelect,
	onMenu,
}: {
	files: readonly ChangedFile[];
	selected: string;
	statusOf: (file: ChangedFile) => ChangeStatusName;
	onSelect: (path: string) => void;
	onMenu?: (anchor: ContextMenuAnchor, file: ChangedFile) => void;
}) {
	const t = useT();
	const { nodes, folders } = useMemo(() => {
		const root: Folder = { folders: new Map(), files: [] };
		for (const file of files) {
			const parts = file.path.split("/");
			let folder = root;
			for (const part of parts.slice(0, -1)) {
				let next = folder.folders.get(part);
				if (!next) {
					next = { folders: new Map(), files: [] };
					folder.folders.set(part, next);
				}
				folder = next;
			}
			folder.files.push(file);
		}
		const ids: string[] = [];
		const build = (folder: Folder, prefix: string): TreeNode[] => [
			...[...folder.folders.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, child]): TreeNode => {
					const id = `${prefix}${name}/`;
					ids.push(id);
					return { id, label: name, children: build(child, id) };
				}),
			...folder.files.map(
				(file): TreeNode => ({
					id: file.path,
					label: file.path.slice(file.path.lastIndexOf("/") + 1),
					icon: <FileIcon className="size-(--sc-icon-sm) shrink-0" path={file.path} />,
					trailing: <ChangeStatus status={statusOf(file)} />,
					onClick: () => onSelect(file.path),
					...(onMenu ? { onMenu: (anchor: ContextMenuAnchor) => onMenu(anchor, file) } : {}),
				}),
			),
		];
		return { nodes: build(root, ""), folders: ids };
	}, [files, statusOf, onSelect, onMenu]);
	// Every folder starts open; one the person folds stays folded while the list changes.
	const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
	const expanded = useMemo(() => new Set(folders.filter(id => !closed.has(id))), [folders, closed]);
	return (
		<TreeView
			emptyMessage={t("diffPanel.noMatch")}
			expanded={expanded}
			nodes={nodes}
			onExpandedChange={next => setClosed(new Set(folders.filter(id => !next.has(id))))}
			selectedId={selected || null}
		/>
	);
}
