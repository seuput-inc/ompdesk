import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import type { Bot } from "../src/shared/bots";
import { exitApp, launchApp } from "./harness";

// A new bot speaks first (Orca's bot-preamble.ts:94-102, bots-create.ts:62-70; the core's bot_first_run.rs): made with
// a purpose, so its SOUL.md exists from the start, it still runs its first run. Once its home chat is open, OMPdesk
// sends the kickoff and the bot answers with a greeting and one question before the owner typed anything; the owner's
// first task gets one small piece of work shown before SOUL.md is written; that turn's end ends the first run. The fake
// omp answers as a first-run home chat only while its bot context says `firstRun` (e2e/fixture/rpc-ui.ts), so the
// flag's way from the core to the chat and back is what this checks; the rules' text is pinned by bridge-bots.test.ts.

let app: ElectronApplication;
let page: Page;
let profile: string;
let errors: string[];

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bot-first-run-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_HEADLESS: "1" } });
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

async function scout(): Promise<Bot> {
	const state = await page.evaluate(() => window.omp.bots.command({ action: "get" }));
	const bot = state.bots.find(known => known.name === "Scout");
	if (!bot) throw new Error("the bot Scout is gone");
	return bot;
}

async function lastAnswer(tabId: string): Promise<string> {
	const response = await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "get_last_assistant_text" }),
		tabId,
	);
	return (response.data as { text?: string | null } | undefined)?.text ?? "";
}

test("a bot made with a purpose greets and asks first, then shows one piece of its first task before SOUL.md", async () => {
	test.setTimeout(150_000);
	const folder = path.join(profile, "bots", "scout");
	await page.evaluate(
		cwd =>
			window.omp.bots.command({ action: "create", name: "Scout", folder: cwd, purpose: "Keeps the README honest." }),
		folder,
	);
	const soul = path.join(folder, "SOUL.md");
	expect(await fs.readFile(soul, "utf8")).toContain("Keeps the README honest.");
	expect((await scout()).firstRun).toBe(true);

	// Its home chat opens, as New bot opens it; the owner types nothing.
	const tabId = (await page.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), folder))?.tabId ?? "";
	expect(tabId).not.toBe("");
	await expect.poll(() => lastAnswer(tabId), { timeout: 60_000 }).toBe("Hi! What should I start on?");
	const greeted = await scout();
	expect(greeted.kickoffs).toHaveLength(1);
	expect(greeted.firstRun).toBe(true);
	expect(await fs.readFile(soul, "utf8")).not.toContain("## How I work");

	// The owner's first task: one small piece shown, SOUL.md written after it, and the first run is over.
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "Check the README" }), tabId);
	await expect
		.poll(() => lastAnswer(tabId), { timeout: 60_000 })
		.toContain('One small piece of "Check the README", done');
	expect(await fs.readFile(soul, "utf8")).toContain("## How I work");
	await expect.poll(async () => (await scout()).firstRun, { timeout: 60_000 }).toBe(false);

	// Its next task is plain work: the chat was told the first run ended, and no kickoff went again.
	await expect
		.poll(
			async () => {
				await page.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "And the CHANGELOG" }),
					tabId,
				);
				return lastAnswer(tabId);
			},
			{ timeout: 60_000 },
		)
		.toBe("Local fixture reply");
	expect((await scout()).kickoffs).toHaveLength(1);
});
