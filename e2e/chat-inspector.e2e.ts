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
		await views.getByRole("button", { name: "Chats", exact: true }).click();
		await panel.locator("[data-panel-close]").click();
		await expect(panel).toHaveCount(0);
		await toggle.click();
		await selected("Chats");
		if (!project?.sessionPath) throw new Error("Project conversation was not saved");
		await page
			.locator(`[data-session-path=${JSON.stringify(project.sessionPath)}]`)
			.first()
			.click();
		await selected("Source Control");
		await page.locator('[data-bot-row="bot-courier"]').click();
		await selected("Chats");
	} finally {
		await exitApp(app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
