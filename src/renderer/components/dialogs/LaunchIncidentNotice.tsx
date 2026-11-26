/**
 * After a freeze or a crash loop (main-thread hang marker, or safe mode after launches that kept failing), the first
 * window offers to report it: one toast with "Report…", which opens the feedback dialog with the record as its
 * captured error. Main leaves the incident in prefs (`LAUNCH_INCIDENT_PREF`) at launch; the window that reads it
 * clears it, so it is offered once. Never on a paired phone's page (the incident is the host's), and not while
 * machine setup or first-run setup holds the window. Renders nothing.
 * Orca: renderer/src/components/crash-report/CrashReportDialog.tsx:63 (one startup prompt, then dismissed).
 */

import { useEffect, useRef } from "react";
import { LAUNCH_INCIDENT_PREF, parseLaunchIncident } from "../../../shared/launch-incident";
import { useT } from "../../lib/i18n";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { webRuntime } from "../../web/runtime";
import { useFirstRunActive } from "../onboarding/FirstRunSlot";

/** Long enough to read and reach for the button after a launch. */
const NOTICE_MS = 30_000;

export function LaunchIncidentNotice() {
	const t = useT();
	const firstRunActive = useFirstRunActive();
	const takeover = useMachineSetupStore(state => state.takeover);
	const decided = useRef(false);

	useEffect(() => {
		if (firstRunActive || takeover || decided.current || webRuntime() !== null) return;
		decided.current = true;
		void (async () => {
			const incident = parseLaunchIncident(await window.omp.prefs.get(LAUNCH_INCIDENT_PREF));
			if (!incident) return;
			await window.omp.prefs.set(LAUNCH_INCIDENT_PREF, null);
			const title = t(incident.kind === "hang" ? "launchIncident.hangTitle" : "launchIncident.unstableTitle");
			toast({
				variant: "info",
				message: t(incident.kind === "hang" ? "launchIncident.hang" : "launchIncident.unstable"),
				durationMs: NOTICE_MS,
				action: {
					label: t("launchIncident.report"),
					run: () => useUiStore.getState().openFeedback({ title, error: incident.detail }),
				},
			});
		})().catch(() => {
			// A failed read offers nothing; the record stays in gui-runtime.jsonl and the diagnostics.
		});
	}, [firstRunActive, takeover, t]);

	return null;
}
