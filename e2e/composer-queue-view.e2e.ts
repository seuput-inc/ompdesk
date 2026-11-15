import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { captureTo } from "./harness";
import { composerGeometry, seedQueue } from "./queue-harness";

// Capture the floating pending-instruction list without shifting the composer at each viewport.

const captureDir = process.env.OMP_GUI_QUEUE_CAPTURES;

const VIEWPORTS = [
	{ name: "desktop-1280", preset: devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, phone: false },
	{ name: "tablet-834", preset: devices["iPad Pro 11"], viewport: { width: 834, height: 1194 }, phone: false },
	{ name: "phone-390", preset: devices["iPhone 15"], viewport: { width: 390, height: 844 }, phone: true },
] as const;

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser;

test.beforeAll(async () => {
	server = await createServer({
		configFile: path.resolve("vite.harness.config.ts"),
		server: { host: "127.0.0.1", port: 0, strictPort: false },
		logLevel: "error",
	});
	await server.listen();
	const address = server.httpServer?.address();
	origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	browser = await chromium.launch();
});

test.afterAll(async () => {
	await browser?.close();
	await server?.close();
});

async function open(look: { theme: "light" | "dark"; lang: "en" | "ko" }, shape: (typeof VIEWPORTS)[number]) {
	const context = await browser.newContext({ ...shape.preset, viewport: shape.viewport });
	const page = await context.newPage();
	page.on("pageerror", error => {
		throw error;
	});
	await page.goto(`${origin}/harness.html?theme=${look.theme}&lang=${look.lang}`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	return page;
}

async function shot(page: Page, shape: string, look: string, state: string): Promise<void> {
	await page.waitForTimeout(450);
	await captureTo(captureDir, page, `queue-${shape}-${look}-${state}`);
}

for (const shape of VIEWPORTS) {
	for (const theme of ["light", "dark"] as const) {
		for (const lang of ["en", "ko"] as const) {
			test(`${shape.name} ${theme} ${lang}: pending instructions float without moving the composer`, async () => {
				test.setTimeout(90_000);
				const page = await open({ theme, lang }, shape);
				const look = `${theme}-${lang}`;
				// The baseline is a running turn with nothing queued: queuing must change nothing from there.
				await seedQueue(page, { entries: [] });
				const idle = await composerGeometry(page);
				const pill = page.locator("[data-queue-pill]");
				const popover = page.locator("[data-queue-popover]");

				await seedQueue(page, { entries: ["f2"] });
				await expect(pill).toBeVisible();
				expect(await composerGeometry(page)).toEqual(idle);
				await shot(page, shape.name, look, "queue1");

				await seedQueue(page, { entries: ["s1", "s2", "f1", "f2"] });
				await expect(pill).toBeVisible();
				expect(await composerGeometry(page)).toEqual(idle);
				await shot(page, shape.name, look, "queue4");

				await seedQueue(page, {
					entries: ["s1", "s2", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"],
				});
				expect(await composerGeometry(page)).toEqual(idle);
				await pill.click();
				await expect(popover).toBeVisible();
				await expect(popover.locator("[data-queue-row]")).toHaveCount(10);
				expect(await composerGeometry(page)).toEqual(idle);
				await shot(page, shape.name, look, "queue10-open");

				await page.context().close();
			});
		}
	}
}
