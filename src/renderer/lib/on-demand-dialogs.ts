import type { OnDemandDialogs } from "../components/dialogs/OnDemandDialogs";

export const ON_DEMAND_DIALOGS_META = "omp-on-demand-dialogs";

type DialogModule = { OnDemandDialogs: typeof OnDemandDialogs };
let attempts = 0;

/** Retry this build's entry URL, not the browser's cached failed module fetch. */
export function loadOnDemandDialogs(): Promise<DialogModule> {
	if (attempts++ === 0) return import("../components/dialogs/OnDemandDialogs");
	const href = document.querySelector<HTMLMetaElement>(`meta[name="${ON_DEMAND_DIALOGS_META}"]`)?.content;
	if (!href) throw new Error("The build did not name its on-demand dialogs chunk");
	const url = new URL(href, window.location.href);
	if (
		url.protocol !== window.location.protocol ||
		url.host !== window.location.host ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!/^\/assets\/OnDemandDialogs-[\w-]+\.js$/.test(url.pathname)
	)
		throw new Error("The build named an invalid on-demand dialogs chunk");
	url.searchParams.set("retry", String(attempts));
	return import(/* @vite-ignore */ url.href);
}
