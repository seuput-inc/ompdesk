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
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}&rows=7`);
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
	// The host's just-written session at work beside its chip ("Ship the release").
	const live = list
		.locator(`[data-sidebar-device="${HOST}"]`)
		.locator(`.omp-sidebar-session-row[data-device-session=${cssString(sessionFile(PROJECT, "sess-live"))}]`);
	await expect(live.locator("[data-family-running]")).toBeVisible();
	await expect(live.locator('[data-session-head="branch"]')).toHaveText("release");
	// At work beside its chip a short name stays whole in a 248 px sidebar and on a phone (it once read "rel…", then
	// nothing but its mark); in the 220 px one it is whole or gone, never cut.
	const liveHead = await live.locator('[data-session-head="branch"]').evaluate(readHeadIn);
	if (surface.name !== "narrow") expect(liveHead).toMatchObject({ onLine: true, visible: "release" });
	else if (liveHead.onLine) expect(liveHead.visible).toBe("release");
	// Its title's faded letters are a frame of the moving light, never a still dim state: the light's window runs
	// (components.css `omp-live-shine-text`, whose holds put the band off the title) and is further on two frames later.
	const motion = await live.locator(".omp-live-shine-window").evaluate(async node => {
		const animation = node.getAnimations()[0] as CSSAnimation | undefined;
		const before = Number(animation?.currentTime ?? 0);
		const frames = Promise.withResolvers<void>();
		requestAnimationFrame(() => requestAnimationFrame(() => frames.resolve()));
		await frames.promise;
		return {
			name: animation?.animationName,
			state: animation?.playState,
			advanced: Number(animation?.currentTime ?? 0) > before,
		};
	});
	expect(motion).toEqual({ name: "omp-live-shine-text", state: "running", advanced: true });
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
	// Two agent branches that differ only at their end read apart: past the shared `omp/agent/` only `…/` shows, the
	// middle gives way and the last segment stays; the whole name stays the title. In the 220 px sidebar both are cut.
	const twins = [];
	for (const file of [sessionFile(PROJECT, "sess-row-2"), sessionFile(PROJECT, "sess-row-4")]) {
		const head = rowFor(list, file).locator('[data-session-head="branch"]');
		await head.scrollIntoViewIfNeeded();
		twins.push(await head.evaluate(readHeadIn));
	}
	for (const [head, tail] of [
		[twins[0], "-light"],
		[twins[1], "-dark"],
	] as const) {
		expect(head?.title).toContain(`omp/agent/settings-panel${tail}`);
		expect(head?.onLine, head?.title).toBe(true);
		expect(head?.visible.startsWith("…/"), head?.title).toBe(true);
		expect(head?.visible.endsWith(tail), head?.title).toBe(true);
		expect(head?.visible.length, head?.title).toBeGreaterThanOrEqual(8);
		if (surface.name === "narrow") expect(head?.cut, head?.title).toBe(true);
	}
	expect(twins[0]?.visible).not.toBe(twins[1]?.visible);

	// The owner's order on a short line, on every row: the age gives way whole before the branch loses a letter, the
	// branch keeps at least eight characters or goes with its mark (never the mark alone), a working arc stays whole in
	// the row's leading status lane, and the family chip and the ⋯ stay whole beside the line.
	const lines = await list.locator(".omp-sidebar-session-row:visible").evaluateAll(rows =>
		rows.map(row => {
			const give = row.querySelector(".omp-session-row-give")?.getBoundingClientRect();
			const shown = (element: Element | null | undefined) => {
				if (!element || !give) return false;
				const box = element.getBoundingClientRect();
				return box.width > 0 && box.top < give.bottom - 1 && box.right <= give.right + 0.5;
			};
			const head = row.querySelector("[data-session-head]");
			const text = head?.querySelector(".truncate");
			const end = row.querySelector("[data-sidebar-row-menu]")?.parentElement?.getBoundingClientRect();
			return {
				name: row.textContent ?? "",
				hasHead: Boolean(head),
				head: shown(head),
				cut: text ? text.scrollWidth > text.clientWidth + 0.5 : false,
				age: shown(row.querySelector("[data-session-row-age] > time")),
				working: Boolean(row.querySelector("[data-session-working]")),
				arc: (() => {
					const lane = row.querySelector("[data-status-lane]")?.getBoundingClientRect();
					const arc = row.querySelector("[data-session-working] .omp-working-arc")?.getBoundingClientRect();
					return Boolean(
						arc && lane && arc.width > 0 && arc.left >= lane.left - 0.5 && arc.right <= lane.right + 0.5,
					);
				})(),
				endClear: Boolean(!end || !give || end.left >= give.right - 0.5),
			};
		}),
	);
	expect(lines.length).toBeGreaterThan(4);
	for (const line of lines) {
		if (line.cut || (line.hasHead && !line.head)) expect(line.age, `${line.name}: age before branch`).toBe(false);
		if (line.working) expect(line.arc, `${line.name}: arc stays`).toBe(true);
		expect(line.endClear, `${line.name}: chip and ⋯ beside the line`).toBe(true);
	}
	const heads = await Promise.all(
		(await list.locator("[data-session-head]:visible").all()).map(head => head.evaluate(readHeadIn)),
	);
	for (const head of heads.filter(head => head.onLine)) {
		expect(head.visible.length, `${head.title}: eight characters or none`).toBeGreaterThanOrEqual(
			Math.min(8, head.shown.length),
		);
		expect(head.past, `${head.title} ${head.why}`).toBeLessThanOrEqual(0.5);
	}

	// The age slot (composer.md): work starting and ending changes only the leading status lane, so the age stays shown
	// and the branch starts where it did.
	const restRow = rowFor(list, sessionFile(PROJECT, "sess-1"));
	const branchStart = () =>
		restRow.locator("[data-session-head]").evaluate(head => Math.round(head.getBoundingClientRect().left));
	const visibleAge = () =>
		restRow
			.locator("[data-session-row-age] > time")
			.evaluate(time => getComputedStyle(time).visibility === "visible" && time.getBoundingClientRect().width > 8);
	const setRun = (status: "running" | "ready") =>
		page.evaluate(next => window.__harness?.summaries.tab("tab-1", { status: next }), status);
	expect(await visibleAge()).toBe(true);
	const atRest = await branchStart();
	await setRun("running");
	const working = restRow.locator("[data-status-lane] [data-session-working]");
	await expect(working).toBeVisible();
	expect(await visibleAge()).toBe(true);
	expect(await branchStart()).toBe(atRest);
	await setRun("ready");
	await expect(restRow.locator("[data-session-working]")).toHaveCount(0);
	expect(await visibleAge()).toBe(true);
	expect(await branchStart()).toBe(atRest);

	// Every session row: two lines in the slim density (40 px for a mouse, 48 under a finger, whose hit height stays
	// 44), the picture first, the ⋯ under the title's line, nothing past the row's edge.
	const rows = list.locator(".omp-sidebar-session-row:visible");
	const count = await rows.count();
	const touch = surface.name === "phone";
	for (let index = 0; index < count; index++) {
		const row = rows.nth(index);
		const box = await row.boundingBox();
		if (!box) continue;
		expect(box.height, `row ${index} height`).toBeGreaterThanOrEqual(touch ? 44 : 38);
		expect(box.height, `row ${index} height`).toBeLessThanOrEqual(touch ? 50 : 42);
		const picture = await row.locator("[data-project-artwork]").boundingBox();
		expect(picture?.height, `row ${index} picture`).toBe(touch ? 28 : 24);
		const title = await row.locator("button[data-roving-item]").first().boundingBox();
		const more = await row.locator("[data-sidebar-row-menu]").boundingBox();
		if (title && more) expect(more.y + more.height / 2).toBeGreaterThan(title.y + title.height);
		const overflow = await row.evaluate(element => element.scrollWidth - element.clientWidth);
		expect(overflow, `row ${index} overflow`).toBeLessThanOrEqual(1);
	}

	// The whole row selects its session, its second line too (the marks, the age, the branch and the room between):
	// only the family chip and the ⋯ beside that line take a click of their own. The line's give-way box is positioned,
	// so it once painted over the row button's stretched click target: a click on the age or the branch, or a phone's
	// tap at the middle of a 48 px row, opened nothing (the Windows e2e of 19 Nov 2026).
	expect(await list.evaluate(rowsMissingClicks)).toEqual([]);
	// A hover on line 2 shows the row's tooltip, so whatever a part of that line names on its own (the branch's whole
	// name, the exact time, a waiting badge's word) is in the row's tooltip too.
	const tips = await list.locator(".omp-sidebar-session-row:visible").evaluateAll(rows =>
		rows.flatMap(row => {
			const tooltip = row.querySelector("button[data-roving-item]")?.getAttribute("title") ?? "";
			return [...row.querySelectorAll("[data-sidebar-row-end] [title]")]
				.map(part => part.getAttribute("title") ?? "")
				.filter(part => !tooltip.includes(part))
				.map(part => `${tooltip.split("\n")[0]}: ${part}`);
		}),
	);
	expect(tips).toEqual([]);
}

/**
 * Where a click on a session row in view lands that does not reach its button: the row's centre and points every 6 px
 * across the middle of its second line (`data-sidebar-row-end`, which ends before the chip and the ⋯). Runs in the
 * page; `elementFromPoint` is the hit test a click takes.
 */
function rowsMissingClicks(list: Element): string[] {
	const view = (list.querySelector(".omp-sidebar-list") ?? list).getBoundingClientRect();
	const misses: string[] = [];
	for (const row of list.querySelectorAll(".omp-sidebar-session-row")) {
		const box = row.getBoundingClientRect();
		const button = row.querySelector("button[data-roving-item]");
		const line = row.querySelector("[data-sidebar-row-end]")?.getBoundingClientRect();
		if (!button || !line || box.height === 0 || box.top < view.top || box.bottom > view.bottom) continue;
		const points: [string, number, number][] = [["centre", box.left + box.width / 2, box.top + box.height / 2]];
		for (let x = line.left + 1; x < line.right - 1; x += 6) points.push(["line 2", x, line.top + line.height / 2]);
		for (const [where, x, y] of points) {
			const hit = document.elementFromPoint(x, y);
			if (hit && button.contains(hit)) continue;
			const name = button.textContent?.trim() ?? "";
			misses.push(
				`${name} ${where} at ${Math.round(x - box.left)},${Math.round(y - box.top)}: ${hit?.className ?? hit}`,
			);
		}
	}
	return misses;
}

/**
 * A branch label as the eye reads it: whether it sits on its line (not wrapped out of sight), the characters fully
 * left of its ellipsis, all it shows, its title, how far it reaches past its line. Runs in the page (Playwright
 * serializes it whole).
 */
function readHeadIn(node: Element): {
	title: string;
	onLine: boolean;
	cut: boolean;
	shown: string;
	visible: string;
	past: number;
	/** The head's geometry, for a failure to say why it stayed on a line too short for it. */
	why: string;
} {
	const text = node.querySelector(".truncate");
	const tail = node.querySelector("[data-head-tail]");
	const line = node.closest(".omp-session-row-give")?.getBoundingClientRect();
	const title = node.getAttribute("title") ?? "";
	const onLine = Boolean(line && node.getBoundingClientRect().top < line.bottom - 1);
	const whole = `${text?.textContent ?? ""}${tail?.textContent ?? ""}`;
	const why = JSON.stringify({
		give: Math.round(line?.width ?? 0),
		box: Math.round(node.parentElement?.getBoundingClientRect().width ?? 0),
		head: Math.round(node.getBoundingClientRect().width),
		top: Math.round(node.getBoundingClientRect().top - (line?.top ?? 0)),
		min: (node as HTMLElement).style.minWidth,
		font: getComputedStyle(node).fontFamily.slice(0, 40),
		fonts: document.fonts.status,
	});
	if (!text?.firstChild || !onLine) return { title, onLine, cut: false, shown: whole, visible: "", past: 0, why };
	const box = text.getBoundingClientRect();
	const cut = text.scrollWidth > text.clientWidth + 0.5;
	const style = getComputedStyle(text);
	const canvas = document.createElement("canvas").getContext("2d");
	if (canvas) canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
	const limit = box.right - (cut ? (canvas?.measureText("…").width ?? 0) : 0);
	const source = text.textContent ?? "";
	const range = document.createRange();
	let visible = "";
	for (let index = 0; index < source.length; index++) {
		range.setStart(text.firstChild, index);
		range.setEnd(text.firstChild, index + 1);
		if (range.getBoundingClientRect().right > limit + 0.5) break;
		visible += source[index];
	}
	// The tail never shrinks: it is in view whole when its own box is inside the line.
	const end = (tail ?? text).getBoundingClientRect().right;
	return {
		title,
		onLine,
		cut,
		shown: whole,
		visible: visible + (tail?.textContent ?? ""),
		past: line ? end - line.right : 0,
		why,
	};
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

			// A real click on the middle of a row's second line, its branch (a tap on a phone), selects its session, as a
			// click on its title does.
			const target = rowFor(sidebar(page), sessionFile(PROJECT, "sess-2"));
			await target.scrollIntoViewIfNeeded();
			await expect(target).not.toHaveAttribute("data-current", /.*/);
			const line = await target.locator("[data-sidebar-row-end]").boundingBox();
			if (!line) throw new Error("the row has no second line");
			const [x, y] = [line.x + line.width / 2, line.y + line.height / 2];
			if (surface.name === "phone") await page.touchscreen.tap(x, y);
			else await page.mouse.click(x, y);
			await expect
				.poll(() =>
					page.evaluate(() =>
						(window.__harness?.calls ?? [])
							.filter(call => call.channel === "runtime:error-report")
							.map(call => call.args[0] as { source?: string; message?: string; details?: { file?: string } })
							.filter(report => report.source === "sidebar" && report.message === "select")
							.map(report => report.details?.file),
					),
				)
				.toContain("sess-2.jsonl");
			await page.context().close();
		});

