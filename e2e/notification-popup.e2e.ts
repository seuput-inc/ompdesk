/**
 * OMPdesk's own notification popup (docs/design/custom-notifications.md). A test run never shows a real popup:
 * `OMP_GUI_TEST_NOTIFICATION_POPUP=1` makes Node send its notifications and the shell give them to the popup's page
 * in a window that never goes on screen (route `hidden`), so this spec drives that page over CDP. It checks the card
 * names the session and its reply, the window carries the flags that keep it from taking focus, and clicking the card
 * opens that session's tab through Node's ordinary notification click. The route, stack, countdown and placement
 * are the Rust unit tests of `tauri-shell/src/notification_popup`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp, readRecords } from "./harness";

let app: ElectronApplication;
let page: Page;
let profile: string;
let desktop: string;

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-popup-"));
	const project = path.join(profile, "project");
	desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_TEST_NOTIFICATION_POPUP: "1" } });
	page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function tabs() {
	return page.evaluate(() => window.omp.tabs.list());
}

async function activeTab(): Promise<string> {
	const active = (await tabs()).find(tab => tab.active);
	if (!active) throw new Error("No active tab");
	return active.tabId;
}

async function fixtureCommand(tabId: string, line: string): Promise<void> {
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[tabId, line] as const,
	);
	expect(response).toMatchObject({ success: true });
}

async function nameTab(tabId: string, title: string): Promise<void> {
	await fixtureCommand(tabId, `fixture:title:${title}`);
	await expect(page.locator(`[data-session-path="tab:${tabId}"]`)).toContainText(title);
}

/** The popup's page, once the shell has made it. */
async function popupPage(): Promise<Page> {
	let found: Page | undefined;
	await expect
		.poll(async () => {
			for (const candidate of app.windows()) {
				if ((await candidate.title().catch(() => "")) === "OMPdesk notifications") found = candidate;
			}
			return found != null;
		})
		.toBe(true);
	return found as Page;
}

test("a finished background run shows as a popup card, and clicking it opens that tab", async () => {
	// Notifications only fire while the window is unfocused; Playwright emulates page focus, so report the real state.
	await page.evaluate(() => {
		document.hasFocus = () => false;
	});
	const background = await activeTab();
	await nameTab(background, "Release notes run");
	await page.locator("textarea").first().fill("fixture running");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabs()).length).toBe(2);
	await expect.poll(activeTab).not.toBe(background);
	await expect.poll(async () => (await tabs()).find(tab => tab.tabId === background)?.status).toBe("running");

	await fixtureCommand(background, "fixture:finish");
	const popup = await popupPage();
	const card = popup.locator(".card");
	await expect(card).toHaveCount(1);
	await expect(card.locator(".title")).toHaveText("Release notes run");
	await expect(card.locator(".body")).toHaveText("Background run finished");
	await expect(card.getByRole("button", { name: "Close" })).toHaveCount(1);

	const log = path.join(desktop, "tauri-shell.jsonl");
	const records = await readRecords(log);
	expect(records.find(record => record.event === "notification.route")).toMatchObject({ route: "hidden" });
	expect(records.find(record => record.event === "notification.popup.window")).toMatchObject({
		noActivate: true,
		toolWindow: true,
		topmost: true,
	});

	// The window never goes on screen in a test run, so the click is the page's own event, not a pointer.
	await card.dispatchEvent("click");
	await expect.poll(activeTab).toBe(background);
	await expect(card).toHaveCount(0);
});
