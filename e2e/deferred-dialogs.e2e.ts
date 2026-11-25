import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, test } from "@playwright/test";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, launchApp, recordsOfType } from "./harness";

// BtwDialog's frame handling and explicit start are covered by explicit-start-dialogs.test.tsx.
test("a side question waits for Ask and Escape leaves the running turn alone", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-deferred-dialogs-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const record = path.join(root, "rpc.jsonl");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true }),
	);
	const app = await launchApp({ project, desktop, agent, profile: root, env: { OMP_GUI_TEST_RECORD: record } });
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const input = page.locator("textarea").first();
		await input.fill("fixture stream parts");
		await input.press("Enter");
		await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
		await input.fill("/btw What is the next step?");
		await input.press("Enter");
		const dialog = page.getByRole("dialog", { name: "Side question" });
		await expect(dialog.getByRole("textbox", { name: "Side question" })).toHaveValue("What is the next step?");
		await test.info().attach("cef-side-question", { body: await dialog.screenshot(), contentType: "image/png" });
		const history = async () => page.evaluate(() => window.omp.rpc.command({ type: "get_btw_history" }));
		const before = await history();
		expect(before).toMatchObject({ success: true, data: { records: [] } });
		await dialog.getByRole("button", { name: "Ask now" }).click();
		await expect(dialog.getByText("Local side answer")).toBeVisible();
		const after = await history();
		expect(after).toMatchObject({ success: true, data: { records: [{ question: "What is the next step?" }] } });
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
		expect(await page.evaluate(() => window.omp.rpc.command({ type: "get_state" }))).toMatchObject({
			success: true,
			data: { isStreaming: true },
		});
		expect(await recordsOfType(record, "abort")).toEqual([]);
		expect(await recordsOfType(record, "abort_and_restore_queue")).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a phone can retry or cancel a side question when its dialogs fail to load", async () => {
	test.skip(process.platform === "win32", "the fake Tailscale is a bun shebang script");
	test.setTimeout(120_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-deferred-phone-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const record = path.join(root, "rpc.jsonl");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	const tailscale = await fixtureTailscale(root, { backendState: "Running" });
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: { ...tailscale.env, OMP_GUI_TEST_RECORD: record },
	});
	const browser = await chromium.launch();
	let proxy: ServeProxy | undefined;
	const gate = Promise.withResolvers<void>();
	let retryGate = Promise.withResolvers<void>();
	try {
		const host = await app.firstWindow();
		await host.waitForFunction(() => window.omp?.mobileWeb != null);
		await host.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => host.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
			.toBe("ready");
		const [site] = serveSites(tailscale);
		if (!site) throw new Error("no serve handler published");
		proxy = await ServeProxy.start(site, "seuput@example.com");
		const context = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" });
		let attempts = 0;
		let allowEntry = false;
		await context.route(/\/assets\/OnDemandDialogs-[^/]+\.js(?:\?.*)?$/, async route => {
			attempts++;
			if (!allowEntry) {
				await gate.promise;
				await route.abort();
			} else {
				await retryGate.promise;
				await route.continue();
			}
		});
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`);
		await phonePaired(phone);
		await phone.evaluate(() => Reflect.set(window, "__btwDocument", document));
		const field = phone.locator("[data-composer-input]").first();
		await expect(field).toBeVisible({ timeout: 60_000 });
		await field.fill("fixture stream parts");
		await phone.getByRole("button", { name: "Send", exact: true }).click();
		await expect(phone.getByRole("button", { name: "Stop" })).toBeVisible();
		await field.fill("/btw What should I check next?");
		await phone.getByRole("button", { name: "Send", exact: true }).click();
		await expect.poll(() => attempts).toBeGreaterThan(0);
		const history = async () => phone.evaluate(() => window.omp.rpc.command({ type: "get_btw_history" }));
		expect(await history()).toMatchObject({ success: true, data: { records: [] } });
		gate.resolve();
		const failed = phone.getByRole("dialog", { name: "Side question" });
		await expect(failed.getByRole("alert")).toBeVisible();
		await expect(failed.getByText("What should I check next?", { exact: true })).toBeVisible();
		await test
			.info()
			.attach("phone-question-load-failed", { body: await failed.screenshot(), contentType: "image/png" });
		expect(await history()).toMatchObject({ success: true, data: { records: [] } });
		const beforeRetry = attempts;
		allowEntry = true;
		await failed.getByRole("button", { name: "Retry", exact: true }).click();
		await expect.poll(() => attempts).toBe(beforeRetry + 1);
		await failed.getByRole("button", { name: "Retry", exact: true }).click();
		expect(attempts).toBe(beforeRetry + 1);
		await expect(failed.getByText("What should I check next?", { exact: true })).toBeVisible();
		retryGate.resolve();
		const dialog = phone.getByRole("dialog", { name: "Side question" });
		await expect(dialog.getByRole("textbox", { name: "Side question" })).toHaveValue("What should I check next?", {
			timeout: 60_000,
		});
		expect(await phone.evaluate(() => document === Reflect.get(window, "__btwDocument"))).toBe(true);
		await test.info().attach("phone-side-question", { body: await dialog.screenshot(), contentType: "image/png" });
		expect(await history()).toMatchObject({ success: true, data: { records: [] } });
		await dialog.getByRole("button", { name: "Ask now" }).click();
		await expect(dialog.getByText("Local side answer")).toBeVisible();
		expect(await history()).toMatchObject({
			success: true,
			data: { records: [{ question: "What should I check next?" }] },
		});
		await dialog.getByRole("button", { name: "Close", exact: true }).tap();
		await expect(dialog).toHaveCount(0);

		allowEntry = false;
		retryGate = Promise.withResolvers<void>();
		await phone.reload();
		await expect(field).toBeVisible();
		await field.fill("/btw Cancel this retained question");
		await phone.getByRole("button", { name: "Send", exact: true }).click();
		await expect(failed.getByRole("alert")).toBeVisible();
		await expect(failed.getByText("Cancel this retained question", { exact: true })).toBeVisible();
		const beforeCancelRetry = attempts;
		allowEntry = true;
		await failed.getByRole("button", { name: "Retry", exact: true }).tap();
		await expect.poll(() => attempts).toBe(beforeCancelRetry + 1);
		await failed.getByRole("button", { name: "Cancel", exact: true }).tap();
		await expect(failed).toHaveCount(0);
		retryGate.resolve();
		const paletteEntry = phone.locator("[data-command-center-entry]:visible").first();
		if (!(await paletteEntry.isVisible()))
			await phone.getByRole("button", { name: "Open menu", exact: true }).first().tap();
		await paletteEntry.tap();
		const palette = phone.locator('[role="dialog"]:has([data-palette-index])');
		await expect(palette).toBeVisible();
		await expect(dialog).toHaveCount(0);
		await phone.keyboard.press("Escape");
		expect(await history()).toMatchObject({
			success: true,
			data: { records: [{ question: "What should I check next?" }] },
		});
		await expect(phone.getByRole("button", { name: "Stop" })).toBeVisible();
		expect(await phone.evaluate(() => window.omp.rpc.command({ type: "get_state" }))).toMatchObject({
			success: true,
			data: { isStreaming: true },
		});
		expect(await recordsOfType(record, "abort")).toEqual([]);
		expect(await recordsOfType(record, "abort_and_restore_queue")).toEqual([]);
	} finally {
		gate.resolve();
		retryGate.resolve();
		await browser.close();
		await proxy?.close();
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
