import type { ShellMode } from "../hooks/shell-queries";
import type { ChromePlatform } from "./window-chrome";

export type ChromeViewer = "windows" | "mac" | "browser" | "phone";

/** The viewing window owns its chrome, not the computer that owns the session. */
export function chromeViewer(platform: ChromePlatform, mode: ShellMode | null): ChromeViewer {
	if (mode === "phone") return "phone";
	if (mode !== null || platform === "web") return "browser";
	return platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "browser";
}

const BROWSER = { bar: "browser", identity: "none", leftInset: 0, captionWidth: 0 } as const;
const PHONE = { ...BROWSER, bar: "phone" } as const;
const WINDOWS = { bar: "desktop", identity: "app-menu", leftInset: 0, captionWidth: 138 } as const;
const MAC = { bar: "desktop", identity: "app-name", leftInset: 80, captionWidth: 0 } as const;
const WINDOWS_FULLSCREEN = { ...WINDOWS, captionWidth: 0 } as const;
const MAC_FULLSCREEN = { ...MAC, leftInset: 0 } as const;

export type ChromeLayout =
	| typeof WINDOWS
	| typeof WINDOWS_FULLSCREEN
	| typeof MAC
	| typeof MAC_FULLSCREEN
	| typeof BROWSER
	| typeof PHONE;

export function chromeLayout(viewer: ChromeViewer, nativeFullscreen: boolean): ChromeLayout {
	switch (viewer) {
		case "windows":
			return nativeFullscreen ? WINDOWS_FULLSCREEN : WINDOWS;
		case "mac":
			return nativeFullscreen ? MAC_FULLSCREEN : MAC;
		case "browser":
			return BROWSER;
		case "phone":
			return PHONE;
	}
}
