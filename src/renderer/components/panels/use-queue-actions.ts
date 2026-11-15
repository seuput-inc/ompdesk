/** Withdraw pending instructions by opaque bridge identity. */
import { useCallback } from "react";
import { useStore } from "zustand";
import { useT } from "../../lib/i18n";
import { reconcileManualRecovery } from "../../lib/manual-recovery";
import { useTabRpc } from "../../lib/tab-rpc";
import { type ComposerStore, useComposerStore } from "../../stores/composer";
import { outboxSession, useOutboxStore } from "../../stores/outbox";
import { type QueueStore, useQueueStore } from "../../stores/queue";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";

export interface QueueActions {
	ready: boolean;
	remove: (instance: string, id: string) => Promise<boolean>;
	edit: (instance: string, id: string) => Promise<boolean>;
}

export function useQueueActions(): QueueActions {
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const queue = sessionRuntimeStore<QueueStore>(tabId, "queue") ?? useQueueStore;
	const session = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
	const ready = useStore(session, state => state.status) === "ready";
	const t = useT();

	const remove = useCallback(
		async (instance: string, id: string): Promise<boolean> => {
			const snapshot = queue.getState();
			if (
				!ready ||
				snapshot.instance !== instance ||
				!snapshot.entries.some(entry => entry.id === id && entry.state === "ready")
			)
				return false;
			const targetId = tabId ?? useTabsStore.getState().activeTabId;
			const tab = useTabsStore.getState().tabs.find(entry => entry.id === targetId);
			const sessionId = tab?.sessionId || session.getState().sessionId;
			const composer = targetId
				? (sessionRuntimeStore<ComposerStore>(targetId, "composer") ?? useComposerStore)
				: null;
			const stillCurrent = () =>
				!!targetId &&
				!!tab &&
				!!sessionId &&
				!!composer &&
				session.getState().sessionId === sessionId &&
				(sessionRuntimeStore<ComposerStore>(targetId, "composer") ?? useComposerStore) === composer;
			let acknowledged = false;
			try {
				const response = await rpc.queueRemove(instance, id, "discard");
				if (!response.success) {
					toastError({ title: t("queuePanel.removeFailed"), error: response });
					return false;
				}
				const data = response.data;
				if (
					typeof data !== "object" ||
					data === null ||
					!("removed" in data) ||
					data.removed !== true ||
					!("recoveryId" in data) ||
					typeof data.recoveryId !== "string" ||
					!("intent" in data) ||
					data.intent !== "discard"
				)
					return false;
				const ack = await rpc.ackManualRecovery(data.recoveryId, { kind: "discard" });
				if (
					!ack.success ||
					typeof ack.data !== "object" ||
					ack.data === null ||
					!("acknowledged" in ack.data) ||
					ack.data.acknowledged !== true ||
					!("recoveryId" in ack.data) ||
					ack.data.recoveryId !== data.recoveryId ||
					!("disposition" in ack.data) ||
					typeof ack.data.disposition !== "object" ||
					ack.data.disposition === null ||
					!("kind" in ack.data.disposition) ||
					ack.data.disposition.kind !== "discard"
				) {
					toast({ variant: "warning", message: t("composerQueue.discardPending") });
					return false;
				}
				acknowledged = true;
				const current = queue.getState();
				if (current.instance !== instance) return false;
				current.setFromFrame({ instance, entries: current.entries.filter(entry => entry.id !== id) });
				return true;
			} catch (error) {
				toastError({ title: t("queuePanel.removeFailed"), error });
				return false;
			} finally {
				void queue.getState().refresh();
				if (!acknowledged && tab && sessionId && composer && stillCurrent())
					await reconcileManualRecovery(rpc, outboxSession({ ...tab, sessionId }), composer, stillCurrent);
			}
		},
		[queue, ready, rpc, session, t, tabId],
	);

	const edit = useCallback(
		async (instance: string, id: string): Promise<boolean> => {
			const snapshot = queue.getState();
			if (
				!ready ||
				snapshot.instance !== instance ||
				!snapshot.entries.some(entry => entry.id === id && entry.state === "ready")
			)
				return false;
			const targetId = tabId ?? useTabsStore.getState().activeTabId;
			const tab = useTabsStore.getState().tabs.find(entry => entry.id === targetId);
			const sessionId = tab?.sessionId || session.getState().sessionId;
			if (!targetId || !tab || !sessionId) {
				toastError({ title: t("queuePanel.editFailed"), error: t("input.agentConnecting") });
				return false;
			}
			const composer = sessionRuntimeStore<ComposerStore>(targetId, "composer") ?? useComposerStore;
			if (composer.getState().editingRecovered) return false;
			const stillCurrent = () =>
				session.getState().sessionId === sessionId &&
				(sessionRuntimeStore<ComposerStore>(targetId, "composer") ?? useComposerStore) === composer;
			let recoveryChecked = false;
			try {
				const response = await rpc.queueRemove(instance, id, "draft");
				if (!response.success) {
					toastError({ title: t("queuePanel.editFailed"), error: response });
					return false;
				}
				const data = response.data;
				if (
					typeof data !== "object" ||
					data === null ||
					!("removed" in data) ||
					data.removed !== true ||
					!("recoveryId" in data) ||
					typeof data.recoveryId !== "string" ||
					!("intent" in data) ||
					data.intent !== "draft"
				)
					return false;
				if (!stillCurrent()) return false;
				await reconcileManualRecovery(rpc, outboxSession({ ...tab, sessionId }), composer, stillCurrent);
				recoveryChecked = true;
				if (!stillCurrent()) return false;
				const manual = useOutboxStore
					.getState()
					.items.find(item => item.send.kind === "manual" && item.send.source.recoveryId === data.recoveryId);
				if (manual?.send.kind === "manual" && manual.send.acknowledged)
					return composer.getState().beginRecoveredEdit(manual.id);
				toast({ variant: "warning", message: t("composerQueue.recoveryPending") });
				return false;
			} catch (error) {
				toastError({ title: t("queuePanel.editFailed"), error });
				return false;
			} finally {
				void queue.getState().refresh();
				if (!recoveryChecked && stillCurrent())
					await reconcileManualRecovery(rpc, outboxSession({ ...tab, sessionId }), composer, stillCurrent);
			}
		},
		[queue, ready, rpc, session, t, tabId],
	);

	return { ready, remove, edit };
}
