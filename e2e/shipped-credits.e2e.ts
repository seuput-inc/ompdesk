/** Real shell and paired phone geometry. SidebarUsage.test.tsx covers credit kinds and grouping. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { exitApp } from "./harness";
import { launchRemote, makeRemoteProfile } from "./remote-harness";
import { before, shot, shots, withPhone } from "./shipped-capture";

async function capture(page: Page, block: Locator, surface: "desktop-popover" | "phone-sidebar", lang: "en" | "ko") {
	const studio = block.locator('[data-usage-account="5"]');
	const team = block.locator('[data-usage-account="6"]');
	await expect(studio.locator("[data-account-label]")).toContainText("studio");
	await expect(team.locator("[data-account-label]")).toContainText("team");
	await expect(team.locator("[data-account-credits]")).toHaveCount(0);
	if (before) {
		await expect(studio.locator("[data-account-credits]")).toHaveCount(0);
	} else {
		const figure = studio.locator("[data-account-credits]");
		await expect(figure).toBeVisible();
		await expect(figure).toContainText("$18.75");
		await expect(figure).toHaveAccessibleName(/18\.75.*50|50.*18\.75/);
		const heading = block.locator("[data-usage-credits-heading]");
		if (surface === "desktop-popover") await expect(heading).toBeVisible();
		else await expect(heading).toHaveCount(0);
	}
	const bars = async (row: Locator) => {
		const gauges = row.getByRole("progressbar");
		await expect(gauges).toHaveCount(2);
		return gauges.evaluateAll(nodes =>
			nodes.flatMap(node => {
				const { left, right } = node.getBoundingClientRect();
				return [left, right];
			}),
		);
	};
	const left = await bars(studio);
	const right = await bars(team);
	for (const [i, edge] of left.entries()) expect(Math.abs(edge - (right[i] ?? Infinity))).toBeLessThanOrEqual(1);
	await expect(studio).toBeInViewport({ ratio: 1 });
	await expect(team).toBeInViewport({ ratio: 1 });
	await shot(page, `50-${lang}-${surface}-account-rows`);
}

if (shots)
	for (const lang of ["ko", "en"] as const) {
		test(`shipped captures #50 ${lang} per-account credits and aligned windows`, async () => {
			test.setTimeout(180_000);
			const root = await mkdtemp(join(tmpdir(), "shipped-credits-"));
			const profile = await makeRemoteProfile(root, "host", {
				language: lang,
				theme: "light",
				env: { OMP_GUI_TEST_USAGE_ACCOUNTS: "credits" },
			});
			const { app, page } = await launchRemote(profile);
			try {
				await page.locator("[data-status-usage]").click();
				await capture(page, page.locator("[data-usage-popover]"), "desktop-popover", lang);
				await withPhone(
					page,
					profile.tailscale,
					async phone => {
						const tab = await phone.evaluate(
							cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }),
							profile.project,
						);
						if (!tab?.tabId) throw new Error("Phone could not open its project");
						await phone.goto(`${new URL(phone.url()).origin}/#/open?tab=${tab.tabId}`);
						await expect(phone.locator("[data-composer-input]").first()).toBeEditable();
						await phone.locator("header button:has(svg.lucide-menu)").click();
						const block = phone.locator('[data-drawer] [data-rail-pin="usage"]');
						const fold = block.locator('[data-sidebar-usage-toggle][aria-expanded="false"]');
						await expect(block).toBeVisible();
						if (await fold.count()) await fold.click();
						await capture(phone, block, "phone-sidebar", lang);
					},
					lang,
				);
			} finally {
				await exitApp(app);
			}
		});
	}
