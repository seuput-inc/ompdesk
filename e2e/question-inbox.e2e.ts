import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { BOTS_STATE, type Bot, type BotsRequest, type BotsState, type Item } from "../src/shared/bots";
import { captureTo } from "./harness";
import { type Look, openLook } from "./responsive-audit";
import { SURFACES } from "./responsive-surfaces";

declare global {
	interface Window {
		questionHost(request: BotsRequest): Promise<BotsState>;
	}
}

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
	server = await createServer({
		configFile: path.resolve("vite.harness.config.ts"),
		server: { host: "127.0.0.1", port: 0 },
		logLevel: "error",
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("No harness port");
	origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(() => server?.close());

function questions(ko: boolean): BotsState {
	const now = Date.now();
	const bots: Bot[] = ["Maple", "Birch", "Cedar"].map((name, i) => ({
		id: name,
		name,
		folder: `/projects/${["Atlas", "Website", "Docs"][i]}`,
		home: null,
		sessions: [],
		paused: false,
		model: null,
		autoApprove: false,
		reach: [],
		staleDays: null,
		lookAround: null,
		tidy: null,
		quiet: [],
		createdAt: new Date(now - 86400000).toISOString(),
	}));
	const titles = ko
		? ["배포 일정", "첫 화면 문구", "접근성 검토", "도움말 예제", "다음 검토자"]
		: ["Release window", "Welcome message", "Accessibility review", "Help examples", "Next reviewer"];
	const prompts = ko
		? [
				"어느 시간대에 배포할까요?",
				"첫 화면 문구를 확정할까요?",
				"검토 범위를 정해 주세요.",
				"도움말에 예제를 넣을까요?",
				"다음 검토를 누가 맡을까요?",
			]
		: [
				"Which release window should we use?",
				"Use the revised welcome message?",
				"Choose the scope of the review.",
				"Include examples in the help page?",
				"Who should review next?",
			];
	const opts = ko ? ["이번 변경에 포함", "다음으로 미룸"] : ["Include now", "Defer"];
	const items: Item[] = titles.map((title, i) => {
		const bot = bots[[0, 0, 1, 2, 2][i]!]!;
		const at = new Date(now - (6 - i) * 60000).toISOString();
		const text = prompts[i]!;
		const options = i === 4 ? [] : i === 0 ? (ko ? ["오전", "오후"] : ["Morning", "Afternoon"]) : opts;
		return {
			id: `question-${i}`,
			bot: bot.id,
			number: i + 1,
			session: `${bot.folder}/chat`,
			title,
			status: "needs_you",
			question: {
				id: 17 + i,
				text,
				options,
				...(i === 4 ? {} : { recommended: 0 }),
				...(i === 2
					? {
							decisions: (ko ? ["키보드", "화면 읽기", "확대"] : ["Keyboard", "Screen reader", "Zoom"]).map(
								question => ({ question, options: opts, recommended: 0 }),
							),
						}
					: {}),
			},
			links: [],
			createdAt: at,
			updatedAt: at,
			events: [{ id: 17 + i, at, actor: "bot", kind: "asked", text }],
			version: 1,
		};
	});
	return {
		bots: bots.slice(0, 2),
		items: items.slice(0, 3),
		remote: [{ device: "studio", name: "Studio Mac", online: true, bots: bots.slice(2), items: items.slice(3) }],
	};
}

for (const lang of ["en", "ko"] as const) {
	test(`${lang}: a failed inbox import keeps the badge and board row; Retry opens without answering`, async ({
		browser,
	}) => {
		const ko = lang === "ko";
		for (const board of [false, true]) {
			const look: Look = board
				? { width: 390, height: 844, orientation: "portrait", theme: "light", dpr: 1, lang }
				: { width: 1280, height: 900, orientation: "landscape", device: "electron", theme: "light", dpr: 1, lang };
			const page = await openLook(browser, look, { origin });
			try {
				const state = questions(ko);
				const item = state.items[0];
				item.session = await page.evaluate(
					async () => (await window.omp.tabs.list()).find(tab => tab.tabId === "tab-1")!.sessionPath!,
				);
				await page.evaluate(
					([channel, state]) => {
						if (!window.__harness) throw new Error("No harness");
						window.__harness.bots = async () => state;
						window.__harness.emit(channel, state);
					},
					[BOTS_STATE, state] as const,
				);
				const module = board ? /\/question-inbox-view\.ts(?:\?|$)/ : /\/QuestionInbox\.tsx(?:\?|$)/;
				let offline = true;
				let failures = 0;
				let hold: Promise<void> | undefined;
				await page.route(module, async route => {
					if (!offline) return route.continue();
					failures++;
					await hold;
					return route.abort("internetdisconnected");
				});
				const badge = page.locator('[data-sidebar-nav-row="questions"]:visible');
				const chip = page.locator("[data-work-chip]:visible");
				if (board) {
					await expect(chip).toContainText(item.question!.text);
					await chip.click();
					await page.locator(`[data-board-waiting="${item.id}"]:visible`).click();
				} else {
					await expect(badge).toContainText("5");
					await badge.click();
				}
				const alert = page
					.getByRole("alert")
					.filter({ hasText: board ? item.title : ko ? "불러오지 못했어요" : "Couldn't load this" });
				const retry = alert.getByRole("button", { name: ko ? "다시 시도" : "Retry" });
				await expect(retry).toBeVisible();
				if (board) {
					await expect(chip).toHaveAttribute("aria-expanded", "false");
					await expect(chip).toContainText(item.question!.text);
				} else await expect(badge).toContainText("5");
				const firstFailures = failures;
				expect(firstFailures).toBeGreaterThan(0);
				const gate = Promise.withResolvers<void>();
				hold = gate.promise;
				try {
					await retry.press("Enter");
					await expect.poll(() => failures).toBeGreaterThan(firstFailures);
					await expect(retry).toBeHidden();
					if (!board) await expect(page.getByTestId("page-skeleton")).toBeVisible();
				} finally {
					gate.resolve();
				}
				await expect(retry).toBeVisible();
				offline = false;
				await retry.press("Enter");
				await expect(
					page.locator(board ? `[data-bot-item-page="${item.id}"]` : "[data-question-inbox]"),
				).toBeVisible();
				expect(
					await page.evaluate(() =>
						window.__harness!.calls.filter(
							call =>
								call.channel === "extension-ui:respond" ||
								(call.channel === "bots:command" && (call.args[0] as BotsRequest).action === "item"),
						),
					),
				).toEqual([]);
			} finally {
				await page.context().close();
			}
		}
	});
	for (const width of [1280, 390])
		test(`${lang} ${width}: one reviewed send, a replacement and a withdrawal on both viewers`, async ({
			browser,
		}) => {
			test.setTimeout(120000);
			const ko = lang === "ko";
			const views: Look[] = [
				{ width: 1280, height: 900, device: "electron", orientation: "landscape", theme: "light", dpr: 1, lang },
				{ width: 390, height: 844, orientation: "portrait", theme: "light", dpr: 1, lang },
			];
			const surface = SURFACES.find(entry => entry.id === "question-inbox")!;
			const shots = process.env.OMP_GUI_QUESTION_INBOX_SHOTS;
			const pages: Page[] = [];
			let state: BotsState = { bots: [], items: [] };
			const push = () =>
				Promise.all(
					pages.map(page =>
						page.evaluate(([channel, next]) => window.__harness?.emit(channel, next), [
							BOTS_STATE,
							state,
						] as const),
					),
				);
			const items = () => [...state.items, ...(state.remote?.[0]?.items ?? [])];
			const sent: string[] = [];
			const command = async (request: BotsRequest): Promise<BotsState> => {
				if (request.action !== "item" || !request.answer) return state;
				const item = items().find(entry => entry.id === request.id);
				if (!item?.question || item.question.id !== request.answer.question)
					return { ...state, refused: "question_changed" };
				item.events.push({
					id: 100 + sent.length,
					at: new Date().toISOString(),
					actor: "owner",
					kind: "answered",
					text: request.answer.text,
					question: item.question.id,
					request: request.requestId,
				});
				item.status = "working";
				delete item.question;
				sent.push(item.id);
				await push();
				return state;
			};
			try {
				for (const look of views) {
					const page = await openLook(browser, look, { origin });
					pages.push(page);
					await page.exposeFunction("questionHost", command);
					await page.evaluate(() => {
						if (!window.__harness) throw new Error("No harness");
						window.__harness.bots = window.questionHost;
					});
					await surface.open(page, look);
					await expect(page.locator(surface.ready!)).toBeVisible();
					await expect(page.locator("[data-question-row]")).toHaveCount(0);
					if (look.width === width) await captureTo(shots, page, `${lang}-${width}-empty`);
				}
				state = questions(ko);
				await push();
				for (const [i, page] of pages.entries()) {
					await page.evaluate(ko => {
						for (const [id, kind, label] of [
							[
								"tab-1",
								"input",
								ko ? "어느 언어를 먼저 검토할까요?" : "Which language should be reviewed first?",
							],
							["tab-2", "approval", "Allow tool: review"],
						] as const) {
							const request =
								kind === "input"
									? { method: "input", title: label }
									: { method: "select", title: label, options: ["Approve", "Deny"] };
							window.__harness?.emit("extension-ui:request", {
								tabId: id,
								request: { id: `${kind}-request`, type: "extension_ui_request", ...request },
							});
							window.__harness?.summaries.tab(id, {
								status: "running",
								ask: kind,
								requests: [{ id: `${kind}-request`, kind, label, askedAt: Date.now() - 60000 }],
							});
						}
					}, ko);
					await expect(page.locator("[data-question-row]")).toHaveCount(7);
					await expect(page.locator('[data-question-row="item"]')).toHaveCount(5);
					if (views[i]?.width === width) await captureTo(shots, page, `${lang}-${width}-filled`);
				}
				const [desktop, phone] = pages as [Page, Page];
				await expect(desktop.locator('[data-sidebar-nav-row="questions"]:visible')).toContainText("7");
				await desktop.locator("[data-sidebar-bots-open]:visible").click();
				await desktop.locator('[data-bots-page-row="Maple"]').click();
				const botNeeds = desktop.locator("[data-bot-needs-you]");
				for (const item of state.items.filter(item => item.bot === "Maple")) {
					await expect(botNeeds.getByText(item.title, { exact: true })).toBeVisible();
				}
				await desktop.locator('[data-sidebar-nav-row="questions"]:visible').click();
				await desktop.locator('[data-question-row="ask"] button').click();
				await expect(desktop.locator('[data-board-waiting="input-request"]:visible')).toHaveCount(1);
				await desktop.locator('[data-sidebar-nav-row="questions"]:visible').click();
				const sender = width === 390 ? phone : desktop;
				const first = sender.locator('[data-item-id="question-0"] [role="radio"]').first();
				const secondCard = sender.locator('[data-item-id="question-1"] [role="radio"]').first();
				await secondCard.focus();
				await secondCard.press("1");
				await expect(secondCard).toBeChecked();
				await expect(secondCard).toBeFocused();
				await expect(first).not.toBeChecked();
				await secondCard.press("1");
				await expect(secondCard).not.toBeChecked();
				if (width === 390) {
					await phone.locator('[data-item-id="question-4"] textarea').focus();
					await phone.setViewportSize({ width, height: 495 });
					await expect(phone.locator("[data-inbox-send]")).toBeInViewport({ ratio: 1 });
					await phone.setViewportSize({ width, height: 844 });
				}
				await sender.locator("[data-inbox-recommend]").click();
				await expect(sender.locator("[data-inbox-send]")).toContainText("4");
				expect(sent).toEqual([]);
				const changed = items()[1]!;
				const newText = ko ? "새 문구도 번역할까요?" : "Translate the new message too?";
				changed.question = { id: 50, text: newText, options: [] };
				changed.events.push({ id: 50, kind: "asked", actor: "bot", at: new Date().toISOString(), text: newText });
				await push();
				await sender.locator("[data-inbox-send]").click();
				await expect.poll(() => sent.slice().sort()).toEqual(["question-0", "question-2", "question-3"]);
				for (const page of pages) {
					await expect(page.locator("[data-question-row]")).toHaveCount(4);
					await expect(page.getByText(newText, { exact: true }).first()).toBeVisible();
				}
				await expect(sender.locator('[data-inbox-outcome="sent"]')).toHaveCount(3);
				await expect(sender.locator('[data-inbox-outcome="changed"]')).toHaveCount(1);
				await expect(sender.locator("[data-inbox-outcome]").first()).toHaveAttribute(
					"data-inbox-outcome",
					"changed",
				);
				await expect(sender.locator("[data-question-inbox]").getByRole("status")).toHaveText(
					ko ? "전체 답변 4개 중 3개의 전송을 확인했어요." : "Answers confirmed sent: 3 of 4.",
				);
				await captureTo(shots, sender, `${lang}-${width}-partial`);
				await sender.getByRole("button", { name: ko ? "결과 닫기" : "Dismiss results" }).click();
				await expect(sender.locator("[data-inbox-outcome]")).toHaveCount(0);
				await expect(sender.getByText(newText, { exact: true }).first()).toBeVisible();
				const withdrawn = items()[4]!;
				withdrawn.events.push({
					id: 120,
					at: new Date().toISOString(),
					actor: "bot",
					kind: "withdrawn",
					question: withdrawn.question?.id,
					text: "Reviewer already assigned",
				});
				withdrawn.status = "working";
				delete withdrawn.question;
				await push();
				for (const page of pages) await expect(page.locator("[data-question-row]")).toHaveCount(3);
			} finally {
				await Promise.all(pages.map(page => page.context().close()));
			}
		});
}
