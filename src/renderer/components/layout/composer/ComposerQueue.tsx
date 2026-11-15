/**
 * The composer's queue pill opens one list of pending instructions without changing the composer's height.
 * Its polite live region announces new and paused instructions.
 */

import { ListOrdered, Pencil, Trash2 } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { RpcQueuedMessage } from "../../../../shared/rpc-types";
import { useShellMode } from "../../../hooks/use-shell-mode";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { queueChipLabel } from "../../../lib/queue-chip";
import { useComposerStore } from "../../../stores/composer";
import { useQueuedMessages, useQueueStore } from "../../../stores/queue";
import { Button, IconButton, LinkButton, Popover } from "../../common";
import { type QueueActions, useQueueActions } from "../../panels/use-queue-actions";
import { QueueImageTiles, queueRowName } from "./queue-lane";

const QueueRow = memo(function QueueRow({
	item,
	instance,
	actions,
	last,
	onEmptied,
}: {
	item: RpcQueuedMessage;
	instance: string;
	actions: QueueActions;
	last: boolean;
	onEmptied: () => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [removing, setRemoving] = useState(false);
	const imageCount = item.images?.length ?? 0;
	const label = queueChipLabel(item.text, imageCount);

	return (
		<li
			className="flex min-h-9 items-start gap-2 rounded-(--sc-radius-sm) py-1 pr-0.5 pl-2 [html[data-input=touch]_&]:min-h-11"
			data-queue-row
		>
			<div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
				<LinkButton
					aria-expanded={open}
					className={cx(
						"max-w-full min-w-0 py-0.5 text-sc-sm",
						open ? "whitespace-pre-wrap break-words" : "truncate",
						item.text === "" && "italic",
					)}
					data-queue-row-text
					onClick={() => setOpen(value => !value)}
					title={open ? t("composerQueue.previewLess") : t("composerQueue.preview")}
					tone="muted"
				>
					{label || "…"}
				</LinkButton>
			</div>
			{item.state !== "ready" && (
				<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">
					{t(item.state === "in_flight" ? "composerQueue.state.inFlight" : "composerQueue.state.approvalSafety")}
				</span>
			)}
			{imageCount > 0 && <QueueImageTiles count={imageCount} images={item.images} />}
			{item.state === "ready" && (
				<span className="flex shrink-0 items-center gap-2 [--hit-gap-x:8px]">
					<IconButton
						data-queue-edit
						disabled={!actions.ready || removing}
						icon={<Pencil />}
						label={t("composerQueue.bringToComposerAria", { text: queueRowName(item.text, imageCount) })}
						onClick={() => {
							setRemoving(true);
							void actions
								.edit(instance, item.id)
								.then(edited => {
									if (edited) onEmptied();
								})
								.finally(() => setRemoving(false));
						}}
						size="sm"
					/>
					<IconButton
						disabled={!actions.ready || removing}
						icon={<Trash2 />}
						label={t("composerQueue.removeAria", { text: queueRowName(item.text, imageCount) })}
						onClick={() => {
							setRemoving(true);
							void actions
								.remove(instance, item.id)
								.then(removed => {
									if (removed && last) onEmptied();
								})
								.finally(() => setRemoving(false));
						}}
						size="sm"
					/>
				</span>
			)}
		</li>
	);
});

/** The count's place inside the localised "{count} queued", so only its words can fold away. */
const COUNT_MARK = "\u0000";

/** The count remains visible when its words fold away on a narrow toolbar. */
function PillLabel({ count, phone }: { count: number; phone: boolean }) {
	const t = useT();
	if (phone) return <span className="tabular-nums">{count}</span>;
	const [before, after] = t("composerQueue.pill", { count: COUNT_MARK }).split(COUNT_MARK);
	return (
		<span className="whitespace-nowrap">
			{before && <span className="omp-queue-pill-word">{before}</span>}
			<span className="tabular-nums">{count}</span>
			{after && <span className="omp-queue-pill-word">{after}</span>}
		</span>
	);
}

/** The queue pill and its popover. */
export function ComposerQueuePill({ onSettled }: { onSettled: () => void }) {
	const t = useT();
	const items = useQueuedMessages();
	const instance = useQueueStore(state => state.instance);
	const actions = useQueueActions();
	const phone = useShellMode() === "phone";
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLButtonElement>(null);
	const total = items.length;
	if (total === 0 || instance === null) return null;
	const close = () => setOpen(false);
	const emptied = () => {
		close();
		onSettled();
	};

	return (
		<>
			<Button
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={t("composerQueue.pillOpen", { count: total })}
				className="omp-composer-queue-pill"
				data-queue-pill
				icon={<ListOrdered aria-hidden />}
				onClick={() => setOpen(value => !value)}
				// Mouse only: the field keeps its focus (a pointerdown handler would swallow the click in WebKit).
				onMouseDown={event => event.preventDefault()}
				ref={anchor}
				size="sm"
				variant="ghost"
			>
				<PillLabel count={total} phone={phone} />
			</Button>
			<Popover
				anchorRef={anchor}
				ariaLabel={t("composerQueue.listLabel")}
				className="max-w-[min(30rem,calc(100vw-1rem))]! p-1.5!"
				onClose={close}
				open={open}
				placement="top-end"
			>
				<div className="w-[min(28rem,calc(100vw-2rem))]" data-queue-popover>
					<div className="flex h-8 items-center gap-1.5 pr-0.5 pl-2 text-sc-xs text-(--sc-text-muted) [--hit-gap-x:8px] [--hit-gap-y:0px]">
						<span className="font-medium text-(--sc-text-secondary)">{t("composerQueue.listLabel")}</span>
						<span className="tabular-nums">{total}</span>
					</div>
					<div className="max-h-72 overflow-y-auto overscroll-contain [--hit-gap-y:0px]" data-queue-list>
						<ul>
							{items.map(item => (
								<QueueRow
									actions={actions}
									instance={instance}
									item={item}
									key={item.id}
									last={total === 1}
									onEmptied={emptied}
								/>
							))}
						</ul>
					</div>
				</div>
			</Popover>
		</>
	);
}

/** Time a live message stays before the region clears (a repeat of the same text then announces again). */
const LIVE_CLEAR_MS = 5_000;
/** The queue hydrates a moment after the composer mounts: its first rows are not news. */
const LIVE_QUIET_MS = 800;

/** Announces new and paused instructions. */
export function ComposerQueueLive() {
	const t = useT();
	const items = useQueuedMessages();
	const held = useComposerStore(state => state.restoredQueue.length);
	const [message, setMessage] = useState("");
	const total = items.length;
	const seen = useRef({ total, held, since: Date.now() });
	useEffect(() => {
		const before = seen.current;
		seen.current = { total, held, since: before.since };
		const hydrating = Date.now() - before.since < LIVE_QUIET_MS;
		if (held > before.held) setMessage(t("composerQueue.livePaused", { count: held }));
		else if (!hydrating && total > before.total) setMessage(t("composerQueue.liveQueued", { count: total }));
	}, [total, held, t]);
	useEffect(() => {
		if (!message) return;
		const timer = setTimeout(() => setMessage(""), LIVE_CLEAR_MS);
		return () => clearTimeout(timer);
	}, [message]);
	return (
		<div aria-live="polite" className="sr-only" data-composer-live role="status">
			{message}
		</div>
	);
}
