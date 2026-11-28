/** Platform of the viewing window and the paired page's browser chrome. */

export type ChromePlatform = "darwin" | "win32" | "other" | "web";

/**
 * `web`: a browser page (the mobile web client), whose boot marks `html[data-platform="web"]` before React mounts.
 * A mark of `darwin` or `win32` already on the root stands too: the dev harness paints the page as that OS's window
 * (`?platform=win32` on a Mac), and reading `navigator.platform` over it turned every Windows look into a Mac one.
 */
export function chromePlatform(): ChromePlatform {
	const marked = typeof document === "undefined" ? undefined : document.documentElement.dataset.platform;
	if (marked === "web" || marked === "darwin" || marked === "win32") return marked;
	const platform = typeof navigator === "undefined" ? "" : navigator.platform.toLowerCase();
	if (platform.startsWith("mac")) return "darwin";
	if (platform.startsWith("win")) return "win32";
	return "other";
}

/**
 * Mark the root once so stylesheets can reserve room for the window controls.
 * `data-mica`: main gave this Windows 11 window the Mica backdrop (`?mica=1`),
 * so the canvas behind the sidebar turns transparent and lets it through.
 */
export function markChromePlatform(root: HTMLElement = document.documentElement): ChromePlatform {
	const platform = chromePlatform();
	root.dataset.platform = platform;
	if (platform === "win32" && new URLSearchParams(window.location.search).get("mica") === "1") {
		root.dataset.mica = "true";
	}
	return platform;
}

/**
 * The web page's theme-color metas follow the surface behind its browser chrome.
 */
export function syncWindowControls(surfaceToken: "--sc-bg" | "--sc-surface-1"): () => void {
	const setThemeColor = window.omp?.windowChrome?.setThemeColor;
	if (!setThemeColor) return () => {};
	let last = "";
	const push = () => {
		const style = getComputedStyle(document.documentElement);
		const color = style.getPropertyValue(surfaceToken).trim();
		if (!color || color === last) return;
		last = color;
		setThemeColor(color);
	};
	push();
	// Theme switches rewrite inline custom properties / classes on <html>.
	const observer = new MutationObserver(push);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
	const media = window.matchMedia?.("(prefers-color-scheme: dark)");
	media?.addEventListener("change", push);
	return () => {
		observer.disconnect();
		media?.removeEventListener("change", push);
	};
}
