/**
 * Settings › Agent behavior › Default browser: which browser agents use (prefs `defaultBrowser`,
 * src/shared/default-browser.ts). The list is what this computer has: ego-browser and each Chromium browser found.
 * Main resolves the pick against it and pushes a change to every open local session, effective from its next turn.
 * Stock's native-host relay cannot verify a Chromium browser's profile, so picking one leaves agents without a
 * browser and the row says so, offering to install the extension where stock registers its native host. The row
 * looks again when the window regains focus: the person installs a browser or ego-browser, then comes back.
 */

import { Globe } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import {
	type AgentBrowserStatus,
	CHROMIUM_BROWSER_NAMES,
	type ChromiumBrowserId,
	chromiumBrowserOf,
	DEFAULT_BROWSER_PREF,
	type DefaultBrowserPref,
	isDefaultBrowserPref,
	parseDefaultBrowser,
} from "../../../shared/default-browser";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { toast, toastError } from "../../stores/toast";
import { Button, Select } from "../common";
import { SettingsRow } from "./SettingsLayout";

/** How long the three setup steps stay up: the person reads them while switching to the browser. */
const STEPS_TOAST_MS = 30_000;

export function DefaultBrowserRow() {
	const t = useT();
	const id = useId();
	const [pref, setPref] = useState<DefaultBrowserPref | null>(null);
	const [status, setStatus] = useState<AgentBrowserStatus | null>(null);
	const [installing, setInstalling] = useState(false);

	const probe = useCallback(() => {
		let live = true;
		window.omp.prefs
			.defaultBrowserStatus()
			.then(next => {
				if (live) setStatus(next);
			})
			// The notes and the browser list just stay as they were.
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	useEffect(() => {
		let live = true;
		window.omp.prefs
			.get(DEFAULT_BROWSER_PREF)
			.then(stored => {
				if (live) setPref(parseDefaultBrowser(stored));
			})
			.catch((error: unknown) => {
				if (!live) return;
				setPref("auto");
				toastError({ title: t("settings.gui.defaultBrowserLoadFailed"), error });
			});
		const stop = probe();
		// The extension is loaded in the browser's own window: look again when the person comes back.
		const onFocus = () => {
			probe();
		};
		window.addEventListener("focus", onFocus);
		return () => {
			live = false;
			stop();
			window.removeEventListener("focus", onFocus);
		};
	}, [t, probe]);

	const picked = pref === null ? undefined : chromiumBrowserOf(pref);
	const pickedBrowser = status?.browsers.find(browser => browser.id === picked);

	const options = [
		{
			value: "auto",
			// What automatic picks on this computer, once known.
			label: status?.auto
				? t("settings.gui.defaultBrowser.autoResolved", {
						browser: t(
							status.auto.kind === "ego"
								? "settings.gui.defaultBrowser.ego"
								: "settings.gui.defaultBrowser.builtin",
						),
					})
				: t("settings.gui.defaultBrowser.auto"),
		},
		{
			value: "ego",
			label:
				status && !status.egoInstalled
					? t("settings.gui.defaultBrowser.notInstalled", { name: t("settings.gui.defaultBrowser.ego") })
					: t("settings.gui.defaultBrowser.ego"),
		},
		...(status?.browsers ?? []).map(browser => ({ value: `chromium:${browser.id}`, label: browser.name })),
		// A stored pick whose browser is gone still reads as itself.
		...(picked && status && !pickedBrowser
			? [
					{
						value: `chromium:${picked}`,
						label: t("settings.gui.defaultBrowser.notInstalled", { name: CHROMIUM_BROWSER_NAMES[picked] }),
					},
				]
			: []),
		{ value: "builtin", label: t("settings.gui.defaultBrowser.builtin") },
	];

	const install = (browser: ChromiumBrowserId) => {
		setInstalling(true);
		window.omp.prefs
			.installBrowserRelay(browser)
			.then(() => {
				toast({
					variant: "info",
					title: t("settings.gui.defaultBrowserStepsTitle", { name: CHROMIUM_BROWSER_NAMES[browser] }),
					message: t("settings.gui.defaultBrowserSteps"),
					durationMs: STEPS_TOAST_MS,
				});
			})
			.catch((error: unknown) => {
				toastError({ title: t("settings.gui.defaultBrowserInstallFailed"), error });
			})
			.finally(() => setInstalling(false));
	};

	let note: ReactNode = null;
	if (status && pref === "ego" && !status.egoInstalled) {
		note = <span data-default-browser-missing="true">{t("settings.gui.defaultBrowserMissing")}</span>;
	} else if (status && picked) {
		note = (
			<span className="inline-flex flex-wrap items-center justify-end gap-2" data-default-browser-unverified="true">
				{t("settings.gui.defaultBrowserRelayUnverified", { name: CHROMIUM_BROWSER_NAMES[picked] })}
				{pickedBrowser && status.nativeHostBrowsers.includes(picked) && (
					<Button loading={installing} onClick={() => install(picked)} size="sm" variant="secondary">
						{t("settings.gui.defaultBrowserInstall")}
					</Button>
				)}
			</span>
		);
	}

	return (
		<SettingsRow
			control={
				<Select
					disabled={pref === null}
					id={id}
					onChange={event => {
						const next = event.target.value;
						if (isDefaultBrowserPref(next))
							void saveGuiPreference(DEFAULT_BROWSER_PREF, next, () => setPref(next));
					}}
					options={options}
					value={pref ?? "auto"}
				/>
			}
			description={t("settings.gui.defaultBrowserDesc")}
			status={note ?? undefined}
			htmlFor={id}
			icon={<Globe />}
			id="setting-gui-defaultBrowser"
			label={t("settings.gui.defaultBrowser")}
		/>
	);
}
