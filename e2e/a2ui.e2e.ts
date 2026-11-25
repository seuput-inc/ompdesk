/**
 * The A2UI answer path (docs/design/a2ui.md §2) across the wire: the host's fake omp raises `fixture a2ui form` as the
 * bridge's `a2ui` tool waits on the person (an `a2ui` call, then stock's blocking form with the marker html,
 * e2e/fixture/rpc-ui.ts), and the answer comes back from the card in the chat. One host window (B), a paired computer
 * viewing B's session (A) and B's phone page, sequentially: the window answers; the dock's Skip dismisses; the phone
 * answers while the window and the paired view go inert; an older client's plain-text answer still ends the call.
 * The card's drawing, checks and replay are component tests (A2uiRenderer.test.tsx, src/renderer/lib/a2ui/**), the
 * dock row ExtensionDialog.test.tsx, the answer's parsing resources/gui-bridge/modes/a2ui-core's tests.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Page, test } from "@playwright/test";
import { A2UI_ANSWER_FIELD, a2uiMarkerToolCallId } from "../resources/gui-bridge/modes/a2ui-contracts";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { cssString, exitApp, recordsOfType } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, REMOTE_LOGIN, type RemoteInstance } from "./remote-harness";

const ANSWERED = "A2UI form answered.";

/** The marker form `page` holds open: its request id, the tab it asks in and the `a2ui` call it waits for. */
async function pendingForm(page: Page): Promise<{ id: string; tabId: string; callId: string }> {
	let found: { id: string; tabId: string; callId: string } | undefined;
	await expect
		.poll(
			async () => {
				for (const { request, tabId } of await page.evaluate(() => window.omp.ui.openRequests())) {
					const callId = request.method === "form" ? a2uiMarkerToolCallId(request.html) : undefined;
					if (callId) found = { id: request.id, tabId, callId };
				}
				return found !== undefined;
			},
			{ timeout: 30_000 },
		)
		.toBe(true);
	if (!found) throw new Error("no marker form open");
	return found;
}

/** The texts of the `a2ui` tool results in the transcript of `tabId`, oldest first. */
async function a2uiResults(page: Page, tabId: string): Promise<string[]> {
	return page.evaluate(async id => {
		const response = await window.omp.rpc.commandForTab(id, {
			type: "get_transcript_page",
			fromEnd: true,
			limit: 50,
		});
		const messages =
			(response.data as { messages?: { role: string; toolName?: string; content?: unknown }[] } | undefined)
				?.messages ?? [];
		return messages
			.filter(message => message.role === "toolResult" && message.toolName === "a2ui")
			.map(message =>
				Array.isArray(message.content)
					? message.content.map(part => (part?.type === "text" ? String(part.text) : "")).join("")
					: String(message.content ?? ""),
			);
	}, tabId);
}

/** B's composer sends `fixture a2ui form`, as a person types it. */
async function askForm(b: Page): Promise<void> {
	const input = b.locator("[data-composer-input]").first();
	await input.fill("fixture a2ui form");
	await input.press("Enter");
}

test("an A2UI form is answered from the chat card, skipped from the dock, answered from the phone and by an older client's text", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-a2ui-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	let proxy: ServeProxy | undefined;
	let browser: Browser | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const b = host.page;
		const a = client.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const deviceId = await connectHost(b, a, "PC-B");
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, { timeout: 30_000 })
			.toBe("online");

		let sessionPath = "";
		let tabId = "";
		await test.step("the window answers from the card: Send waits for the name, the answer ends the call", async () => {
			await askForm(b);
			const form = await pendingForm(b);
			tabId = form.tabId;
			await expect(b.locator(`[data-a2ui-waiting=${cssString(form.callId)}]`)).toBeVisible({ timeout: 30_000 });
			await expect(b.locator("[data-prompt-card]")).toHaveCount(0);
			await expect
				.poll(
					async () =>
						(sessionPath =
							(await b.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === form.tabId)
								?.sessionPath ?? ""),
					{ timeout: 30_000 },
				)
				.not.toBe("");
			// The session needs the person: its sidebar row says so, as for an ask card.
			const row = b
				.locator(
					`.omp-session-sidebar [data-session-path=${cssString(sessionPath)}]:not([data-sidebar-opened-session])`,
				)
				.first();
			await expect(row).toHaveAttribute("data-signal", "waiting", { timeout: 30_000 });

			const card = b.locator(`[data-a2ui-call=${cssString(form.callId)}]`);
			await expect(card).toHaveAttribute("data-a2ui-live", "");
			await expect(card.locator('[data-a2ui-surface="contact"]')).toBeVisible();
			const send = card.getByRole("button", { name: "Send", exact: true });
			await expect(send).toBeDisabled();
			await card.getByLabel("Name").fill("Ada Lovelace");
			await expect(send).toBeEnabled();
			await send.click();

			await expect(b.getByText(ANSWERED, { exact: true }).last()).toBeVisible({ timeout: 30_000 });
			await expect(card.locator("[data-a2ui-sent]")).toContainText("submit");
			await expect(card.locator("[data-a2ui-pressed]")).toHaveCount(1);
			await expect(card).not.toHaveAttribute("data-a2ui-live");
			await expect(card.getByLabel("Name")).toBeDisabled();
			await expect(b.locator("[data-a2ui-waiting]")).toHaveCount(0);
			await expect(row).not.toHaveAttribute("data-signal", "waiting");

			const sent = (await recordsOfType(hostProfile.record, "extension_ui_response")).filter(
				record => record.id === form.id,
			);
			expect(sent).toHaveLength(1);
			const data = sent[0]?.data as Record<string, unknown> | undefined;
			expect(JSON.parse(String(data?.[A2UI_ANSWER_FIELD]))).toMatchObject({
				name: "submit",
				surfaceId: "contact",
				sourceComponentId: "send",
				context: { name: "Ada Lovelace" },
				dataModel: { name: "Ada Lovelace", plan: ["free"] },
			});
			const results = await a2uiResults(b, tabId);
			expect(results).toHaveLength(1);
			expect(results[0]).toContain('The person pressed send (action "submit") on surface contact.');
			expect(results[0]).toContain("Ada Lovelace");
		});

		await test.step("Skip in the dock dismisses the form", async () => {
			await askForm(b);
			const form = await pendingForm(b);
			const card = b.locator(`[data-a2ui-call=${cssString(form.callId)}]`);
			await expect(card).toHaveAttribute("data-a2ui-live", "", { timeout: 30_000 });
			await b.locator("[data-a2ui-dock-skip]").click();
			await expect(card.locator("[data-a2ui-dismissed]")).toBeVisible({ timeout: 30_000 });
			await expect(card).not.toHaveAttribute("data-a2ui-live");
			await expect(b.locator("[data-a2ui-waiting]")).toHaveCount(0);
			await expect.poll(() => a2uiResults(b, tabId), { timeout: 30_000 }).toHaveLength(2);
			expect((await a2uiResults(b, tabId))[1]).toBe("The person dismissed the surface without acting.");
		});

		await test.step("the phone answers; the window and the paired computer's view go inert", async () => {
			// A views B's session from B's section of its sidebar.
			const row = a.locator(`[data-sidebar-device="${deviceId}"] [data-device-session=${cssString(sessionPath)}]`);
			await expect(row).toHaveCount(1, { timeout: 30_000 });
			await row.locator("button").first().click();
			await expect
				.poll(async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.sessionPath, {
					timeout: 30_000,
				})
				.toBe(sessionPath);

			// B's phone page on the same session.
			await b.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
			await expect
				.poll(() => b.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
				.toBe("ready");
			await expect.poll(() => serveSites(hostProfile.tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
			const site = serveSites(hostProfile.tailscale).at(-1);
			if (!site) throw new Error("B's Mobile web published no serve handler");
			proxy = await ServeProxy.start(site, REMOTE_LOGIN);
			browser = await chromium.launch();
			const phone = await (await browser.newContext({ ...devices["Pixel 7"], colorScheme: "light" })).newPage();
			await phone.goto(`${proxy.url}/`, { timeout: 60_000 });
			await phonePaired(phone);
			const tab = await phone.evaluate(spawn => window.omp.tabs.spawn(spawn), {
				cwd: hostProfile.project,
				sessionPath,
			});
			if (!tab?.tabId) throw new Error(`the phone could not view the session: ${JSON.stringify(tab)}`);
			await phone.goto(`${proxy.url}/#/open?tab=${tab.tabId}`);
			await expect
				.poll(async () => (await phone.evaluate(() => window.omp.tabs.list())).find(entry => entry.active)?.tabId, {
					timeout: 30_000,
				})
				.toBe(tab.tabId);

			await askForm(b);
			const form = await pendingForm(b);
			const cardOf = (page: Page) => page.locator(`[data-a2ui-call=${cssString(form.callId)}]`);
			for (const page of [b, a, phone])
				await expect(cardOf(page)).toHaveAttribute("data-a2ui-live", "", { timeout: 30_000 });
			await cardOf(phone).getByLabel("Name").fill("Grace Hopper");
			await cardOf(phone).getByRole("button", { name: "Send", exact: true }).click();

			for (const page of [b, a, phone]) {
				await expect(cardOf(page).locator("[data-a2ui-sent]")).toBeVisible({ timeout: 30_000 });
				await expect(cardOf(page)).not.toHaveAttribute("data-a2ui-live");
				await expect(page.locator("[data-a2ui-waiting]")).toHaveCount(0);
			}
			await expect.poll(() => a2uiResults(b, tabId), { timeout: 30_000 }).toHaveLength(3);
			expect((await a2uiResults(b, tabId))[2]).toContain("Grace Hopper");
			expect(
				(await recordsOfType(hostProfile.record, "extension_ui_response")).filter(record => record.id === form.id),
			).toHaveLength(1);
		});

		await test.step("an older client's plain-text answer ends the call as text", async () => {
			await askForm(b);
			const form = await pendingForm(b);
			await b.evaluate(
				({ id, tab, field }) =>
					window.omp.ui.respondExtensionUi(
						{ type: "extension_ui_response", id, data: { [field]: "plain words" } },
						tab,
					),
				{ id: form.id, tab: form.tabId, field: A2UI_ANSWER_FIELD },
			);
			await expect.poll(() => a2uiResults(b, tabId), { timeout: 30_000 }).toHaveLength(4);
			expect((await a2uiResults(b, tabId))[3]).toContain("plain words");
			await expect(b.locator(`[data-a2ui-call=${cssString(form.callId)}]`)).not.toHaveAttribute("data-a2ui-live", {
				timeout: 30_000,
			});
			await expect(b.locator("[data-a2ui-waiting]")).toHaveCount(0);
		});
	} finally {
		await browser?.close().catch(() => undefined);
		await proxy?.close().catch(() => undefined);
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
	}
});
