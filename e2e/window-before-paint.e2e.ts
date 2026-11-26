/**
 * A window whose page has not painted yet is on screen anyway, drawn as the app. An app window used to stay hidden
 * until its page's first paint, and a fresh WebView2 runtime took 50 s to start its browser process (nightly
 * 45646449982): no window at all for that long, so a person clicked the app again. That wait happens inside the
 * Tauri host's `build` of the window, so on Windows the host shows the window as soon as wry's WebView container exists
 * and draws the boot shell into it natively (`boot_paint.rs`); the WebView stays transparent over it until the page's
 * own first frame. Elsewhere the window shows 500 ms after making it, painted in the page's background
 * (`app_window.rs` `SHOW_BEFORE_PAINT`). Either way how late the paint came is logged.
 * `OMP_GUI_TEST_SHELL_HOLD_PAGE_MS` (test builds of the host) answers the first app document that late, as the cold
 * start holds the paint. Unit cases: app_window.rs's and boot_paint.rs's tests.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import windowBackground from "../src/shared/window-background.json" with { type: "json" };
import { exitApp, launchApp, readRecords } from "./harness";
import { screenshotBitmap } from "./screenshot-bitmap";

const HOLD_MS = 8_000;
const SIDEBAR_WIDTH = 320;

/** The window's client area as it is composed (`PrintWindow` with `PW_CLIENTONLY | PW_RENDERFULLCONTENT`), whatever covers it on screen. */
function captureWindow(hwnd: number, file: string): void {
	const helper = [
		"using System; using System.Runtime.InteropServices;",
		"public static class Capture {",
		'[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);',
		'[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);',
		"[StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }",
		"}",
	].join(" ");
	execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			[
				"Add-Type -AssemblyName System.Drawing;",
				`Add-Type -TypeDefinition '${helper}';`,
				`$h = [IntPtr]${hwnd}; $r = New-Object Capture+Rect; [void][Capture]::GetClientRect($h, [ref]$r);`,
				"$bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top);",
				"$g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc();",
				"[void][Capture]::PrintWindow($h, $dc, 3); $g.ReleaseHdc($dc);",
				`$bmp.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)`,
			].join(" "),
		],
		{ stdio: "ignore" },
	);
}

test("a window whose page paints late shows before it, and the late paint is measured", async () => {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-before-paint-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(profile, name));
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, sidebarWidth: SIDEBAR_WIDTH, sidebarVisible: true }),
	);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_TEST_SHELL_HOLD_PAGE_MS: String(HOLD_MS) },
	});
	const log = path.join(desktop, "tauri-shell.jsonl");
	try {
		if (process.platform === "win32") {
			// The window is on screen with the boot shell while its document is held.
			const bootRecord = async () => (await readRecords(log)).find(record => record.event === "window.boot_shell");
			await expect.poll(bootRecord, { timeout: 30_000 }).toBeTruthy();
			const boot = await bootRecord();
			expect(boot?.sidebar).toBe(SIDEBAR_WIDTH);
			expect(boot?.shown, "shown while the window was built").toBeTruthy();
			const file = test.info().outputPath("boot-shell.png");
			captureWindow(Number(boot?.hwnd), file);
			const records = await readRecords(log);
			expect(
				records.some(record => record.event === "window.first_paint"),
				"captured before the page painted",
			).toBe(false);
			const { width, height } = await sharp(file).metadata();
			const pixels = await screenshotBitmap(file);
			const scale =
				(width ?? 0) /
				(await app.evaluate(
					({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentBounds().width ?? 1,
				));
			const at = (x: number, y: number) => {
				const i = (Math.round(y * scale) * (width ?? 0) + Math.round(x * scale)) * 4;
				const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(2, "0");
				return `#${hex(pixels[i + 2])}${hex(pixels[i + 1])}${hex(pixels[i])}`;
			};
			const scheme = boot?.dark ? "dark" : "light";
			const colours = { bg: windowBackground[scheme], ...windowBackground.bootShell[scheme] };
			const middle = (height ?? 0) / scale / 2;
			// Under the Mica backdrop the band is its surface colour over the backdrop, as the page draws it.
			if (boot?.mica) expect(at(SIDEBAR_WIDTH / 2, middle), "the tinted band").not.toBe(colours.bg.toLowerCase());
			else expect(at(SIDEBAR_WIDTH / 2, middle), "the sidebar band").toBe(colours.surface.toLowerCase());
			expect(at(SIDEBAR_WIDTH - 1, middle), "its border").toBe(colours.border.toLowerCase());
			expect(at(SIDEBAR_WIDTH + 24, 12), "the main pane").toBe(colours.bg.toLowerCase());
		}
		const page = await app.firstWindow({ timeout: 45_000 });
		await expect(page.locator("#root")).not.toBeEmpty({ timeout: 30_000 });
		const records = await readRecords(log);
		const shown = records.findIndex(record => record.event === "window.shown_before_paint");
		const painted = records.findIndex(record => record.event === "window.first_paint");
		expect(shown, "the window showed before its page painted").toBeGreaterThanOrEqual(0);
		expect(painted, "the paint after it was measured").toBeGreaterThan(shown);
		expect(records[painted]?.ms).toBeGreaterThanOrEqual(HOLD_MS);
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true);
	} finally {
		await exitApp(app);
	}
});
