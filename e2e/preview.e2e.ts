import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { acceptLanguages } from "../src/main/system-languages";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";
import { screenshotBitmap } from "./screenshot-bitmap";

test("@smoke isolated Preview loads a local HTTP page without shell privileges", async () => {
	test.setTimeout(120_000);
	const screenshotDir = process.env.OMP_GUI_PREVIEW_SCREENSHOTS ?? path.join(os.tmpdir(), "ompdesk-preview-captures");
	const acceptLanguage: (string | undefined)[] = [];
	const server = createServer((request, response) => {
		if (request.url === "/") acceptLanguage.push(request.headers["accept-language"]);
		if (request.url === "/slow") {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.flushHeaders();
			return;
		}
		if (request.url === "/error") {
			response.destroy();
			return;
		}
		if (request.url === "/edit") {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.end('<!doctype html><title>Edit fixture</title><input id=field aria-label="Field">');
			return;
		}
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end(
			'<!doctype html><title>Local preview fixture</title><h1>Real preview page</h1><a href="/next">Next</a>',
		);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No fixture server address");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-"));
	const desktop = path.join(profile, "desktop");
	const project = path.join(profile, "project");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const env = {
		...process.env,
		OMP_GUI_HEADLESS: "1",
		PI_CODING_AGENT_DIR: agent,
		OMP_GUI_OMP: await fixtureOmp(profile),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		// `--lang=de` stands for a system language whose locale file the package trims: Chromium alone would send
		// German first; the Preview sends the system's own languages (src/main/system-languages.ts).
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			project,
			`--user-data-dir=${desktop}`,
			"--lang=de",
		],
		env,
	});
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const aside = page.locator("aside[data-docked]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
		await aside.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(aside.locator(".omp-panel-topbar button")).toHaveCount(5);
		await expect(aside.locator("form").getByRole("button", { name: "Open in browser", exact: true })).toBeVisible();
		await page.getByRole("textbox", { name: "Preview URL" }).fill(url);
		await page.getByRole("textbox", { name: "Preview URL" }).press("Enter");
		await expect(page.locator("[data-preview-status]")).toHaveText("Local preview fixture");
		const preferred = await app.evaluate(({ app }) => app.getPreferredSystemLanguages());
		expect(preferred.length).toBeGreaterThan(0);
		expect(
			acceptLanguage
				.at(-1)
				?.split(",")
				.map(part => part.split(";")[0]),
		).toEqual(acceptLanguages(preferred).split(","));
		const security = await app.evaluate(async ({ webContents }) => {
			const child = webContents
				.getAllWebContents()
				.find(contents => contents.getTitle() === "Local preview fixture");
			if (!child) throw new Error("Missing native preview contents");
			return child.executeJavaScript("({ title: document.title, node: typeof require, ipc: typeof window.omp })");
		});
		expect(security).toEqual({ title: "Local preview fixture", node: "undefined", ipc: "undefined" });
		// Electron's isFocused is the window's own activation, not its focused webContents (`Widget::IsActive`,
		// `-[NSWindow isKeyWindow]`): a test window (OMP_GUI_HEADLESS) is setFocusable(false) and shown inactive.
		expect(
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
			"the window was activated: the shell log's window.activation, window.inactive and window.webview_focus lines say by what",
		).toBe(false);
		// The application menu's edit commands (Cmd/Ctrl+A, C, V, X, Z) act on the Preview view that holds the window's
		// native keyboard focus, as Electron's menu roles act on the focused webContents, not on the window's own page.
		await page.getByRole("textbox", { name: "Preview URL" }).fill(`${url}edit`);
		await page.getByRole("textbox", { name: "Preview URL" }).press("Enter");
		await expect(page.locator("[data-preview-status]")).toHaveText("Edit fixture");
		// The Preview page is the shell's own Chromium page, not one of the app WebView's targets: Playwright cannot
		// hold it, so the page is driven through its webContents in main (typed text and focus as the page receives them).
		const onEditPage = (action: { run: "eval"; code: string } | { run: "text"; text: string } | { run: "focus" }) =>
			app.evaluate(
				async ({ webContents }, source) => {
					const contents = webContents.getAllWebContents().find(item => item.getURL() === source.address);
					if (!contents) throw new Error("No Preview page target");
					if (source.action.run === "text") return contents.insertText(source.action.text);
					if (source.action.run === "focus") {
						contents.focus();
						return undefined;
					}
					return contents.executeJavaScript(source.action.code, true);
				},
				{ address: `${url}edit`, action },
			);
		const fieldValue = () => onEditPage({ run: "eval", code: "document.getElementById('field').value" });
		await onEditPage({ run: "eval", code: "document.getElementById('field').focus()" });
		await onEditPage({ run: "text", text: "abc" });
		await expect.poll(fieldValue).toBe("abc");
		// The native view takes the keyboard focus: the window's focused page is the Preview page now.
		await onEditPage({ run: "focus" });
		// What the menu's Select All runs: the window's page is told to select all.
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.selectAll());
		await onEditPage({ run: "text", text: "x" });
		await expect.poll(fieldValue).toBe("x");
		await page.getByRole("textbox", { name: "Preview URL" }).fill(url);
		await page.getByRole("textbox", { name: "Preview URL" }).press("Enter");
		await expect(page.locator("[data-preview-status]")).toHaveText("Local preview fixture");
		const palette = page.getByRole("dialog").getByRole("combobox");
		await pressShortcutUntilVisible(page, "ControlOrMeta+k", palette);
		await palette.fill("Background tasks");
		await page
			.getByRole("dialog")
			.locator("button[data-palette-index]", { hasText: "Background tasks" })
			.first()
			.click();
		await expect(page.locator('[data-view-sheet="jobs"]')).toBeVisible();
		await expect
			.poll(() =>
				app.evaluate(({ BrowserWindow }) =>
					BrowserWindow.getAllWindows()[0].contentView.children.at(-1)?.getVisible(),
				),
			)
			.toBe(false);
		await page.keyboard.press("Escape");
		for (const [theme, label] of [
			["light", "OMPdesk Light"],
			["dark", "OMPdesk Dark"],
		]) {
			await page.locator("textarea").first().fill("/theme");
			await page.getByRole("button", { name: "Send", exact: true }).click();
			const picker = page.getByRole("dialog", { name: "Choose theme" });
			await picker.getByPlaceholder("Search themes…").fill(label);
			await picker.locator("[data-theme-entry]").filter({ hasText: label }).click();
			await expect(picker).toHaveCount(0);
			await expect
				.poll(() =>
					app.evaluate(({ BrowserWindow }) =>
						BrowserWindow.getAllWindows()[0].contentView.children.at(-1)?.getVisible(),
					),
				)
				.toBe(true);
			const toast = page.getByRole("status").filter({ hasText: `Theme: ${label}` });
			await toast.getByRole("button", { name: "Close", exact: true }).click();
			await expect(toast).toHaveCount(0);
			let nativeCapture = "";
			await expect
				.poll(async () => {
					nativeCapture = await app.evaluate(async ({ webContents }) => {
						const child = webContents
							.getAllWebContents()
							.find(contents => contents.getTitle() === "Local preview fixture");
						if (!child) throw new Error("Missing native preview capture");
						const image = await child.capturePage(undefined, { stayHidden: true });
						return image.toPNG().toString("base64");
					});
					const bitmap = await screenshotBitmap(Buffer.from(nativeCapture, "base64"));
					return bitmap.some(
						(alpha, index) =>
							index % 4 === 3 &&
							alpha > 0 &&
							Math.min(bitmap[index - 3], bitmap[index - 2], bitmap[index - 1]) < 200,
					);
				})
				.toBe(true);
			// Capture the actual app WebView through its test driver, not the separate Preview CDP service.
			// Native child pixels are checked and retained independently above.
			const shellCapture = (await page.screenshot({ animations: "disabled" })).toString("base64");
			await fs.mkdir(screenshotDir, { recursive: true });
			await fs.writeFile(path.join(screenshotDir, `preview-${theme}.png`), Buffer.from(shellCapture, "base64"));
			await fs.writeFile(
				path.join(screenshotDir, `preview-page-${theme}.png`),
				Buffer.from(nativeCapture, "base64"),
			);
			const addressBar = page.getByRole("textbox", { name: "Preview URL" });
			await addressBar.fill(`${url}slow`);
			await addressBar.press("Enter");
			await expect(page.locator("[data-preview-status]")).toHaveText("Loading…");
			await aside.screenshot({
				animations: "disabled",
				path: path.join(screenshotDir, `preview-loading-${theme}.png`),
			});
			await aside.getByRole("button", { name: "Stop", exact: true }).click();
			await addressBar.fill(`${url}error`);
			await addressBar.press("Enter");
			await expect(aside.getByRole("alert")).toContainText("Couldn't load this page");
			await expect(aside.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
			await aside.screenshot({
				animations: "disabled",
				path: path.join(screenshotDir, `preview-error-${theme}.png`),
			});
			await addressBar.fill(url);
			await addressBar.press("Enter");
			await expect(page.locator("[data-preview-status]")).toHaveText("Local preview fixture");
		}
		console.log(`Preview captures: ${screenshotDir}`);
	} finally {
		await exitApp(app);
		await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
		await fs.rm(profile, { recursive: true, force: true });
	}
});
