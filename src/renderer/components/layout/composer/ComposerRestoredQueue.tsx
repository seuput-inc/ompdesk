/**
 * Messages withdrawn by Stop stay apart from the draft until the person resumes or removes them.
 * Each chip can put its message back in the field, including its pictures. Resume sends the held
 * messages in order. The row fits inside the composer on every width.
 */

import { Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import { resumeRestoredQueue } from "../../../lib/messages";
import { queueChipLabel } from "../../../lib/queue-chip";
import { useTabRpc } from "../../../lib/tab-rpc";
import { type RestoredQueueItem, useComposerStore } from "../../../stores/composer";
import { useSessionStore } from "../../../stores/session";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { Button, Chip, Tooltip } from "../../common";
import { QueueImageTiles, queueRowName } from "./queue-lane";

function HeldChip({ item, onSettled }: { item: RestoredQueueItem; onSettled: () => void }) {
	const t = useT();
	const dropRestored = useComposerStore(state => state.dropRestored);
	const restoreHeldToDraft = useComposerStore(state => state.restoreHeldToDraft);
	const name = queueRowName(item.text, item.images.length);
	return (
		<Chip
			actionLabel={t("composerQueue.pausedEdit", { text: name })}
			as="li"
			className="max-w-56"
			data-restored-item
			onClick={() => {
				restoreHeldToDraft(item.id);
				onSettled();
			}}
			onRemove={() => {
				dropRestored(item.id);
				onSettled();
			}}
			removeLabel={t("composerQueue.pausedRemove", { text: name })}
			tooltip={queueChipLabel(item.text, item.images.length)}
			trailing={
				item.images.length > 0 &&
				item.text !== "" && (
					<QueueImageTiles count={item.images.length} images={item.images.map(image => image.content)} />
				)
			}
		>
			{queueChipLabel(item.text, item.images.length)}
		</Chip>
	);
}

export function ComposerRestoredQueue({ onSettled }: { onSettled: () => void }) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const items = useComposerStore(state => state.restoredQueue);
	const clearRestored = useComposerStore(state => state.clearRestored);
	const setMounted = useComposerStore(state => state.setRestoredTrayMounted);
	const ready = useSessionStore(state => state.status) === "ready";
	const [resuming, setResuming] = useState(false);
	useEffect(() => {
		setMounted(true);
		return () => setMounted(false);
	}, [setMounted]);
	if (items.length === 0) return null;

	const resume = () => {
		setResuming(true);
		void resumeRestoredQueue(rpc, tabId).finally(() => {
			setResuming(false);
			onSettled();
		});
	};

	return (
		<section
			aria-label={t("composerQueue.pausedLabel")}
			className="omp-restored-queue flex h-9 shrink-0 items-center gap-2 pr-2 pl-3 pt-1 [--hit-gap-x:8px] [--hit-gap-y:4px]"
			data-restored-queue
		>
			<ul
				aria-label={t("composerQueue.pausedChips")}
				className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none]"
				data-restored-chips
			>
				<li className="inline-flex shrink-0 items-center gap-1.5 text-sc-xs text-(--sc-warning)" data-restored-note>
					<Pause aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					<span className="whitespace-nowrap text-(--sc-text-secondary)">{t("composerQueue.paused")}</span>
				</li>
				{items.map(item => (
					<HeldChip item={item} key={item.id} onSettled={onSettled} />
				))}
			</ul>
			{ready ? (
				<Tooltip content={t("composerQueue.resumeTip")} describe={false}>
					<Button
						data-restored-resume
						disabled={resuming}
						icon={<Play aria-hidden />}
						onClick={resume}
						size="sm"
						variant="secondary"
					>
						{t("composerQueue.resume")}
					</Button>
				</Tooltip>
			) : (
				<Button
					data-restored-resume
					disabled
					disabledReason={t("common.notConnected")}
					icon={<Play aria-hidden />}
					size="sm"
					variant="secondary"
				>
					{t("composerQueue.resume")}
				</Button>
			)}
			<Button
				aria-label={t("composerQueue.pausedDiscardAll")}
				data-restored-discard
				onClick={() => {
					clearRestored();
					onSettled();
				}}
				size="sm"
				variant="ghost"
			>
				{t("composerQueue.pausedDiscard")}
			</Button>
		</section>
	);
}
