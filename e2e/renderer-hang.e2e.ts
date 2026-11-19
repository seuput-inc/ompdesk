import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp } from "./harness";

// 19 Nov 2026, the Mac mini: the window's page sat in a WebKit log-stream wait from 09:12 for hours; it showed the same
// frame, closed no tab an agent asked it to and nothing noticed. The shell probes each app page (page_watch.rs), main
// gives a page that stopped answering RENDERER_HANG_RESTART_MS (window.ts) and then ends its process; the page loads
// again with its tabs and the draft the person had typed. Here the page's main thread is held by a busy loop.

let app: ElectronApplication;
let page: Page;
let profile: string;
let desktop: string;

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-renderer-hang-"));
	const project = path.join(profile, "project");
	desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_HEADLESS: "1", OMP_GUI_E2E_SHELL_LOG: "1" },
	});
	page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function runtimeLog(): Promise<{ source: string; message: string }[]> {
	const text = await fs.readFile(path.join(desktop, "logs", "gui-runtime.jsonl"), "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { source: string; message: string });
}

test("a window whose page stops answering is started again with its tabs and draft", async () => {
	test.setTimeout(180_000);
	const tabsBefore = (await page.evaluate(() => window.omp.tabs.list())).map(tab => tab.tabId);
	const input = page.locator(".omp-composer-input").first();
	await input.fill("half-written thought");
	// The draft is filed under its session before the page is held (draft-persistence.ts saves it after a pause).
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("omp.composerDrafts") ?? ""))
		.toContain("half-written thought");
	// TEMP diagnosis: who ends main after the restart (runs 44570371258, 44574031048 saw the app exit right after it).
	await app.evaluate(({ app: electronApp, BrowserWindow }) => {
		const say = (what: string) => console.error(`[hang-diag] ${what}\n${new Error().stack}`);
		process.on("exit", code => say(`process exit ${code}`));
		const quit = electronApp.quit.bind(electronApp);
		const exit = electronApp.exit.bind(electronApp);
		electronApp.quit = () => {
			say("app.quit");
			quit();
		};
		electronApp.exit = (code?: number) => {
			say(`app.exit ${code}`);
			exit(code);
		};
		electronApp.on("window-all-closed", () => say("window-all-closed"));
		for (const win of BrowserWindow.getAllWindows()) win.on("closed", () => say(`window ${win.id} closed`));
	});

	// Hold the page's main thread for longer than detection and the grace together; never awaited (it cannot answer).
	void page
		.evaluate(() => {
			const until = Date.now() + 10 * 60_000;
			while (Date.now() < until) {
				// busy
			}
		})
		.catch(() => undefined);

	await expect
		.poll(async () => (await runtimeLog()).map(line => line.message), { timeout: 90_000, intervals: [1_000] })
		.toEqual(expect.arrayContaining(["Renderer stopped responding", "Restarting the stuck page"]));
	await expect
		.poll(async () => (await runtimeLog()).some(line => line.source === "renderer-process"), { timeout: 30_000 })
		.toBe(true);

	// The page loads again in the same window: the same tabs, and what the person had typed. Playwright closes the page
	// whose renderer ended (`Target crashed`); the reloaded document is the window's app page again.
	await expect.poll(() => page.isClosed(), { timeout: 30_000 }).toBe(true);
	const back = await app.firstWindow({ timeout: 60_000 });
	await back.waitForFunction(() => window.omp?.rpc != null, undefined, { timeout: 60_000 });
	await expect
		.poll(async () => (await back.evaluate(() => window.omp.tabs.list())).map(tab => tab.tabId), { timeout: 30_000 })
		.toEqual(tabsBefore);
	await expect(back.locator(".omp-composer-input").first()).toHaveValue("half-written thought", { timeout: 30_000 });
	await expect(back.getByText("Something went wrong")).toHaveCount(0);
});
