import { useEffect, useRef } from "react";
import { changelogSummary } from "../../../shared/release-summary";
import { useLang, useT } from "../../lib/i18n";
import {
	changelogSection,
	endsWithFinalConsonant,
	useChangelog,
	WHATS_NEW_AUTO_HIDE_MS,
	WHATS_NEW_PREF,
} from "../../lib/whats-new";
import { useUiStore } from "../../stores/ui";
import { Banner, BrandMark, Button } from "../common";

export default function WhatsNewCardBody({ version, since }: { version: string; since: string | null }) {
	const t = useT();
	const { lang } = useLang();
	const paused = useRef(false);
	// Loaded already when WhatsNewNotice put the card up; the summary follows the title otherwise.
	const markdown = useChangelog();
	const summary = markdown === null ? "" : changelogSummary(changelogSection(markdown, version, lang) ?? "");
	const title = t(endsWithFinalConsonant(version) ? "whatsNew.cardTitle" : "whatsNew.cardTitleRo", { version });

	const open = () => useUiStore.getState().openWhatsNew(version, since);
	const dismiss = useUiStore(state => state.dismissWhatsNewCard);

	// On screen: this version counts as seen, so a relaunch does not show the card again.
	useEffect(() => {
		void window.omp.prefs.set(WHATS_NEW_PREF, version).catch(() => {});
	}, [version]);

	useEffect(() => {
		let visible = 0;
		const timer = setInterval(() => {
			if (paused.current) return;
			if (typeof document.hasFocus === "function" && !document.hasFocus()) return;
			visible += 1000;
			if (visible >= WHATS_NEW_AUTO_HIDE_MS) dismiss();
		}, 1000);
		return () => clearInterval(timer);
	}, [dismiss]);

	return (
		// A full-width row with its own rule under it, so the transcript plainly starts below it: a pill floating over
		// the scroller's top edge, with a line cut there, read as covering the transcript.
		<div className="shrink-0 border-b border-(--sc-divider) px-(--omp-column-pad) py-2">
			<Banner
				actions={
					<Button className="ml-auto shrink-0" data-whats-new-details onClick={open} size="sm" variant="ghost">
						{t("whatsNew.details")}
					</Button>
				}
				aria-label={title}
				className="omp-whats-new-card mx-auto max-w-(--omp-column-reading)"
				compact
				data-whats-new-card=""
				icon={<BrandMark size={16} />}
				onBlur={event => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) paused.current = false;
				}}
				onClick={event => {
					if (!(event.target as Element).closest("button")) open();
				}}
				onDismiss={dismiss}
				onFocus={() => {
					paused.current = true;
				}}
				onKeyDown={event => {
					// ime-ok: Enter acts only when the card itself has focus (target === currentTarget), never a text field.
					if (event.key === "Escape") {
						event.stopPropagation();
						dismiss();
					} else if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
						event.preventDefault();
						open();
					}
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
				{/* Title and the summary sentence wrap whole: one truncated line cut the summary mid-word ("…for the
				    first t…"), so the visible text said nothing. A narrow pane (a phone, a split's quarter) shows the
				    title alone (components.css), its sentence one tap away in See details. */}
				<p className="py-0.5 break-keep" title={summary || title}>
					<span className="font-semibold text-(--sc-text)">{title}</span>
					{summary && (
						<>
							{" "}
							<span className="omp-whats-new-summary" data-whats-new-summary>
								{summary}
							</span>
						</>
					)}
				</p>
			</Banner>
		</div>
	);
}
