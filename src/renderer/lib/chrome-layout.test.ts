import { describe, expect, it } from "vitest";
import { chromeLayout, chromeViewer } from "./chrome-layout";

describe("the viewing window's title bar", () => {
	it("reserves room for Windows controls only outside native fullscreen", () => {
		const viewer = chromeViewer("win32", null);
		expect(chromeLayout(viewer, false)).toEqual({
			bar: "desktop",
			identity: "app-menu",
			leftInset: 0,
			captionWidth: 138,
		});
		expect(chromeLayout(viewer, true).captionWidth).toBe(0);
	});

	it("keeps the Mac lights clear without adding a second set of buttons", () => {
		const viewer = chromeViewer("darwin", null);
		expect(chromeLayout(viewer, false)).toEqual({
			bar: "desktop",
			identity: "app-name",
			leftInset: 80,
			captionWidth: 0,
		});
		expect(chromeLayout(viewer, true).leftInset).toBe(0);
	});

	it("keeps native controls off a browser or phone even on a Windows or Mac host", () => {
		for (const platform of ["darwin", "win32", "web"] as const) {
			for (const mode of ["phone", "tablet-portrait", "tablet-landscape"] as const) {
				expect(chromeLayout(chromeViewer(platform, mode), false)).toEqual({
					bar: mode === "phone" ? "phone" : "browser",
					identity: "none",
					leftInset: 0,
					captionWidth: 0,
				});
			}
		}
		expect(chromeLayout(chromeViewer("web", null), true).bar).toBe("browser");
	});
});
