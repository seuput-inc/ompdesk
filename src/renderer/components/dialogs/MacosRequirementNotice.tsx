/**
 * One notice when the updater withholds a newer release because this Mac's macOS is below the one it needs
 * (`UpdateStatus` `not-available` with `unsupportedSystem`, app-updater.md › macOS floor): this version keeps
 * working, and Apple's guide says how to update macOS. Shown once per required macOS (pref
 * `macosRequirementSeen`), never on a paired phone's page (its update status is the host's), and never over
 * machine setup or first-run setup. Orca: components/macos-update-requirement/MacosUpdateRequirementHost.tsx:9,
 * MacosUpdateRequirementDialog.tsx:24. The app ships for Apple silicon only, so Orca's Intel model probe
 * (main/macos-update-requirement/macos-upgrade-support.ts:52) has nothing to decide here.
 */

import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { openExternal } from "../../lib/open-external";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { useUpdaterStore } from "../../stores/updater";
import { webRuntime } from "../../web/runtime";
import { Button, Modal } from "../common";
import { useFirstRunActive } from "../onboarding/FirstRunSlot";

export const MACOS_REQUIREMENT_PREF = "macosRequirementSeen";
export const MACOS_UPDATE_GUIDE_URL = "https://support.apple.com/en-us/108382";

export function MacosRequirementNotice() {
	const t = useT();
	const requirement = useUpdaterStore(state =>
		state.status.state === "not-available" ? state.status.unsupportedSystem : undefined,
	);
	const firstRunActive = useFirstRunActive();
	const takeover = useMachineSetupStore(state => state.takeover);
	// null while unread; the notice waits for the pref so a seen one never flashes.
	const [seen, setSeen] = useState<string | null | undefined>(undefined);
	const macos = requirement?.minimumMacOS;

	useEffect(() => {
		if (!macos || webRuntime() !== null) return;
		let live = true;
		window.omp.prefs
			.get(MACOS_REQUIREMENT_PREF)
			.then(value => {
				if (live) setSeen(typeof value === "string" ? value : null);
			})
			.catch(() => {
				// An unreadable pref shows nothing this launch rather than a notice that may have been seen.
			});
		return () => {
			live = false;
		};
	}, [macos]);

	if (!requirement || !macos || seen === undefined || seen === macos || firstRunActive || takeover) return null;
	if (webRuntime() !== null) return null;

	const close = () => {
		setSeen(macos);
		void window.omp.prefs.set(MACOS_REQUIREMENT_PREF, macos).catch(() => {});
	};

	return (
		<Modal
			description={t("macosRequirement.description", { version: requirement.version, macos })}
			footer={
				<>
					<Button onClick={close} variant="ghost">
						{t("macosRequirement.dismiss")}
					</Button>
					<Button
						data-dialog-autofocus
						trailingIcon={<ArrowUpRight />}
						onClick={() => {
							close();
							openExternal(MACOS_UPDATE_GUIDE_URL);
						}}
						variant="primary"
					>
						{t("macosRequirement.guide")}
					</Button>
				</>
			}
			onClose={close}
			open
			size="sm"
			title={t("macosRequirement.title", { macos })}
		>
			<p className="text-sc-sm text-(--sc-text-muted)" data-macos-requirement={macos}>
				{t("macosRequirement.body", { macos })}
			</p>
		</Modal>
	);
}
