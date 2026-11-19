/**
 * The two-line session row (the owner's approved design, 15 Nov 2026; panels-sidebar.md › Session targets) on the dev
 * harness (`vite.harness.config.ts`), whose `sessions.targets` / `sessions.artwork` answer every kind of row
 * (`dev-harness/fixture-targets.ts`): a repository with a picture on `main`, the same one on a long agent branch, a
 * repository without a picture (its letter mark) on a detached HEAD, an unborn branch and a folder in no repository;
 * the paired host's section (`host-1`) shows the same rows from the host, one of them with three subagents at work.
 * Checked on a desktop window, a narrow (220 px) sidebar and a phone: every session row is two lines and leads with
 * its picture, the long branch ends in an ellipsis with its whole name as its title, the ⋯ sits on the second line,
 * and the work board names the focused session's branch. `OMP_GUI_SESSION_ROWS_SHOTS=<dir>` also writes captures.
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Locator, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { cssString } from "./harness";

const SHOTS = process.env.OMP_GUI_SESSION_ROWS_SHOTS;
const PROJECT = "/Users/dev/projects/ompdesk";
const WEBSITE = "/Users/dev/projects/website";
const sessionFile = (cwd: string, id: string) => `${cwd.replace(/\//g, "-")}/${id}.jsonl`;
const HOST = "host-1";
const LONG_BRANCH = "omp/agent/settings-dark-mode-follows-the-system-theme-20261119";

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser | undefined;

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createNetServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		const port = typeof address === "object" && address ? address.port : 0;
		probe.close(() => resolve(port));
	});
	return promise;
}

test.beforeAll(async () => {
	const port = await freePort();
	server = await createServer({
		configFile: path.resolve("vite.harness.config.ts"),
		server: { host: "127.0.0.1", port, strictPort: true },
		logLevel: "error",
	});
	await server.listen();
	origin = `http://127.0.0.1:${port}`;
	browser = await chromium.launch();
});

test.afterAll(async () => {
	await browser?.close();
	await server?.close();
});

interface Surface {
	name: "desktop" | "narrow" | "phone";
	context: Parameters<Browser["newContext"]>[0];
	sidebarWidth?: number;
}

const SURFACES: readonly Surface[] = [
	{ name: "desktop", context: { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 } },
	{ name: "narrow", context: { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 }, sidebarWidth: 220 },
	{
		name: "phone",
		context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
	},
];

const sidebar = (page: Page) => page.locator(".omp-session-sidebar").first();
const rowFor = (scope: Locator, file: string) =>
	scope
		.locator(
			`.omp-sidebar-session-row[data-session-path=${cssString(file)}], .omp-sidebar-session-row[data-device-session=${cssString(file)}]`,
		)
		.first();

async function openHarness(surface: Surface, theme: "light" | "dark", lang: "en" | "ko"): Promise<Page> {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext(surface.context);
	if (surface.sidebarWidth)
		await context.addInitScript(
			width => localStorage.setItem("omp.sidebarWidth", String(width)),
			surface.sidebarWidth,
		);
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}&rows=6`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.waitForFunction(() => window.__harness?.summaries !== undefined, undefined, { timeout: 45_000 });
	// The paired host runs its ompdesk session with three subagents at work: that row's family chip counts them. A second
	// session written a moment ago works there too, with one subagent: its age reads "just now", the widest the working
	// arc's slot holds, beside a chip (a 248 px sidebar once left its branch nothing but its mark).
	await page.evaluate(
		({ host, file, live, project }) => {
			const harness = window.__harness;
			if (!harness) throw new Error("no harness");
			const agent = (index: number) => ({
				id: `agent-${index}`,
				index,
				agent: "task",
				status: "running",
				title: `Child task ${index}`,
				startedAt: Date.now() - index * 60_000,
			});
			const now = new Date().toISOString();
			harness.sessions.unshift({
				path: live,
				id: "sess-live",
				title: "Ship the release",
				cwd: project,
				created: now,
				modified: now,
				messageCount: 2,
				size: 4096,
				status: "complete",
				firstMessage: "Ship the release",
			});
			const working = (sessionPath: string, tabId: string, agents: number) => ({
				sessionPath,
				tabId,
				cwd: project,
				kind: "agent" as const,
				status: "running" as const,
				agents: Array.from({ length: agents }, (_, index) => agent(index + 1)),
			});
			harness.summaries.host(host, [working(file, "tab-host", 3), working(live, "tab-host-live", 1)]);
			harness.emit("sessions:changed", {});
			harness.emit("sessions:changed", { device: host });
		},
		{ host: HOST, file: sessionFile(PROJECT, "sess-1"), live: sessionFile(PROJECT, "sess-live"), project: PROJECT },
	);
	if (surface.name === "phone") {
		await page.getByRole("button", { name: /Open menu|메뉴 열기/ }).click();
		await expect(page.locator("[data-drawer] .omp-session-sidebar")).toBeVisible();
	}
	return page;
}

async function checkRows(page: Page, surface: Surface): Promise<void> {
	const list = sidebar(page);
	// The host's just-written session at work beside its chip: its branch keeps its letters.
	const live = list
		.locator(`[data-sidebar-device="${HOST}"]`)
		.locator(`.omp-sidebar-session-row[data-device-session=${cssString(sessionFile(PROJECT, "sess-live"))}]`);
	await expect(live.locator("[data-family-running]")).toBeVisible();
	await expect(live.locator('[data-session-head="branch"]')).toHaveText("release");
	const local = rowFor(list, sessionFile(PROJECT, "sess-1"));
	// The repository's own picture once `sessions.artwork` answered; the website has none: its letter.
	await expect(local.locator('[data-project-artwork="image"] img')).toBeVisible();
	const website = rowFor(list, sessionFile(WEBSITE, "sess-3"));
	await expect(website.locator('[data-project-artwork="letter"]')).toHaveText("W");
	await expect(website.locator('[data-session-head="detached"]')).toContainText("9f3c2a1");
	await expect(local.locator('[data-session-head="branch"]')).toHaveText("main");
	// The long branch gives way to an ellipsis; its whole name is its title.
	const long = rowFor(list, sessionFile(PROJECT, "sess-2")).locator('[data-session-head="branch"]');
	await expect(long).toHaveAttribute("title", new RegExp(LONG_BRANCH));
	const cut = await long.locator(".truncate").evaluate(text => text.scrollWidth > text.clientWidth);
	expect(cut).toBe(true);
	// No branch shrinks to its mark alone or reaches past its line (the line clips: a branch cut there loses its
	// ellipsis, or all of it): beside a family chip, in a 220 px sidebar and on a phone it keeps letters in view.
	const heads = await list.locator("[data-session-head]:visible").evaluateAll(nodes =>
		nodes.map(node => {
			const text = node.querySelector(".truncate")?.getBoundingClientRect();
			const line = node.parentElement?.getBoundingClientRect();
			return {
				name: node.getAttribute("title") ?? "",
				letters: text ? Math.min(text.right, line?.right ?? text.right) - text.left : 0,
				past: text && line ? text.right - line.right : 0,
			};
		}),
	);
	expect(heads.length).toBeGreaterThan(2);
	for (const head of heads) {
		expect(head.letters, head.name).toBeGreaterThanOrEqual(16);
		expect(head.past, head.name).toBeLessThanOrEqual(0.5);
	}

	// Every session row: two lines, the picture first, the ⋯ under the title's line, nothing past the row's edge.
	const rows = list.locator(".omp-sidebar-session-row:visible");
	const count = await rows.count();
	expect(count).toBeGreaterThan(4);
	for (let index = 0; index < count; index++) {
		const row = rows.nth(index);
		const box = await row.boundingBox();
		if (!box) continue;
		expect(box.height, `row ${index} height`).toBeGreaterThanOrEqual(44);
		expect(box.height, `row ${index} height`).toBeLessThanOrEqual(surface.name === "desktop" ? 52 : 58);
		await expect(row.locator("[data-project-artwork]")).toHaveCount(1);
		const title = await row.locator("button[data-roving-item]").first().boundingBox();
		const more = await row.locator("[data-sidebar-row-menu]").boundingBox();
		if (title && more) expect(more.y + more.height / 2).toBeGreaterThan(title.y + title.height);
		const overflow = await row.evaluate(element => element.scrollWidth - element.clientWidth);
		expect(overflow, `row ${index} overflow`).toBeLessThanOrEqual(1);
		// The state (age, arc, badge) and the branch never draw over each other.
		const gap = await row.evaluate(element => {
			const state = element.querySelector("[data-sidebar-row-end]")?.getBoundingClientRect();
			const head = element.querySelector("[data-session-head]")?.getBoundingClientRect();
			return state && head ? head.left - state.right : null;
		});
		if (gap !== null) expect(gap, `row ${index} state over branch`).toBeGreaterThanOrEqual(0);
	}
}

for (const surface of SURFACES)
	for (const [theme, lang] of [
		["light", "en"],
		["dark", "ko"],
	] as const)
		test(`session rows ${surface.name} ${theme} ${lang}`, async () => {
			test.setTimeout(120_000);
			const page = await openHarness(surface, theme, lang);
			await checkRows(page, surface);

			// The paired computer's section: the host's rows, its subagents counted on the row's chip.
			const host = sidebar(page).locator(`[data-sidebar-device="${HOST}"]`);
			await host.scrollIntoViewIfNeeded();
			const hostRow = rowFor(host, sessionFile(PROJECT, "sess-1"));
			if (!(await hostRow.isVisible())) await host.locator("button[aria-expanded]").first().click();
			await expect(hostRow.locator("[data-family-running]")).toHaveText(/3/);
			await expect(hostRow.locator('[data-session-head="branch"]')).toHaveText("main");

			if (SHOTS) {
				await fs.mkdir(SHOTS, { recursive: true });
				const file = (view: string) => path.join(SHOTS, `${surface.name}-${view}-${theme}-${lang}.png`);
				await sidebar(page).evaluate(element => element.querySelector(".omp-sidebar-list")?.scrollTo(0, 0));
				await page.screenshot({ path: file("sidebar") });
				await host.scrollIntoViewIfNeeded();
				await page.screenshot({ path: file("paired") });
			}

			if (surface.name === "desktop") {
				// The work board names the focused session's branch from the same target. It docks only with room
				// beside the transcript column.
				await page.setViewportSize({ width: 1720, height: 860 });
				const branch = page.locator('[data-board-session="branch"]');
				await expect(branch).toContainText("main");
				if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `desktop-board-${theme}-${lang}.png`) });
			}
			await page.context().close();
		});
