/** #52 on one live session. TodoDockCard.test.tsx and WorkBoardChip.test.tsx cover the list model and rotation. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp, pressShortcutUntilVisible } from "./harness";
import { launchRemote, makeRemoteProfile } from "./remote-harness";
import { before, shot, shots, withPhone } from "./shipped-capture";

const active = "설정 변경 확인";
const workers = ["Map the settings code", "Review the sidebar diff"];
const firstBoardTask = before ? "릴리스 노트 작성" : active;
const elapsed = /^(?:(?:\d+분 )?\d+초|\d+시간 \d+분)$/;

async function captureEditor(page: Page, surface: string): Promise<void> {
	const dialog = page.getByRole("dialog");
	const search = dialog.getByRole("combobox");
	await pressShortcutUntilVisible(page, "ControlOrMeta+k", search);
	await search.fill("todo");
	await dialog.locator('button[data-command-name="todo"]').first().click();
	await dialog.locator("button[data-palette-index]", { hasText: "할 일 편집" }).first().click();
	await expect(dialog).toBeHidden();

	const dock = page.locator('[data-dock-card="todo"][data-dock-expanded]');
	if (before) {
		// The old editor keeps completed tasks in their original phase. Do not scroll it to the active one.
		await expect(dock.getByText("색상 검토", { exact: true })).toBeInViewport();
	} else {
		await expect(dock.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "4/10");
		const status = dock.getByRole("button", { name: /^상태:/ });
		await expect(status).toHaveCount(6);
		await expect(status.first()).toHaveAccessibleName(/^상태: 진행 중/);
		const phase = dock.locator("section").first();
		await expect(phase.getByRole("button", { name: /설정 점검.*1\/4/ })).toBeInViewport();
		await expect(phase.getByText(active, { exact: true })).toBeInViewport({ ratio: 1 });
		const turn = phase.getByText("현재 턴", { exact: true }).locator("..");
		await expect(turn.getByText("설정 파일 비교", { exact: true })).toBeVisible();
		await expect(turn.getByText(elapsed)).toBeVisible();
		await expect(dock.getByText("요구사항 조사", { exact: true })).toBeHidden();
		await expect(dock.getByText("보류한 실험", { exact: true })).toBeHidden();
		const closed = dock.getByRole("button", { name: "완료 4개 · 포기 2개" });
		await expect(closed).toHaveAttribute("aria-expanded", "false");
		const rows = dock.locator("[data-dock-runner]");
		await expect(rows).toHaveCount(2);
		for (const worker of workers) {
			await expect(rows.filter({ hasText: worker }).getByText(elapsed)).toBeVisible();
		}
	}
	expect(await page.getByTestId("workspace-dock").evaluate(el => el.scrollTop)).toBe(0);
	await shot(page, `52-ko-${surface}-todos-at-rest`);
}

if (shots)
	test("shipped captures #52 active todo, two workers and the folded phone list", async () => {
		test.setTimeout(180_000);
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-shipped-work-")));
		const profile = await makeRemoteProfile(root, "desk", { language: "ko", theme: "light" });
		const { app, page } = await launchRemote(profile);
		try {
			await page.emulateMedia({ reducedMotion: "reduce" });
			const input = page.locator("[data-composer-input]").first();
			await input.fill("fixture running");
			await input.press("Enter");
			let sessionPath = "";
			await expect
				.poll(
					async () => {
						sessionPath = await page.evaluate(async () => {
							const tab = (await window.omp.tabs.list()).find(t => t.active && t.status === "running");
							return tab?.sessionPath ?? "";
						});
						return sessionPath;
					},
					{ timeout: 30_000 },
				)
				.not.toBe("");

			await withPhone(page, profile.tailscale, async phone => {
				await phone.emulateMedia({ reducedMotion: "reduce" });
				const view = await phone.evaluate(
					({ cwd, sessionPath }) => window.omp.tabs.spawn({ cwd, kind: "agent", sessionPath }),
					{ cwd: profile.project, sessionPath },
				);
				if (!view?.tabId) throw new Error("The phone could not open the desktop session");
				await phone.goto(new URL(`/#/open?tab=${encodeURIComponent(view.tabId)}`, phone.url()).href);
				await expect(phone.locator("[data-composer-input]").first()).toBeEditable({ timeout: 30_000 });
				await expect
					.poll(() => phone.evaluate(async () => (await window.omp.tabs.list()).find(t => t.active)?.sessionPath))
					.toBe(sessionPath);
				const seeded = await page.evaluate(() =>
					window.omp.rpc.command({ type: "bash", command: "fixture:board-work" }),
				);
				expect(seeded.success).toBe(true);

				const board = page.locator(".omp-work-board-slot [data-work-board-panel]");
				const plan = board.locator('[data-board-section="plan"]');
				await expect(plan).toContainText("4/10");
				await expect(plan.locator("[data-todo-status]").first()).toContainText(firstBoardTask);
				for (const worker of workers) await expect(board.getByText(worker, { exact: true })).toBeInViewport();
				await shot(page, "52-ko-desktop-board");
				await captureEditor(page, "desktop");

				const strip = phone.locator("[data-work-chip]");
				await expect(strip).toHaveAttribute("aria-expanded", "false");
				await expect(strip).toContainText(active);
				await expect(strip).toContainText("4/10");
				if (before) {
					await expect(strip.locator('[data-count="agents"]')).toHaveText("2");
				} else {
					const lines = strip.locator("[data-work-line]");
					await expect(lines).toHaveCount(3);
					await expect(lines.first()).toContainText(`${active} · 설정 파일 비교`);
					for (const worker of workers) await expect(lines.filter({ hasText: worker })).toBeInViewport();
					await expect(lines.last()).toContainText("+1");
				}
				await shot(phone, "52-ko-phone390-strip-collapsed");
				await strip.tap();
				const panel = phone.locator("[data-work-strip-panel]");
				await panel.locator('[data-board-summary="plan"]').tap();
				const openPlan = panel.locator('[data-board-section="plan"]');
				await expect(openPlan).toContainText("4/10");
				const first = openPlan.locator("[data-todo-status]").first();
				await expect(first).toContainText(firstBoardTask);
				await expect(first).toBeInViewport({ ratio: 1 });
				await shot(phone, "52-ko-phone390-strip-expanded");
				await strip.tap();
				await expect(panel).toBeHidden();
				await captureEditor(phone, "phone390");
			});
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
