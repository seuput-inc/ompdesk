/**
 * A drag across the sidebar's rows selects no text (the owner's report), while its text fields still do: the search
 * and a session's inline rename (settings-layout-look › Sidebar header). Real mouse drags on the built app with the
 * fake omp.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { exitApp, launchApp } from "./harness";

let app: ElectronApplication | undefined;
let root = "";

test.afterEach(async () => {
	if (app) await exitApp(app);
	app = undefined;
	if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	root = "";
});

/** A stored session in the fake omp's journal format. */
async function seed(agent: string, id: string, cwd: string, title: string, minutesAgo: number): Promise<void> {
	const file = path.join(agent, "sessions", "seeded", `${id}.jsonl`);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
	const lines = [
		{ type: "title", v: 1, title, updatedAt: at },
		{ type: "session", version: 3, id, timestamp: at, cwd },
		{ type: "message", id: `${id}-1`, parentId: null, timestamp: at, message: { role: "user", content: title } },
		{
			type: "message",
			id: `${id}-2`,
			parentId: `${id}-1`,
			timestamp: at,
			message: { role: "assistant", content: [{ type: "text", text: `${title} answer` }] },
		},
	];
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
}

test("a drag across the sidebar's rows selects no text, and a rename field still selects its own", async () => {
	test.setTimeout(120_000);
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-no-select-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(root, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	await seed(agent, "s-1", project, "Alpha plan", 3);
	await seed(agent, "s-2", project, "Bravo plan", 2);
	await seed(agent, "s-3", project, "Charlie plan", 1);
	app = await launchApp({ project, desktop, agent, profile: root, env: { OMP_GUI_TEST_SESSION_FILES: "1" } });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	const rows = page.locator("[data-session-group] .omp-sidebar-session-row");
	await expect(rows).toHaveCount(3);

	// From the nav rows past the project header and every session row, then the same drag back up from the last row's
	// left edge: a person sweeping the list with a pressed mouse.
	const sidebar = page.locator(".omp-session-sidebar").first();
	const nav = await page.locator("[data-sidebar-nav-row]").first().boundingBox();
	const last = await rows.last().boundingBox();
	const box = await sidebar.boundingBox();
	if (!nav || !last || !box) throw new Error("expected the sidebar, a nav row and the last session row");
	const sweep = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
		await page.evaluate(() => document.getSelection()?.removeAllRanges());
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(to.x, to.y, { steps: 20 });
		await page.mouse.up();
		return page.evaluate(() => document.getSelection()?.toString() ?? "");
	};
	expect(await sweep({ x: nav.x + 4, y: nav.y + nav.height / 2 }, { x: box.x + box.width - 12, y: last.y + 4 })).toBe(
		"",
	);
	expect(await sweep({ x: box.x + 3, y: last.y + last.height - 3 }, { x: box.x + 3, y: nav.y + 2 })).toBe("");
	// Every kind of row the owner named reads unselectable.
	const selectable = await page.evaluate(() =>
		[
			"[data-sidebar-nav-row]",
			"[data-workspace-group]",
			".omp-sidebar-session-row",
			"[data-sidebar-bots]",
			"[data-sidebar-chats]",
		].flatMap(selector => {
			const element = document.querySelector(selector);
			return element && getComputedStyle(element).userSelect !== "none" ? [selector] : [];
		}),
	);
	expect(selectable).toEqual([]);

	// The search field takes a selection.
	const search = page.locator("[data-sidebar-filter]").first();
	await search.fill("Bravo");
	await search.selectText();
	expect(
		await search.evaluate(input => [
			(input as HTMLInputElement).selectionStart,
			(input as HTMLInputElement).selectionEnd,
		]),
	).toEqual([0, 5]);
	await search.fill("");

	// An inline rename opens with its title selected.
	await rows.filter({ hasText: "Bravo plan" }).first().click({ button: "right" });
	await page
		.getByRole("menuitem", { name: /^Rename/ })
		.first()
		.click();
	const field = page.locator(".omp-sidebar-session-rename input").first();
	await expect(field).toBeFocused();
	const range = await field.evaluate(input => {
		const element = input as HTMLInputElement;
		return { start: element.selectionStart, end: element.selectionEnd, length: element.value.length };
	});
	expect(range.length).toBeGreaterThan(0);
	expect([range.start, range.end]).toEqual([0, range.length]);
	await page.keyboard.press("Escape");
});
