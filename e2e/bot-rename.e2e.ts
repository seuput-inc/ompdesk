import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp } from "./harness";

// A bot's rename reaches more than its prompt (the owner's report, Nov 2026: the folder stayed under the old name, its
// routines kept the old title). Renamed in the bot's page header, the bot's folder in ~/.omp/bots follows the new
// name's slug with no question, its files go along, its routine takes the new title and runs in the new folder, and
// the page and the sidebar show the new name (`native/ompdesk/crates/core/src/agentctl/service/work/bot_move.rs`).

let app: ElectronApplication;
let page: Page;
let profile: string;
let errors: string[];

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bot-rename-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		// The fake omp keeps stock session files, so the chat below is the bot's home chat with a file to move.
		env: {
			HOME: profile,
			USERPROFILE: profile,
			PI_CONFIG_DIR: ".",
			OMP_GUI_HEADLESS: "1",
			OMP_GUI_TEST_SESSION_FILES: "1",
		},
	});
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

const exists = (dir: string) =>
	fs.stat(dir).then(
		() => true,
		() => false,
	);

test("a renamed bot's folder, files, routine and open chat follow its new name with no question", async () => {
	const folder = await page.evaluate(async () => {
		const state = await window.omp.bots.command({ action: "create", name: "Rex", purpose: "Reviews pull requests." });
		return state.bots.find(bot => bot.name === "Rex")?.folder ?? "";
	});
	expect(path.basename(folder)).toBe("rex");
	await fs.writeFile(path.join(folder, "notes.md"), "kept");
	const saved = await page.evaluate(
		cwd =>
			window.omp.schedules.command({
				action: "save",
				draft: {
					name: "Rex: nightly",
					prompt: "Look at the open pull requests.",
					cwd,
					frequency: { kind: "interval", minutes: 60 },
					model: null,
					autoApprove: false,
					enabled: false,
				},
			}),
		folder,
	);
	const routineId = saved.schedules.find(row => row.name === "Rex: nightly")?.id;
	expect(routineId).toBeTruthy();
	// Its home chat is open and idle in its folder: the rename stops its omp, moves its session and starts it again there.
	const chat = (await page.evaluate(cwd => window.omp.tabs.spawn({ cwd }), folder))?.tabId ?? "";
	expect(chat).not.toBe("");
	const tabOf = () => page.evaluate(async id => (await window.omp.tabs.list()).find(tab => tab.tabId === id), chat);
	const ask = (message: string) =>
		page.evaluate(([id, text]) => window.omp.rpc.commandForTab(id, { type: "prompt", message: text }), [
			chat,
			message,
		] as const);
	const field = (data: unknown, key: string): unknown =>
		data && typeof data === "object" && key in data ? Reflect.get(data, key) : undefined;
	const lastAnswer = async () => {
		const reply = await page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "get_last_assistant_text" }),
			chat,
		);
		return field(reply.data, "text");
	};
	await expect.poll(async () => (await tabOf())?.status).toBe("ready");
	await ask("Who are you?");
	await expect
		.poll(() => page.evaluate(async () => (await window.omp.bots.command({ action: "get" })).bots[0]?.home ?? null))
		.not.toBeNull();
	await expect.poll(async () => (await tabOf())?.status).toBe("ready");

	await page.locator('[data-sidebar-nav-row="bots"]:visible').first().click();
	if ((await page.locator("[data-bot-pane]:visible").count()) === 0)
		await page.locator("[data-bots-page-row]:visible").first().click();
	await page.getByRole("button", { name: "Rename Rex" }).click();
	const input = page.getByRole("textbox", { name: "Rename Rex" });
	await input.fill("Ruby");
	await input.press("Enter");

	const moved = path.join(path.dirname(folder), "ruby");
	await expect
		.poll(() => page.evaluate(async () => (await window.omp.bots.command({ action: "get" })).bots[0]?.folder))
		.toBe(moved);
	expect(await exists(folder)).toBe(false);
	expect(await fs.readFile(path.join(moved, "notes.md"), "utf8")).toBe("kept");
	await expect
		.poll(() =>
			page.evaluate(
				async id => (await window.omp.schedules.command({ action: "get" })).schedules.find(row => row.id === id),
				routineId,
			),
		)
		.toMatchObject({ name: "Ruby: nightly", cwd: moved });
	await expect(page.locator("[data-bot-pane-header]")).toContainText("Ruby");
	await expect(page.locator("[data-sidebar-bots]")).toContainText("Ruby");

	// The open chat runs in the new folder, its session says so, and it still answers.
	await expect.poll(async () => (await tabOf())?.cwd).toBe(moved);
	await expect.poll(async () => (await tabOf())?.status).toBe("ready");
	const state = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), chat);
	expect(state).toMatchObject({ success: true });
	const sessionFile = String(field(state.data, "sessionFile") ?? "");
	const header: unknown = JSON.parse((await fs.readFile(sessionFile, "utf8")).split("\n")[1] ?? "{}");
	expect(field(header, "cwd")).toBe(moved);
	const history = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_branch_messages" }), chat);
	expect(field(history.data, "messages")).toEqual(
		expect.arrayContaining([expect.objectContaining({ text: "Who are you?" })]),
	);
	await ask("Still there? fixture:result-ok");
	await expect.poll(lastAnswer).toContain("Result: ok");
	await expect.poll(async () => (await tabOf())?.status).toBe("ready");
});
