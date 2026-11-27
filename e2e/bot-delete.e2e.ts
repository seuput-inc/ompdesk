import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Page, test } from "@playwright/test";
import { initRepo } from "../src/main/local/git/test-repos";
import { BOTS_FOLDER } from "../src/shared/bots";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { capture, controlToolCaller, cssString, exitApp, openedSessions, untilAnswered, variants } from "./harness";
import { launchRemote, makeRemoteProfile, REMOTE_LOGIN, type RemoteInstance } from "./remote-harness";

// The dialog tests cover empty counts. This flow uses the real host, session list, routines and bot registry.
const bot = { id: "courier", name: "Courier" };
const byFile = (file: string) => `[data-session-path=${cssString(file)}]`;
const tabs = (page: Page) => page.evaluate(() => window.omp.tabs.list());
const stored = (page: Page) =>
	page.evaluate(async () => (await window.omp.sessions.list("global")).map(row => row.path));
const prompt = (page: Page, id: string, message: string) =>
	page.evaluate(([tab, text]) => window.omp.rpc.commandForTab(tab, { type: "prompt", message: text }), [id, message]);

async function journal(page: Page, id: string) {
	const file = () => tabs(page).then(rows => rows.find(row => row.tabId === id)?.sessionPath);
	await expect.poll(file).toBeTruthy();
	const result = await file();
	if (!result) throw new Error(`Tab ${id} has no journal`);
	return result;
}

async function chat(page: Page, folder: string, message: string) {
	const tab = await page.evaluate(cwd => window.omp.tabs.spawn({ cwd }), folder);
	if (!tab?.tabId) throw new Error(`No chat opened in ${folder}`);
	await expect.poll(async () => (await tabs(page)).find(row => row.tabId === tab.tabId)?.status).toBe("ready");
	await prompt(page, tab.tabId, message);
	await untilAnswered(page, tab.tabId, { after: message });
	return { id: tab.tabId, file: await journal(page, tab.tabId) };
}

async function showSidebar(page: Page) {
	if (
		(await page.locator("html").getAttribute("data-shell")) === "phone" &&
		!(await page.locator("[data-drawer]").isVisible())
	)
		await page.locator("button:visible:has(svg.lucide-menu)").first().click();
	await expect(page.locator('[data-sidebar-nav-row="board"]:visible').first()).toBeVisible();
}

const looks = (["en", "ko"] as const).flatMap(language =>
	(["desktop", "phone-390"] as const).map(view => ({ language, view })),
);
for (const { language, view } of variants(looks)) {
	const tag = language === "en" && view === "desktop" ? ["@smoke"] : [];
	test(`deleting a bot keeps only the handed session (${view}, ${language})`, { tag }, async () => {
		test.setTimeout(180_000);
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-delete-")));
		let host: RemoteInstance | undefined;
		let browser: Browser | undefined;
		let proxy: ServeProxy | undefined;
		try {
			const profile = await makeRemoteProfile(root, "host", {
				language,
				theme: "light",
				env: { HOME: root, USERPROFILE: root, PI_CONFIG_DIR: "." },
			});
			const folder = path.join(root, BOTS_FOLDER, "courier");
			await Promise.all([initRepo(folder), initRepo(profile.project)]);
			await fs.writeFile(path.join(profile.desktop, "bots.json"), JSON.stringify([{ ...bot, folder }]));
			const soul = path.join(folder, "SOUL.md");
			const memory = path.join(folder, "MEMORY.md");
			await fs.writeFile(soul, "# Courier\n\nDeliver the release notes.\n");
			await fs.writeFile(memory, "Keep the original release date.\n");
			host = await launchRemote(profile);
			const desk = host.page;
			const human = (await tabs(desk)).find(tab => tab.active);
			if (!human) throw new Error("No project tab");
			const note = "My original release notes";
			await prompt(desk, human.tabId, note);
			await untilAnswered(desk, human.tabId, { after: note });
			const kept = await journal(desk, human.tabId);
			const home = await chat(desk, folder, "Courier dispatch desk");
			await expect
				.poll(() =>
					desk.evaluate(
						async id => (await window.omp.bots.command({ action: "get" })).bots.find(b => b.id === id)?.home,
						bot.id,
					),
				)
				.toBe(home.file);
			const second = await chat(desk, folder, "Courier release checklist");
			const call = await controlToolCaller(desk, profile.record, home.id);
			const result = await call("ompdesk_session_open", {
				folder: profile.project,
				message: "Review the release",
				show: "background",
			});
			expect(result.isError, result.text).toBe(false);
			const [child] = openedSessions(result.text);
			if (!child) throw new Error(result.text);
			await untilAnswered(desk, child, { after: "Review the release" });
			const worker = await journal(desk, child);
			const removed = [home.file, second.file, worker];
			expect(new Set([...removed, kept]).size).toBe(4);
			await desk.evaluate(
				([id, session]) => window.omp.bots.command({ action: "handTo", id, session, text: "Check my notes" }),
				[bot.id, human.tabId],
			);
			const { schedules } = await desk.evaluate(
				([cwd, wakeSession]) =>
					window.omp.schedules.command({
						action: "save",
						draft: {
							cwd,
							wakeSession,
							name: "Courier reminders",
							prompt: "Check the dispatch desk",
							frequency: { kind: "interval", minutes: 60 },
							enabled: false,
							model: null,
							autoApprove: false,
						},
					}),
				[folder, home.file],
			);
			const routine = schedules.find(s => s.name === "Courier reminders");
			if (!routine) throw new Error("No bot routine saved");
			await prompt(desk, second.id, "fixture running");
			await expect.poll(async () => (await tabs(desk)).find(row => row.tabId === second.id)?.status).toBe("running");
			await expect.poll(() => stored(desk)).toEqual(expect.arrayContaining([...removed, kept]));

			let page = desk;
			if (view === "phone-390") {
				await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
				await expect
					.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), {
						timeout: 60_000,
					})
					.toBe("ready");
				await expect.poll(() => serveSites(profile.tailscale).length).toBeGreaterThan(0);
				const site = serveSites(profile.tailscale).at(-1);
				if (!site) throw new Error("No phone site published");
				proxy = await ServeProxy.start(site, REMOTE_LOGIN, undefined, { plainCookie: true });
				browser = await chromium.launch();
				page = await browser.newPage({
					...devices["Pixel 8"],
					viewport: { width: 390, height: 844 },
					screen: { width: 390, height: 844 },
					locale: language,
					colorScheme: "light",
				});
				await page.goto(proxy.url);
				await phonePaired(page);
				await expect(page.locator("html")).toHaveAttribute("data-shell", "phone");
			}
			await showSidebar(page);
			const fold = page.locator(`[data-bot-fold="${bot.id}"]:visible`).first();
			if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
			const group = page.locator(`[data-bot-chats="${bot.id}"]:visible`).first();
			for (const file of [...removed, kept]) await expect(group.locator(byFile(file)).first()).toBeVisible();
			const entry = `[data-bot-row="${bot.id}"]`;
			await page.locator(`${entry}:visible`).first().click({ button: "right" });
			const label = language === "en" ? "Delete bot" : "봇 삭제";
			await page.getByRole("menuitem", { name: `${label}…`, exact: true }).click();
			const name = language === "en" ? "Delete Courier?" : "Courier 봇을 삭제할까요?";
			const dialog = page.getByRole("dialog", { name });
			for (const [kind, count] of Object.entries({ chats: 2, workers: 1, kept: 1 }))
				await expect(dialog.locator(`[data-bot-delete-count="${kind}"]`)).toHaveText(
					new RegExp(`\\b${count}(?!\\d)`),
				);
			await expect(dialog).toContainText(folder);
			await expect(dialog).toContainText(language === "en" ? "permanent" : "영구");
			expect((await tabs(desk)).find(tab => tab.tabId === second.id)?.status).toBe("running");
			await capture(page, `${view}-${language}-before`);
			await dialog.getByRole("button", { name: label, exact: true }).click();
			await expect(dialog).toHaveCount(0);

			const afterDelete = async (p: Page) => {
				await showSidebar(p);
				await expect(p.locator(entry)).toHaveCount(0);
				const toggle = p
					.locator(`[data-workspace-group=${cssString(profile.project)}]:visible button[aria-expanded]`)
					.first();
				if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
				const ordinary = p
					.locator(`[data-session-group=${cssString(profile.project)}] ${byFile(kept)}:visible`)
					.first();
				await expect(ordinary).toBeVisible();
				await ordinary.scrollIntoViewIfNeeded();
				for (const file of removed) await expect(p.locator(`.omp-session-sidebar ${byFile(file)}`)).toHaveCount(0);
			};
			const checkHost = async (p: Page) => {
				const listed = await stored(p);
				expect(listed).toContain(kept);
				const open = await tabs(p);
				for (const t of open) {
					if (p === desk) expect([home.id, second.id, child]).not.toContain(t.tabId);
					expect(removed).not.toContain(t.sessionPath);
				}
				for (const file of removed) {
					expect(listed).not.toContain(file);
					await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
				}
				expect(await fs.readFile(kept, "utf8")).toContain(note);
				expect(await fs.readFile(soul, "utf8")).toBe("# Courier\n\nDeliver the release notes.\n");
				expect(await fs.readFile(memory, "utf8")).toBe("Keep the original release date.\n");
				const ids = await p.evaluate(async () =>
					(await window.omp.schedules.command({ action: "get" })).schedules.map(s => s.id),
				);
				expect(ids).not.toContain(routine.id);
				await showSidebar(p);
				await p.locator('[data-sidebar-nav-row="board"]:visible').first().click();
				const board = p.locator("[data-board-lanes]");
				await expect(board.locator(byFile(kept))).toBeVisible();
				for (const file of removed) await expect(board.locator(byFile(file))).toHaveCount(0);
			};
			await afterDelete(page);
			await capture(page, `${view}-${language}-after`);
			await checkHost(desk);
			await browser?.close();
			browser = undefined;
			await proxy?.close();
			proxy = undefined;
			await exitApp(host.app);
			host = undefined;
			host = await launchRemote(profile, { project: false, ready: false });
			await afterDelete(host.page);
			await checkHost(host.page);
		} finally {
			await browser?.close();
			await proxy?.close();
			if (host) await exitApp(host.app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});
}
