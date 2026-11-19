/**
 * Settings › Tools & extensions: the control tools' project boundary (`agentProjectBoundary`, control-tools.md ›
 * Project boundary): Off, Log only or Enforce. It is written through its own channel, which only a desktop window's
 * page may call (no agent path and no paired page reaches it), so a paired page shows the value and cannot change it.
 */

import { Fence } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	AGENT_PROJECT_BOUNDARY_PREF,
	isProjectBoundaryMode,
	PROJECT_BOUNDARY_MODES,
	type ProjectBoundaryMode,
	projectBoundaryOf,
} from "../../../shared/agent-control";
import { useT } from "../../lib/i18n";
import { toastError } from "../../stores/toast";
import { webRuntime } from "../../web/runtime";
import { Select } from "../common";
import { SettingsRow } from "./SettingsLayout";

const LABEL_KEYS: Record<ProjectBoundaryMode, string> = {
	off: "settings.gui.projectBoundary.off",
	log: "settings.gui.projectBoundary.log",
	enforce: "settings.gui.projectBoundary.enforce",
};

export function ProjectBoundaryRow() {
	const t = useT();
	const id = useId();
	const [mode, setMode] = useState<ProjectBoundaryMode | null>(null);
	const page = webRuntime() !== null;

	useEffect(() => {
		let live = true;
		// A failed read shows the default: the select stays usable and the next choice is what main stores.
		const show = (stored: unknown) => {
			if (live) setMode(projectBoundaryOf(stored).mode);
		};
		void window.omp.prefs.get(AGENT_PROJECT_BOUNDARY_PREF).then(show, () => show(undefined));
		return () => {
			live = false;
		};
	}, []);

	return (
		<SettingsRow
			control={
				<Select
					disabled={mode === null || page}
					id={id}
					onChange={event => {
						const next = event.target.value;
						if (!isProjectBoundaryMode(next)) return;
						void window.omp.prefs.setProjectBoundary(next).then(
							() => setMode(next),
							(error: unknown) => toastError({ title: t("settings.gui.projectBoundaryFailed"), error }),
						);
					}}
					options={PROJECT_BOUNDARY_MODES.map(value => ({ value, label: t(LABEL_KEYS[value]) }))}
					value={mode ?? projectBoundaryOf(undefined).mode}
				/>
			}
			description={t("settings.gui.projectBoundaryDesc")}
			footer={
				page ? (
					<p className="mt-1 text-sc-xs text-(--sc-text-muted)">{t("settings.gui.projectBoundaryDesktopOnly")}</p>
				) : undefined
			}
			htmlFor={id}
			icon={<Fence />}
			id="setting-gui-projectBoundary"
			label={t("settings.gui.projectBoundary")}
		/>
	);
}
