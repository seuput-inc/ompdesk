/** #43: ModelPicker.test.tsx covers the filter; these captures reach it through each real composer's chip. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp } from "./harness";
import { launchRemote, makeRemoteProfile } from "./remote-harness";
import { before, shot, shots, withPhone } from "./shipped-capture";

async function capturePicker(page: Page, surface: "desktop" | "phone"): Promise<void> {
	await page.locator("[data-model-chip]").click();
	const dialog = page.getByRole("dialog", { name: "모델 검색" });
	const search = dialog.getByRole("combobox", { name: "모델 검색" });
	const providers = dialog.getByRole("tablist", { name: "프로바이더" });
	const models = dialog.getByRole("option");
	const local = models.filter({ hasText: /local fixture/i });
	await expect(local).toBeVisible();
	if (before) {
		await expect(providers).toHaveCount(0);
		await expect(models.filter({ hasText: /Opus 4\.1/i })).toBeVisible();
		await shot(page, `43-ko-${surface}-all-providers`);
		// The old picker could narrow the same list only by typing the provider's name.
		await search.fill("anthropic");
	} else {
		const fixture = providers.getByRole("tab", { name: "Local fixture", exact: true });
		const claude = providers.getByRole("tab", { name: "Claude 구독", exact: true });
		await expect(providers.getByRole("tab")).toHaveCount(2);
		await expect(fixture.locator("[data-provider-mark]")).toBeVisible();
		await expect(claude.locator("[data-provider-mark]")).toBeVisible();
		await expect(fixture).toHaveAttribute("aria-selected", "true");
		await expect(models).toHaveCount(1);
		await shot(page, `43-ko-${surface}-local-selected`);
		await search.press("Shift+Tab");
		await expect(fixture).toBeFocused();
		await page.keyboard.press("ArrowRight");
		await expect(claude).toBeFocused();
		await expect(claude).toHaveAttribute("aria-selected", "true");
		await expect(fixture).toHaveAttribute("aria-selected", "false");
	}
	await expect(models).toHaveCount(2);
	await expect(local).toHaveCount(0);
	await expect(models.filter({ hasText: /Opus 4\.1/i })).toBeVisible();
	await expect(models.filter({ hasText: /Sonnet 4\.5/i })).toBeVisible();
	await shot(page, `43-ko-${surface}-${before ? "claude-search" : "claude-selected"}`);
}

if (shots) {
	test("shipped captures #43 Korean composer provider filters on desktop and paired phone", async () => {
		test.setTimeout(180_000);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shipped-picker-"));
		try {
			const profile = await makeRemoteProfile(root, "desktop", {
				language: "ko",
				theme: "light",
				env: { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1" },
			});
			const { app, page } = await launchRemote(profile);
			try {
				await capturePicker(page, "desktop");
				await page.keyboard.press("Escape");
				await withPhone(page, profile.tailscale, async phone => {
					const tab = await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), profile.project);
					if (!tab) throw new Error("The phone could not open the project");
					await phone.goto(`${new URL(phone.url()).origin}/#/open?tab=${tab.tabId}`);
					await capturePicker(phone, "phone");
				});
			} finally {
				await exitApp(app);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
