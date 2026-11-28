import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";
import { before, shot, shots, withPhone } from "./shipped-capture";

const prompt = "변경 내용을 `git diff`로 확인합니다.";

async function measure(page: Page, surface: "desktop" | "390", saved: number | undefined) {
	const reading = page.locator(".omp-user-text p").filter({ hasText: "git diff" });
	await expect(reading).toBeVisible();
	const text = await reading.evaluate(p => ({
		body: getComputedStyle(document.body).fontSize,
		prose: getComputedStyle(p).fontSize,
		code: getComputedStyle(p.querySelector("code")!).fontSize,
	}));
	const name = `44-ko-${surface}-${saved ? `saved-${saved}` : "default"}`;
	await shot(page, `${name}-reading`);
	if (surface === "390") await page.locator("header button:has(svg.lucide-menu)").click();
	const sidebar = page.locator(surface === "390" ? "[data-drawer] [data-sidebar-bots]" : "[data-sidebar-bots]");
	await expect(sidebar.locator("[data-bot-owner]").first()).toHaveText("작업실", { timeout: 30_000 });
	const rows = sidebar.locator("[data-bot-entry] .omp-list-row:has([data-bot-row])");
	await expect(rows).toHaveCount(2);
	const geometry = await rows.evaluateAll(nodes =>
		nodes.map(node => {
			const title = node.querySelector<HTMLElement>("[data-bot-row]")!;
			const secondary = document.getElementById(title.getAttribute("aria-describedby")!)!;
			const rect = node.getBoundingClientRect();
			return {
				top: rect.top,
				bottom: rect.bottom,
				height: rect.height,
				avatarToText: title.getBoundingClientRect().left - node.firstElementChild!.getBoundingClientRect().right,
				title: title.textContent,
				ownerInTitle: title.querySelector("[data-bot-owner]")?.textContent,
				ageInDetail: secondary.querySelector("time")?.textContent,
				titleFont: getComputedStyle(title).fontSize,
				secondary: secondary.textContent,
				secondaryFont: getComputedStyle(secondary).fontSize,
				lineGap: secondary.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
				clipped: [title, secondary, ...node.querySelectorAll<HTMLElement>(".truncate")].some(
					e => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1,
				),
			};
		}),
	);
	const gap = geometry[1].top - geometry[0].bottom;
	await shot(page, `${name}-rows`);
	await fs.writeFile(
		path.join(shots!, `${before ? "before" : "after"}-${name}.json`),
		JSON.stringify({ width: await page.evaluate(() => innerWidth), text, rows: geometry, gap }, null, 2),
	);
	if (!before) {
		for (const row of geometry) {
			expect.soft(row.clipped, row.title ?? "bot row").toBe(false);
			expect.soft(row.ownerInTitle).toBe("작업실");
			expect.soft(row.ageInDetail).toBeTruthy();
			expect.soft(row.secondary?.trim()).toBeTruthy();
			expect.soft(row.lineGap).toBeGreaterThanOrEqual(-1);
		}
		if (surface === "desktop" && !saved) {
			expect.soft(text.prose).toBe("13px");
			expect.soft(text.code).toBe("12px");
			// Orca's two lines (20 + 16), vertical padding (2 × 5) and borders (2 × 1).
			for (const row of geometry) expect.soft(row.height, "#44: Orca two-line row height").toBeCloseTo(48, 0);
			expect.soft(gap, "#44: Orca folded rows have no intervening spacer").toBeCloseTo(0, 0);
		}
	}
	if (saved) {
		expect.soft(await page.evaluate(() => window.omp.prefs.get("fontSize"))).toBe(saved);
		expect.soft(text.body).toBe(`${saved}px`);
		expect.soft(text.prose).toBe(`${saved}px`);
	}
}

if (shots)
	for (const fontSize of [undefined, 18]) {
		test(`shipped captures #44 Korean bot rows and reading size (${fontSize ?? "default"})`, async () => {
			test.setTimeout(180_000);
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shipped-rows-")));
			const host = await makeRemoteProfile(root, "studio", { language: "ko", theme: "light" });
			const client = await makeRemoteProfile(root, "viewer", {
				language: "ko",
				theme: "light",
				port: host.port,
				prefs: { fontSize },
			});
			const bots = await Promise.all(
				["정리", "검토"].map(async (name, i) => {
					const folder = path.join(host.root, `bot-${i}`);
					await fs.mkdir(folder);
					return {
						id: `bot-${i}`,
						name,
						folder,
						sessions: [],
						paused: i === 1,
						createdAt: new Date(Date.now() - 7_200_000).toISOString(),
					};
				}),
			);
			await fs.writeFile(path.join(host.desktop, "bots.json"), JSON.stringify(bots));
			const owner = await launchRemote(host);
			let viewer: RemoteInstance | undefined;
			try {
				viewer = await launchRemote(client);
				const desk = viewer.page;
				await connectHost(owner.page, desk, "작업실");
				const input = desk.locator("[data-composer-input]").first();
				await input.fill(prompt);
				await input.press("Enter");
				await expect(desk.getByText("Local fixture reply", { exact: true }).first()).toBeVisible();
				await measure(desk, "desktop", fontSize);
				if (!fontSize) {
					const session = await desk.evaluate(
						async () => (await window.omp.tabs.list()).find(t => t.active)?.sessionPath,
					);
					if (!session) throw new Error("No saved reading sample");
					await withPhone(desk, client.tailscale, async phone => {
						const tab = await phone.evaluate(
							([cwd, sessionPath]) => window.omp.tabs.spawn({ cwd, sessionPath, kind: "agent" }),
							[client.project, session] as const,
						);
						if (!tab) throw new Error("Phone could not open reading sample");
						await phone.goto(`${new URL(phone.url()).origin}/#/open?tab=${tab.tabId}`);
						await measure(phone, "390", undefined);
					});
				}
			} finally {
				try {
					if (viewer) await exitApp(viewer.app);
				} finally {
					await exitApp(owner.app);
				}
			}
		});
	}
