/**
 * omp updates itself, end to end, with the fixture omp's `update --check` and a
 * fake installer (`OMP_GUI_TEST_OMP_UPDATES=1`, `OMP_GUI_TEST_INSTALLER`; both are
 * needed for a test launch to check at all). The check runs on the fixture omp
 * with that omp's folder first on PATH and reports a newer release
 * (`OMP_GUI_TEST_LATEST_OMP`, `NEWER`) than the fixture (`FLOOR`), so main runs the
 * omp-update plan on its own while the tab keeps its process and its draft; once
 * the installer reports the new version, main re-detects omp, restarts the idle
 * tab on it (the boot log shows the floor then the newer one), shows one "omp updated to
 * …" toast, and the restarted bridge's capabilities probe names a feature
 * the new omp lacks. With the pref off nothing checks on its own, and "Update
 * now" still works. A release whose major is above the omp OMPdesk was tested
 * with (`UNTESTED_MAJOR`) is never installed on its own: Settings says it is held
 * and why, "Update now" installs it, and gui-runtime.jsonl says who did what.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { writeFakeOmp } from "../src/main/test-fake-omp";
import { FIXTURE_MIN_OMP_VERSION as FLOOR, FIXTURE_NEWER_OMP_VERSION as NEWER } from "./fixture/version";
import { exitApp, fixtureOmp, launchApp, pressShortcutUntilVisible } from "./harness";

/** A major above any omp an OMPdesk release was tested with (`src/shared/omp-tested.json`). */
const UNTESTED_MAJOR = "99.0.0";

/** The fake installer: logs each call; the omp update waits for the test's `go` file, then "installs" the launch's newest omp. */
const INSTALLER = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [item, method] = process.argv.slice(2);
const dir = process.env.OMPDESK_FAKE_INSTALLER_DIR;
appendFileSync(join(dir, "installs.log"), item + " " + method + "\\n");
if (item === "omp" && method === "omp-update") {
	while (!existsSync(join(dir, "go"))) await Bun.sleep(25);
	writeFileSync(process.env.OMPDESK_FAKE_VERSION_FILE, process.env.OMPDESK_FAKE_NEW_VERSION);
	console.log("Updated to " + process.env.OMPDESK_FAKE_NEW_VERSION);
} else {
	console.log("fake " + item + " install");
}
`;

const DRAFT = "a draft that must survive the omp restart";

interface Launched {
	app: ElectronApplication;
	page: Page;
	root: string;
	errors: string[];
	/** The fixture omp OMPdesk runs. */
	omp: string;
}

/** One line per `omp update --check` main ran: the first PATH entry it gave the check. */
async function checks(launched: Launched): Promise<string[]> {
	const log = await fs.readFile(path.join(launched.root, "update-checks.log"), "utf8").catch(() => "");
	return log.split("\n").filter(Boolean);
}

/** The `omp-update` lines of gui-runtime.jsonl, in order: each step and the path that started it (`checked launch`). */
async function updateLog(launched: Launched): Promise<string[]> {
	const log = await fs
		.readFile(path.join(launched.root, "desktop", "logs", "gui-runtime.jsonl"), "utf8")
		.catch(() => "");
	return log
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { source?: string; message?: string; details?: { path?: string } })
		.filter(entry => entry.source === "omp-update")
		.map(entry => `${entry.message} ${entry.details?.path}`);
}

/** `latest`: what the fixture omp's `update --check` calls the newest release, and what the fake installer installs. */
async function launch(name: string, prefs: Record<string, unknown>, latest = NEWER): Promise<Launched> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-gui-update-${name}-`));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const installerDir = path.join(root, "installer");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(installerDir)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ firstRunComplete: true, language: "en", ...prefs }),
	);
	const omp = await fixtureOmp(root);
	const installer = await writeFakeOmp(installerDir, INSTALLER);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: {
			OMP_GUI_OMP: omp,
			OMP_GUI_TEST_INSTALLER: installer,
			OMP_GUI_TEST_OMP_UPDATES: "1",
			OMP_GUI_TEST_LATEST_OMP: latest,
			OMPDESK_FAKE_NEW_VERSION: latest,
			OMP_GUI_TEST_UPDATE_CHECK_LOG: path.join(root, "update-checks.log"),
			OMP_GUI_TEST_VERSION_FILE: path.join(root, "omp-version"),
			OMP_GUI_TEST_BOOT_LOG: path.join(root, "boots.log"),
			OMP_GUI_TEST_UNAVAILABLE_AFTER_UPDATE: "planMode",
			OMPDESK_FAKE_INSTALLER_DIR: installerDir,
			OMPDESK_FAKE_VERSION_FILE: path.join(root, "omp-version"),
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page, root, errors, omp };
}

async function close(launched: Launched): Promise<void> {
	await exitApp(launched.app);
	await fs.rm(launched.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const sidecarStatus = (page: Page) => page.evaluate(async () => (await window.omp.sidecar.getStatus()).status);
const updatePhase = (page: Page) => page.evaluate(async () => (await window.omp.ompUpdate.getState()).phase);

async function boots(launched: Launched): Promise<string[]> {
	const log = await fs.readFile(path.join(launched.root, "boots.log"), "utf8").catch(() => "");
	return log.split("\n").filter(Boolean);
}

async function installs(launched: Launched): Promise<string[]> {
	const log = await fs.readFile(path.join(launched.root, "installer", "installs.log"), "utf8").catch(() => "");
	return log.split("\n").filter(line => line.startsWith("omp "));
}

async function releaseInstaller(launched: Launched): Promise<void> {
	await fs.writeFile(path.join(launched.root, "installer", "go"), "");
}

/** After "go": one toast, the idle tab restarted on `NEWER`, its draft kept, the probe's warning, the state in Settings. */
async function expectUpdated(launched: Launched): Promise<void> {
	const { page } = launched;
	await expect(page.getByText(`omp updated to ${NEWER}`)).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => boots(launched), { timeout: 30_000 }).toEqual([FLOOR, NEWER]);
	await expect.poll(() => sidecarStatus(page), { timeout: 30_000 }).toBe("ready");
	await expect(page.locator(".omp-composer-input").first()).toHaveValue(DRAFT);
	// The restarted bridge answered the capabilities probe for the newer omp; planMode is missing there.
	await expect(page.getByText(/lacks internals OMPdesk needs for: Plan mode/)).toBeVisible({ timeout: 30_000 });
	expect(await installs(launched)).toEqual(["omp omp-update"]);
	// Every check (main's, and Settings' on the tab) ran with this omp's folder first on PATH: stock's
	// `omp update` resolves `$which("omp")`, so that is the install it checked and would update.
	const ran = await checks(launched);
	expect(ran.length).toBeGreaterThan(0);
	expect(new Set(ran)).toEqual(new Set([path.dirname(launched.omp)]));
	// A check that starts right after the restart may still run here; the state it settles to is what counts.
	await expect
		.poll(() => page.evaluate(() => window.omp.ompUpdate.getState()), { timeout: 30_000 })
		.toMatchObject({
			phase: "idle",
			installed: NEWER,
			latest: NEWER,
			updatedTo: NEWER,
			failure: null,
		});
	expect(launched.errors).toEqual([]);
}

test("a newer omp installs on its own; the idle tab restarts on it with its draft, and the probe runs again", async () => {
	test.setTimeout(120_000);
	const launched = await launch("auto", {});
	try {
		const { page } = launched;
		await expect.poll(() => sidecarStatus(page), { timeout: 30_000 }).toBe("ready");
		await page.locator(".omp-composer-input").first().fill(DRAFT);
		// Nobody clicked: main found a release newer than the installed floor and runs the installer, which waits for `go`.
		await expect.poll(() => updatePhase(page), { timeout: 30_000 }).toBe("updating");
		await expect.poll(() => installs(launched), { timeout: 30_000 }).toEqual(["omp omp-update"]);
		// The install never touches the running tab: same process, still ready.
		expect(await boots(launched)).toEqual([FLOOR]);
		expect(await sidecarStatus(page)).toBe("ready");
		await releaseInstaller(launched);
		await expectUpdated(launched);
		// Settings › Updates & about › This computer: the switch is on, omp's row names the new version, and no status
		// line speaks while omp is current.
		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.locator('[data-settings-section="updates"]').click();
		await expect(settings.locator("#setting-gui-toolsAutoUpdate [role='switch']")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		const ompRow = settings.locator('[data-setup-item="omp"]');
		await expect(ompRow).toContainText(NEWER);
		await expect(ompRow.getByTestId("omp-update-now")).toBeVisible();
		await expect(settings.getByTestId("omp-update-status")).toHaveCount(0);
		// On a local tab "This computer" is the only place that updates omp: no second omp row above it.
		await expect(settings.getByText("The omp CLI installed on this system", { exact: false })).toHaveCount(0);
	} finally {
		await close(launched);
	}
});

test("a newer major waits for the person: nothing installs on its own, Settings says why, and Update now installs it", async () => {
	test.setTimeout(120_000);
	const launched = await launch("held", {}, UNTESTED_MAJOR);
	try {
		const { page } = launched;
		const state = () => page.evaluate(() => window.omp.ompUpdate.getState());
		await expect.poll(() => sidecarStatus(page), { timeout: 30_000 }).toBe("ready");
		// The launch check found the newer major and left it alone: no installer ran, the tab keeps its omp.
		await expect.poll(state, { timeout: 30_000 }).toMatchObject({
			phase: "idle",
			installed: FLOOR,
			latest: UNTESTED_MAJOR,
			held: { version: UNTESTED_MAJOR, reason: "untested-major" },
			updatedTo: null,
			failure: null,
		});
		expect(await installs(launched)).toEqual([]);
		expect(await boots(launched)).toEqual([FLOOR]);
		// Settings › Updates & about › This computer: omp's row says what is held and why, and keeps Update now.
		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.locator('[data-settings-section="updates"]').click();
		const held = settings.getByTestId("omp-update-held");
		await expect(held).toContainText(`omp ${UNTESTED_MAJOR} is available`);
		await expect(held).toContainText("tested with omp");
		await expect(settings.getByTestId("omp-update-status")).toHaveCount(0);
		// The person's click is the ask: the same update now runs.
		await settings.locator('[data-setup-item="omp"]').getByTestId("omp-update-now").click();
		await expect.poll(() => installs(launched), { timeout: 30_000 }).toEqual(["omp omp-update"]);
		await releaseInstaller(launched);
		await expect.poll(state, { timeout: 30_000 }).toMatchObject({
			phase: "idle",
			installed: UNTESTED_MAJOR,
			updatedTo: UNTESTED_MAJOR,
			held: null,
			failure: null,
		});
		await expect.poll(() => boots(launched), { timeout: 30_000 }).toEqual([FLOOR, UNTESTED_MAJOR]);
		await expect(held).toHaveCount(0);
		// Who installed what: the launch's check held it, the person's pass installed it (a later repair check may follow).
		expect((await updateLog(launched)).slice(0, 5)).toEqual([
			"checked launch",
			"held launch",
			"checked manual",
			"started manual",
			"finished manual",
		]);
	} finally {
		await close(launched);
	}
});

/** Opt-in captures (`OMP_GUI_OMP_UPDATE_CAPTURES=<dir>`): the updating row, the updated toast and Settings' omp rows. */
const CAPTURES = process.env.OMP_GUI_OMP_UPDATE_CAPTURES ?? "";
for (const [language, themeName] of [
	["en", "light"],
	["ko", "dark"],
] as const)
	test(`omp update captures (${language} ${themeName})`, async () => {
		test.skip(!CAPTURES, "OMP_GUI_OMP_UPDATE_CAPTURES=<dir> captures the update surfaces");
		test.setTimeout(120_000);
		await fs.mkdir(CAPTURES, { recursive: true });
		const launched = await launch(`capture-${language}`, { language, themeName });
		try {
			const { page } = launched;
			const shot = async (name: string) => {
				await page.mouse.move(1, 1);
				await page.screenshot({
					path: path.join(CAPTURES, `${language}-${themeName}-${name}.png`),
					scale: "css",
					animations: "disabled",
				});
			};
			await expect.poll(() => sidecarStatus(page), { timeout: 30_000 }).toBe("ready");
			await expect.poll(() => updatePhase(page), { timeout: 30_000 }).toBe("updating");
			const settings = page.locator("[data-settings-page]");
			await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
			await settings.locator('[data-settings-section="updates"]').click();
			await expect(settings.getByTestId("omp-update-status")).toBeVisible();
			await shot("1-updating-settings");
			await page.keyboard.press("Escape");
			await releaseInstaller(launched);
			await expect.poll(() => boots(launched), { timeout: 30_000 }).toEqual([FLOOR, NEWER]);
			await expect.poll(() => sidecarStatus(page), { timeout: 30_000 }).toBe("ready");
			await expect(page.locator("[role='status'], [role='alert']").first()).toBeVisible({ timeout: 30_000 });
			await shot("2-updated-toast");
			await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
			await settings.locator('[data-settings-section="updates"]').click();
			await expect(settings.locator('[data-setup-item="omp"]')).toContainText(NEWER);
			await shot("3-updated-settings");
		} finally {
			await close(launched);
		}
	});
