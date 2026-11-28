/** DesktopTitleBar.test.tsx covers the rendering branches. Here a keyboard activation must change the Tauri window. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import { exitApp, launchApp, readRecords } from "./harness";

const looks = [
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const;

for (const [language, theme] of looks) {
	const smoke = language === "en" && theme === "light" ? "@smoke " : "";
	test(`${smoke}Windows caption buttons operate the window by keyboard (${language}-${theme})`, async () => {
		test.skip(process.platform !== "win32", "Windows caption buttons");
		test.setTimeout(120_000);
		const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-chrome-actions-")));
		const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(profile, name));
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({
				language,
				themeName: theme,
				firstRunComplete: true,
				sidebarVisible: true,
				panelVisible: false,
			}),
		);
		await fs.writeFile(
			path.join(desktop, "window-state.json"),
			JSON.stringify({ windowState: { width: 1000, height: 640 } }),
		);
		const app = await launchApp({ project, desktop, agent, profile });
		try {
			const page = await app.firstWindow();
			const { id, wcId } = await app.evaluate(({ BrowserWindow }) => {
				const [win] = BrowserWindow.getAllWindows();
				return { id: win.id, wcId: win.webContents.id };
			});
			const records = await readRecords(path.join(desktop, "tauri-shell.jsonl"));
			const hwnd = Number(records.find(r => r.event === "window.boot_shell" && r.wcId === wcId)?.hwnd);
			expect(Number.isSafeInteger(hwnd) && hwnd > 0).toBe(true);
			const pid = app.process().pid;
			const placement = () =>
				execFileSync(
					"bun",
					[path.join(import.meta.dirname, "fixture/win-chrome-hit.ts"), JSON.stringify({ hwnd, pid })],
					{
						encoding: "utf8",
						timeout: 5_000,
						windowsHide: true,
					},
				).trim();
			const bar = page.locator("[data-desktop-titlebar]");
			const words = language === "ko" ? ko : en;
			const button = (name: string) => bar.getByRole("button", { name, exact: true });
			const minimize = button(words["titlebar.minimize"]);
			const maximize = button(words["titlebar.maximize"]);
			const restore = button(words["titlebar.restore"]);
			const close = button(words["titlebar.close"]);
			const sidebar = button(words["titlebar.toggleSidebar"]);
			const shell = page.locator(".omp-shell[data-sidebar]");
			const capture = async (state: string) => {
				await test.info().attach(`${language}-${theme}-${state}.png`, {
					body: await page.screenshot({ animations: "disabled", scale: "css" }),
					contentType: "image/png",
				});
			};
			const nativeState = () => page.evaluate(() => window.omp.windowChrome.native?.getState());
			await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
			await expect(shell).toHaveAttribute("data-sidebar", "docked");
			await expect(sidebar).toHaveAttribute("aria-pressed", "true");
			await expect.poll(placement).toBe("normal");
			await capture("normal");
			await sidebar.press("Enter");
			await expect(sidebar).toHaveAttribute("aria-pressed", "false");
			await expect(shell).toHaveAttribute("data-sidebar", "hidden");
			await expect(page.locator(".omp-session-sidebar")).toBeHidden();
			await capture("sidebar-collapsed");

			// Tab into and through the caption cluster. locator.press targets this WebView, never the OS keyboard.
			await button(words["titlebar.sidePanel"]).press("Tab");
			await expect(minimize).toBeFocused();
			await page.keyboard.press("Tab");
			await expect(maximize).toBeFocused();
			await page.keyboard.press("Enter");
			await expect.poll(placement).toBe("maximized");
			await expect(restore).toBeFocused();
			await capture("maximized");
			await page.keyboard.press("Space");
			await expect.poll(placement).toBe("normal");
			await expect(maximize).toBeFocused();
			await page.keyboard.press("Shift+Tab");
			await expect(minimize).toBeFocused();
			await page.keyboard.press("Space");
			await expect.poll(placement).toBe("minimized");
			await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.restore(), id);
			await expect.poll(placement).toBe("normal");

			await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.setFullScreen(true), id);
			await expect.poll(nativeState).toMatchObject({ fullscreen: true });
			await expect(bar).toBeVisible();
			await expect(page.locator("[data-caption]")).toHaveCount(0);
			await expect(sidebar).toHaveAttribute("aria-pressed", "false");
			await capture("fullscreen");
			await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.setFullScreen(false), id);
			await expect.poll(nativeState).toEqual({ maximized: false, fullscreen: false });
			await expect(close).toBeVisible();

			// With one other shown window, Close destroys only its target instead of applying the last-window policy.
			expect(await page.evaluate(() => window.omp.sessions.openInNewWindow({}))).toBe(true);
			await expect.poll(() => app.windows().length).toBe(2);
			const other = app.windows().find(win => win !== page);
			if (!other) throw new Error("No second window");
			await expect(other.locator("[data-desktop-titlebar]")).toBeVisible();
			await maximize.press("Tab");
			await expect(close).toBeFocused();
			await page.keyboard.press("Space");
			await expect.poll(() => page.isClosed()).toBe(true);
			await expect
				.poll(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id) === null, id))
				.toBe(true);
			await expect(other.locator("[data-desktop-titlebar]")).toBeVisible();
		} finally {
			await exitApp(app);
		}
	});
}
