/**
 * Settings › Updates & about › Advanced › "Remove OMPdesk from this computer" (Orca FS119: settings/advanced/
 * uninstall/OrcaUninstallSection.tsx, use-orca-uninstall.ts:76). One confirmation names what goes (the `ompdesk`
 * command; memory's wiring in the terminal omp, when on; then the app, shown in Finder or by its Windows uninstaller)
 * and what stays (sessions, memory pages, omp, settings). Main does the rest behind the running-work guard
 * (`removeFromComputer`, index.ts) and quits. Orca also removes agent hooks, SSH host hooks and its terminal daemon;
 * OMPdesk writes none of those. ai-memory's own per-user service stays: it is ai-memory's, not OMPdesk's (memory.md).
 * This computer's window only: never a paired phone's page or a paired host's settings.
 */

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { toastError } from "../../stores/toast";
import { Button, ConfirmDialog } from "../common";
import { SettingsRow } from "./SettingsLayout";

export function RemoveFromComputerRow() {
	const t = useT();
	const [asking, setAsking] = useState(false);
	const [terminalWired, setTerminalWired] = useState(false);
	const [busy, setBusy] = useState(false);

	const ask = () => {
		setAsking(true);
		window.omp.aiMemory
			.getState()
			.then(state => setTerminalWired(state.wiring.terminal))
			.catch(() => setTerminalWired(false));
	};

	const remove = async () => {
		setBusy(true);
		try {
			// Null: the running-work guard kept the app; nothing was removed. Otherwise the app is quitting.
			if ((await window.omp.app.removeFromComputer()) === null) setAsking(false);
		} catch (error) {
			toastError({ title: t("settings.remove.failed"), error });
			setAsking(false);
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<SettingsRow
				control={
					<Button data-remove-from-computer onClick={ask} size="sm" variant="danger-soft">
						{t("settings.remove.action")}
					</Button>
				}
				description={t("settings.remove.desc")}
				icon={<Trash2 />}
				id="setting-remove-from-computer"
				label={t("settings.remove.label")}
			/>
			<ConfirmDialog
				busy={busy}
				confirmLabel={t("settings.remove.confirm")}
				message={
					<div className="space-y-2">
						<p>{t("settings.remove.goes")}</p>
						<ul className="list-disc space-y-1 pl-5">
							<li>{t("settings.remove.goesCli")}</li>
							{terminalWired && <li>{t("settings.remove.goesTerminal")}</li>}
							<li>{t("settings.remove.goesApp")}</li>
						</ul>
						<p>{t("settings.remove.stays")}</p>
					</div>
				}
				onCancel={() => setAsking(false)}
				onConfirm={() => void remove()}
				open={asking}
				title={t("settings.remove.title")}
				warning={t("settings.remove.quits")}
			/>
		</>
	);
}
