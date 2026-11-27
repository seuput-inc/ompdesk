import type { Page } from "@playwright/test";
import { pressShortcutUntilVisible } from "./harness";

export async function selectInspectorView(page: Page, view: "diff" | "files" | "terminal" | "preview") {
	const button = page.locator(`[data-inspector-tab="${view}"]:visible`).first();
	if (await button.isVisible()) return button.click();
	const search = page.getByRole("dialog").getByRole("combobox");
	await pressShortcutUntilVisible(page, "ControlOrMeta+k", search);
	const command = view === "diff" ? "git" : view;
	await search.fill(command);
	await page.locator(`[data-command-name="${command}"]`).click();
}
