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

/** The popup's page, once the shell has written it; a failure names every page the connection sees. */
async function popupPage(): Promise<Page> {
	let found: Page | undefined;
	await expect
		.poll(async () => {
			const seen: string[] = [];
			for (const candidate of app.windows()) {
				const title = await candidate.title().catch((error: unknown) => `(no title: ${String(error)})`);
				if (title === "OMPdesk notifications") found = candidate;
				seen.push(`${candidate.url()} ${title}`);
			}
			return found ? "found" : seen;
		})
		.toBe("found");
	return found as Page;
}

/** Tab `title` runs a turn in the background behind a new front tab; returns the background tab and the front one. */
async function backgroundRun(title: string): Promise<{ background: string; front: string }> {
	// Notifications only fire while the window is unfocused; Playwright emulates page focus, so report the real state.
	await page.evaluate(() => {
		document.hasFocus = () => false;
	});
	const background = await activeTab();
	await nameTab(background, title);
	await page.locator("textarea").first().fill("fixture running");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabs()).length).toBe(2);
	await expect.poll(activeTab).not.toBe(background);
	await expect.poll(async () => (await tabs()).find(tab => tab.tabId === background)?.status).toBe("running");
	return { background, front: await activeTab() };
}

async function routes(): Promise<unknown[]> {
	return (await readRecords(path.join(desktop, "tauri-shell.jsonl")))
		.filter(record => record.event === "notification.route")
		.map(record => record.route);
}

test("a finished background run shows as a popup card, and clicking it opens that tab", async () => {
	const { background } = await backgroundRun("Release notes run");
	await fixtureCommand(background, "fixture:finish");
	const popup = await popupPage();
	const card = popup.locator(".card");
	await expect(card).toHaveCount(1);
	await expect(card.locator(".title")).toHaveText("Release notes run");
	await expect(card.locator(".body")).toHaveText("Background run finished");
	await expect(card.getByRole("button", { name: "Close" })).toHaveCount(1);

	expect(await routes()).toEqual(["hidden"]);
	const records = await readRecords(path.join(desktop, "tauri-shell.jsonl"));
	expect(records.find(record => record.event === "notification.popup.window")).toMatchObject({
		noActivate: true,
		toolWindow: true,
		topmost: true,
	});

	// The gear folds the controls away: its menu opens inside the popup and closes again.
	const gear = card.getByRole("button", { name: "Notification options" });
	await gear.dispatchEvent("click");
	const menu = popup.getByRole("menu");
	await expect(menu.getByRole("menuitem")).toHaveText([
		"Mute for 1 hour",
		"Mute until tomorrow",
		"Notification settings…",
	]);
	await expect(gear).toHaveAttribute("aria-expanded", "true");
	await gear.dispatchEvent("click");
	await expect(menu).toHaveCount(0);

	// The window never goes on screen in a test run, so the click is the page's own event, not a pointer.
	await card.dispatchEvent("click");
	await expect.poll(activeTab).toBe(background);
	await expect(card).toHaveCount(0);
});

test("muting from the gear closes the card and holds the next notification", async () => {
	const { background, front } = await backgroundRun("First run");
	await nameTab(front, "Second run");
	await page.locator("textarea").first().fill("fixture running");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await expect.poll(async () => (await tabs()).find(tab => tab.tabId === front)?.status).toBe("running");

	await fixtureCommand(background, "fixture:finish");
	const popup = await popupPage();
	const card = popup.locator(".card");
	await expect(card).toHaveCount(1);
	await card.getByRole("button", { name: "Notification options" }).dispatchEvent("click");
	await popup.getByRole("menuitem", { name: "Mute for 1 hour" }).dispatchEvent("click");
	await expect(card).toHaveCount(0);
	const muted = (await readRecords(path.join(desktop, "tauri-shell.jsonl"))).find(
		record => record.event === "notification.muted",
	);
	expect(Number(muted?.until) - Date.now()).toBeGreaterThan(59 * 60_000);

	// The mute holds at admission: main answers `dropped`, so no card, no banner and no chime from the page.
	await fixtureCommand(front, "fixture:finish");
	await expect
		.poll(async () =>
			(await readRecords(path.join(desktop, "logs", "gui-runtime.jsonl")).catch(() => []))
				.filter(record => record.source === "notify" && record.message === "skipped")
				.map(record => record.details),
		)
		.toContainEqual(expect.objectContaining({ tabId: front, reason: "dropped" }));
	expect(await routes()).toEqual(["hidden"]);
	await expect(card).toHaveCount(0);
});
