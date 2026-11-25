/**
 * Once per launch, when the sidecar first reports ready: with no provider
 * that can serve, start the inline first-run setup (the empty main area
 * renders it); a setup left at the model step before a relaunch
 * resumes there; otherwise make sure new sessions start on a model that can
 * serve (`ensureServingDefault`). Renders nothing.
 */

import { useCallback, useEffect, useRef } from "react";
import type { CustomProviderView } from "../../../shared/ipc-types";
import type { ProviderInfo } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { FIRST_RUN_STEP_PREF, isResumableFirstRunStep, useFirstRunStore } from "../../stores/first-run";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { chosenModelOf, useModelStore } from "../../stores/model";
import { focusedTabDevice } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { servingVerdict, toProviderInfo } from "../settings/providers/provider-catalog";
import { modelTextAmong } from "../settings/providers/provider-marks";
import { ensureServingDefault } from "./default-model";

export function FirstRunGate() {
	const tabRpc = useTabRpc();
	const t = useT();
	const status = useSessionStore(state => state.status);
	const refreshProviders = useModelStore(state => state.refreshProviders);
	const checkedThisLaunch = useRef(false);
	/**
	 * The connect step was opened ahead of the check below (a fresh install, a true first run). The user may act
	 * on it before the check settles — "Set up later", a sign-in that moves on — and the check must not undo that.
	 */
	const openedEarly = useRef(false);
	const ompInstalled = useMachineSetupStore(state => state.ompInstalled);
	const takeover = useMachineSetupStore(state => state.takeover);
	const openEarly = useCallback(() => {
		const store = useFirstRunStore.getState();
		if (store.phase !== "idle") return;
		store.openProvisional();
		openedEarly.current = true;
	}, []);

	// The first window's React tree is up (this gate mounts with App): a launch timing mark.
	useEffect(() => window.omp.runtime.startupMark("renderer-mounted"), []);

	// Machine setup just installed omp, so it never ran and holds no provider: the provider step shows the
	// moment the setup screen leaves, while omp's first boot runs (seconds on Windows, where cmd.exe, a cold
	// disk and the virus scan of a fresh install all sit in it); its providers fill in once the session is
	// ready. The check below settles it: no serving provider keeps it, one that serves after all (an omp
	// reinstalled over an agent dir with credentials) closes it again.
	useEffect(() => {
		if (!ompInstalled || takeover || checkedThisLaunch.current) return;
		openEarly();
	}, [ompInstalled, openEarly, takeover]);

	// omp is installed but holds no credential at all (stock's store and env keys, read in main without a
	// session) and models.yml has no keyless endpoint: a true first run. The provider step opens now instead
	// of after omp's boot (≈3.6 s for the real omp on macOS), settled by the check below like the one above.
	// A paired host's tab, a saved later step or an answer after the check leaves it to that check.
	useEffect(() => {
		const device = focusedTabDevice();
		if (device !== undefined) return;
		let cancelled = false;
		void Promise.all([
			window.omp.models.signedIn(),
			window.omp.models.listProviders().catch(() => null),
			window.omp.prefs.get(FIRST_RUN_STEP_PREF).catch(() => undefined),
		]).then(([signedIn, config, savedStep]) => {
			if (cancelled || signedIn !== false || config === null || checkedThisLaunch.current) return;
			if (isResumableFirstRunStep(savedStep) || useMachineSetupStore.getState().takeover) return;
			if (config.providers.some(entry => entry.auth === "none" && entry.models.length > 0)) return;
			if (useSessionStore.getState().status === "ready") return;
			openEarly();
		});
		return () => {
			cancelled = true;
		};
	}, [openEarly]);

	useEffect(() => {
		if (status !== "ready" || checkedThisLaunch.current) return;
		let cancelled = false;
		window.omp.runtime.startupMark("first-run-check");
		void (async () => {
			// models.yml's endpoints come through the stock helper, which answered 10 to 30 s late on a busy runner
			// (G22): asked now, awaited only when omp's catalog cannot decide alone, so it never holds the provider
			// step of a computer where nothing can serve, nor flashes it where a signed-in provider does.
			const configsRead = window.omp.models.listProviders(focusedTabDevice()).then(
				result => result.providers,
				(): CustomProviderView[] => [],
			);
			const [catalogResult, savedStep] = await Promise.allSettled([
				refreshProviders(false),
				window.omp.prefs.get(FIRST_RUN_STEP_PREF),
			]);
			// A failed catalog read is transient (sidecar/transport): stay
			// unlatched so the next ready transition checks again.
			if (cancelled || catalogResult.status === "rejected") return;
			checkedThisLaunch.current = true;
			const resume = savedStep.status === "fulfilled" ? savedStep.value : undefined;
			// A step an older version saved (GitHub) is gone: forget it instead of resuming at it.
			if (resume !== undefined && !isResumableFirstRunStep(resume))
				void window.omp.prefs.set(FIRST_RUN_STEP_PREF, undefined).catch(() => {});
			const providers = catalogResult.value.providers
				.map(toProviderInfo)
				.filter((row): row is ProviderInfo => row !== null);
			let verdict = servingVerdict(providers);
			if (verdict === "unknown") {
				verdict = servingVerdict(providers, await configsRead);
				if (cancelled) return;
			}
			const early = useFirstRunStore.getState();
			// Opened early and since left (dismissed, or moved on by the user): their choice stands.
			const userMoved = openedEarly.current && !early.provisional;
			if (verdict === "none") {
				if (!userMoved) useFirstRunStore.getState().setPhase("connect", null);
				return;
			}
			if (early.provisional) useFirstRunStore.getState().setPhase("idle", null);
			if (isResumableFirstRunStep(resume)) {
				useFirstRunStore.getState().setPhase(resume, null);
				return;
			}
			const configs = await configsRead;
			if (cancelled) return;
			try {
				const outcome = await ensureServingDefault(tabRpc, useTabsStore.getState().activeTabId, {
					providers,
					configs,
					models: catalogResult.value.models,
					current: chosenModelOf(useModelStore.getState()),
				});
				if (outcome.kind === "switched" && outcome.from) {
					toast({
						variant: "info",
						title: t("setup.defaultSwitched.title"),
						message: t("setup.defaultSwitched.message", {
							model: modelTextAmong(outcome.model, catalogResult.value.models),
							from: modelTextAmong(outcome.from, catalogResult.value.models),
						}),
					});
				}
			} catch {
				// Best effort: the session still runs on whatever omp picked, and the
				// composer's model chip and error recovery stay available.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [refreshProviders, status, t, tabRpc]);

	return null;
}
