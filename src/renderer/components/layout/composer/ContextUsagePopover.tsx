import { ArrowUpRight, BarChart3, GitFork, Minimize2, RotateCw } from "lucide-react";
import {
	type CSSProperties,
	type FocusEvent,
	type ReactElement,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type { RpcContextReportResult } from "../../../../shared/rpc-types";
import { useOverlayPresence } from "../../../hooks/use-overlay-presence";
import { buildCurrentCommandMenu } from "../../../lib/command-registry";
import { useCompactionPoints } from "../../../lib/compaction-limits";
import { type ContextTone, contextTone, contextUsageView, promptCacheText } from "../../../lib/context-usage";
import { cx, formatTokens } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { openHandoffDialog } from "../../../stores/fork-handoff";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Button, ProgressBar, Spinner, Tooltip } from "../../common";
import { popoverTabStops, tabOutOfPopover } from "../../common/popover-focus";
import { ComposerSheet } from "./ComposerSheet";
import { keepFocus } from "./keep-focus";

interface AnchorPosition {
	bottom?: number;
	left: number;
	top?: number;
	width: number;
}

interface UsageCategory {
	color: string;
	key: "files" | "messages" | "system" | "tools";
	tokens: number;
}

const POPOVER_WIDTH = 336;
const POPOVER_ESTIMATED_HEIGHT = 220;
const VIEWPORT_EDGE = 12;

function approximateTokens(tokens: number): string {
	return tokens > 0 ? `~${formatTokens(tokens)}` : "0";
}

/**
 * Compact context control beside Send, the same on every shell: a ring that fills with the used share of the window
 * and turns warning near the compaction point and danger at it (`contextTone`). Its numbers ("Context 62% · 124k /
 * 200k · compacts at 160k") are the accessible name and the tooltip, never text on the toolbar. A hover or a click or
 * Enter/Space reveals the native provider-anchored token breakdown without opening the full context-report modal
 * (the tooltip stays off while it shows: the breakdown says the same). Keyboard focus alone never opens it; an
 * Enter/Space open moves focus into the breakdown, Tab past its last control closes it and goes on to the next toolbar
 * control, Escape closes it and returns to the ring.
 */
export function ContextUsagePopover({ variant = "ring" }: { variant?: "ring" | "sheet" }) {
	/** The phone: the breakdown is a bottom sheet (no floating card, no hover) and the ring keeps the field's focus. */
	const sheet = variant === "sheet";
	const t = useT();
	const rpc = useTabRpc();
	const contextUsage = useSessionStore(state => state.contextUsage);
	const sessionId = useSessionStore(state => state.sessionId);
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const compacting = useSessionStore(state => state.isCompacting);
	const model = useModelStore(state => state.model);
	const modelSelector = model ? `${model.provider}/${model.id}` : null;
	const points = useCompactionPoints(sidecarReady, modelSelector);
	/** Stock's resolved auto-compaction trigger for this model, in tokens; absent while auto-compaction is off. */
	const compactAt = modelSelector ? points?.bySelector.get(modelSelector)?.tokens : undefined;
	const [open, setOpen] = useState(false);
	const [pinned, setPinned] = useState(false);
	const [anchor, setAnchor] = useState<AnchorPosition | null>(null);
	const [report, setReport] = useState<RpcContextReportResult | null>(null);
	const [loadedKey, setLoadedKey] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const closeTimer = useRef<number | undefined>(undefined);
	// The popover leaves in `instant` (`omp-pop-out`); the phone's sheet has its own presence (ComposerSheet).
	const { mounted, closing } = useOverlayPresence(open, "instant");
	/** Opened with Enter or Space: focus moves into the breakdown once it is on screen (never on a hover or a focus). */
	const focusPanel = useRef(false);

	useEffect(() => {
		if (!mounted || !anchor || !focusPanel.current) return;
		focusPanel.current = false;
		const panel = popoverRef.current;
		(panel ? (popoverTabStops(panel)[0] ?? panel) : null)?.focus();
	}, [mounted, anchor]);

	const usageKey = contextUsage ? `${sessionId}:${contextUsage.tokens}:${contextUsage.contextWindow}` : "";

	const updateAnchor = useCallback(() => {
		const rect = buttonRef.current?.getBoundingClientRect();
		if (!rect) return;
		const viewportWidth = Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1024;
		const viewportHeight = Number.isFinite(window.innerHeight) && window.innerHeight > 0 ? window.innerHeight : 768;
		const width = Math.min(POPOVER_WIDTH, viewportWidth - VIEWPORT_EDGE * 2);
		const left = Math.max(VIEWPORT_EDGE, Math.min(rect.right - width, viewportWidth - width - VIEWPORT_EDGE));
		if (rect.top >= POPOVER_ESTIMATED_HEIGHT + VIEWPORT_EDGE) {
			setAnchor({ bottom: viewportHeight - rect.top + 10, left, width });
			return;
		}
		setAnchor({ left, top: rect.bottom + 10, width });
	}, []);

	const cancelScheduledClose = useCallback(() => {
		if (closeTimer.current !== undefined) {
			window.clearTimeout(closeTimer.current);
			closeTimer.current = undefined;
		}
	}, []);

	const reveal = useCallback(() => {
		cancelScheduledClose();
		updateAnchor();
		setOpen(true);
	}, [cancelScheduledClose, updateAnchor]);

	const dismiss = useCallback(() => {
		cancelScheduledClose();
		setOpen(false);
		setPinned(false);
		// Escape from inside the breakdown: the portaled panel is about to go, focus goes back to the ring.
		if (popoverRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
	}, [cancelScheduledClose]);

	const scheduleClose = useCallback(() => {
		if (pinned) return;
		cancelScheduledClose();
		closeTimer.current = window.setTimeout(() => setOpen(false), 120);
	}, [cancelScheduledClose, pinned]);

	useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose]);

	/** Focus moving on to a control outside the ring and the breakdown closes it, pinned or not (Tab out of it). */
	const closeOnFocusOut = (event: FocusEvent<HTMLElement>) => {
		const next = event.relatedTarget as Node | null;
		if (buttonRef.current?.contains(next) || popoverRef.current?.contains(next)) return;
		if (next) dismiss();
		else scheduleClose();
	};

	useEffect(() => {
		if (!open || sheet) return;
		const onViewportChange = () => updateAnchor();
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
			dismiss();
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// Claim the keypress: the app-wide Escape handler runs next on window and
			// would abort the active turn in the same keystroke that closed this popover.
			event.preventDefault();
			dismiss();
		};
		window.addEventListener("resize", onViewportChange);
		window.addEventListener("scroll", onViewportChange, true);
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("resize", onViewportChange);
			window.removeEventListener("scroll", onViewportChange, true);
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [sheet, dismiss, open, updateAnchor]);

	const [attempt, setAttempt] = useState(0);

	/* The retry button's bump is the only reason this effect re-runs; nothing
	   inside reads it. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry re-reads by bump
	useEffect(() => {
		if (!open || !sidecarReady || !usageKey || usageKey === loadedKey) return;
		let cancelled = false;
		setLoading(true);
		setError(false);
		void rpc
			.getContextReport()
			.then(response => {
				if (cancelled) return;
				if (response.success) {
					setReport(response.data as RpcContextReportResult);
					setLoadedKey(usageKey);
				} else {
					setError(true);
				}
			})
			.catch(() => {
				if (!cancelled) setError(true);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, loadedKey, open, sidecarReady, usageKey, rpc]);

	const breakdown = loadedKey === usageKey ? report?.breakdown : undefined;
	const promptCache = loadedKey === usageKey ? report?.promptCache : undefined;
	const view = contextUsageView(contextUsage, breakdown);
	const { capacityKnown, contextWindow, percent, remainingTokens, usedTokens } = view;
	const categories = useMemo<UsageCategory[]>(() => {
		if (!breakdown) return [];
		return [
			{
				color: "var(--sc-text-subtle)",
				key: "system",
				tokens: breakdown.systemPromptTokens + breakdown.systemContextTokens + breakdown.skillsTokens,
			},
			// Stock's `/context` counts the context files (AGENTS.md, CLAUDE.md, …) as a category of their own.
			{ color: "var(--omp-syntax-string)", key: "files", tokens: breakdown.instructionFilesTokens },
			{ color: "var(--sc-info)", key: "tools", tokens: breakdown.systemToolsTokens },
			{ color: "var(--sc-accent)", key: "messages", tokens: breakdown.messagesTokens },
		].filter(category => category.tokens > 0) as UsageCategory[];
	}, [breakdown]);

	/** One action at a time: the registry's own `/compact` (maintenance guard, hydrate, toasts). */
	const compactNow = async () => {
		const compact = buildCurrentCommandMenu([]).find(item => item.name === "compact");
		if (compact?.affordance.kind !== "action") return;
		dismiss();
		try {
			await compact.affordance.run();
		} catch (cause) {
			toastError({ title: t("contextUsage.compactFailed"), error: cause });
		}
	};

	if (!contextUsage) return null;

	const tone = contextTone(view, compactAt);
	const used = formatTokens(usedTokens);
	const capacity = formatTokens(contextWindow);
	const percentRounded = Math.round(percent);
	const label = !capacityKnown
		? t("contextUsage.ringUnknown", { used })
		: compactAt
			? t("contextUsage.ringCompacts", {
					percent: percentRounded,
					used,
					window: capacity,
					point: formatTokens(compactAt),
				})
			: t("contextUsage.ring", { percent: percentRounded, used, window: capacity });

	const popoverStyle: CSSProperties | undefined = anchor
		? ({
				bottom: anchor.bottom,
				left: anchor.left,
				top: anchor.top,
				width: anchor.width,
				// Grows from the ring: out of the edge that faces it.
				"--omp-pop-origin": anchor.bottom === undefined ? "top center" : "bottom center",
			} as CSSProperties)
		: undefined;

	const frame = (panel: ReactElement) =>
		sheet ? (
			<ComposerSheet label={t("contextUsage.title")} onClose={dismiss} open={open}>
				{panel}
			</ComposerSheet>
		) : (
			createPortal(panel, document.body)
		);

	return (
		<div
			className="relative shrink-0"
			onMouseEnter={sheet ? undefined : reveal}
			onMouseLeave={sheet ? undefined : scheduleClose}
		>
			<Tooltip content={label} describe={false} hidden={open}>
				{/* controls-ok: the popover's trigger is the context ring itself; IconButton would redraw the ring at icon size */}
				<button
					{...(sheet ? keepFocus : {})}
					aria-controls={mounted ? "omp-context-usage-popover" : undefined}
					aria-expanded={open}
					aria-haspopup="dialog"
					aria-label={label}
					className={cx(
						"omp-context-usage-trigger inline-flex h-(--sc-control-sm) min-w-0 items-center justify-center rounded-(--sc-radius-sm) px-1.5 transition-colors duration-(--sc-duration-instant)",
						open
							? "bg-(--sc-selected) text-(--sc-text)"
							: "text-(--sc-text-muted) hover:bg-(--sc-hover) hover:text-(--sc-text)",
					)}
					data-context-ring={tone}
					onBlur={sheet ? undefined : closeOnFocusOut}
					onClick={event => {
						if (sheet) {
							if (open) dismiss();
							else reveal();
							return;
						}
						if (open && pinned) {
							dismiss();
							return;
						}
						reveal();
						setPinned(true);
						// Enter or Space (a click without a pointer): the keyboard user's focus goes into the breakdown.
						if (event.detail === 0) focusPanel.current = true;
					}}
					ref={buttonRef}
					type="button"
				>
					<ContextRing percent={capacityKnown ? percent : null} tone={tone} />
				</button>
			</Tooltip>

			{(sheet || (mounted && anchor)) &&
				frame(
					<div
						aria-hidden={closing || undefined}
						aria-label={sheet ? undefined : t("contextUsage.title")}
						className={cx(
							sheet
								? "px-3 pt-1 pb-1 break-keep text-(--sc-text)"
								: "fixed z-(--sc-z-popover) overflow-hidden rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-elevated) break-keep text-(--sc-text) shadow-(--sc-shadow-md)",
							!sheet && (closing ? "omp-pop-out pointer-events-none" : "omp-pop-in"),
						)}
						id="omp-context-usage-popover"
						inert={closing}
						onBlur={sheet ? undefined : closeOnFocusOut}
						onFocus={sheet ? undefined : cancelScheduledClose}
						onKeyDown={event => {
							const panel = popoverRef.current;
							if (panel && tabOutOfPopover(event, panel, buttonRef.current)) dismiss();
						}}
						onMouseEnter={sheet ? undefined : cancelScheduledClose}
						onMouseLeave={sheet ? undefined : scheduleClose}
						ref={popoverRef}
						role={sheet ? undefined : pinned ? "dialog" : "group"}
						style={sheet ? undefined : popoverStyle}
					>
						<div className={cx(sheet ? "pb-2" : "border-b border-(--sc-divider) bg-(--sc-surface-1) px-4 py-3")}>
							<div className="flex items-baseline justify-between gap-3">
								<span className="flex items-center text-sc-md font-medium text-(--sc-text)">
									{t("contextUsage.title")}{" "}
									{capacityKnown && (
										<strong
											className={cx(
												"ml-1.5 rounded-full px-1.5 py-px font-mono text-sc-xs font-semibold tabular-nums",
												tone === "danger"
													? "bg-(--sc-danger-soft) text-(--sc-danger-on-soft)"
													: tone === "warning"
														? "bg-(--sc-warning-soft) text-(--sc-warning-on-soft)"
														: "bg-(--sc-accent-soft) text-(--sc-accent-on-soft)",
											)}
										>{`${Math.round(percent)}%`}</strong>
									)}
								</span>
								<span className="shrink-0 font-mono text-sc-sm font-semibold tabular-nums" data-context-figure>
									{capacityKnown
										? `${approximateTokens(usedTokens)} / ${formatTokens(contextWindow)}`
										: approximateTokens(usedTokens)}
								</span>
							</div>
							{/* What is left, said once, where touch and the keyboard read it too; the compaction point beside it. */}
							{capacityKnown && (
								<p className="mt-1 text-sc-xs text-(--sc-text-muted) tabular-nums" data-context-left>
									<span data-context-remaining>
										{t("contextUsage.left", { tokens: formatTokens(remainingTokens) })}
									</span>
									{compactAt !== undefined && (
										<>
											{" · "}
											<span data-context-compacts>
												{t("contextUsage.compactsAt", { point: formatTokens(compactAt) })}
											</span>
										</>
									)}
								</p>
							)}
						</div>

						<div className={sheet ? "pt-1" : "px-4 py-3"}>
							{capacityKnown && (
								<ProgressBar
									ariaLabel={t("contextUsage.progress", { percent: Math.round(percent) })}
									ariaValueText={t("contextUsage.left", { tokens: formatTokens(remainingTokens) })}
									segments={
										categories.length > 0
											? categories.map(category => ({
													value: category.tokens,
													label: t(`contextUsage.category.${category.key}`),
													color: category.color,
												}))
											: [{ value: usedTokens, label: t("contextUsage.used"), color: "var(--sc-accent)" }]
									}
									total={contextWindow}
									value={percent / 100}
								/>
							)}

							{!capacityKnown && (
								<div className="rounded-(--sc-radius-md) bg-(--sc-surface-2) px-2.5 py-2 text-sc-sm text-(--sc-text-muted)">
									{t("contextUsage.windowUnknown")}
								</div>
							)}

							{loading && categories.length === 0 ? (
								<Spinner className="py-5" label={t("contextUsage.loading")} size="sm" />
							) : error && categories.length === 0 ? (
								<div className="flex flex-col items-start gap-2 py-4">
									<p role="alert" className="text-sc-sm text-(--sc-text-muted)">
										{t("contextUsage.unavailable")}
									</p>
									<Button
										icon={<RotateCw aria-hidden />}
										onClick={() => setAttempt(count => count + 1)}
										size="sm"
										variant="secondary"
									>
										{t("common.retry")}
									</Button>
								</div>
							) : (
								<div className={cx("mt-3", sheet ? "space-y-2" : "space-y-1.5")}>
									{categories.map(category => {
										const share =
											capacityKnown && contextWindow > 0
												? Math.max(1, Math.round((category.tokens / contextWindow) * 100))
												: null;
										return (
											<div className="flex items-center gap-2.5" key={category.key}>
												<span
													aria-hidden="true"
													className="size-2 shrink-0 rounded-full"
													style={{ backgroundColor: category.color }}
												/>
												<span className="min-w-0 flex-1 truncate text-sc-sm text-(--sc-text-secondary)">
													{t(`contextUsage.category.${category.key}`)}
												</span>
												<span className="shrink-0 font-mono text-sc-sm font-medium text-(--sc-text) tabular-nums">
													{approximateTokens(category.tokens)}
												</span>
												{share !== null && (
													<span className="w-8 shrink-0 text-right font-mono text-sc-xs text-(--sc-text-subtle) tabular-nums">
														{`${share}%`}
													</span>
												)}
											</div>
										);
									})}
								</div>
							)}
							{promptCache && (
								<div
									className="mt-3 flex items-center gap-2 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-1) px-2.5 py-1.5 text-sc-xs text-(--sc-text-muted) tabular-nums"
									data-prompt-cache={promptCache.state}
								>
									<span
										aria-hidden
										className={cx(
											"size-1.5 shrink-0 rounded-full",
											promptCache.state === "warm" ? "bg-(--sc-success)" : "bg-(--sc-text-subtle)",
										)}
									/>
									<span className="min-w-0 truncate">{promptCacheText(promptCache, Date.now(), t)}</span>
								</div>
							)}
						</div>
						<div
							className={
								sheet
									? "-mx-1 mt-2 flex flex-col gap-0.5 border-t border-(--sc-divider) pt-2"
									: "flex flex-wrap gap-1 border-t border-(--sc-divider) bg-(--sc-surface-1) px-2 py-2"
							}
							data-context-actions
						>
							<Button
								className={sheet ? "min-h-(--sc-row-action) w-full justify-start" : undefined}
								disabled={compacting || !sidecarReady}
								icon={<Minimize2 aria-hidden className="text-(--sc-text-muted)" />}
								loading={compacting}
								onClick={() => void compactNow()}
								size="sm"
								variant="ghost"
							>
								{t("contextUsage.compact")}
							</Button>
							<Button
								className={sheet ? "min-h-(--sc-row-action) w-full justify-start" : undefined}
								disabled={compacting || !sidecarReady}
								icon={<GitFork aria-hidden className="text-(--sc-text-muted)" />}
								onClick={() => {
									dismiss();
									openHandoffDialog();
								}}
								size="sm"
								variant="ghost"
							>
								{t("contextUsage.handoff")}
							</Button>
							<Button
								className={cx("w-full justify-start", sheet && "min-h-(--sc-row-action)")}
								icon={<BarChart3 aria-hidden className="text-(--sc-text-muted)" />}
								onClick={() => {
									dismiss();
									useUiStore.getState().openInsights("stats", "session");
								}}
								size="sm"
								trailingIcon={<ArrowUpRight aria-hidden className="ml-auto text-(--sc-text-subtle)" />}
								variant="ghost"
							>
								{t("contextUsage.fullReport")}
							</Button>
						</div>
					</div>,
				)}
		</div>
	);
}

const RING_TONE: Record<ContextTone, string> = {
	unknown: "text-(--sc-text-muted)",
	ok: "text-(--sc-accent)",
	warning: "text-(--sc-warning)",
	danger: "text-(--sc-danger)",
};

/**
 * The composer's context meter glyph: a crisp 16px Orca ring whose arc is the used share of the window,
 * coloured by `tone`. No known capacity draws the empty track only — a share would be invented. The arc
 * and colour ease to a new value once (`.omp-context-ring` in components.css); nothing loops, and reduced
 * motion or software compositing jumps.
 */
function ContextRing({ percent, tone }: { percent: number | null; tone: ContextTone }) {
	const radius = 6;
	const circumference = 2 * Math.PI * radius;
	const filled = percent === null ? 0 : (Math.min(100, Math.max(0, percent)) / 100) * circumference;
	return (
		<svg
			aria-hidden
			className={cx("omp-context-ring size-(--sc-icon-md) shrink-0 -rotate-90", RING_TONE[tone])}
			viewBox="0 0 16 16"
		>
			{/* The track must read as a gauge, not a loading spinner: a solid ring under the fill. */}
			<circle
				cx="8"
				cy="8"
				fill="none"
				r={radius}
				stroke="var(--sc-border)"
				strokeOpacity="0.65"
				strokeWidth="1.75"
			/>
			<circle
				cx="8"
				cy="8"
				data-context-arc={percent === null ? undefined : Math.round(percent)}
				fill="none"
				r={radius}
				stroke="currentColor"
				strokeDasharray={`${filled} ${circumference}`}
				strokeLinecap={filled > 0 ? "round" : "butt"}
				strokeWidth="1.75"
			/>
		</svg>
	);
}
