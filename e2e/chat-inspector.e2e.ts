import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, untilAnswered } from "./harness";
import { launchRemote, makeRemoteProfile } from "./remote-harness";

test("project and bot conversations keep their own inspector on reopen and on return", async () => {
	test.setTimeout(150_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "chat-inspector-")));
	const home = path.join(parent, "home");
	const folder = path.join(home, ".omp", "bots", "courier");
	await fs.mkdir(folder, { recursive: true });
	const profile = await makeRemoteProfile(parent, "ordinary", {
		language: "en",
		theme: "dark",
		env: { HOME: home, USERPROFILE: home },
	});
	await fs.writeFile(
		path.join(profile.desktop, "bots.json"),
		JSON.stringify([{ id: "bot-courier", name: "Courier", folder }]),
	);
	const { app, page } = await launchRemote(profile);
	try {
		const active = () => page.evaluate(async () => (await window.omp.tabs.list()).find(tab => tab.active));
		const say = async (message: string) => {
			const tab = await active();
			if (!tab) throw new Error("Missing conversation");
			await page.locator("textarea:visible").first().fill(message);
			await page.getByRole("button", { name: "Send", exact: true }).click();
			await untilAnswered(page, tab.tabId, { after: message });
		};
		const panel = page.locator('aside.omp-inspector[data-side="right"]');
		const toggle = page.getByRole("button", { name: "Side panel", exact: true }).first();
		const views = panel.locator("[data-panel-views]");
		const selected = (name: string) =>
			expect(views.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
		const capture = async (name: string) => {
			await expect(panel).toHaveCSS("width", "280px");
			await expect(panel).toHaveAttribute("aria-busy", "false");
			await expect.poll(async () => Math.round((await panel.boundingBox())?.x ?? -1)).toBe(1000);
			await page.evaluate(() => document.fonts.ready.then(() => true));
			const geometry = await panel.evaluate(element => ({
				viewport: [innerWidth, innerHeight],
				dpr: devicePixelRatio,
				bounds: element.getBoundingClientRect().toJSON(),
			}));
			expect(geometry.viewport).toEqual([1280, 860]);
			expect(geometry.dpr).toBe(1);
			const dir = path.join("test-results", "chat-inspector");
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(geometry));
			await page.screenshot({ path: path.join(dir, `${name}.png`), animations: "disabled", scale: "css" });
		};
		await expect.poll(async () => path.normalize((await active())?.cwd ?? "")).toBe(path.normalize(profile.project));
		await say("Show the project status.");
		const project = await active();
		await expect(panel).toHaveCount(0);
		await toggle.click();
		await selected("Explorer");
		await expect(panel.getByRole("radio", { name: "Names" })).toBeChecked();
		await capture("project-open");
		await views.getByRole("button", { name: "Source Control" }).click();
		await page.locator('[data-bot-row="bot-courier"]').click();
		await expect.poll(async () => path.normalize((await active())?.cwd ?? "")).toBe(path.normalize(folder));
		await say("Show the project status.");
		await selected("Home");
		await expect(panel.locator('[data-inspector-bot="bot-courier"]')).toContainText("Courier");
		await capture("bot-open");
		const more = panel.locator("[data-inspector-bot] header").getByRole("button", { name: "More", exact: true });
		await more.click();
		const menu = page.getByRole("menu", { name: "More", exact: true });
		await expect(menu.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
		await menu.getByRole("menuitem", { name: "Pause bot" }).click();
		await expect(panel.locator("[data-inspector-bot] header")).toContainText("Paused");
		await more.click();
		await menu.getByRole("menuitem", { name: "Resume bot" }).click();
		await expect(panel.locator("[data-inspector-bot] header")).not.toContainText("Paused");
		await views.getByRole("button", { name: "Chats", exact: true }).click();
		await panel.locator("[data-panel-close]").click();
		await expect(panel).toHaveCount(0);
		await toggle.click();
		await selected("Chats");
		if (!project?.sessionPath) throw new Error("Project conversation was not saved");
		const projectRow = page.locator(`[data-session-path=${JSON.stringify(project.sessionPath)}]`).first();
		await projectRow.click();
		await selected("Source Control");
		await page.locator('[data-bot-row="bot-courier"]').click();
		await selected("Chats");

		const grip = panel.getByRole("separator", { name: "Resize side panel" });
		await grip.focus();
		await page.keyboard.press("ArrowLeft");
		await expect(panel).toHaveCSS("width", "304px");
		await expect.poll(() => page.evaluate(() => window.omp.prefs.get("gui.panelWidth"))).toBe(304);
		await panel.locator("[data-panel-close]").click();
		await expect(panel).toHaveCount(0);
		await toggle.click();
		await expect(panel).toHaveCSS("width", "304px");
		await projectRow.click();
		const note = path.join(profile.project, "notes.md");
		await fs.writeFile(note, "# Original\n");
		await views.getByRole("button", { name: "Explorer", exact: true }).click();
		await panel.getByRole("button", { name: "Refresh file tree", exact: true }).click();
		await panel.locator('[data-tree-id="file:notes.md"]').click();
		await panel.getByRole("button", { name: "Edit", exact: true }).click();
		const editor = panel.getByRole("textbox", { name: "Contents of notes.md" });
		await editor.press("End");
		await page.keyboard.type("unsaved");
		await expect(panel.locator("[data-editor-status]")).toHaveText("Unsaved");
		await page.locator('[data-bot-row="bot-courier"]').click();
		await expect(editor).toContainText("unsaved");
		await panel.locator("[data-panel-close]").click();
		const guard = page.getByRole("dialog").filter({ hasText: "notes.md" });
		await guard.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(editor).toContainText("unsaved");
		await panel.locator("[data-panel-close]").click();
		await guard.getByRole("button", { name: "Discard", exact: true }).click();
		await expect(editor).toHaveCount(0);
		await expect.poll(async () => path.normalize((await active())?.cwd ?? "")).toBe(path.normalize(folder));
		await projectRow.click();
		await expect.poll(async () => (await active())?.sessionPath).toBe(project.sessionPath);
		await expect(page.getByText("Show the project status.", { exact: true }).first()).toBeVisible();
		expect(await fs.readFile(note, "utf8")).toBe("# Original\n");
	} finally {
		await exitApp(app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
