/**
 * Queue mutations of the composer's queue popover and its edit-in-field: edit (omp re-queues the text at the end of its lane),
 * Steer now (queue_move of a follow-up into the steering lane, appended to its end),
 * per-item remove (queue_remove) and per-lane clear (queue_clear). omp cannot
 * reorder within a lane. Every mutation applies optimistically, rolls back on
 * a failed response or rejected transport call unless a newer snapshot
 * superseded it, then resyncs from get_queue so the server stays the single
 * source of truth.
 */

import { useCallback } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { RpcQueuedMessage } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { optimisticWrite } from "../../lib/optimistic";
import { type TabRpc, useTabRpc } from "../../lib/tab-rpc";
import { type QueueLane, type QueueStore, useQueueStore } from "../../stores/queue";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { toastError } from "../../stores/toast";

async function applyLaneMutation(
	queueStore: StoreApi<QueueStore>,
	lane: QueueLane,
	optimistic: (items: RpcQueuedMessage[]) => RpcQueuedMessage[],
	persist: () => Promise<{ success: boolean; error?: string }>,
	failureKey: string,
	t: (key: string) => string,
): Promise<void> {
	await optimisticWrite({
		store: queueStore,
		mutate: state =>
			lane === "steering" ? { steering: optimistic(state.steering) } : { followUp: optimistic(state.followUp) },
		persist,
		onFailure: failure => toastError({ title: t(failureKey), error: failure }),
		resync: () => queueStore.getState().refresh(),
	});
}

/** Remember where stock put a re-queued message (the end of its lane), for the tray to point at it. */
function noteLanded(queueStore: StoreApi<QueueStore>, lane: QueueLane, id: string, kind: "edit" | "lane"): void {
	const items = queueStore.getState()[lane];
	const index = items.findIndex(entry => entry.id === id);
	if (index !== -1) queueStore.getState().noteMoved({ id, lane, position: index + 1, count: items.length, kind });
}

async function applySteerNow(
	queueStore: StoreApi<QueueStore>,
	rpc: TabRpc,
	id: string,
	t: (key: string) => string,
): Promise<void> {
	const settled = optimisticWrite({
		store: queueStore,
		mutate: state => {
			const item = state.followUp.find(entry => entry.id === id);
			if (!item) return {};
			return { steering: [...state.steering, item], followUp: state.followUp.filter(entry => entry.id !== id) };
		},
		persist: () => rpc.queueMove(id, Number.MAX_SAFE_INTEGER, "steering"),
		onFailure: failure => {
			queueStore.setState({ moved: null });
			toastError({ title: t("queuePanel.moveFailed"), error: failure });
		},
		resync: () => queueStore.getState().refresh(),
	});
	noteLanded(queueStore, "steering", id, "lane");
	await settled;
}

export interface QueueActions {
	/** Mutations need a ready sidecar; every action is a no-op otherwise. */
	ready: boolean;
	remove: (lane: QueueLane, id: string) => void;
	edit: (lane: QueueLane, id: string, text: string) => void;
	/** A follow-up (stock's lane) joins the running turn: it moves to the end of the steering lane, pictures kept. */
	steerNow: (id: string) => void;
	clearLane: (lane: QueueLane) => void;
}

export function useQueueActions(): QueueActions {
	const tabRpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const queueStore = sessionRuntimeStore<QueueStore>(tabId, "queue") ?? useQueueStore;
	const t = useT();
	const sessionStore = sessionRuntimeStore<SessionStore>(tabId, "session");
	const ready = useStore(sessionStore ?? useSessionStore, state => state.status) === "ready";

	const remove = useCallback(
		(lane: QueueLane, id: string) => {
			if (!ready) return;
			void applyLaneMutation(
				queueStore,
				lane,
				items => items.filter(item => item.id !== id),
				() => tabRpc.queueRemove(id),
				"queuePanel.removeFailed",
				t,
			);
		},
		[ready, t, tabRpc.queueRemove, queueStore],
	);

	const edit = useCallback(
		(lane: QueueLane, id: string, text: string) => {
			if (!ready) return;
			void applyLaneMutation(
				queueStore,
				lane,
				items => {
					// omp re-queues edited text at the end of its lane.
					const edited = items.find(item => item.id === id);
					return edited ? [...items.filter(item => item.id !== id), { ...edited, text }] : items;
				},
				() => tabRpc.queueEdit(id, text),
				"queuePanel.editFailed",
				t,
			);
			// The re-queue carries the text only.
			queueStore.getState().forgetImages(id);
			noteLanded(queueStore, lane, id, "edit");
		},
		[ready, t, tabRpc.queueEdit, queueStore],
	);

	const steerNow = useCallback(
		(id: string) => {
			if (!ready) return;
			void applySteerNow(queueStore, tabRpc, id, t);
		},
		[ready, t, tabRpc, queueStore],
	);

	const clearLane = useCallback(
		(lane: QueueLane) => {
			if (!ready) return;
			void applyLaneMutation(
				queueStore,
				lane,
				() => [],
				() => tabRpc.queueClear(lane),
				"queuePanel.clearFailed",
				t,
			);
		},
		[ready, t, tabRpc.queueClear, queueStore],
	);

	return { ready, remove, edit, steerNow, clearLane };
}
