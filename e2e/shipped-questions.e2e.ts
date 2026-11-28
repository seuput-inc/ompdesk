// The item commands cross the real bot service; only omp and tailnet discovery/Serve are fixtures.
// question-inbox.e2e.ts and inbox-answers.test.ts cover stale drafts and partial delivery.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { controlToolCaller, exitApp, untilAnswered } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";
import { before, shot, shots, withPhone } from "./shipped-capture";

const botName = "단풍";
const hostName = "작업실";
const release = "배포 일정";
const reviewer = "문서 검토";
const examples = "도움말 예제";
const initial = "첫 예제를 어떤 언어로 쓸까요?";
const revised = "첫 예제를 두 언어로 제공할까요?";
const otherWork = "배포 답변을 기다리는 동안 문서 색인을 정리해 주세요.";
const ownerAnswer = "접근성 팀에 검토를 부탁해 주세요.";
const badge = '[data-sidebar-nav-row="questions"]:visible';
const timeout = 30_000;

function state(page: Page) {
	return page.evaluate(() => window.omp.bots.command({ action: "get" }));
}

async function prompt(page: Page, tab: string, message: string) {
	const response = await page.evaluate(
		([id, message]) => window.omp.rpc.commandForTab(id, { type: "prompt", message }),
		[tab, message] as const,
	);
	expect(response.success).toBe(true);
}

async function activeTab(page: Page) {
	const tab = await page.evaluate(async () => (await window.omp.tabs.list()).find(tab => tab.active)?.tabId);
	if (!tab) throw new Error("The initial project did not open");
	return tab;
}

if (shots) {
	for (const surface of ["desktop", "390"] as const) {
		test(`shipped captures #53 ko ${surface} paired questions, other work and reviewed answers`, async () => {
			test.setTimeout(240_000);
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-questions-")));
			let host: RemoteInstance | undefined;
			let client: RemoteInstance | undefined;
			try {
				const profile = await makeRemoteProfile(root, "studio", { language: "ko", theme: "light" });
				const peer = await makeRemoteProfile(root, "desk", { language: "ko", theme: "light", port: profile.port });
				host = await launchRemote(profile);
				client = await launchRemote(peer);
				const a = host.page;
				const b = client.page;
				const hostProject = await activeTab(a);
				const peerProject = await activeTab(b);
				const device = await connectHost(a, b, hostName);
				const folder = path.join(profile.root, "안내서");
				const made = await a.evaluate(
					([name, folder]) => window.omp.bots.command({ action: "create", name, folder }),
					[botName, folder] as const,
				);
				const bot = made.bots.find(bot => bot.name === botName);
				if (!bot) throw new Error("The host did not create the bot");
				const tab = await a.evaluate(async cwd => (await window.omp.tabs.spawn({ cwd }))?.tabId, folder);
				if (!tab) throw new Error("The host did not open the bot's chat");
				await expect
					.poll(
						() => a.evaluate(async id => (await window.omp.tabs.list()).find(t => t.tabId === id)?.status, tab),
						{ timeout },
					)
					.toBe("ready");
				await prompt(a, tab, "배포 안내서를 준비해 주세요.");
				await untilAnswered(a, tab);
				const tool = await controlToolCaller(a, profile.record, tab);
				const item = async (args: Record<string, unknown>) => {
					const result = await tool("ompdesk_item", args);
					expect(result.isError, result.text).toBe(false);
				};
				await item({ action: "add", title: release });
				await item({
					action: "set",
					item: "1",
					ask: "언제 배포할까요?",
					options: ["오전", "오후"],
					recommended: 0,
				});
				const firstQuestion = (await state(a)).items.find(i => i.title === release)?.question?.id;
				expect(firstQuestion).toBeGreaterThan(0);
				await prompt(a, tab, otherWork);
				await untilAnswered(a, tab, { after: otherWork });
				await item({ action: "add", title: "문서 색인 정리" });
				await item({ action: "done", item: "2", note: "색인을 정리했어요." });
				const afterWork = (await state(a)).items;
				expect(afterWork.find(i => i.number === 2)?.status).toBe("done");
				expect(afterWork.find(i => i.title === release)).toMatchObject({
					status: "needs_you",
					question: { id: firstQuestion },
				});
				await item({ action: "add", title: reviewer });
				await item({ action: "set", item: "3", ask: "누구에게 검토를 부탁할까요?" });
				await item({ action: "add", title: examples });
				await item({ action: "set", item: "4", ask: initial });
				await expect
					.poll(
						async () =>
							(await state(b)).remote?.find(h => h.device === device)?.items.filter(i => i.question).length,
						{ timeout },
					)
					.toBe(3);

				const capture = async (page: Page) => {
					const picture = (name: string) => shot(page, `53-ko-${surface}-${name}`);
					const drawer = async () => {
						if (surface === "390" && !(await page.locator("[data-drawer]").isVisible())) {
							await page.getByRole("button", { name: "메뉴 열기" }).click();
							await expect(page.locator("[data-drawer]")).toBeVisible();
						}
					};
					await drawer();
					const bots = page.locator("[data-sidebar-bots-open]:visible");
					await expect(bots).toBeVisible();
					if (before) await expect(page.locator(badge)).toHaveCount(0);
					else await expect(page.locator(badge)).toContainText("3", { timeout });
					await picture("sidebar");
					await bots.click();
					await page.locator(`[data-bots-page-row="${bot.id}"]:visible`).click();
					const needs = page.locator("[data-bot-needs-you]");
					await expect(needs.getByRole("heading")).toContainText("3", { timeout });
					await expect(needs).toContainText(release);
					await needs.scrollIntoViewIfNeeded();
					await picture("bot-needs-three");
					if (before) {
						await needs.getByRole("button", { name: release, exact: true }).click();
						const question = page.locator("[data-bot-item-question]");
						await expect(question).toContainText("언제 배포할까요?");
						await question.scrollIntoViewIfNeeded();
						await picture("individual-question");
					}
					await drawer();
					await page.locator(`[data-bot-row="${bot.id}"]:visible`).click();
					const continued = page.locator(".omp-user-bubble:visible").filter({ hasText: otherWork });
					await expect(continued).toBeVisible({ timeout });
					await continued.scrollIntoViewIfNeeded();
					await picture("other-work");
					const dock = page.locator(".omp-work-board-slot [data-work-board-panel]:visible");
					const strip = page.locator("[data-work-chip]:visible");
					if (before) {
						if (!(await dock.isVisible()) && (await strip.isVisible())) await strip.click();
						await expect(page.locator("[data-board-waiting]:visible")).toHaveCount(0);
						await picture("board");
						return;
					}
					await expect(dock.or(strip).first()).toBeVisible({ timeout });
					const openStrip = !(await dock.isVisible());
					if (openStrip) await strip.click();
					const waiting = page.locator('[data-board-section="needs"] [data-board-waiting]:visible');
					await expect(waiting).toHaveCount(3, { timeout });
					await expect(waiting.filter({ hasText: initial })).toHaveCount(1);
					await picture("board");
					if (openStrip) await strip.click();
					await drawer();
					await page.locator(badge).click();
					const inbox = page.locator("[data-question-inbox]");
					const rows = inbox.locator("[data-question-row]");
					const card = (name: string) => rows.filter({ has: page.getByRole("heading", { name, exact: true }) });
					await expect(rows).toHaveCount(3, { timeout });
					await expect(card(release)).toContainText(hostName);
					await expect(inbox.getByRole("heading", { name: "안내서", exact: true })).toBeVisible();
					await expect(inbox.getByRole("heading", { name: botName, exact: true })).toBeVisible();
					await picture("inbox-three");
					await item({ action: "set", item: "4", ask: revised });
					await expect(card(examples)).toContainText(revised, { timeout });
					await expect(card(examples)).not.toContainText(initial);
					await card(examples).scrollIntoViewIfNeeded();
					await picture("edited");
					const question = (await state(a)).items.find(i => i.title === examples)?.question?.id;
					if (!question) throw new Error("The host did not retain the revised question");
					await item({ action: "withdraw", item: "4", question, note: "두 언어의 예제가 이미 있어요." });
					await expect(card(examples)).toHaveCount(0, { timeout });
					await expect(rows).toHaveCount(2);
					await picture("withdrawn");

					await prompt(a, hostProject, "fixture ask");
					await prompt(b, peerProject, "fixture approval session");
					await expect(rows).toHaveCount(4, { timeout });
					const approval = inbox.locator('[data-question-row="approval"]');
					const ask = inbox.locator('[data-question-row="ask"]');
					await expect(ask).toHaveCount(1);
					await expect(approval.getByRole("button")).toBeVisible();
					await expect(approval.getByRole("textbox")).toHaveCount(0);
					const afternoon = card(release).getByRole("radio", { name: "오후", exact: true });
					await afternoon.click();
					await expect(afternoon).toBeChecked();
					await card(reviewer).getByRole("textbox").fill(ownerAnswer);
					await inbox.locator("[data-inbox-recommend]").click();
					await expect(inbox.getByRole("heading", { name: "보낼 답변 검토" })).toBeVisible();
					await expect(afternoon).not.toBeChecked();
					const review = inbox.getByRole("list").filter({ hasText: ownerAnswer });
					await expect(review.getByRole("listitem")).toHaveCount(2);
					await expect(review).toContainText("오전");
					await expect(inbox.locator("[data-inbox-send]")).toHaveText("보내기 (2)");
					const answers = async () =>
						(await state(a)).items
							.flatMap(i => i.events.filter(e => e.kind === "answered").map(e => [i.title, e.text]))
							.sort();
					expect(await answers()).toEqual([]);
					await review.scrollIntoViewIfNeeded();
					await picture("review");
					await inbox.locator("[data-inbox-send]").click();
					await expect(inbox.locator('[data-inbox-outcome="sent"]')).toHaveCount(2, { timeout });
					await expect.poll(answers, { timeout }).toEqual(
						[
							[release, "오전"],
							[reviewer, ownerAnswer],
						].sort(),
					);
					await expect(rows).toHaveCount(2);
					await expect(ask).toHaveCount(1);
					await expect(approval).toHaveCount(1);
					const pending = await b.evaluate(() => window.omp.ui.openRequests());
					expect(
						pending.some(entry => entry.tabId === peerProject && entry.request.id === "approval-session"),
					).toBe(true);
					await picture("sent");
					await approval.scrollIntoViewIfNeeded();
					await picture("approval-still-open");
					await drawer();
					await expect(page.locator(badge)).toContainText("2", { timeout });
				};
				if (surface === "390") await withPhone(b, peer.tailscale, capture, "ko");
				else await capture(b);
			} finally {
				try {
					await Promise.all([client && exitApp(client.app), host && exitApp(host.app)]);
				} finally {
					await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
				}
			}
		});
	}
}
