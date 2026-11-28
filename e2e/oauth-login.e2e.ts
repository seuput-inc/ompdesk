/**
 * Browser sign-in from Settings › Models on the fake omp, which replays stock's
 * `login` sequence (omp 18.10.3, rpc-mode over Anthropic's callback-server
 * flow): open_url with a loopback launch page, the "waiting" notice, then a
 * code-paste `input` that stock races against its callback and never closes.
 *
 * The panel waits for the browser first and keeps the paste as a collapsed,
 * localized fallback; the "browser" (this test) follows the launch page's
 * redirect back to the fake's callback, the login completes, and the leftover
 * paste request is answered for stock and never shows as a chat card. Cancel
 * ends the login through the callback's denial instead of answering the paste
 * (which would only re-ask). The two Claude account orders use the same fake
 * callback and the real models.yml writer in a fresh profile. Provider picker
 * and ProvidersSection component tests cover the controls in isolation.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import { appLaunchOptions, exitApp, pressShortcutUntilVisible, readRecords, variants } from "./harness";

test.describe.configure({ mode: "parallel" });

type Language = "en" | "ko";
const dummyClaudeKey = "offline-fixture-not-a-credential";
const offeredModel = "offline-claude-model";

function tr(language: Language, key: string, params: Record<string, string> = {}): string {
	const template = (language === "ko" ? ko : en)[key];
	if (template === undefined) throw new Error(`missing locale key ${key}`);
	return template.replace(/\{(\w+)\}/g, (_match, name: string) => params[name] ?? `{${name}}`);
}

interface Launched {
	app: ElectronApplication;
	page: Page;
	record: string;
	errors: string[];
	root: string;
	reopen: () => Promise<ElectronApplication>;
}

async function launch(language: Language, theme: "light" | "dark", firstRun = false): Promise<Launched> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-oauth-${language}-${theme}-`)));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: !firstRun }),
	);
	const record = path.join(root, "record.jsonl");
	const options = await appLaunchOptions({
		project,
		desktop,
		agent,
		profile: root,
		env: {
			OMP_GUI_REMOTE_PORT: "0",
			OMP_GUI_TEST_LOGIN: "1",
			OMP_GUI_TEST_RECORD: record,
			...(firstRun ? { OMP_GUI_TEST_SIGNED_OUT: "1", OMP_GUI_TEST_MODELS: "0" } : {}),
		},
	});
	for (const key of Object.keys(options.env)) {
		if (/_API_KEY$|_TOKEN$|^ANTHROPIC_/.test(key)) delete options.env[key];
	}
	if (firstRun) {
		const preload = path.join(project, "claude-list.cjs");
		await fs.writeFile(
			preload,
			`
const send = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const request = new Request(input, init), url = new URL(request.url);
	if (["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return send(input, { ...init, redirect: "error" });
	if (url.origin !== "https://api.anthropic.com" || url.pathname !== "/v1/models" || request.method !== "GET" ||
		request.headers.get("x-api-key") !== ${JSON.stringify(dummyClaudeKey)}) throw new Error("external request blocked by login fixture");
	return Response.json({data: [{id: ${JSON.stringify(offeredModel)}}], has_more: false});
};
globalThis.__loginFixtureGuard = true;
`,
		);
		options.env.NODE_OPTIONS = `--require "${preload.replaceAll("\\", "/")}"`;
	}
	const reopen = async () => {
		const app = await electron.launch(options);
		if (firstRun) expect(await app.evaluate(() => Reflect.get(globalThis, "__loginFixtureGuard"))).toBe(true);
		await app.evaluate(({ BrowserWindow, shell }) => {
			BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 860);
			const opened: string[] = [];
			Object.assign(globalThis, { openedUrls: opened });
			shell.openExternal = async (url: string) => {
				opened.push(url);
			};
		});
		return app;
	};
	const app = await reopen();
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
		.toBe("ready");
	return { app, page, record, errors, root, reopen };
}

/** Settings › Models with the Anthropic row in view; returns the row. */
async function openAnthropicRow(page: Page, language: Language) {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="models"]').click();
	// Providers to connect sit behind "Add a provider" once one (the fixture) is connected.
	await settings.getByRole("button", { name: tr(language, "providers.add") }).click();
	// The sign-in panel is one block under the list, whichever provider started it.
	return settings.locator("[data-login-panel]");
}

/** Settings › Models with the Anthropic row's sign-in started; returns the row. */
async function startSignIn(page: Page, language: Language) {
	const anthropic = await openAnthropicRow(page, language);
	await page.locator("[data-settings-page]").locator('button[data-provider-connect="anthropic"]').click();
	await page.getByRole("button", { name: tr(language, "providers.featured.subscription"), exact: true }).click();
	await expect(anthropic.locator("[data-login-progress]")).toHaveText(tr(language, "providerList.login.waiting"));
	return anthropic;
}

/** The browser half: open the launch page the panel opened and follow it back to omp's callback. */
async function finishInBrowser(launchUrl: string, query: Record<string, string>): Promise<number> {
	expect(new URL(launchUrl).hostname).toBe("127.0.0.1");
	const launch = await fetch(launchUrl, { redirect: "manual" });
	expect(launch.status).toBe(302);
	const authorize = new URL(launch.headers.get("location") ?? "");
	expect(authorize.host).toBe("claude.ai");
	const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
	expect(callback.origin).toBe(new URL(launchUrl).origin);
	callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
	for (const [key, value] of Object.entries(query)) callback.searchParams.set(key, value);
	return (await fetch(callback)).status;
}

for (const first of ["subscription", "key"] as const) {
	test(`Claude accounts survive relaunch: ${first} first`, async () => {
		test.setTimeout(120_000);
		const { app, page, record, root, reopen } = await launch("ko", "light", true);
		let running: ElectronApplication | null = app;
		const settings = page.locator("[data-settings-page]");
		const firstRun = page.locator('[data-first-run-step="connect"]');
		const chooser = page.locator("[data-claude-connect]");
		const keyId = "anthropic-api-key";
		const loginIds = async () =>
			(await readRecords(record)).filter(row => row.type === "login").map(row => row.providerId);
		const opened = () => app.evaluate(() => (Reflect.get(globalThis, "openedUrls") as string[]).length);
		const saved = (view: Page) =>
			view.evaluate(async () =>
				(await window.omp.models.listProviders()).providers.map(({ id, api, baseUrl, hasApiKey, models }) => ({
					id,
					api,
					baseUrl,
					hasApiKey,
					models: models.map(model => model.id),
				})),
			);
		const expected = [
			{
				id: keyId,
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				hasApiKey: true,
				models: [offeredModel],
			},
		];
		try {
			let subscriptions = 0;
			for (const [index, method] of [first, first === "key" ? "subscription" : "key"].entries()) {
				if (index === 1) {
					await expect(firstRun).toHaveCount(0);
					await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
					await settings.locator('[data-settings-section="models"]').click();
				}
				const enter =
					index === 0
						? firstRun.locator('[data-provider-connect="anthropic"]')
						: settings.locator('[data-provider-add="anthropic"]');
				await enter.click();
				const subscription = chooser.getByRole("button", { name: tr("ko", "providers.featured.subscription") });
				const key = chooser.getByRole("button", { name: tr("ko", "providers.featured.apiKey") });
				await expect(subscription).toBeVisible();
				await expect(key).toBeVisible();
				await chooser.getByRole("button", { name: tr("ko", "common.cancel"), exact: true }).click();
				await expect(enter).toBeVisible();
				expect(await loginIds()).toHaveLength(subscriptions);
				expect(await opened()).toBe(subscriptions);
				await enter.click();
				if (method === "subscription") {
					await subscription.click();
					subscriptions++;
					await expect.poll(opened).toBe(subscriptions);
					const url = await app.evaluate(() => (Reflect.get(globalThis, "openedUrls") as string[])[0]);
					expect(await finishInBrowser(url ?? "", { code: "abc" })).toBe(200);
					await expect(page.locator("[data-login-progress]")).toHaveCount(0);
				} else {
					await key.click();
					const form = page.getByRole("dialog", { name: tr("ko", "providers.claude.keyTitle") });
					const input = form.getByLabel(tr("ko", "providerCfg.form.apiKey"), { exact: true });
					await expect(form.locator("input")).toHaveCount(1);
					await expect(input).toHaveAttribute("type", "password");
					await expect(input).toBeFocused();
					await input.fill(dummyClaudeKey);
					await page.keyboard.press("Escape");
					await expect(enter).toBeFocused();
					expect(await saved(page)).toEqual([]);
					await enter.click();
					await key.click();
					await expect(input).toHaveValue("");
					await input.fill(dummyClaudeKey);
					await test.info().attach(`ko-${index === 0 ? "onboarding" : "settings"}-claude-key.png`, {
						body: await page.screenshot(),
						contentType: "image/png",
					});
					if (index === 0) await input.press("Enter");
					else
						await form.getByRole("button", { name: tr("ko", "providers.featured.connect"), exact: true }).click();
					await expect.poll(() => saved(page)).toEqual(expected);
					await expect(form).toHaveCount(0);
					if (index === 0) {
						const model = page.locator('[data-first-run-step="model"]');
						await model.getByRole("button", { name: tr("ko", "setup.model.use"), exact: true }).click();
					}
					expect(await loginIds()).toHaveLength(subscriptions);
					expect(await opened()).toBe(subscriptions);
				}
			}
			await expect(settings.locator('[data-provider-row="anthropic"]')).toBeVisible();
			await expect(
				settings.locator(`[data-provider-row="anthropic"] [data-provider-account="${keyId}"]`),
			).toBeVisible();
			await exitApp(app);
			running = null;
			running = await reopen();
			const again = await running.firstWindow();
			const reopenedSettings = again.locator("[data-settings-page]");
			await pressShortcutUntilVisible(again, "ControlOrMeta+Comma", reopenedSettings);
			await reopenedSettings.locator('[data-settings-section="models"]').click();
			await expect(reopenedSettings.locator('[data-provider-row="anthropic"]')).toBeVisible();
			await expect(
				reopenedSettings.locator(`[data-provider-row="anthropic"] [data-provider-account="${keyId}"]`),
			).toBeVisible();
			expect(await saved(again)).toEqual(expected);
			expect(await loginIds()).toEqual(["anthropic"]);
			expect((await fs.readFile(path.join(root, "agent", "models.yml"), "utf8")).includes(dummyClaudeKey)).toBe(
				true,
			);
			expect((await fs.readFile(record, "utf8")).includes(dummyClaudeKey)).toBe(false);
		} finally {
			if (running) await exitApp(running);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}

for (const [language, theme] of variants([
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const)) {
	test(`${language === "en" && theme === "light" ? "@smoke " : ""}browser sign-in finishes through the callback; the code paste stays a fallback (${language} ${theme})`, async () => {
		test.setTimeout(120_000);
		const { app, page, record, errors, root } = await launch(language, theme);
		const shot = (name: string) =>
			page.screenshot({
				animations: "disabled",
				path: test.info().outputPath(`oauth-${language}-${theme}-${name}.png`),
			});
		try {
			const anthropic = await startSignIn(page, language);
			// Stock's paste request reached the app, yet neither the panel nor the chat asks for it.
			await expect.poll(async () => (await readRecords(record)).some(frame => frame.type === "login")).toBe(true);
			const toggle = anthropic.getByRole("button", { name: tr(language, "providerList.login.pasteToggle") });
			await expect(toggle).toHaveAttribute("aria-expanded", "false");
			await expect(anthropic.getByLabel(tr(language, "providerList.login.pasteLabel"))).toHaveCount(0);
			await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
			await expect(page.getByText("Paste the authorization code")).toHaveCount(0);
			await shot("1-waiting");

			await toggle.click();
			await expect(anthropic.getByLabel(tr(language, "providerList.login.pasteLabel"))).toBeVisible();
			await expect(anthropic).toContainText(tr(language, "providerList.login.pasteHint"));
			await expect(anthropic.locator("[data-login-progress]")).toHaveText(
				tr(language, "providerList.login.waiting"),
			);
			await expect(page.locator("[data-prompt-countdown]")).toHaveCount(0);
			await shot("2-fallback-open");

			// The browser opens by itself, once, with no click; the button stays to reopen it.
			await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "openedUrls"))).toHaveLength(1);
			await expect(
				anthropic.getByRole("button", { name: tr(language, "providerList.login.openBrowser") }),
			).toBeVisible();
			const [launchUrl] = (await app.evaluate(() => Reflect.get(globalThis, "openedUrls"))) as string[];
			expect(launchUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/launch$/);
			expect(await finishInBrowser(launchUrl ?? "", { code: "abc" })).toBe(200);

			await expect(page.getByText(tr(language, "providers.loginSuccess", { provider: "Claude" }))).toBeVisible();
			await expect(anthropic.locator("[data-login-progress]")).toHaveCount(0);
			// The paste request stock left open was answered for it, and never became a chat card.
			const frames = await readRecords(record);
			const pasteId = frames.findLast(
				frame => frame.type === "extension_ui_response" && frame.cancelled === true,
			)?.id;
			expect(pasteId).toMatch(/^fixture-login-input-/);
			expect(frames.filter(frame => frame.type === "extension_ui_response" && frame.id === pasteId)).toHaveLength(1);
			await page.keyboard.press("Escape");
			await expect(page.locator("[data-settings-page]")).toHaveCount(0);
			await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
			await expect(page.locator("[data-prompt-countdown]")).toHaveCount(0);
			await shot("3-signed-in-chat");
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}

/** Reload the window mid-sign-in: main still runs `login`, so it hands the sign-in back. */
async function reloadMidSignIn(page: Page): Promise<void> {
	await page.reload();
	await page.waitForFunction(() => window.omp?.rpc != null);
	// What main hands the reloaded page: stock's paste request, the panel's while `login` runs.
	await expect
		.poll(() => page.evaluate(() => window.omp.ui.openRequests().then(open => open.map(o => o.signIn?.active))))
		.toEqual([true]);
}

test("a reload mid-sign-in leaves no chat card and the panel shows the sign-in again, through to connected", async () => {
	test.setTimeout(120_000);
	const { app, page, record, errors, root } = await launch("en", "light");
	try {
		await startSignIn(page, "en");
		await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "openedUrls"))).toHaveLength(1);
		await page.keyboard.press("Escape");
		await reloadMidSignIn(page);
		await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
		await expect(page.getByText("Paste the authorization code")).toHaveCount(0);

		const anthropic = await openAnthropicRow(page, "en");
		await expect(anthropic.locator("[data-login-progress]")).toHaveText(en["providerList.login.inProgress"] ?? "");
		await expect(anthropic.getByRole("button", { name: en["providerList.login.pasteToggle"] })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		await expect(page.locator("[data-prompt-card]")).toHaveCount(0);

		// The browser half still reaches the callback server of the login that survived the reload.
		// The sign-in already opened the browser once by itself; the button reopens the same page.
		await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "openedUrls"))).toHaveLength(1);
		await anthropic.getByRole("button", { name: en["providerList.login.openBrowser"] }).click();
		await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "openedUrls"))).toHaveLength(2);
		const launchUrl = ((await app.evaluate(() => Reflect.get(globalThis, "openedUrls"))) as string[]).at(-1);
		expect(await finishInBrowser(launchUrl ?? "", { code: "abc" })).toBe(200);

		await expect(page.getByText(tr("en", "providers.loginSuccess", { provider: "Claude" }))).toBeVisible();
		await expect(anthropic.locator("[data-login-progress]")).toHaveCount(0);
		// The leftover paste was answered once for stock, by the page that took the sign-in over.
		await expect
			.poll(async () =>
				(await readRecords(record)).filter(
					frame => frame.type === "extension_ui_response" && frame.cancelled === true,
				),
			)
			.toHaveLength(1);
		await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("an agent starts provider sign-in without waiting for authentication and shows the person's login panel", async () => {
	test.setTimeout(120_000);
	const { app, page, record, errors, root } = await launch("en", "light");
	try {
		const tabId = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
		expect(tabId).toBeDefined();
		await page.evaluate(({ tabId, command }) => window.omp.rpc.commandForTab(tabId, { type: "bash", command }), {
			tabId: tabId ?? "",
			command: `fixture:host-tool:ompdesk_app ${JSON.stringify({
				action: "accounts.provider_sign_in",
				args: { providerId: "anthropic" },
			})}`,
		});
		await expect
			.poll(
				async () =>
					(await readRecords(record))
						.filter(frame => frame.type === "host_tool_result" && frame.recordedBy !== undefined)
						.map(frame => frame.isError === true),
				{ timeout: 10_000 },
			)
			.toEqual([false]);
		const panel = page.locator("[data-login-panel]");
		await expect(panel.locator("[data-login-progress]")).toBeVisible();
		await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
		const duplicate = await page.evaluate(
			tabId => window.omp.rpc.commandForTab(tabId, { type: "login", providerId: "anthropic" }),
			tabId ?? "",
		);
		expect(duplicate).toMatchObject({ success: false, code: "login_in_progress" });
		await page.screenshot({ path: test.info().outputPath("agent-login-panel.png") });
		await panel.getByRole("button", { name: en["providerList.login.pasteToggle"] }).click();
		await panel.getByLabel("Authorization code or redirect address").fill("abc");
		await panel.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(page.getByText("Signed in to Claude")).toBeVisible();
		await expect(panel.locator("[data-login-progress]")).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
