/**
 * Settings › Updates & about › This computer: one "Keep tools up to date" switch (default on) for omp (main
 * `omp-updater.ts`), the tool CLIs and extensions (their rows follow below). omp's own "Update now" and what main
 * last learned from npm sit on omp's machine-setup row (`OmpUpdateNowButton`, `OmpUpdateStatus`): one row for omp,
 * not two. OMPdesk's own update stays manual (the section above).
 */
import { RefreshCcw, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { TOOLS_AUTO_UPDATE_PREF } from "../../../shared/desktop-prefs";
import type { OmpUpdateFailure, OmpUpdateHold, OmpUpdateState } from "../../../shared/omp-update";
import { majorOf } from "../../../shared/version";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { useOmpUpdateStore } from "../../stores/omp-update";
import { IconButton, InlineNotice } from "../common";
import { SettingsSwitchRow } from "./SettingsLayout";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What is going on or newer; nothing while omp is current, unchecked or left to the person (the switch says so).
 * A held omp has its own line (`OmpHeldNote`).
 */
function statusText(t: Translate, state: OmpUpdateState): string | null {
	if (state.phase === "checking") return t("ompUpdate.status.checking");
	if (state.phase === "updating") return t("ompUpdate.status.updating");
	if (state.installed === null || state.latest === null || state.latest === state.installed || state.held) return null;
	return t("ompUpdate.status.available", { version: state.installed, latest: state.latest });
}

function failureTitle(t: Translate, failure: OmpUpdateFailure, state: OmpUpdateState): string {
	return t(`ompUpdate.failure.${failure.reason}`, { latest: state.latest ?? "" });
}

/** Why the last omp update attempt failed, and that the next check retries; nothing while the last attempt did not fail. */
export function OmpUpdateFailureNotice({ state }: { state: OmpUpdateState }) {
	const t = useT();
	if (!state.failure) return null;
	return (
		<InlineNotice
			detail={state.failure.detail}
			title={`${failureTitle(t, state.failure, state)} ${t("ompUpdate.retryNote")}`}
			tone="warning"
		/>
	);
}

/** What a held omp's line says: why nothing installed it, and that "Update now" does. */
function heldText(t: Translate, state: OmpUpdateState, held: OmpUpdateHold): string {
	const params = { latest: held.version, installed: state.installed ?? "", tested: state.tested ?? "" };
	if (held.reason !== "failed") return t(`ompUpdate.held.${held.reason}`, params);
	const since = held.since ? Date.parse(held.since) : Number.NaN;
	const days = Number.isNaN(since) ? 0 : Math.floor((Date.now() - since) / DAY_MS);
	return days > 0 ? t("ompUpdate.held.failedDays", { ...params, days }) : t("ompUpdate.held.failed", params);
}

/**
 * A newer omp OMPdesk leaves alone: runners have not verified it against this release yet, or found it breaks it
 * (a host on an older OMPdesk says its major was above the tested one). Nothing while a check or an update runs (the
 * status line speaks then).
 */
export function OmpHeldNote({ state, className = "" }: { state: OmpUpdateState; className?: string }) {
	const t = useT();
	if (!state.held || state.phase !== "idle") return null;
	return (
		<p className={`${className} text-sc-xs break-words text-(--sc-text-muted)`} data-testid="omp-update-held">
			{heldText(t, state, state.held)}
		</p>
	);
}

/**
 * The omp that runs is one runners have not verified against this release (a person's "Update now", an `omp update`
 * in a terminal): said in full, beside a held line too, because OMPdesk keeps that omp and never moves it back, so the
 * row is where the person learns that features may not work on it. A host on an older OMPdesk sends no verified list:
 * its omp above the tested major is the unverified one, and any other omp than the tested one is named as a plain
 * fact ("Tested with"), which a held line already says.
 */
export function OmpTestedNote({ state, className = "" }: { state: OmpUpdateState; className?: string }) {
	const t = useT();
	if (!state.tested || state.installed === null || state.installed === state.tested) return null;
	if (state.verified?.includes(state.installed)) return null;
	const installedMajor = majorOf(state.installed);
	const testedMajor = majorOf(state.tested);
	const unverified =
		state.verified !== undefined || (installedMajor !== null && testedMajor !== null && installedMajor > testedMajor);
	if (!unverified && state.held && state.phase === "idle") return null;
	return (
		<p className={`${className} text-sc-xs break-words text-(--sc-text-muted)`} data-testid="omp-tested">
			{unverified
				? t("ompUpdate.unverified", { version: state.installed, tested: state.tested })
				: t("ompUpdate.tested", { version: state.tested })}
		</p>
	);
}

/** omp's "Update now", in the action slot of its machine-setup row. */
export function OmpUpdateNowButton() {
	const t = useT();
	const state = useOmpUpdateStore(store => store.state);
	const updateNow = useOmpUpdateStore(store => store.updateNow);
	const busy = state?.phase !== undefined && state.phase !== "idle";
	return (
		<IconButton
			data-testid="omp-update-now"
			disabled={state === null || busy}
			icon={<RefreshCw />}
			label={t("ompUpdate.now")}
			loading={busy}
			onClick={() => void updateNow()}
			size="sm"
			variant="secondary"
		/>
	);
}

/** Under omp's machine-setup row: a check or update under way, a newer version, one held back, or the last failure. */
export function OmpUpdateStatus() {
	const t = useT();
	const state = useOmpUpdateStore(store => store.state);
	if (!state) return null;
	const text = statusText(t, state);
	return (
		<>
			{text && (
				<p className="ps-6 text-sc-xs break-words text-(--sc-text-muted)" data-testid="omp-update-status">
					{text}
				</p>
			)}
			<OmpHeldNote className="ps-6" state={state} />
			<OmpTestedNote className="ps-6" state={state} />
			<OmpUpdateFailureNotice state={state} />
		</>
	);
}

export function OmpUpdateRows() {
	const t = useT();
	const state = useOmpUpdateStore(store => store.state);
	useEffect(() => {
		useOmpUpdateStore.getState().ensureLoaded();
	}, []);
	return (
		<>
			<SettingsSwitchRow
				icon={<RefreshCcw />}
				checked={state?.enabled ?? true}
				description={t("toolsUpdate.autoDesc")}
				tipOnly
				disabled={state === null}
				id="setting-gui-toolsAutoUpdate"
				label={t("toolsUpdate.auto")}
				onCheckedChange={next => void saveGuiPreference(TOOLS_AUTO_UPDATE_PREF, next, () => {})}
			/>
			{state?.stockAutoTaken && (
				<p className="ps-6 text-sc-xs break-words text-(--sc-text-muted)" data-testid="omp-stock-auto-taken">
					{t("ompUpdate.stockAutoTaken")}
				</p>
			)}
		</>
	);
}
