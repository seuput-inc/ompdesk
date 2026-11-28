import { BarChart3, Info } from "lucide-react";
import { type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import type { SessionStats } from "../../../shared/rpc-types";
import { lazyChunk } from "../../lib/chunk-load";
import { cx, formatCost } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useMessagesStore } from "../../stores/messages";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { useUiStore } from "../../stores/ui";
import { Button, Popover, Skeleton } from "../common";
import { StatusPill, useSessionStatus } from "./SessionStatus";

const SessionUsageFigures = lazyChunk(() => import("./SessionUsageFigures"));

function CurrentStatusPill() {
	const { tone, label } = useSessionStatus();
	return <StatusPill tone={tone} label={label} />;
}

/** One reader: the desktop footer or the paired page's session bar. */
export function SessionUsage({ inFooter = false, statusPill }: { inFooter?: boolean; statusPill?: ReactNode }) {
	const tabRpc = useTabRpc();
	const t = useT();
	const tabId = useRuntimeTabId();
	const sessionId = useSessionStore(s => s.sessionId);
	const status = useSessionStore(s => s.status);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const isCompacting = useSessionStore(s => s.isCompacting);
	const statsPulse = useSessionStore(s => s.statsPulse);
	const statsMessageCount = useMessagesStore(s => s.messages.length);
	const [statusOpen, setStatusOpen] = useState(false);
	const [stats, setStats] = useState<SessionStats | null>(null);
	const statusAnchorRef = useRef<HTMLButtonElement>(null);
	// A settled transcript append and a fresh sidecar snapshot are the two things
	// that can move these figures. Mid-run appends come several times a turn, so
	// only the pulse may re-queue a stats command there — the serial command queue
	// has to stay free for the agent's own traffic.
	const statsTrigger = isStreaming ? `streaming:${statsPulse}` : `idle:${statsMessageCount}:${statsPulse}`;
	const prevSessionRef = useRef<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the settled transcript and the snapshot pulse both refresh the cost figures even when the session ID is stable.
	useEffect(() => {
		if (!sessionId || status !== "ready") {
			setStats(null);
			prevSessionRef.current = null;
			return;
		}
		// Cross-session staleness is the bug: session A's tokens/cost must never
		// display over session B. Within ONE session, keeping the previous read
		// while the refetch is in flight beats a clear-refetch flicker on every
		// message append; the session-id guard rejects mismatched responses.
		if (prevSessionRef.current !== sessionId) setStats(null);
		prevSessionRef.current = sessionId;
		// Compaction rewrites the journal, so a reading taken mid-shake is noise.
		if (isCompacting) return;
		let cancelled = false;
		const requestedSessionId = sessionId;
		const originSession = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		void tabRpc
			.getSessionStats()
			.then(response => {
				if (!cancelled && response.success && originSession.getState().sessionId === requestedSessionId) {
					setStats(response.data as SessionStats);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [sessionId, statsTrigger, status, tabRpc.getSessionStats, tabId, isCompacting]);

	const visibleStats = stats?.sessionId === sessionId ? stats : null;
	const cost = visibleStats ? (visibleStats.history?.cost ?? visibleStats.cost) : null;
	return (
		<>
			<Button
				aria-expanded={statusOpen}
				aria-haspopup="dialog"
				aria-label={t("sessionStatus.trigger", { cost: formatCost(cost, 2) })}
				className={cx(
					"omp-session-status-trigger gap-1.5 px-2 font-normal text-(--sc-text-muted) tabular-nums hover:text-(--sc-text)",
					inFooter && "h-5! px-1.5 text-sc-xs",
				)}
				data-status-session={inFooter || undefined}
				icon={<Info />}
				onClick={() => setStatusOpen(open => !open)}
				ref={statusAnchorRef}
				size="sm"
				variant="ghost"
			>
				{/* A zero or unknown spend is noise in the bar; the popover still spells it out. */}
				{cost ? <span className="omp-session-status-cost">{formatCost(cost, 2)}</span> : null}
			</Button>
			<Popover
				anchorRef={statusAnchorRef}
				ariaLabel={t("sessionStatus.title")}
				className="w-80 max-w-[calc(100vw-2rem)] p-4"
				onClose={() => setStatusOpen(false)}
				open={statusOpen}
				placement={inFooter ? "top-start" : "bottom-end"}
			>
				<div className="flex items-center justify-between gap-3 pb-3">
					<span className="text-sc-md font-semibold text-(--sc-text)">{t("sessionStatus.title")}</span>
					{statusPill ?? <CurrentStatusPill />}
				</div>
				{visibleStats ? (
					<Suspense fallback={<Skeleton className="h-32 w-full" />}>
						<SessionUsageFigures stats={visibleStats} />
					</Suspense>
				) : (
					<p className="border-y border-(--sc-divider) py-3 text-sc-sm text-(--sc-text-muted)">
						{t("sessionStatus.unavailable")}
					</p>
				)}
				<Button
					className="mt-3 w-full justify-start"
					icon={<BarChart3 />}
					onClick={() => {
						setStatusOpen(false);
						useUiStore.getState().openInsights("stats", "session");
					}}
					size="sm"
					variant="ghost"
				>
					{t("sessionStatus.openInsights")}
				</Button>
			</Popover>
		</>
	);
}
