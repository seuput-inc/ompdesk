import { useSessionList } from "../../hooks/use-session-list";
import { useShellMode } from "../../hooks/use-shell-mode";
import { useT } from "../../lib/i18n";
import { sessionDisplayTitle } from "../../lib/session-title";
import { useHostView } from "../../stores/remote";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useProjectList, useSidebarProjects } from "../../stores/sidebar-projects";
import { useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import type { MissingFolderRequest } from "../../stores/ui";
import { Banner, Button, PanelErrorBoundary, Sheet } from "../common";
import { SubagentTranscript } from "../panels/SubagentTranscript";
import { useStoredTranscript } from "../panels/use-stored-transcript";

/**
 * The sheet a click on a stored session whose folder is gone opens instead of resuming work there (main refuses the
 * spawn: `folder-missing`): its transcript, read-only (no composer), and one action. Restore when disk care saved the
 * worktree (the reopen with `restoreSaved`), else Archive on the computer that owns the session.
 */
export function MissingFolderSheet({
	request,
	open,
	onClose,
}: {
	request: MissingFolderRequest;
	open: boolean;
	onClose: () => void;
}) {
	const t = useT();
	const phone = useShellMode() === "phone";
	const { sessionPath, device, folder, saved } = request;
	const { sessions } = useSessionList("global", device);
	const row = sessions.find(session => session.path === sessionPath);
	const title = row ? sessionDisplayTitle(row, t("sidebar.untitled")) : t("sidebar.untitled");
	const transcript = useStoredTranscript(sessionPath, device);
	const host = useHostView(device);
	const { layout } = useProjectList(device, host?.state === "online" && !saved);
	const liveLayout = useSidebarProjects(s => (device === undefined ? undefined : s.liveLayouts[device]));
	const canArchive =
		!!row && (device === undefined || (host?.state === "online" && !!layout && layout === liveLayout));

	const restore = () => {
		onClose();
		useTabsStore
			.getState()
			.openTab({
				sessionPath,
				kind: row?.kind === "chat" ? "chat" : "agent",
				restoreSaved: true,
				...(device === undefined ? {} : { device }),
			})
			.catch((error: unknown) => toastError({ title: t("tabs.newFailed"), error }));
	};
	const archive = async () => {
		if (!row || !canArchive) return;
		try {
			if (device === undefined) await useSidebarPrefs.getState().setSessionsArchived([row.id], true);
			else if (layout)
				await useSidebarProjects.getState().changeLayout(device, layout, {
					op: "set-sessions-archived",
					ids: [row.id],
					archived: true,
				});
			onClose();
		} catch (error) {
			toastError({ title: t("sidebar.archiveFailed"), error });
		}
	};

	return (
		<Sheet
			bodyClassName="flex min-h-0 flex-1 flex-col"
			footer={
				saved ? (
					<Button data-missing-folder-restore onClick={restore} variant="primary">
						{t("missingFolder.restore")}
					</Button>
				) : (
					<>
						<Button
							data-missing-folder-locate
							onClick={() =>
								void import("../../lib/relocate-folder")
									.then(module => module.relocateFolder({ device, from: folder, sessions }))
									.then(moved => moved && onClose())
									.catch((error: unknown) => toastError({ title: t("sidebar.project.addFailed"), error }))
							}
							variant="secondary"
						>
							{t("sidebar.menu.locateFolder")}
						</Button>
						<Button
							data-missing-folder-archive
							disabled={!canArchive}
							onClick={() => void archive()}
							variant="primary"
						>
							{t("missingFolder.archive")}
						</Button>
					</>
				)
			}
			onClose={onClose}
			open={open}
			placement={phone ? "full" : "right"}
			size="lg"
			title={title}
		>
			<div className="flex min-h-0 flex-1 flex-col" data-missing-folder-sheet={sessionPath}>
				<div className="shrink-0 px-4 pt-3 pb-1">
					<Banner variant="warning">
						{t(saved ? "missingFolder.bannerSaved" : "missingFolder.banner", { folder })}
					</Banner>
				</div>
				<PanelErrorBoundary>
					<SubagentTranscript live={false} transcript={transcript} />
				</PanelErrorBoundary>
			</div>
		</Sheet>
	);
}
