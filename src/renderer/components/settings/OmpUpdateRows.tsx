/**
 * Settings › Updates & about › This computer: one "Keep tools up to date" switch (default on) for omp (main
 * `omp-updater.ts`), the tool CLIs and extensions (their rows follow below). omp's own "Update now" and what main
 * last learned from npm sit on omp's machine-setup row (`OmpUpdateNowButton`, `OmpUpdateStatus`): one row for omp,
 * not two. OMPdesk's own update stays manual (the section above).
 */
import { RefreshCcw, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { TOOLS_AUTO_UPDATE_PREF } from "../../../shared/desktop-prefs";
import type { OmpUpdateFailure, OmpUpdateState } from "../../../shared/omp-update";
import { majorOf } from "../../../shared/version";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { useOmpUpdateStore } from "../../stores/omp-update";
import { IconButton, InlineNotice } from "../common";
import { SettingsSwitchRow } from "./SettingsLayout";

type Translate = (key: string, params?: Record<string, string | number>) => string;

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

/**
 * A newer omp OMPdesk leaves alone because its major is above the tested omp's: what it is, why nothing installed
 * it, and that "Update now" does. Nothing while a check or an update runs (the status line speaks then).
 */
export function OmpHeldNote({ state, className = "" }: { state: OmpUpdateState; className?: string }) {
	const t = useT();
	if (!state.held || state.phase !== "idle") return null;
	return (
		<p className={`${className} text-sc-xs break-words text-(--sc-text-muted)`} data-testid="omp-update-held">
			{t("ompUpdate.held.untested-major", { latest: state.held.version, tested: state.tested ?? "" })}
		</p>
	);
}

/**
 * The omp this OMPdesk was verified against, said only while another one runs (after an `omp update`, say), so a
 * mismatch is visible; a held omp's line names it already. Inside the tested major it is a fact, never a warning.
 * An installed omp above the tested major (a person's "Update now", or an install made outside OMPdesk) is said in
 * full instead, whatever else the row says: OMPdesk keeps that omp and never moves it back, so the row is where the
 * person learns that features may not work on it.
 */
export function OmpTestedNote({ state, className = "" }: { state: OmpUpdateState; className?: string }) {
	const t = useT();
	if (!state.tested || state.installed === null || state.installed === state.tested) return null;
	const installedMajor = majorOf(state.installed);
	const testedMajor = majorOf(state.tested);
	const untested = installedMajor !== null && testedMajor !== null && installedMajor > testedMajor;
	if (!untested && state.held && state.phase === "idle") return null;
	return (
		<p className={`${className} text-sc-xs break-words text-(--sc-text-muted)`} data-testid="omp-tested">
			{untested
				? t("ompUpdate.untested", { version: state.installed, tested: state.tested })
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
	);
}
