import * as path from "node:path";
import { chromium, devices, expect, type Page } from "@playwright/test";
import type { FixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { closeBrowser, launchBrowser } from "./harness";
import { REMOTE_LOGIN } from "./remote-harness";

const directory = process.env.OMP_GUI_SHIPPED_CAPTURES;
export const shots = directory && path.resolve(directory);
export const before = process.env.OMP_GUI_SHIPPED_TAG === "v0.152.0";

export async function shot(page: Page, name: string): Promise<void> {
	if (!shots) throw new Error("Shipped capture directory not set");
	await page.screenshot({
		path: path.join(shots, `${before ? "before" : "after"}-${name}.png`),
		animations: "disabled",
		scale: "css",
	});
}

export async function withPhone(
	page: Page,
	tailscale: FixtureTailscale,
	run: (phone: Page) => Promise<void>,
	lang: "en" | "ko" = "ko",
): Promise<void> {
	await page.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
	await expect
		.poll(() => page.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
		.toBe("ready");
	await expect.poll(() => serveSites(tailscale).length).toBeGreaterThan(0);
	const proxy = await ServeProxy.start(serveSites(tailscale).at(-1)!, REMOTE_LOGIN);
	try {
		const browser = await launchBrowser(chromium);
		try {
			const phone = await browser.newPage({
				...devices["Pixel 8"],
				viewport: { width: 390, height: 844 },
				locale: lang,
			});
			await phone.goto(`${proxy.url}/`);
			await phonePaired(phone);
			await expect.poll(() => phone.evaluate(() => innerWidth)).toBe(390);
			await run(phone);
		} finally {
			await closeBrowser(browser);
		}
	} finally {
		await proxy.close();
	}
}
