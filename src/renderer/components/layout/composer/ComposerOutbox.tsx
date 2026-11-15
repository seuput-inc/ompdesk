/**
 * Offline sends and manually recovered instructions. Manual items never send until the person edits and sends them.
 */
import { AlertTriangle, CloudOff, MessageCircleQuestion, Pencil, RotateCcw, Send } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useT } from "../../../lib/i18n";
import { reconcileManualRecovery } from "../../../lib/manual-recovery";
import { queueChipLabel } from "../../../lib/queue-chip";
import { useTabRpc } from "../../../lib/tab-rpc";
import { type ComposerStore, useComposerStore } from "../../../stores/composer";
import { type OutboxItem, outboxFor, outboxSession, useOutboxStore } from "../../../stores/outbox";
import { useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { pushTabExtensionUiRequest, useTabsStore } from "../../../stores/tabs";
import { toast } from "../../../stores/toast";
import { Chip, IconButton, Tooltip } from "../../common";
import { QueueImageTiles, queueRowName } from "./queue-lane";

function ManualChip({ item, onSettled }: { item: OutboxItem; onSettled: () => void }) {
	const t = useT();
	const editing = useComposerStore(state => state.editingRecovered);
	const begin = useComposerStore(state => state.beginRecoveredEdit);
	const drop = useOutboxStore(state => state.drop);
	if (item.send.kind !== "manual") return null;
	const { text, images } = item.send;
	const note =
		item.send.recovery.kind === "withdrawal_uncertain"
			? t("composerQueue.withdrawalUnknown")
			: item.send.recovery.kind === "discard_pending"
				? t("composerQueue.discardPending")
				: item.send.recovery.kind === "attempt"
					? t("input.deliveryUnknown")
					: !item.send.acknowledged
						? t("composerQueue.recoveryPending")
						: "";
	return (
		<Chip
			actionLabel={t("composerQueue.bringToComposerAria", { text: queueRowName(text, images.length) })}
			as="li"
			className="max-w-64"
			data-manual-draft
			disabled={
				editing !== null ||
				!item.send.acknowledged ||
				item.send.recovery.kind === "withdrawal_uncertain" ||
				item.send.recovery.kind === "discard_pending"
			}
			icon={<Pencil aria-hidden className="size-(--sc-icon-sm)" />}
			labelDisabled={item.send.recovery.kind === "attempt"}
			onClick={() => {
				if (begin(item.id)) onSettled();
				else toast({ variant: "warning", message: t("outbox.notKept") });
			}}
			onRemove={() => {
				drop(item.id);
				onSettled();
			}}
			removeLabel={t("outbox.manualDiscard", { text: queueRowName(text, images.length) })}
			tooltip={note || t("outbox.manualTip")}
			trailing={images.length > 0 && <QueueImageTiles count={images.length} images={images} />}
		>
			{queueChipLabel(text, images.length)}
			{note && <span className="ml-1 text-(--sc-warning)">{note}</span>}
		</Chip>
	);
}
function OutboxChip({ item, tabId, onSettled }: { item: OutboxItem; tabId: string; onSettled: () => void }) {
	const t = useT();
	const drop = useOutboxStore(state => state.drop);
	const patch = useOutboxStore(state => state.patch);
	const { send } = item;
	if (send.kind === "manual") return <ManualChip item={item} onSettled={onSettled} />;
	const text =
		send.kind === "message"
			? queueChipLabel(send.text, send.images.length)
			: t("outbox.answer", { summary: send.summary });
	const StateIcon =
		item.state === "failed"
			? AlertTriangle
			: item.state === "sending"
				? Send
				: send.kind === "answer"
					? MessageCircleQuestion
					: CloudOff;
	const stateWord =
		item.state === "failed" ? t("outbox.failed", { error: item.error ?? "" }) : t(`outbox.${item.state}`);
	return (
		<Chip
			as="li"
			className="max-w-64"
			data-outbox-item
			data-outbox-state={item.state}
			disabled={item.state === "sending"}
			icon={
				<Tooltip content={stateWord} describe={false}>
					<span
						className={`inline-flex shrink-0 ${item.state === "failed" ? "text-(--sc-warning)" : "text-(--sc-text-muted)"}`}
					>
						<StateIcon aria-hidden className="size-(--sc-icon-sm)" />
						<span className="sr-only">{stateWord}</span>
					</span>
				</Tooltip>
			}
			onRemove={() => {
				drop(item.id);
				// The question is open on the computer still: its card comes back to be answered again.
				if (send.kind === "answer" && send.request) pushTabExtensionUiRequest(send.tabId, send.request);
				onSettled();
			}}
			removeLabel={t("outbox.cancel", { text })}
			tooltip={text}
			trailing={
				<>
					{item.state === "failed" && (
						<IconButton
							data-outbox-retry
							icon={<RotateCcw />}
							label={t("outbox.retry", { text })}
							onClick={() => patch(item.id, { state: "held", error: undefined })}
							size="inline"
						/>
					)}
					{send.kind === "message" && (
						<IconButton
							data-outbox-edit
							disabled={item.state === "sending"}
							icon={<Pencil />}
							label={t("outbox.edit", { text })}
							onClick={() => {
								drop(item.id);
								window.dispatchEvent(
									new CustomEvent("omp:fill-composer", {
										detail: { text: send.text, images: send.images, prepend: true, tabId },
									}),
								);
								onSettled();
							}}
							size="inline"
						/>
					)}
				</>
			}
		>
			{text}
		</Chip>
	);
}

export function ComposerOutbox({ onSettled }: { onSettled: () => void }) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId() ?? useTabsStore.getState().activeTabId;
	const tab = useTabsStore(state => state.tabs.find(entry => entry.id === tabId));
	const sessionId = useSessionStore(state => state.sessionId);
	const session = tab ? outboxSession(tab) : null;
	const stableSession =
		tab && (tab.sessionId || sessionId) ? outboxSession({ ...tab, sessionId: tab.sessionId || sessionId }) : null;
	const all = useOutboxStore(state => state.items);
	const saved = useOutboxStore(state => state.saved);
	const items = useMemo(() => {
		if (!session) return [];
		const own = outboxFor(all, session);
		return stableSession && stableSession !== session
			? [...own, ...outboxFor(all, stableSession)].sort((a, b) => a.at - b.at)
			: own;
	}, [all, session, stableSession]);
	useEffect(() => {
		if (!tabId || !stableSession) return;
		const composer = sessionRuntimeStore<ComposerStore>(tabId, "composer") ?? useComposerStore;
		let current = true;
		void reconcileManualRecovery(rpc, stableSession, composer, () => current);
		return () => {
			current = false;
		};
	}, [rpc, stableSession, tabId]);
	const automatic = items.filter(item => item.send.kind !== "manual");
	const manual = items.filter(item => item.send.kind === "manual");
	if (!tabId || items.length === 0) return null;
	return (
		<section
			aria-label={t("outbox.label")}
			className="omp-composer-outbox flex h-9 shrink-0 items-center gap-2 pr-2 pl-3 pt-1 [--hit-gap-x:8px] [--hit-gap-y:4px]"
			data-composer-outbox
		>
			<ul
				aria-label={t("outbox.label")}
				className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none]"
			>
				{automatic.length > 0 && (
					<li className="inline-flex shrink-0 items-center gap-1.5 text-sc-xs" data-outbox-note>
						<CloudOff aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-warning)" />
						<span className="whitespace-nowrap text-(--sc-text-secondary)" role="status">
							{saved ? t("outbox.label") : t("outbox.notKept")}
						</span>
					</li>
				)}
				{automatic.map(item => (
					<OutboxChip item={item} key={item.id} onSettled={onSettled} tabId={tabId} />
				))}
				{manual.length > 0 && (
					<li className="inline-flex shrink-0 items-center gap-1.5 text-sc-xs" data-manual-note>
						<Pencil aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
						<span className="whitespace-nowrap text-(--sc-text-secondary)" role="status">
							{!saved
								? t("outbox.notKept")
								: manual.some(item => item.send.kind === "manual" && item.send.acknowledged)
									? t("outbox.manualLabel")
									: t("composerQueue.recoveryPending")}
						</span>
					</li>
				)}
				{manual.map(item => (
					<ManualChip item={item} key={item.id} onSettled={onSettled} />
				))}
			</ul>
		</section>
	);
}
