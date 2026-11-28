import {
	BarChart3,
	ChevronRight,
	FolderOpen,
	GitBranch,
	GitFork,
	ListTree,
	Pencil,
	Rocket,
	Share2,
	Wrench,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { pathBaseName, worktreeFolderSlug, worktreeKindOf, worktreeLabel } from "../../../shared/project-origin";
import { useAutoTitle } from "../../hooks/use-auto-title";
import { useSessionList } from "../../hooks/use-session-list";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { onEscape } from "../../lib/keymap";
import { useProjectNames, useWorktreeKindLabels } from "../../lib/project-origin";
import { sessionForkOrigin } from "../../lib/session-fork";
import { useTabRpc } from "../../lib/tab-rpc";
import { useHostView } from "../../stores/remote";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useActiveTabKind, useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { BotHomeBanner } from "../bots/BotHomeBanner";
import { AutoTitleButton, Button, type ContextMenuItem, Input, Tooltip } from "../common";
import { DeviceChip } from "../remote/DeviceChip";
import { ForkParent } from "./ForkParent";

export function sessionCommands(t: (key: string) => string, startRename: () => void): ContextMenuItem[] {
	const ui = useUiStore.getState;
	return [
		{ id: "rename", label: t("titlebar.rename"), icon: Pencil, onSelect: startRename },
		{
			id: "branch",
			label: t("cmd.branch"),
			description: t("cmd.branch.desc"),
			icon: GitBranch,
			onSelect: () => ui().openBranchPicker(),
		},
		{
			id: "tree",
			label: t("cmd.tree"),
			description: t("cmd.tree.desc"),
			icon: ListTree,
			onSelect: () => ui().openSessionTree(),
		},
		{
			id: "share",
			label: t("cmd.share"),
			description: t("cmd.share.desc"),
			icon: Share2,
			onSelect: () => ui().openShareSession(),
		},
		{
			id: "tools",
			label: t("cmd.tools"),
			description: t("cmd.tools.desc"),
			icon: Wrench,
			onSelect: () => ui().openActiveTools(),
		},
		{
			id: "import",
			label: t("cmd.import"),
			description: t("cmd.import.desc"),
			icon: FolderOpen,
			onSelect: () => ui().openImportDialog(),
		},
		{
			id: "insights",
			label: t("sessionStatus.openInsights"),
			icon: BarChart3,
			onSelect: () => ui().openInsights("stats", "session"),
		},
	];
}

/** Edit the session that opened the field, never a newly focused tab. */
export function SessionRename({ onDone }: { onDone: () => void }) {
	const tabRpc = useTabRpc();
	const t = useT();
	const tabId = useRuntimeTabId();
	const sessionId = useSessionStore(s => s.sessionId);
	const sessionName = useSessionStore(s => s.sessionName);
	const status = useSessionStore(s => s.status);
	const device = useTabsStore(s => s.tabs.find(tab => tab.id === tabId)?.device);
	const host = useHostView(device);
	const { sessions } = useSessionList("global", device, { read: !device || host?.state === "online" });
	const initial = sessionName ?? sessions.find(row => row.id === sessionId)?.title ?? "";
	const [draft, setDraft] = useState(initial);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const autoTitle = useAutoTitle(tabRpc.regenerateSessionTitle);
	const autoTitleErrorId = useId();
	const finished = useRef(false);
	useEffect(() => {
		finished.current = false;
		nameInputRef.current?.focus();
		nameInputRef.current?.select();
		return () => {
			finished.current = true;
		};
	}, []);
	const end = () => {
		finished.current = true;
		onDone();
	};
	const commitName = () => {
		if (finished.current || autoTitle.pending) return;
		const name = draft.trim();
		end();
		if (!name || name === initial) return;
		const originSession = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		const originId = originSession.getState().sessionId;
		void tabRpc
			.setSessionName(name)
			.then(response => {
				if (response.success) {
					if (originSession.getState().sessionId === originId) originSession.setState({ sessionName: name });
				} else renameFailed(response.error);
			})
			.catch(renameFailed);
	};
	const renameFailed = (cause: unknown) => {
		toastError({ title: t("titlebar.renameFailed"), error: cause });
	};
	const regenerateName = async () => {
		const originSession = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		const originId = originSession.getState().sessionId;
		const title = await autoTitle.run();
		if (!title) return;
		if (originSession.getState().sessionId === originId) originSession.setState({ sessionName: title });
		if (!finished.current) end();
	};
	return (
		<div
			className="relative w-72 max-w-full min-w-0"
			onBlur={event => {
				if (!event.currentTarget.contains(event.relatedTarget)) commitName();
			}}
		>
			<Input
				aria-describedby={autoTitle.error ? autoTitleErrorId : undefined}
				aria-invalid={autoTitle.error ? true : undefined}
				aria-label={t("titlebar.rename")}
				controlSize="sm"
				onChange={event => {
					setDraft(event.target.value);
					autoTitle.clearError();
				}}
				onKeyDown={event => {
					if (isImeKeyEvent(event)) return;
					if (event.key === "Enter") commitName();
					onEscape(event, end);
				}}
				readOnly={autoTitle.pending}
				ref={nameInputRef}
				trailing={
					<AutoTitleButton
						onClick={() => void regenerateName()}
						pending={autoTitle.pending}
						tabIndex={0}
						unavailableReason={status === "ready" ? undefined : t("sidecar.notResponding")}
					/>
				}
				value={draft}
			/>
			{autoTitle.error && (
				// Under the field, over the page: the bar keeps its height.
				<p
					className="absolute top-full left-0 z-20 mt-1 max-w-full rounded-(--sc-radius-sm) border border-(--sc-border-subtle) bg-(--sc-elevated) px-2 py-1 text-sc-sm text-(--sc-danger) shadow-(--sc-shadow-md)"
					data-auto-title-error=""
					id={autoTitleErrorId}
					role="alert"
				>
					{autoTitle.error}
				</p>
			)}
		</div>
	);
}

const crumbSeparator = (
	<ChevronRight aria-hidden className="omp-titlebar-crumb-sep size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)" />
);

/** The project and origin of the attached session, in the web breadcrumb or the desktop details panel. */
export function SessionIdentity({
	children,
	editing = false,
	closeDetails,
}: {
	children?: ReactNode;
	editing?: boolean;
	closeDetails?: () => void;
}) {
	const details = closeDetails !== undefined;
	const t = useT();
	const tabId = useRuntimeTabId();
	const sessionId = useSessionStore(s => s.sessionId);
	const cwd = useSessionStore(s => s.cwd);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const isChat = useActiveTabKind() === "chat";
	const tab = useTabsStore(s => s.tabs.find(entry => entry.id === (tabId ?? s.activeTabId)));
	const device = tab?.device;
	const host = useHostView(device);
	const groupAliases = useSidebarPrefs(s => s.groupAliases);
	const { sessions } = useSessionList("global", device, { read: !device || host?.state === "online" });
	// A paired host's folders are not on this computer: git here cannot tell about them.
	const projectNameOf = useProjectNames(
		useMemo(() => (!isChat && cwd && device === undefined ? [cwd] : []), [isChat, cwd, device]),
	);
	const kindLabels = useWorktreeKindLabels();
	const shown = projectNameOf(!isChat && !device && cwd ? cwd : "");
	const binding = !isChat ? tab?.worktree : undefined;
	const origin =
		shown.worktree ??
		(binding && {
			project: pathBaseName(binding.baseCwd),
			root: binding.baseCwd,
			worktree: { kind: worktreeKindOf(binding.branch), branch: binding.branch, slug: binding.name },
		});
	const worktreeLabelText = origin ? worktreeLabel(origin, kindLabels) : null;
	const folder = device && cwd ? worktreeFolderSlug(cwd) : shown.name;
	const tooltip = device ? (cwd ?? "") : shown.tooltip;
	const projectName = !isChat && cwd ? (groupAliases[cwd] ?? origin?.project ?? folder) : t("sidebar.chats");
	const current = sessions.find(s => s.id === sessionId);
	const fork = useMemo(() => {
		if (!current?.parentSessionPath) return null;
		const parentPath = current.parentSessionPath;
		const parent = sessions.find(row => row.path === parentPath || row.id === parentPath);
		return sessionForkOrigin(current, new Map(parent ? [[parentPath, parent]] : []));
	}, [current, sessions]);
	return (
		<>
			{device !== undefined && (
				<span className="mr-1 flex shrink-0 items-center">
					<DeviceChip deviceId={device} />
				</span>
			)}
			<Tooltip
				content={cwd && !isChat ? `${t("titlebar.switchProject")} · ${tooltip}` : t("titlebar.switchProject")}
				describe={false}
				side="bottom"
			>
				<Button
					className="omp-titlebar-project min-w-12 max-w-48 shrink-[4]! px-2 font-normal text-(--sc-text-muted) hover:text-(--sc-text)"
					disabled={isStreaming}
					onClick={() => {
						closeDetails?.();
						useUiStore.getState().openProjectPicker();
					}}
					size="sm"
					title={isStreaming ? t("titlebar.abortHint") : undefined}
					variant="ghost"
				>
					<span className="truncate">{projectName}</span>
				</Button>
			</Tooltip>
			{details && !isChat && cwd && (
				<span className="max-w-full break-all text-sc-xs text-(--sc-text-muted)">{cwd}</span>
			)}
			{!details && crumbSeparator}
			{worktreeLabelText !== null && (
				<>
					{/* A worktree reads as its project › what it is for (the folder name never shows). */}
					<Tooltip content={tooltip} describe={false} side="bottom">
						<span
							className="omp-titlebar-worktree flex min-w-0 max-w-40 shrink-[3] items-center gap-1 px-1 text-sc-sm text-(--sc-text-muted)"
							data-titlebar-worktree=""
						>
							{/* An Autopilot run is its rocket alone (the user's call, 23 Oct 2026), its word for screen readers. */}
							{origin?.worktree?.kind === "autopilot" ? (
								<>
									<Rocket aria-hidden className="size-(--sc-icon-sm) shrink-0" />
									<span className={details ? undefined : "sr-only"}>{worktreeLabelText}</span>
								</>
							) : (
								<>
									<GitBranch aria-hidden className="size-(--sc-icon-sm) shrink-0" />
									<span className="truncate">{worktreeLabelText}</span>
								</>
							)}
						</span>
					</Tooltip>
					{!details && crumbSeparator}
				</>
			)}
			{children}
			{fork && !editing && (
				<Tooltip content={fork.tooltip} describe={false} side="bottom">
					<span
						aria-label={fork.tooltip}
						className="flex min-w-0 max-w-64 shrink items-center text-(--sc-text-subtle) [&>svg]:size-(--sc-icon-sm) [&>svg]:shrink-0"
						data-titlebar-fork=""
						role="note"
						tabIndex={details ? 0 : -1}
					>
						<GitFork aria-hidden />
						{details ? <span>{fork.tooltip}</span> : fork.parentTitle && <ForkParent name={fork.parentTitle} />}
					</span>
				</Tooltip>
			)}
			{!editing && <BotHomeBanner cwd={cwd} device={device} sessionPath={tab?.sessionPath} />}
		</>
	);
}
