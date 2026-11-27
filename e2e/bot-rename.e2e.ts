import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { BOTS_FOLDER } from "../src/shared/bots";
import { exitApp, launchApp } from "./harness";

// A bot's rename reaches more than its prompt (the owner's report, Nov 2026: the folder stayed under the old name, its
// routines kept the old title). Renamed in the bot's page header, the bot's folder in ~/.omp/bots follows the new
// name's slug with no question, its files go along, its routine takes the new title and runs in the new folder, and
// the page and the sidebar show the new name (`native/ompdesk/crates/core/src/agentctl/service/work/bot_move.rs`).

let app: ElectronApplication;
let page: Page;
let profile: string;
let errors: string[];
let folder: string;
let missing: string;

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bot-rename-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	folder = path.join(profile, BOTS_FOLDER, "rex");
	await fs.mkdir(folder, { recursive: true });
	missing = path.join(agent, "sessions", "fixture", "2026-11-01_missing-chat.jsonl");
	await fs.writeFile(
		path.join(desktop, "bots.json"),
		JSON.stringify([{ id: "bot-rex", name: "Rex", folder, sessions: [missing] }]),
	);
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
			OMP_GUI_TEST_AGENT_SWEEP_MS: "500",
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
	test.setTimeout(120_000);
	const getBot = () => page.evaluate(async () => (await window.omp.bots.command({ action: "get" })).bots[0]);
	const original = path.join(profile, "original.png");
	const picture = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
		"base64",
	);
	const digest = async (file: string) =>
		createHash("sha256")
			.update(await fs.readFile(file))
			.digest("hex");
	await fs.writeFile(original, picture);
	await fs.copyFile(original, path.join(folder, "picture.png"));
	const before = await digest(original);
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
	const beforeState = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), chat);
	const originalId = field(beforeState.data, "sessionId");
	expect(originalId).toBeTruthy();
	const oldFile = String(field(beforeState.data, "sessionFile"));
	await expect.poll(async () => (await getBot()).home).toBe(oldFile);
	const [slot] = (await fs.readFile(oldFile, "utf8")).split("\n");
	expect(Buffer.byteLength(`${slot}\n`)).toBe(256);
	const childFolder = path.join(folder, "nested");
	await fs.mkdir(childFolder);
	const child = (await page.evaluate(cwd => window.omp.tabs.spawn({ cwd }), childFolder))?.tabId ?? "";
	const childTab = () =>
		page.evaluate(async id => (await window.omp.tabs.list()).find(tab => tab.tabId === id), child);
	await expect.poll(async () => (await childTab())?.status).toBe("ready");
	await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture stream parts" }),
		child,
	);
	await expect.poll(async () => (await childTab())?.status).toBe("running");

	await page.locator("[data-sidebar-bots-open]:visible").first().click();
	if ((await page.locator("[data-bot-pane]:visible").count()) === 0)
		await page.locator("[data-bots-page-row]:visible").first().click();
	await page.getByRole("button", { name: "Rename Rex" }).click();
	const input = page.getByRole("textbox", { name: "Rename Rex" });
	await input.fill("Ruby");
	await input.press("Enter");

	const moved = path.join(path.dirname(folder), "ruby");
	await expect.poll(getBot).toMatchObject({ name: "Ruby", folder });
	expect(await childTab()).toMatchObject({ status: "running", cwd: childFolder });
	expect(await exists(moved)).toBe(false);
	await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:finish:parts" }),
		child,
	);
	await expect.poll(async () => (await childTab())?.status).toBe("ready");
	expect(await page.evaluate(id => window.omp.tabs.close(id), child)).toBe(true);
	await expect
		.poll(() => page.evaluate(async () => (await window.omp.bots.command({ action: "get" })).bots[0]?.folder))
		.toBe(moved);
	expect(await exists(folder)).toBe(false);
	expect(await fs.readFile(path.join(moved, "notes.md"), "utf8")).toBe("kept");
	// The home journal moved, but the index cannot find the second journal on either side.
	await expect.poll(() => exists(oldFile), { timeout: 30_000 }).toBe(false);
	expect(await getBot()).toMatchObject({ home: oldFile, sessions: expect.arrayContaining([missing]) });
	const routine = () =>
		page.evaluate(
			async id => (await window.omp.schedules.command({ action: "get" })).schedules.find(r => r.id === id),
			routineId,
		);
	expect(await routine()).toMatchObject({ cwd: folder });
	const timestamp = "2026-11-01T00:00:00Z";
	await fs.writeFile(
		missing,
		[
			{ type: "session", version: 3, id: "missing-chat", timestamp, cwd: folder },
			{
				type: "message",
				id: "first",
				parentId: null,
				timestamp,
				message: { role: "user", content: "Second chat", timestamp: Date.parse(timestamp) },
			},
		]
			.map(entry => `${JSON.stringify(entry)}\n`)
			.join(""),
	);
	await expect.poll(routine, { timeout: 30_000 }).toMatchObject({ name: "Ruby: nightly", cwd: moved });
	await expect.poll(async () => (await getBot()).sessions).not.toContain(missing);
	const savedBot = await getBot();
	const second = savedBot.sessions.find(file => path.basename(file) === path.basename(missing));
	expect(second).toBeTruthy();
	expect(second).not.toBe(missing);
	expect(await fs.readFile(String(second), "utf8")).toContain("Second chat");
	expect(await digest(original)).toBe(before);
	expect(await digest(path.join(moved, "picture.png"))).toBe(before);
	await expect(page.locator("[data-bot-pane-header]")).toContainText("Ruby");
	await expect(page.locator("[data-sidebar-bots]")).toContainText("Ruby");

	// The open chat runs in the new folder, its session says so, and it still answers.
	await expect.poll(async () => (await tabOf())?.cwd).toBe(moved);
	await expect.poll(async () => (await tabOf())?.status).toBe("ready");
	const state = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), chat);
	expect(state).toMatchObject({ success: true });
	const sessionFile = String(field(state.data, "sessionFile") ?? "");
	expect(field(state.data, "sessionId")).toBe(originalId);
	expect(savedBot.home).toBe(sessionFile);
	const header: unknown = JSON.parse((await fs.readFile(sessionFile, "utf8")).split("\n")[1] ?? "{}");
	expect(field(header, "cwd")).toBe(moved);
	const history = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_branch_messages" }), chat);
	expect(field(history.data, "messages")).toEqual(
		expect.arrayContaining([expect.objectContaining({ text: "Who are you?" })]),
	);
	await ask("Still there? fixture:result-ok");
	await expect.poll(lastAnswer).toContain("Result: ok");
	await expect.poll(async () => (await tabOf())?.status).toBe("ready");
	console.info("bot rename verified", {
		originalId,
		resumedId: field(state.data, "sessionId"),
		sourceSha256: before,
		afterSha256: await digest(original),
		recoveredSecond: path.basename(String(second)),
	});
});
