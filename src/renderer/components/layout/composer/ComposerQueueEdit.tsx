/**
 * Edit queued: the composer field takes a queued message over (`composer.editingQueued`). A banner says so
 * ("Edit queued · Saves as last in “After this turn” · Cancel"), the field holds the message, Send becomes a check that
 * saves, and Cancel or Esc puts the exact previous draft (text and pictures) back.
 *
 * While it is edited the message is held, so stock can never deliver it unedited (Orca's edit hold): Edit hands the field
 * over at once, so what the person types next lands in the edit and never in a send beneath it, and meanwhile has the
 * core keep it (`queue_hold`, a 120 s lease this window renews every 30 s), then takes it out of stock's queue
 * (`queue_remove`); one stock delivered meanwhile is not edited ("editGone") and the field gets its draft back. Save and
 * Cancel wait for that (`EditingQueued.began`) before they queue anything. Save queues the edited text, pictures
 * kept, in the message's lane the way the composer sends (`prompt` with that lane's `streamingBehavior`: queued while a
 * turn runs, a new turn once none does); Cancel queues the original back the same way while a turn runs, and holds it
 * in the restored tray once none does. The core's hold goes only after that. A window or tab that goes mid-edit stops
 * renewing: the original is handed to the core's held queue (never re-sent by itself), the lease lapses and the tab's
 * restored tray takes it once (`takeHeldQueue`: when a tray mounts or the omp comes back, and again one lease later).
 * A picture-only message stays not editable.
 */

import { useCallback } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { RpcQueuedMessage } from "../../../../shared/rpc-types";
import { cx } from "../../../lib/format";
import { translate, useT } from "../../../lib/i18n";
import { restoreAbortedQueue } from "../../../lib/messages";
import { expandPasteMarkers } from "../../../lib/paste-blobs";
import { type TabRpc, useTabRpc } from "../../../lib/tab-rpc";
import { type ComposerStore, type EditingQueued, useComposerStore } from "../../../stores/composer";
import { type QueueLane, type QueueStore, useQueueStore } from "../../../stores/queue";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { toast, toastError } from "../../../stores/toast";
import { Badge, Button } from "../../common";
import { queueRowName } from "./queue-lane";
import { useStableCallback } from "./use-stable-callback";

/** The core's hold of an edited message lapses this long after its last renewal (`EDIT_LEASE_MS`, core `sidecar/held_queue.rs`). */
export const HOLD_LEASE_MS = 120_000;
/** How often an edit renews the core's hold. */
const HOLD_RENEW_MS = 30_000;

interface TabStores {
	composer: Pick<StoreApi<ComposerStore>, "getState">;
	queue: Pick<StoreApi<QueueStore>, "getState">;
	session: Pick<StoreApi<SessionStore>, "getState">;
}

/** The tab's stores, bound before any await: the user may switch tabs meanwhile. */
function tabStores(tabId: string | null): TabStores {
	return {
		composer: sessionRuntimeStore<ComposerStore>(tabId, "composer") ?? useComposerStore,
		queue: sessionRuntimeStore<QueueStore>(tabId, "queue") ?? useQueueStore,
		session: sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore,
	};
}

function letGo(rpc: TabRpc, token: string): void {
	// shortcut: a release lost to a dropped link lets the lease lapse, and the original is offered once more in the
	// restored tray (held, never sent); retry the release if that shows up.
	rpc.command({ type: "queue_hold", token }).catch(() => {});
}

/**
 * Queue `text` (the edit's or the original) in the edited message's lane, then let the core's hold go. `cancel`: no turn
 * runs any more, so the original waits in the restored tray instead of starting one. A refused send holds it there too.
 */
async function requeue(
	rpc: TabRpc,
	stores: TabStores,
	editing: EditingQueued,
	text: string,
	cancel: boolean,
): Promise<void> {
	// Nothing to queue again until the core holds it and stock's queue let it go; an edit that never began left both as they were.
	if (!(await editing.began)) return;
	const images = editing.images.length > 0 ? editing.images : undefined;
	const hold = () => {
		const entry = [{ text, images }];
		restoreAbortedQueue(stores.composer.getState(), {
			steering: editing.lane === "steering" ? entry : [],
			followUp: editing.lane === "followUp" ? entry : [],
		});
	};
	if (cancel && !stores.session.getState().isStreaming) hold();
	else {
		// Saved: the edit's new chip, whenever its frame comes, is where it landed (the last of its lane).
		const forget = cancel ? undefined : stores.queue.getState().expectEdited(text, editing.lane);
		try {
			if (images) stores.queue.getState().expectImages(text, images);
			const response = await rpc.prompt(text, images, editing.lane === "steering" ? "steer" : "followUp");
			if (!response.success) {
				forget?.();
				toastError({ title: translate("input.sendFailed"), error: response });
				hold();
			}
		} catch (error) {
			forget?.();
			toastError({ title: translate("input.sendFailed"), error });
			hold();
		}
	}
	letGo(rpc, editing.token);
}

/**
 * Edit of a queued message (the queue row's Edit): hand the field over at once, then hold it in the core and take it
 * out of stock's queue. An edit that cannot begin gives the field its draft back.
 */
export function useBeginQueueEdit(): (item: RpcQueuedMessage, lane: QueueLane) => void {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	return useStableCallback((item: RpcQueuedMessage, lane: QueueLane): void => {
		const stores = tabStores(tabId);
		const hold = {
			token: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
			lane,
			text: item.text,
		};
		const { promise: began, resolve } = Promise.withResolvers<boolean>();
		stores.composer
			.getState()
			.beginEditQueued({ id: item.id, lane, text: item.text, images: item.images, token: hold.token, began });
		const giveUp = () => {
			resolve(false);
			if (stores.composer.getState().editingQueued?.token === hold.token) stores.composer.getState().endEditQueued();
		};
		void (async () => {
			try {
				const held = await rpc.command({ type: "queue_hold", ...hold });
				if (!held.success) {
					toastError({ title: t("queuePanel.editFailed"), error: held });
					return giveUp();
				}
				const removed = await rpc.queueRemove(item.id).catch(() => null);
				if (!removed?.success || (removed.data as { removed?: boolean } | undefined)?.removed === false) {
					letGo(rpc, hold.token);
					giveUp();
					await stores.queue.getState().refresh();
					const { steering, followUp } = stores.queue.getState();
					if ([...steering, ...followUp].some(entry => entry.id === item.id))
						toastError({ title: t("queuePanel.editFailed"), error: removed ?? undefined });
					else toast({ variant: "info", message: t("composerQueue.editGone", { text: queueRowName(item.text) }) });
					return;
				}
			} catch (error) {
				toastError({ title: t("queuePanel.editFailed"), error });
				return giveUp();
			}
			resolve(true);
			// Renewed while this tab's store still edits it; a window or tab that went stops, and the lease lapses.
			const renew = setInterval(() => {
				if (
					tabStores(tabId).composer !== stores.composer ||
					stores.composer.getState().editingQueued?.token !== hold.token
				)
					clearInterval(renew);
				else rpc.command({ type: "queue_hold", ...hold }).catch(() => {});
			}, HOLD_RENEW_MS);
		})();
	});
}

/** Save and cancel of the queued message the field is editing; `editing` is null when none is. */
export function useComposerQueueEdit() {
	const editing = useComposerStore(state => state.editingQueued);
	const endEdit = useComposerStore(state => state.endEditQueued);
	const ready = useSessionStore(state => state.status) === "ready";
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	/** Save `text` (the field's draft) as the queued message; true when the edit ended. */
	const save = useStableCallback((text: string): boolean => {
		const next = expandPasteMarkers(text).trim();
		if (!editing || !ready || next === "") return false;
		endEdit();
		void requeue(rpc, tabStores(tabId), editing, next, false);
		return true;
	});
	const cancel = useCallback(() => {
		if (!editing) return;
		endEdit();
		void requeue(rpc, tabStores(tabId), editing, editing.original, true);
	}, [editing, endEdit, rpc, tabId]);
	return { editing, save, cancel };
}

/** The banner above the field while a queued message is edited. `onCancel` also hands focus back to the field. */
export function ComposerEditBanner({ onCancel }: { onCancel: () => void }) {
	const t = useT();
	const editing = useComposerStore(state => state.editingQueued);
	if (!editing) return null;
	return (
		<div
			className={cx(
				"flex h-9 shrink-0 items-center gap-2 rounded-t-(--sc-radius-xl) bg-(--sc-accent-soft) pr-1.5 pl-3 text-sc-sm text-(--sc-text) [--hit-gap-x:8px] [--hit-gap-y:0px]",
			)}
			data-queue-edit-banner
		>
			<Badge variant="accent">{t("composerQueue.editBanner")}</Badge>
			<span
				className="min-w-0 flex-1 truncate text-sc-xs text-(--sc-text-muted)"
				title={t("composerQueue.editRestore")}
			>
				{t("composerQueue.editSaves", { lane: t(`composerQueue.lane.${editing.lane}`) })}
			</span>
			<Button data-queue-edit-cancel onClick={onCancel} size="sm" variant="ghost">
				{t("queuePanel.cancelEdit")}
			</Button>
		</div>
	);
}
