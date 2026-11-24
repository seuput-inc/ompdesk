/**
 * The steps of closing a tab, shared by the window's own `tabs.close` and by main closing a paired web page's tab
 * on an agent's behalf (`AgentControlHostDeps.releaseTab`), so the two never drift.
 */
import type { AutoCloseTurn } from "../shared/ipc-types";
import type { SidecarPool } from "./sidecar-pool";
import type { ClientWindow } from "./web/client-window";
import type { FileEditTarget } from "./web/file-edit-reports";
import { readLiveLifecycleSettings, type WorktreeLifecycle } from "./worktree-lifecycle";

export interface TabReleaseDeps {
	sidecarPool: Pick<
		SidecarPool,
		"sidecarForTab" | "windowOfTab" | "detachViewer" | "isHostedView" | "canReleaseTab" | "releaseTab" | "fileEdits"
	>;
	/** A tab owning a `worktree.onStart` worktree re-reads `worktree.onExit` from its live session before it goes. */
	worktreeLifecycle: Pick<WorktreeLifecycle, "refreshExitPolicy">;
	closeTabTerminals(windowId: number, tabId: string): void;
}

/**
 * Close `tabId` of `win`. A window viewing another window's tab only leaves it (the owner's close releases it for
 * all); a view of a paired device's tab only leaves it (the omp and its worktree are the device's); anything else
 * hands its worktree exit to `worktree-lifecycle`, closes the window's terminals of the tab and releases its sidecar.
 * `senderId` is the id the tab's terminals were opened under. `unlessDirty` (main closing a paired page's tab for an
 * agent): false when a live connection of that page names the tab dirty, which the core checks in the step that
 * removes the tab (`releaseTab`), so a report landing during the exit-policy read or the host close still keeps it.
 * Main asks the page's word itself only before a paired host is told to close its turn, which no refusal undoes.
 */
export async function closeWindowTab(
	deps: TabReleaseDeps,
	win: ClientWindow,
	tabId: string,
	senderId: number,
	unlessDirty?: FileEditTarget,
	expectedTurn?: AutoCloseTurn,
): Promise<boolean> {
	const sidecar = deps.sidecarPool.sidecarForTab(win, tabId);
	if (!sidecar) return false;
	if (expectedTurn !== undefined) {
		if (deps.sidecarPool.windowOfTab(tabId)?.webContents.id !== win.webContents.id) return false;
	} else if (deps.sidecarPool.detachViewer(win, tabId)) return true;
	if (!deps.sidecarPool.isHostedView(tabId)) {
		await deps.worktreeLifecycle.refreshExitPolicy(tabId, () => readLiveLifecycleSettings(sidecar));
	}
	if (expectedTurn !== undefined) {
		if (sidecar.closeHostTurn) {
			if (!deps.sidecarPool.canReleaseTab(tabId, expectedTurn)) return false;
			if (unlessDirty && deps.sidecarPool.fileEdits(unlessDirty, tabId) === "dirty") return false;
			if (!(await sidecar.closeHostTurn(expectedTurn.host ?? null))) return false;
			if (deps.sidecarPool.sidecarForTab(win, tabId) !== sidecar) return false;
		}
		if (!deps.sidecarPool.releaseTab(tabId, expectedTurn, unlessDirty)) return false;
		deps.closeTabTerminals(senderId, tabId);
		return true;
	}
	if (!unlessDirty) {
		deps.closeTabTerminals(senderId, tabId);
		return deps.sidecarPool.releaseTab(tabId);
	}
	if (!deps.sidecarPool.releaseTab(tabId, undefined, unlessDirty)) return false;
	deps.closeTabTerminals(senderId, tabId);
	return true;
}
