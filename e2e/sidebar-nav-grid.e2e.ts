/**
 * The sidebar's nav rows (Agents, Schedules, Stats, Phone; settings-layout-look.md › Nav rows) sit two to a row at
 * every width (the owner's request, 26 Nov 2026, restated 27 Nov 2026), on the dev harness (`vite.harness.config.ts`):
 * at the default 280 px sidebar and at 260 px every label reads whole in English and Korean, at the 220 px minimum a
 * cut label keeps its icon and is named whole in its tooltip, an odd count leaves its last cell at a column's width,
 * and a phone's drawer keeps 44 px cells.
 * `OMP_GUI_SIDEBAR_NAV_SHOTS=<dir>` also writes captures.
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { SIDEBAR_WIDTH } from "../src/shared/boot-shell-geometry";
import { reassertTouch } from "./fixture/touch-emulation";
import { animationsDone } from "./harness";

/** The narrowest sidebar whose labels all read whole in both languages. */
const GRID_MIN_SIDEBAR_WIDTH = 260;
/** The narrowest docked sidebar (boot-shell-geometry.json). */
const SIDEBAR_MIN_WIDTH = SIDEBAR_WIDTH.min;

const SHOTS = process.env.OMP_GUI_SIDEBAR_NAV_SHOTS;

// A cold Vite dev server can reload once while it optimizes dependencies; a second try is that, not a flake.
test.describe.configure({ retries: 1 });

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

async function openHarness(lang: "en" | "ko", options: { sidebarWidth?: number; phone?: boolean }): Promise<Page> {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext(
		options.phone
			? { ...devices["iPhone 15"], viewport: { width: 390, height: 844 } }
			: { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 },
	);
	if (options.sidebarWidth)
		await context.addInitScript(
			width => localStorage.setItem("omp.sidebarWidth", String(width)),
			options.sidebarWidth,
		);
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?theme=light&lang=${lang}`);
	if (options.phone) await reassertTouch(page);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	if (options.phone) {
		await page.locator("button:visible:has(svg.lucide-menu)").first().click();
		await expect(page.locator("[data-drawer] [data-sidebar-nav]")).toBeVisible();
		// The drawer slides in: measure and capture where it comes to rest.
		await animationsDone(page.locator("[data-drawer] [data-sidebar-nav]"));
	}
	return page;
}

interface Cell {
	row: string;
	left: number;
	top: number;
	width: number;
	height: number;
	/** The label is cut (its text is wider than its box). */
	cut: boolean;
}

function cells(page: Page): Promise<Cell[]> {
	return page.locator("[data-sidebar-nav-row]:visible").evaluateAll(rows =>
		rows.map(row => {
			const box = row.getBoundingClientRect();
			const label = row.querySelector("span");
			return {
				row: row.getAttribute("data-sidebar-nav-row") ?? "",
				left: Math.round(box.left),
				top: Math.round(box.top),
				width: Math.round(box.width),
				height: Math.round(box.height),
				cut: label ? label.scrollWidth > label.clientWidth : true,
			};
		}),
	);
}

async function shoot(page: Page, name: string): Promise<void> {
	if (!SHOTS) return;
	await fs.mkdir(SHOTS, { recursive: true });
	const nav = await page.locator("[data-sidebar-nav]:visible").boundingBox();
	const sidebar = await page.locator(".omp-session-sidebar:visible").first().boundingBox();
	if (!nav || !sidebar) throw new Error("no sidebar to capture");
	await page.screenshot({
		path: path.join(SHOTS, `${name}.png`),
		clip: { x: sidebar.x, y: 0, width: sidebar.width, height: nav.y + nav.height + 48 },
	});
}

/** All sessions leads across the whole row; the other cells fill rows two at a time, in reading order, a column wide. */
function expectTwoPerRow(all: Cell[]): void {
	const board = all.find(cell => cell.row === "board");
	const list = all.filter(cell => cell.row !== "board");
	expect(list.length).toBeGreaterThanOrEqual(2);
	const column = list[0]?.width ?? 0;
	if (board) {
		expect(board.width, "All sessions spans the row").toBeGreaterThan(2 * column);
		expect(board.top, "All sessions leads").toBeLessThan(list[0]?.top ?? 0);
	}
	list.forEach((cell, index) => {
		expect(cell.width, `${cell.row} is one column wide`).toBe(column);
		const first = list[index - (index % 2)];
		expect(cell.top, `${cell.row} shares its row`).toBe(first?.top);
		if (index % 2 === 1)
			expect(cell.left, `${cell.row} sits right of ${first?.row}`).toBeGreaterThan(first?.left ?? 0);
		else expect(cell.left, `${cell.row} starts the row`).toBe(list[0]?.left);
		if (index >= 2)
			expect(cell.top, `${cell.row} sits under the row before`).toBeGreaterThan(list[index - 2]?.top ?? 0);
	});
}

for (const lang of ["en", "ko"] as const)
	for (const width of [undefined, GRID_MIN_SIDEBAR_WIDTH])
		test(`two per row, every label whole: ${lang} at ${width ?? "the default"} px`, async () => {
			const page = await openHarness(lang, { sidebarWidth: width });
			await shoot(page, `desktop-${lang}-${width ?? "default"}`);
			const list = await cells(page);
			expectTwoPerRow(list);
			for (const cell of list) expect(cell.cut, `${cell.row}'s label is cut`).toBe(false);
			// The Agents shortcut lives in its tooltip and aria-keyshortcuts, not in a half-width cell.
			const agents = page.locator('[data-sidebar-nav-row="agents"]');
			await expect(agents).toHaveAttribute("aria-keyshortcuts", /\+A$/);
			await agents.hover();
			await expect(page.getByRole("tooltip")).toContainText(/⌥A|Alt\+A/);
			await page.context().close();
		});

test("an odd count leaves the last cell a column wide", async () => {
	const page = await openHarness("en", {});
	const besideBoard = (list: Cell[]) => list.filter(cell => cell.row !== "board").length;
	// Hide a cell, and one more when that leaves an even count.
	let list = await cells(page);
	do {
		const hide = list[list.length - 2]?.row ?? "";
		await page.locator(`[data-sidebar-nav-row="${hide}"]`).click({ button: "right" });
		await page.getByRole("menuitem", { name: "Hide from sidebar" }).click();
		await expect(page.getByRole("menu")).toHaveCount(0);
		list = await cells(page);
	} while (besideBoard(list) % 2 === 0 && besideBoard(list) > 1);
	expect(besideBoard(list) % 2).toBe(1);
	await shoot(page, "desktop-en-odd");
	expectTwoPerRow(list);
	await page.context().close();
});

for (const lang of ["en", "ko"] as const)
	test(`the narrowest sidebar keeps two per row, each icon shown and a cut label named in its tooltip (${lang})`, async () => {
		const page = await openHarness(lang, { sidebarWidth: SIDEBAR_MIN_WIDTH });
		await shoot(page, `desktop-${lang}-min`);
		const sidebar = await page.locator(".omp-session-sidebar:visible").first().boundingBox();
		expect(Math.round(sidebar?.width ?? 0), "the sidebar is at its minimum").toBeLessThanOrEqual(
			SIDEBAR_MIN_WIDTH + 1,
		);
		const list = await cells(page);
		expectTwoPerRow(list);
		const icons = await page.locator("[data-sidebar-nav-row]:visible").evaluateAll(rows =>
			rows.map(row => {
				const icon = row.querySelector("svg")?.getBoundingClientRect();
				const box = row.getBoundingClientRect();
				return icon !== undefined && icon.width > 0 && icon.left >= box.left && icon.right <= box.right;
			}),
		);
		expect(icons.every(Boolean), "every cell shows its icon whole").toBe(true);
		const cut = list.find(cell => cell.cut && cell.row !== "board");
		if (cut) {
			const cell = page.locator(`[data-sidebar-nav-row="${cut.row}"]`);
			const label = (await cell.locator("span").first().textContent())?.trim() ?? "";
			await cell.hover();
			await expect(page.getByRole("tooltip")).toContainText(label);
		}
		await page.context().close();
	});

for (const lang of ["en", "ko"] as const)
	test(`a phone's drawer: two per row, 44 px cells (${lang})`, async () => {
		const page = await openHarness(lang, { phone: true });
		await shoot(page, `phone-${lang}`);
		const list = await cells(page);
		expectTwoPerRow(list);
		for (const cell of list) {
			expect(cell.height, `${cell.row} is a 44 px target`).toBeGreaterThanOrEqual(44);
			expect(cell.cut, `${cell.row}'s label is cut`).toBe(false);
		}
		await page.context().close();
	});
