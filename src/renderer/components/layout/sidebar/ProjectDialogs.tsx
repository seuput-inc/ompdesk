/**
 * The project header's dialogs, loaded on first use (Sidebar.tsx and SidebarDevices.tsx lazy-load this module):
 *
 * - Move to group (Orca's project groups: worktree-list/rows/ProjectGroupNameDialog.tsx and the Project Group submenu,
 *   workspace-actions/context-menu/WorktreeContextMenuSubMenus.tsx:99-148): an existing group, no group, or a new name.
 * - Rename group (ProjectGroupNameDialog.tsx, rename mode); Ungroup is a menu item, it asks nothing (no file moves).
 * - Appearance (Orca's project peek and identity editor: repo/project-peek/ProjectPeek.tsx,
 *   ProjectAppearanceEditor.tsx, settings/repository/identity/RepositoryIconEmojiPicker.tsx): what the header shows,
 *   its color (the device hues) and its emoji (`:name` suggests from the composer's emoji data).
 * - A session's emoji (Orca's workspace emoji, components/workspace-emoji/*) and the parent it nests under (Orca's
 *   parent picker, workspace-actions/parenting/WorktreeParentPickerPopover.tsx).
 *
 * Each saves to the computer the project or session belongs to (`stores/sidebar-entries.ts`).
 */
import { useEffect, useId, useState } from "react";
import { DEVICE_COLORS } from "../../../lib/device-color";
import { type EmojiSuggestionItem, getEmojiSuggestions } from "../../../lib/emoji";
import { useT } from "../../../lib/i18n";
import { renameProjectGroup, setSidebarEntry, useSidebarEntry } from "../../../stores/sidebar-entries";
import { Button, ChoiceList, Input, Modal } from "../../common";
import { ProjectGlyph } from "./ProjectGlyph";
import { WslProjectDialog } from "./WslProjectDialog";

export type ProjectDialogRequest =
	| { kind: "move"; device?: string; cwd: string; name: string }
	| { kind: "rename"; device?: string; group: string }
	| { kind: "look"; device?: string; cwd: string; name: string }
	| { kind: "host"; cwd: string; name: string }
	| { kind: "emoji"; device?: string; path: string; name: string }
	| {
			kind: "parent";
			device?: string;
			path: string;
			name: string;
			/** The sessions it may nest under: its own list's, itself and its own children left out. */
			candidates: readonly { path: string; title: string }[];
	  };

function MoveDialog({
	request,
	onClose,
}: {
	request: Extract<ProjectDialogRequest, { kind: "move" }>;
	onClose: () => void;
}) {
	const t = useT();
	const groups = useSidebarEntry("projectGroups", request.device);
	const current = groups[request.cwd] ?? "";
	const names = [...new Set(Object.values(groups))].sort((a, b) => a.localeCompare(b));
	const [chosen, setChosen] = useState(current);
	const [typed, setTyped] = useState("");
	const labelId = useId();
	const value = typed.trim() || chosen;
	const save = () => {
		onClose();
		void setSidebarEntry(request.device, "projectGroups", request.cwd, value || null);
	};
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button disabled={value === current} form="project-group-move" type="submit" variant="primary">
						{t("sidebar.group.move")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="sm"
			title={t("sidebar.group.moveTitle", { name: request.name })}
		>
			<form
				className="flex flex-col gap-3"
				data-project-group-dialog="move"
				id="project-group-move"
				onSubmit={event => {
					event.preventDefault();
					if (value !== current) save();
				}}
			>
				<span className="text-sc-sm text-(--sc-text-secondary)" id={labelId}>
					{t("sidebar.group.choose")}
				</span>
				<ChoiceList
					choices={[
						...names.map(name => ({ key: name, label: name })),
						{ key: "", label: t("sidebar.group.none") },
					]}
					labelledBy={labelId}
					mode="single"
					onChoose={key => {
						setChosen(key);
						setTyped("");
					}}
					selected={new Set(typed.trim() ? [] : [chosen])}
				/>
				<Input
					label={t("sidebar.group.new")}
					maxLength={100}
					onChange={event => setTyped(event.target.value)}
					placeholder={t("sidebar.group.newPlaceholder")}
					value={typed}
				/>
			</form>
		</Modal>
	);
}

function RenameDialog({
	request,
	onClose,
}: {
	request: Extract<ProjectDialogRequest, { kind: "rename" }>;
	onClose: () => void;
}) {
	const t = useT();
	const [name, setName] = useState(request.group);
	const next = name.trim();
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={!next || next === request.group}
						form="project-group-rename"
						type="submit"
						variant="primary"
					>
						{t("sidebar.menu.rename")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="sm"
			title={t("sidebar.group.renameTitle")}
		>
			<form
				data-project-group-dialog="rename"
				id="project-group-rename"
				onSubmit={event => {
					event.preventDefault();
					if (!next || next === request.group) return;
					onClose();
					void renameProjectGroup(request.device, request.group, next);
				}}
			>
				<Input
					autoFocus
					label={t("sidebar.group.name")}
					maxLength={100}
					onChange={event => setName(event.target.value)}
					value={name}
				/>
			</form>
		</Modal>
	);
}

function LookDialog({
	request,
	onClose,
}: {
	request: Extract<ProjectDialogRequest, { kind: "look" }>;
	onClose: () => void;
}) {
	const t = useT();
	const colors = useSidebarEntry("projectColors", request.device);
	const emojis = useSidebarEntry("projectEmoji", request.device);
	const [color, setColor] = useState(colors[request.cwd] ?? "");
	const [emoji, setEmoji] = useState(emojis[request.cwd] ?? "");
	const colorLabel = useId();
	const pickedEmoji = chosenEmoji(emoji);
	const save = () => {
		onClose();
		if (color !== (colors[request.cwd] ?? ""))
			void setSidebarEntry(request.device, "projectColors", request.cwd, color || null);
		if (pickedEmoji !== (emojis[request.cwd] ?? ""))
			void setSidebarEntry(request.device, "projectEmoji", request.cwd, pickedEmoji || null);
	};
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button form="project-look" type="submit" variant="primary">
						{t("common.save")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="sm"
			title={t("sidebar.look.title")}
		>
			<form
				className="flex flex-col gap-4"
				data-project-look-dialog
				id="project-look"
				onSubmit={event => {
					event.preventDefault();
					save();
				}}
			>
				{/* What the project's header shows, as it will. */}
				<div
					className="flex min-w-0 items-center gap-2 rounded-(--sc-radius-md) border border-(--sc-border-subtle) px-3 py-2"
					data-project-look-preview
				>
					<ProjectGlyph color={color || undefined} emoji={pickedEmoji || undefined} />
					<span className="min-w-0 flex-1 truncate text-sc-sm font-semibold text-(--sc-text)">{request.name}</span>
					<span className="min-w-0 truncate text-sc-xs text-(--sc-text-muted)" title={request.cwd}>
						{request.cwd}
					</span>
				</div>
				<div className="flex flex-col gap-2">
					<span className="text-sc-sm text-(--sc-text-secondary)" id={colorLabel}>
						{t("sidebar.look.color")}
					</span>
					<ChoiceList
						choices={[
							{ key: "", label: t("remote.sidebar.color.none") },
							...DEVICE_COLORS.map(value => ({
								key: value,
								label: (
									<span className="flex items-center gap-2">
										<span className="omp-menu-swatch" data-device-color={value} />
										{t(`remote.sidebar.color.${value}`)}
									</span>
								),
							})),
						]}
						labelledBy={colorLabel}
						mode="single"
						onChoose={setColor}
						selected={new Set([color])}
					/>
				</div>
				<EmojiField onChange={setEmoji} value={emoji} />
			</form>
		</Modal>
	);
}

/** An emoji typed or pasted, or picked from what `:name` suggests (the composer's emoji data). */
function EmojiField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const t = useT();
	const [suggestions, setSuggestions] = useState<EmojiSuggestionItem[]>([]);
	useEffect(() => {
		let live = true;
		void getEmojiSuggestions(value)
			.then(found => {
				if (live) setSuggestions(found?.items.slice(0, 8) ?? []);
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [value]);
	return (
		<div className="flex flex-col gap-2">
			<Input
				hint={t("sidebar.look.emojiHint")}
				label={t("sidebar.look.emoji")}
				maxLength={32}
				onChange={event => onChange(event.target.value)}
				value={value}
			/>
			{suggestions.length > 0 && (
				<div className="flex flex-wrap gap-1" data-project-emoji-suggestions>
					{suggestions.map(item => (
						<Button
							key={item.label}
							onClick={() => onChange(item.value)}
							size="sm"
							title={item.label}
							variant="ghost"
						>
							{item.value}
						</Button>
					))}
				</div>
			)}
		</div>
	);
}

/** A `:name` still being typed is no emoji yet. */
const chosenEmoji = (text: string) => (text.startsWith(":") ? "" : text.trim());

function EmojiDialog({
	request,
	onClose,
}: {
	request: Extract<ProjectDialogRequest, { kind: "emoji" }>;
	onClose: () => void;
}) {
	const t = useT();
	const emojis = useSidebarEntry("sessionEmoji", request.device);
	const [emoji, setEmoji] = useState(emojis[request.path] ?? "");
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button form="session-emoji" type="submit" variant="primary">
						{t("common.save")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="sm"
			title={t("sidebar.emoji.title", { name: request.name })}
		>
			<form
				id="session-emoji"
				onSubmit={event => {
					event.preventDefault();
					onClose();
					const next = chosenEmoji(emoji);
					if (next !== (emojis[request.path] ?? ""))
						void setSidebarEntry(request.device, "sessionEmoji", request.path, next || null);
				}}
			>
				<EmojiField onChange={setEmoji} value={emoji} />
			</form>
		</Modal>
	);
}

/**
 * The session a row nests under, chosen by hand (Orca's parent picker, workspace-actions/parenting/
 * WorktreeParentPickerPopover.tsx): one of its list's sessions, or Automatic (back to who opened it).
 */
function ParentDialog({
	request,
	onClose,
}: {
	request: Extract<ProjectDialogRequest, { kind: "parent" }>;
	onClose: () => void;
}) {
	const t = useT();
	const parents = useSidebarEntry("sessionParents", request.device);
	const current = parents[request.path];
	const [chosen, setChosen] = useState(current ?? AUTOMATIC);
	const labelId = useId();
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={chosen === (current ?? AUTOMATIC)}
						form="session-parent"
						type="submit"
						variant="primary"
					>
						{t("common.save")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="sm"
			title={t("sidebar.parent.title", { name: request.name })}
		>
			<form
				className="flex flex-col gap-3"
				data-session-parent-dialog
				id="session-parent"
				onSubmit={event => {
					event.preventDefault();
					onClose();
					void setSidebarEntry(
						request.device,
						"sessionParents",
						request.path,
						chosen === AUTOMATIC ? null : chosen,
					);
				}}
			>
				<span className="text-sc-sm text-(--sc-text-secondary)" id={labelId}>
					{t("sidebar.parent.choose")}
				</span>
				<div className="max-h-80 overflow-y-auto">
					<ChoiceList
						choices={[
							{ key: AUTOMATIC, label: t("sidebar.parent.automatic") },
							...request.candidates.map(candidate => ({ key: candidate.path, label: candidate.title })),
						]}
						labelledBy={labelId}
						mode="single"
						onChoose={setChosen}
						selected={new Set([chosen])}
					/>
				</div>
			</form>
		</Modal>
	);
}

/** The parent picker's "back to the automatic opener" choice, which no session file can be. */
const AUTOMATIC = "\u0000automatic";

export default function ProjectDialog({ request, onClose }: { request: ProjectDialogRequest; onClose: () => void }) {
	if (request.kind === "host") return <WslProjectDialog key={request.cwd} onClose={onClose} {...request} />;
	if (request.kind === "move") return <MoveDialog onClose={onClose} request={request} />;
	if (request.kind === "rename") return <RenameDialog onClose={onClose} request={request} />;
	if (request.kind === "emoji") return <EmojiDialog onClose={onClose} request={request} />;
	if (request.kind === "parent") return <ParentDialog onClose={onClose} request={request} />;
	return <LookDialog onClose={onClose} request={request} />;
}
