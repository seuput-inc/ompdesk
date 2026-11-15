import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page, Route } from "playwright";
import type { RpcCommand, RpcGetQueueResult } from "../src/shared/rpc-types";
import { exitApp, launchApp, recordsOfType } from "./harness";

// The preload and renderer reset state machines have unit coverage in shell-stream.test.ts and shell-resync.test.ts.
// This exercises their consumer across the CEF scheme handler and the real Node IPC host.
test("a replaced CEF event reader catches up without losing a draft, queue, or approvals", async () => {
	test.setTimeout(180_000);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-recovery-"));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const record = path.join(root, "rpc.jsonl");
	let app: ElectronApplication | undefined;
	const reconnect = Promise.withResolvers<void>();
	const firstRead = Promise.withResolvers<void>();
	const retryRead = Promise.withResolvers<void>();
	let reconnectHeld = false;
	let replacementsRouted = 0;
	let readsHeld = 0;
	let armReads = false;
	let firstRequest: Route | undefined;
	try {
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
		app = await launchApp({ project, desktop, agent, profile: root, env: { OMP_GUI_TEST_RECORD: record } });
		const page: Page = await app.firstWindow();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
		const tab = (await page.evaluate(() => window.omp.tabs.list())).find(item => item.active)?.tabId;
		if (!tab) throw new Error("No active fixture tab");
		const command = (cmd: RpcCommand) =>
			page.evaluate(([id, request]) => window.omp.rpc.commandForTab(id, request), [tab, cmd] as const);
		const run = async (cmd: RpcCommand) => {
			const result = await command(cmd);
			expect(result.success, JSON.stringify(result)).toBe(true);
			return result;
		};
		const queue = async () => (await run({ type: "get_queue" })).data as RpcGetQueueResult;
		const input = page.locator("textarea").first();
		await input.fill("fixture flow");
		await input.press("Enter");
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
		await run({ type: "follow_up", message: "Keep this queued message" });
		await run({ type: "follow_up", message: "Remove this queued message" });
		await expect(page.locator("[data-queue-pill]")).toContainText("2 queued");
		const original = await queue();
		const keep = original.followUp.find(item => item.text === "Keep this queued message");
		const remove = original.followUp.find(item => item.text === "Remove this queued message");
		if (!keep || !remove || keep.id === remove.id) throw new Error("Fixture queue did not assign distinct ids");
		const state = await run({ type: "get_state" });
		const sessionState = state.data as { sessionId?: string } | undefined;
		const sessionId = sessionState?.sessionId;
		if (!sessionId) throw new Error("Fixture tab has no session id");
		await run({ type: "bash", command: `fixture:flow:${JSON.stringify({ op: "ask" })}` });
		const oldCard = page
			.locator("[data-prompt-card]")
			.filter({ hasText: "Which environment should the checks use?" });
		await expect(oldCard).toHaveCount(1);
		await expect
			.poll(() =>
				page.evaluate(() => window.omp.ui.openRequests().then(items => items.map(item => item.request.id))),
			)
			.toContain("flow-ask-1");
		const draft = "Draft retained across the CEF reader gap";
		await input.fill(draft);
		await page.evaluate(() => {
			Reflect.set(window, "__recoveryDocument", document);
			const stream = Reflect.get(window, "__ompShellStream") as {
				pending(): object | null;
				onReset(listener: () => void): () => void;
			};
			if (!stream || stream.pending()) throw new Error("Expected an idle shell stream");
			stream.onReset(() => Reflect.set(window, "__recoveryToken", stream.pending()));
		});

		await page.route("**/__ipc/events", async route => {
			if (route.request().headers()["x-omp-recovery-test"] === "replace") {
				replacementsRouted++;
				await route.continue();
				return;
			}
			reconnectHeld = true;
			await reconnect.promise;
			await route.continue();
		});
		await page.route("**/__ipc/invoke", async route => {
			const body = route.request().postDataJSON() as { channel?: string } | null;
			if (!armReads || body?.channel !== "extension-ui:open") {
				await route.continue();
				return;
			}
			readsHeld++;
			if (readsHeld === 1) {
				firstRequest = route;
				await firstRead.promise;
				await route.abort("failed");
			} else if (readsHeld === 2) {
				await retryRead.promise;
				await route.continue();
			} else await route.continue();
		});
		await page.evaluate(() => {
			const controller = new AbortController();
			Reflect.set(window, "__recoveryFetch", controller);
			Reflect.set(window, "__recoveryFetchResult", { state: "pending" });
			void fetch("app://ompdesk/__ipc/events", {
				headers: { "x-omp-recovery-test": "replace" },
				signal: controller.signal,
			}).then(
				response => Reflect.set(window, "__recoveryFetchResult", { state: "open", status: response.status }),
				error => Reflect.set(window, "__recoveryFetchResult", { state: "failed", error: String(error) }),
			);
		});
		await expect
			.poll(
				async () => ({
					reconnectHeld,
					replacementsRouted,
					replacement: await page.evaluate(() => Reflect.get(window, "__recoveryFetchResult")),
				}),
				{
					timeout: 30_000,
					message: "CEF events reconnect was not intercepted after the real reader replacement",
				},
			)
			.toMatchObject({ reconnectHeld: true });

		await run({ type: "queue_remove", queueId: remove.id });
		await run({ type: "follow_up", message: "Added while events were disconnected" });
		await page.evaluate(
			id =>
				window.omp.ui.respondExtensionUi(
					{
						type: "extension_ui_response",
						id: "flow-ask-1",
						answers: [{ id: "target", selectedOptions: ["Staging"] }],
					},
					id,
				),
			tab,
		);
		await run({ type: "bash", command: "fixture:confirm" });
		await expect
			.poll(() =>
				page.evaluate(() => window.omp.ui.openRequests().then(items => items.map(item => item.request.id))),
			)
			.toEqual(["fixture-confirm"]);
		const authoritative = await queue();
		expect(authoritative.followUp.map(item => item.text)).toEqual([
			"Keep this queued message",
			"Added while events were disconnected",
		]);
		expect(authoritative.followUp[0]?.id).toBe(keep.id);
		armReads = true;
		reconnect.resolve();
		await expect
			.poll(() => readsHeld, { timeout: 30_000, message: "CEF strict open-requests read was not intercepted" })
			.toBe(1);
		await page.evaluate(() => {
			const controller = Reflect.get(window, "__recoveryFetch") as AbortController;
			controller.abort();
		});
		await expect
			.poll(() =>
				page.evaluate(() => {
					const stream = Reflect.get(window, "__ompShellStream") as { pending(): object | null };
					return stream.pending() !== null && stream.pending() === Reflect.get(window, "__recoveryToken");
				}),
			)
			.toBe(true);
		expect(firstRequest).toBeDefined();
		firstRead.resolve();
		await expect.poll(() => readsHeld, { timeout: 30_000, message: "A failed strict read did not retry" }).toBe(2);
		expect(
			await page.evaluate(() => {
				const stream = Reflect.get(window, "__ompShellStream") as { pending(): object | null };
				return stream.pending() !== null && stream.pending() === Reflect.get(window, "__recoveryToken");
			}),
		).toBe(true);
		const successfulRead = page.waitForResponse(
			response =>
				response.url().endsWith("/__ipc/invoke") &&
				response.request().postDataJSON()?.channel === "extension-ui:open",
			{ timeout: 30_000 },
		);
		retryRead.resolve();
		const response = await successfulRead;
		expect(response.ok()).toBe(true);
		expect(await response.json()).toHaveProperty("value");
		await expect
			.poll(
				() =>
					page.evaluate(() => {
						const stream = Reflect.get(window, "__ompShellStream") as { pending(): object | null };
						return stream.pending() === null;
					}),
				{ timeout: 30_000 },
			)
			.toBe(true);
		expect(await page.evaluate(() => document === Reflect.get(window, "__recoveryDocument"))).toBe(true);
		expect((await page.evaluate(() => window.omp.tabs.list())).find(item => item.active)?.tabId).toBe(tab);
		const recoveredState = (await run({ type: "get_state" })).data as { sessionId?: string };
		expect(recoveredState.sessionId).toBe(sessionId);
		await expect(input).toHaveValue(draft);
		expect((await queue()).followUp).toEqual(authoritative.followUp);
		await expect(page.locator("[data-queue-pill]")).toContainText("2 queued");
		await test.info().attach("cef-recovered-state", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
		await page.locator("[data-queue-pill]").click();
		await expect(page.locator("[data-queue-row]").filter({ hasText: "Keep this queued message" })).toHaveCount(1);
		await expect(
			page.locator("[data-queue-row]").filter({ hasText: "Added while events were disconnected" }),
		).toHaveCount(1);
		await expect(page.locator("[data-queue-row]").filter({ hasText: "Remove this queued message" })).toHaveCount(0);
		await page.getByRole("button", { name: "More actions: Keep this queued message" }).click();
		await page.getByRole("menuitem", { name: "Remove" }).click();
		await expect
			.poll(async () => (await queue()).followUp.map(item => item.id))
			.toEqual([authoritative.followUp[1]?.id]);
		await expect(oldCard).toHaveCount(0);
		const confirm = page.getByRole("region", { name: "Deploy to staging?" });
		await expect(confirm).toHaveCount(1);
		await confirm.getByRole("button", { name: "Approve", exact: true }).click();
		await expect(confirm).toHaveCount(0);
		await expect
			.poll(async () =>
				(await recordsOfType(record, "extension_ui_response")).filter(item => item.id === "fixture-confirm"),
			)
			.toEqual([{ type: "extension_ui_response", id: "fixture-confirm", confirmed: true, recordedBy: sessionId }]);
		await expect
			.poll(async () =>
				(await recordsOfType(record, "extension_ui_response")).filter(item => item.id === "flow-ask-1"),
			)
			.toHaveLength(1);
	} finally {
		reconnect.resolve();
		firstRead.resolve();
		retryRead.resolve();
		if (app) await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
