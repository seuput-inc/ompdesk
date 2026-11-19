/**
 * A first launch whose profile-migration page (`/__profile/migrate`, served by the Tauri host while
 * `tauri-local-storage-import.json` is missing) never gets its request answered still opens the app. Windows e2e saw
 * that request sent and never answered, the window left on it for good (nightly 44612826698 shard 3, rc 44581968887).
 * The host now logs each step of the page to tauri-shell.jsonl, loads it again when a step sees no next one in 10 s,
 * and after three tries shows the reason with a Retry (`migrate_watch.rs`). `OMP_GUI_TEST_SHELL_STALL_MIGRATE=<n>`
 * (test builds of the host) leaves the first n requests unanswered. Unit cases: migrate_watch.rs's tests.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { exitApp, launchApp, readRecords } from "./harness";

async function launchStalled(stalls: number): Promise<{ app: ElectronApplication; log: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-migrate-stall-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(profile, name));
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_TEST_SHELL_STALL_MIGRATE: String(stalls) },
	});
	return { app, log: path.join(desktop, "tauri-shell.jsonl") };
}

async function events(log: string, name: string): Promise<Record<string, unknown>[]> {
	return (await readRecords(log)).filter(record => record.event === name);
}

test("a migration page whose request is never answered is loaded again and the app opens", async () => {
	const { app, log } = await launchStalled(1);
	try {
		const page = await app.firstWindow({ timeout: 45_000 });
		await expect(page.locator("#root")).not.toBeEmpty({ timeout: 30_000 });
		const stalled = await events(log, "profile.migrate.stalled");
		expect(stalled).toEqual([expect.objectContaining({ step: "navigate", retry: 2 })]);
		const steps = (await events(log, "profile.migrate")).map(record => `${record.step}@${record.attempt}`);
		expect(steps).toEqual(expect.arrayContaining(["navigate@1", "navigate@2", "served@2", "read@2", "app@2"]));
		expect(steps).not.toContain("served@1");
	} finally {
		await exitApp(app);
	}
});

test("after three unanswered tries the window shows why, and its Retry opens the app", async () => {
	const { app, log } = await launchStalled(3);
	try {
		await expect.poll(() => events(log, "profile.migrate.gave_up"), { timeout: 60_000 }).toHaveLength(1);
		let shown: Page | undefined;
		await expect
			.poll(
				async () => {
					for (const page of app.windows()) {
						const text = await page
							.locator("#omp-profile-error")
							.textContent({ timeout: 1_000 })
							.catch(() => null);
						if (text) {
							shown = page;
							return text;
						}
					}
					return null;
				},
				{ timeout: 15_000 },
			)
			.toContain('the profile migration step "navigate" got no answer in 10 s, 3 times');
		await shown?.locator("#omp-profile-retry").click();
		const page = await app.firstWindow({ timeout: 30_000 });
		await expect(page.locator("#root")).not.toBeEmpty({ timeout: 30_000 });
		const steps = (await events(log, "profile.migrate")).map(record => `${record.step}@${record.attempt}`);
		// The page's own Retry starts a new round once its document loads; its request was answered just before.
		expect(steps).toEqual(expect.arrayContaining(["navigate@3", "loading@1", "read@1", "app@1"]));
	} finally {
		await exitApp(app);
	}
});
