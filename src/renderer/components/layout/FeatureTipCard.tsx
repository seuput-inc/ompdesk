/**
 * One-time feature tips (Orca's feature tips, FG58: renderer/src/components/feature-tips/FeatureTipsModal.tsx,
 * feature-tip-startup-gate.ts): a quiet row in the shell's main column under the title bar, with WhatsNewCard's
 * placement rules (in the layout flow, so it never covers a transcript, composer, Send, queue, goal dock or toasts;
 * Esc with focus inside dismisses; it hides after `WHATS_NEW_AUTO_HIDE_MS` of focused, unhovered time). At most one
 * tip per launch, the first of `FEATURE_TIPS` not yet seen, counted seen once it is on screen. It waits until the
 * getting-started guide is finished or hidden, and never shows beside the update card, during first-run or machine
 * setup, or while a tour runs. "Try it" goes to the feature. Orca's animated demos are not ported.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { useSessionStore } from "../../stores/session";
import { FEATURE_TIPS, type FeatureTipId, STARTER_STEPS, useStarterGuideStore } from "../../stores/starter-guide";
import { useUiStore } from "../../stores/ui";
import { webRuntime } from "../../web/runtime";
import { Banner, Button } from "../common";
import { Collapse } from "../common/Collapse";
import { useFirstRunActive } from "../onboarding/FirstRunSlot";
import { WHATS_NEW_AUTO_HIDE_MS } from "./WhatsNewCard";

const TRY: Record<FeatureTipId, () => void> = {
	board: () => useUiStore.getState().openBoard(),
	palette: () => useUiStore.getState().openCommandPalette(),
	phone: () => useUiStore.getState().openSettings("connections:mobile-web"),
	pet: () => useUiStore.getState().openSettings("appearance"),
};

/** Tips a phone's page cannot act on. */
const DESKTOP_ONLY: readonly FeatureTipId[] = ["phone", "pet"];

/** The tip this launch offers, decided once; null when none. */
function useLaunchTip(): FeatureTipId | null {
	const ready = useSessionStore(state => state.status) === "ready";
	const firstRun = useFirstRunActive();
	const takeover = useMachineSetupStore(state => state.takeover);
	const loaded = useStarterGuideStore(state => state.loaded);
	const tipsSeen = useStarterGuideStore(state => state.tipsSeen);
	const touring = useStarterGuideStore(state => state.tour !== null || state.surfaceTour !== null);
	const gettingStarted = useStarterGuideStore(
		state => !state.dismissed && STARTER_STEPS.some(step => !state.done.includes(step)),
	);
	const whatsNew = useUiStore(state => state.whatsNewCard !== null);
	const [tip, setTip] = useState<FeatureTipId | null>(null);
	const decided = useRef(false);

	useEffect(() => {
		void useStarterGuideStore.getState().load();
	}, []);

	useEffect(() => {
		if (decided.current || !ready || !loaded || firstRun || takeover || touring || whatsNew) return;
		decided.current = true;
		if (gettingStarted) return;
		const onPhone = webRuntime() !== null;
		const next = FEATURE_TIPS.find(id => !tipsSeen.includes(id) && !(onPhone && DESKTOP_ONLY.includes(id)));
		if (next) setTip(next);
	}, [ready, loaded, tipsSeen, firstRun, takeover, touring, whatsNew, gettingStarted]);

	return tip;
}

function FeatureTipBody({ id, onDone }: { id: FeatureTipId; onDone: () => void }) {
	const t = useT();
	const paused = useRef(false);

	// On screen: this tip counts as seen, so a relaunch does not offer it again.
	useEffect(() => {
		useStarterGuideStore.getState().seeTip(id);
	}, [id]);

	useEffect(() => {
		let visible = 0;
		const timer = setInterval(() => {
			if (paused.current) return;
			if (typeof document.hasFocus === "function" && !document.hasFocus()) return;
			visible += 1000;
			if (visible >= WHATS_NEW_AUTO_HIDE_MS) onDone();
		}, 1000);
		return () => clearInterval(timer);
	}, [onDone]);

	const title = t(`tip.${id}.title`);
	return (
		<div className="shrink-0 border-b border-(--sc-divider) px-(--omp-column-pad) py-2">
			<Banner
				actions={
					<Button
						className="ml-auto shrink-0"
						data-feature-tip-try
						onClick={() => {
							onDone();
							TRY[id]();
						}}
						size="sm"
						variant="ghost"
					>
						{t("tip.try")}
					</Button>
				}
				aria-label={title}
				className="mx-auto max-w-(--omp-column-reading)"
				compact
				data-feature-tip={id}
				onBlur={event => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) paused.current = false;
				}}
				onDismiss={onDone}
				onFocus={() => {
					paused.current = true;
				}}
				onKeyDown={event => {
					if (event.key !== "Escape") return;
					event.stopPropagation();
					onDone();
				}}
				onMouseEnter={() => {
					paused.current = true;
				}}
				onMouseLeave={() => {
					paused.current = false;
				}}
				role="region"
				tabIndex={0}
				variant="neutral"
			>
				<p className="py-0.5 break-keep">
					<span className="font-semibold text-(--sc-text)">{title}</span> {t(`tip.${id}.body`)}
				</p>
			</Banner>
		</div>
	);
}

/** Mounted once in the shell's main column, after WhatsNewCard. */
export function FeatureTipCard() {
	const tip = useLaunchTip();
	const [open, setOpen] = useState(true);
	const close = useCallback(() => setOpen(false), []);
	return (
		<div aria-atomic="true" aria-live="polite" className="shrink-0" role="status">
			<Collapse open={tip !== null && open}>{tip && <FeatureTipBody id={tip} onDone={close} />}</Collapse>
		</div>
	);
}
