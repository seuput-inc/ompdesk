import { ArrowLeft } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import type { NativeWindowState } from "../../../shared/ipc-types";
import { type ChromeViewer, chromeLayout } from "../../lib/chrome-layout";
import { useT } from "../../lib/i18n";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { IconButton } from "../common";
import { DesktopSessionTabs } from "./DesktopSessionTabs";
import { DesktopTitleBar } from "./DesktopTitleBar";

export function DesktopChrome({ viewer }: { viewer: ChromeViewer }) {
	const t = useT();
	const setup = useMachineSetupStore(s => s.takeover);
	const onPage = useUiStore(s => s.destination !== "session");
	const [state, setState] = useState<NativeWindowState>({ maximized: false, fullscreen: false });
	useLayoutEffect(() => {
		const native = window.omp?.windowChrome?.native;
		if (!native) return;
		let initialPending = true;
		const unsubscribe = native.onStateChanged(next => {
			initialPending = false;
			setState(next);
		});
		void native.getState().then(
			next => {
				if (initialPending) setState(next);
			},
			error => {
				if (initialPending) toastError({ title: t("app.actionFailed"), error });
			},
		);
		return () => {
			initialPending = false;
			unsubscribe();
		};
	}, [t]);
	const layout = chromeLayout(viewer, state.fullscreen);
	useLayoutEffect(() => {
		const root = document.documentElement;
		root.dataset.desktopChrome = layout.captionWidth ? "caption" : "no-caption";
		document.body.style.setProperty("--sc-caption-buttons", `${layout.captionWidth}px`);
		return () => {
			delete root.dataset.desktopChrome;
			document.body.style.removeProperty("--sc-caption-buttons");
		};
	}, [layout.captionWidth]);
	return (
		<DesktopTitleBar layout={layout} maximized={state.maximized} disabledContent={setup}>
			{onPage && (
				<IconButton
					className="no-drag"
					icon={<ArrowLeft />}
					label={t("shell.backToSession")}
					onClick={() => useUiStore.getState().closeDestination()}
					size="sm"
				/>
			)}
			<DesktopSessionTabs />
		</DesktopTitleBar>
	);
}
