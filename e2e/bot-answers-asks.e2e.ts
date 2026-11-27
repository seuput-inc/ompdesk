import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { controlToolCaller, exitApp, launchApp, openedSessions, readRecords } from "./harness";

// A session working on a bot's request raises its form to that bot, not the owner (the owner's decision of 27 Nov 2026;
// agentctl/service/route.rs, pool/routes.rs): the bot gets the card in its chat and answers it with
// `ompdesk_session_answer`, or passes it on with `escalate`, and the owner answers it in the bot's chat. The owner gets
// no card in the session's own tab either way. The fake omp raises stock's `form` card for a message carrying
// `fixture:bot-form` and ends its run with the answer's data (e2e/fixture/rpc-ui.ts); tools are called through its
// `fixture:host-tool:` line, as the bot's agent would.

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
let errors: string[];
let chat: string;

test.beforeEach(async () => {
	// A real path: a chat is the bot's only when its folder, read back resolved, is the bot's.
	profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bot-asks-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_HEADLESS: "1", OMP_GUI_TEST_RECORD: record, OMP_GUI_TEST_SESSION_FILES: "1" },
	});
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");

	// The bot Ada and its chat, which joins it once the chat has a session file.
	const folder = path.join(profile, "bots", "ada");
	await page.evaluate(cwd => window.omp.bots.command({ action: "create", name: "Ada", folder: cwd }), folder);
	chat = (await page.evaluate(cwd => window.omp.tabs.spawn({ cwd }), folder))?.tabId ?? "";
	expect(chat).not.toBe("");
	await expect.poll(() => status(chat), { timeout: 60_000 }).toBe("ready");
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "Hello" }), chat);
	await expect
		.poll(
			async () => {
				const state = await page.evaluate(() => window.omp.bots.command({ action: "get" }));
				return state.bots.find(bot => bot.name === "Ada")?.home ?? null;
			},
			{ timeout: 60_000 },
		)
		.not.toBeNull();
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

async function status(tabId: string): Promise<string | undefined> {
	return (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId)?.status;
}

async function botCalls(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
	return (await controlToolCaller(page, record, chat))(name, args);
}

/** The bot hands work to a session whose run raises the form; resolves with the session's tab id. */
async function handOutForm(item?: string): Promise<string> {
	const opened = await botCalls("ompdesk_session_open", {
		folder: path.join(profile, "project"),
		message: "Pick the badge color fixture:bot-form",
		show: "background",
		...(item ? { item, mode: "goal" } : {}),
	});
	expect(opened.isError, opened.text).toBe(false);
	const [worker] = openedSessions(opened.text);
	if (!worker) throw new Error(opened.text);
	return worker;
}

/** The question cards the bot's chat was handed, by their text. */
async function botCards(): Promise<string[]> {
	return (await readRecords(record))
		.filter(frame => frame.type === "agent_control.mail")
		.map(frame => String(frame.content ?? ""))
		.filter(content => content.includes("It came to you, not the owner"));
}

async function lastAnswer(tabId: string): Promise<string> {
	const response = await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "get_last_assistant_text" }),
		tabId,
	);
	return response.success ? ((response.data as { text?: string | null } | undefined)?.text ?? "") : "";
}

/** The owner sees no card for the worker: none open in the window, none in its tab. */
async function ownerSeesNoCard(worker: string): Promise<void> {
	const open = await page.evaluate(() => window.omp.ui.openRequests());
	expect(open.filter(item => item.tabId === worker)).toEqual([]);
	await page.evaluate(id => window.omp.tabs.setActive(id), worker);
	await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
}

test("the bot answers the form a session raised for its request; the owner gets no card", async () => {
	test.setTimeout(180_000);
	const worker = await handOutForm();
	await expect.poll(botCards, { timeout: 60_000 }).toHaveLength(1);
	const [card] = await botCards();
	expect(card).toContain("Which color should the badge be?");
	expect(card).toContain('"Red" | "Blue"');
	await ownerSeesNoCard(worker);

	// Another answer is refused: no request id, and a request id that names nothing.
	const unnamed = await botCalls("ompdesk_session_answer", {
		session: worker,
		answers: [{ id: "field-0", selected: ["Red"] }],
	});
	expect(unnamed.isError).toBe(true);
	expect(unnamed.text).toContain("Name the card");

	const answered = await botCalls("ompdesk_session_answer", {
		session: worker,
		request: "bot-form-1",
		answers: [{ id: "field-0", selected: ["Red"] }],
	});
	expect(answered.isError, answered.text).toBe(false);
	await expect.poll(() => lastAnswer(worker), { timeout: 60_000 }).toBe('Form answered: {"color":"red"}');

	// The same answer again finds the card closed and answers nothing.
	const late = await botCalls("ompdesk_session_answer", {
		session: worker,
		request: "bot-form-1",
		answers: [{ id: "field-0", selected: ["Blue"] }],
	});
	expect(late.isError).toBe(true);
	expect(await lastAnswer(worker)).toBe('Form answered: {"color":"red"}');
	await ownerSeesNoCard(worker);
});

test("the bot passes a form on; the owner answers it in the bot's chat and the session goes on with it", async () => {
	test.setTimeout(180_000);
	const item = await botCalls("ompdesk_item", { action: "add", title: "Pick a badge color" });
	expect(item.isError, item.text).toBe(false);
	const worker = await handOutForm("1");
	await expect.poll(botCards, { timeout: 60_000 }).toHaveLength(1);
	const passed = await botCalls("ompdesk_session_answer", { session: worker, request: "bot-form-1", escalate: true });
	expect(passed.isError, passed.text).toBe(false);
	expect(passed.text).toContain("Passed on to the owner");
	await ownerSeesNoCard(worker);

	// The card is in the bot's chat, with the session's question and options.
	await page.evaluate(id => window.omp.tabs.setActive(id), chat);
	const card = page.locator("[data-prompt-card]").filter({ hasText: "Which color should the badge be?" });
	await expect(card).toBeVisible({ timeout: 30_000 });
	await card.locator('[data-choice="Blue"]').click();
	await card.getByRole("button", { name: "Submit", exact: true }).click();
	await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
	await expect.poll(() => lastAnswer(worker), { timeout: 60_000 }).toBe('Form answered: {"color":"blue"}');

	// The bot hears the owner's answer once, and its own late answer is refused.
	await expect
		.poll(async () =>
			(await readRecords(record)).filter(
				frame => frame.type === "agent_control.mail" && String(frame.content ?? "").includes("The owner answered"),
			),
		)
		.toHaveLength(1);
	const late = await botCalls("ompdesk_session_answer", {
		session: worker,
		request: "bot-form-1",
		answers: [{ id: "field-0", selected: ["Red"] }],
	});
	expect(late.isError).toBe(true);
	expect(await lastAnswer(worker)).toBe('Form answered: {"color":"blue"}');
});
