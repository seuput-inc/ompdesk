/**
 * A window whose page has not painted yet is on screen anyway. An app window used to stay hidden until its page's
 * first paint, and a fresh WebView2 runtime took 50 s to start its browser process (nightly 45646449982): no window at
 * all for that long, so a person clicked the app again. The Tauri host now shows the window 500 ms after making it,
 * painted in the page's background (`app_window.rs` `SHOW_BEFORE_PAINT`, `theme.rs` `window_background`), and logs how
 * late the paint came. `OMP_GUI_TEST_SHELL_HOLD_PAGE_MS` (test builds of the host) answers the first app document that
 * late, as the cold start holds the paint. Unit cases: app_window.rs's tests.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp, readRecords } from "./harness";

const HOLD_MS = 8_000;

test("a window whose page paints late shows before it, and the late paint is measured", async () => {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-before-paint-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(profile, name));
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_TEST_SHELL_HOLD_PAGE_MS: String(HOLD_MS) },
	});
	try {
		const page = await app.firstWindow({ timeout: 45_000 });
		await expect(page.locator("#root")).not.toBeEmpty({ timeout: 30_000 });
		const log = path.join(desktop, "tauri-shell.jsonl");
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
