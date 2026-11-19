import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { controlToolCaller, exitApp, launchApp, openedSessions } from "./harness";
import { corePids } from "./process-tree";

// 19 Nov 2026, the Mac mini on 0.134.0: after the app's core was lost and started again (09:12), every
// `ompdesk_session_stop {close: true}` of a finished child answered that its window kept the tab, also for a child
// opened after the loss. Main sent the window its close (AGENT_CONTROL_VIEW) and the window never released the tab.
// A close before the loss and one after it must both take the tab out of the window.

let app: ElectronApplication;
let page: Page;
let profile: string;
let errors: string[];

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-agent-close-core-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_HEADLESS: "1", OMP_GUI_TEST_RECORD: path.join(profile, "rpc.jsonl") },
	});
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

const listed = () => page.evaluate(() => window.omp.tabs.list());
const listedIds = async () => (await listed()).map(tab => tab.tabId);

test("a child's close takes its tab out of the window after the app's core was lost and started again", async () => {
	test.setTimeout(240_000);
	const main = (await listed()).find(tab => tab.active)?.tabId ?? "";
	expect(main).not.toBe("");
	const record = path.join(profile, "rpc.jsonl");
	let call = await controlToolCaller(page, record, main);
	const opened = await call("ompdesk_session_open", {
		sessions: [{ message: "First" }, { message: "Second" }, { message: "Third" }],
		show: "background",
	});
	const [before, after, late] = openedSessions(opened.text);
	expect(late).toBeTruthy();
	await expect.poll(async () => (await listedIds()).length).toBe(4);

	const closedBefore = await call("ompdesk_session_stop", { session: before, close: true });
	expect(closedBefore).toMatchObject({ isError: false });
	await expect.poll(listedIds).not.toContain(before);

	const mainPid = await app.evaluate(() => process.pid);
	const [core] = corePids(mainPid);
	if (core === undefined) throw new Error("expected the app's core");
	process.kill(core, "SIGKILL");
	await expect.poll(() => corePids(mainPid).filter(pid => pid !== core).length, { timeout: 60_000 }).toBe(1);
	await expect
		.poll(
			async () =>
				(await listed())
					.filter(tab => tab.status === "ready")
					.map(tab => tab.tabId)
					.sort(),
			{
				timeout: 90_000,
			},
		)
		.toEqual([main, after, late].sort());

	// What the window hears from main from now on: the close it is asked to make.
	await page.evaluate(() => {
		const seen: unknown[] = [];
		Reflect.set(window, "__seenViews", seen);
		window.omp.events.onAgentControlView(event => seen.push(event));
	});
	call = await controlToolCaller(page, record, main);
	const closedAfter = await call("ompdesk_session_stop", { session: after, close: true });
	const diagnosis = {
		views: await page.evaluate(() => Reflect.get(window, "__seenViews")),
		listed: (await listed()).map(tab => `${tab.tabId}:${tab.status}${tab.active ? ":active" : ""}`),
	};
	expect(closedAfter, JSON.stringify(diagnosis)).toMatchObject({ isError: false });
	expect(await listedIds()).not.toContain(after);
});
