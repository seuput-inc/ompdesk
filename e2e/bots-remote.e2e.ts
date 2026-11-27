/**
 * A bot lives on the computer that made it and every paired computer lists it (orca-bots-remote; the owner's decision
 * of 27 Nov 2026). Two computers: B pairs with A through `linkProxy`.
 *
 * - A bot made on A, with an item asking its owner a question, is listed on B: in B's sidebar under its name with A's
 *   name beside it, and in B's bots state as A's (`remote`).
 * - B opens its chat: a tab of A on the bot's home chat.
 * - B answers the item's question, twice with one request id (a retry over the link): A records one answer.
 * - A goes out of reach: B still lists the bot, greyed, its owner label saying offline, and refuses a change.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp } from "./harness";
import {
	connectHost,
	freePort,
	launchRemote,
	linkProxy,
	makeRemoteProfile,
	type RemoteInstance,
} from "./remote-harness";

/** Checks `ready` until it holds (30 s); throws `what` when it never does. */
async function until(ready: () => Promise<boolean>, what: string): Promise<void> {
	await expect.poll(ready, { message: what, timeout: 30_000 }).toBe(true);
}

/** A: makes the bot and, from a chat in its folder (its home), an item that asks its owner which day. */
async function botWithQuestion(a: Page): Promise<{ id: string; home: string; folder: string }> {
	const made = await a.evaluate(() =>
		window.omp.bots.command({ action: "create", name: "Courier", purpose: "Carries notes between computers." }),
	);
	const bot = made.bots.find(known => known.name === "Courier");
	if (!bot) throw new Error("the bot was not made");
	const tabId = (await a.evaluate(cwd => window.omp.tabs.spawn({ cwd }), bot.folder))?.tabId;
	if (!tabId) throw new Error("no chat opened in the bot's folder");
	await until(
		async () =>
			(await a.evaluate(() => window.omp.tabs.list())).some(tab => tab.tabId === tabId && tab.status === "ready"),
		"the bot's chat never became ready",
	);
	// A chat with a turn in it: the host's session list holds only sessions with content, as the sidebar does.
	await a.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "Hello, Courier" }), tabId);
	const tool = (args: Record<string, unknown>) =>
		a.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
			tabId,
			`fixture:host-tool:ompdesk_item ${JSON.stringify(args)}`,
		] as const);
	await tool({ action: "add", title: "Pick a day" });
	await tool({ action: "set", item: "1", ask: "Which day?", options: ["Mon", "Tue"] });
	let home = "";
	await until(async () => {
		const state = await a.evaluate(() => window.omp.bots.command({ action: "get" }));
		home = state.bots.find(known => known.id === bot.id)?.home ?? "";
		return home !== "" && state.items.some(item => item.bot === bot.id && item.status === "needs_you");
	}, "the bot's question never arrived");
	await a.evaluate(id => window.omp.tabs.close(id), tabId);
	return { id: bot.id, home, folder: bot.folder };
}

test("a bot made on one computer is listed, chatted with and answered on its paired computer, and reads offline", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bots-remote-")));
	const hostPort = await freePort();
	const proxy = await linkProxy(hostPort);
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const hostProfile = await makeRemoteProfile(parent, "a", { language: "en", theme: "light", port: hostPort });
		const clientProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			port: Number(proxy.address.split(":")[1]),
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = host.page;
		const b = client.page;
		const deviceId = await connectHost(a, b, "Studio");
		const courier = await botWithQuestion(a);

		// B lists A's bot from the copy A shares, tagged with A, and its own bots are untouched.
		let question = 0;
		let itemId = "";
		await until(async () => {
			const state = await b.evaluate(() => window.omp.bots.command({ action: "get" }));
			const copy = state.remote?.find(entry => entry.device === deviceId);
			const item = copy?.items.find(entry => entry.bot === courier.id);
			question = item?.question?.id ?? 0;
			itemId = item?.id ?? "";
			return state.bots.length === 0 && copy?.bots.some(known => known.id === courier.id) === true && question > 0;
		}, "B never listed A's bot");
		const row = b.locator(`[data-bot-entry="${courier.id}"]`);
		await expect(row.locator(`[data-bot-owner="${deviceId}"]`)).toHaveText("Studio");
		// Its chats fold under its row, never as a project of A's section.
		await row.locator(`[data-bot-fold="${courier.id}"]`).click();
		await expect(row.getByRole("button", { name: "Home chat", exact: true })).toBeVisible();
		await expect(b.locator(`[data-device-group=${JSON.stringify(courier.folder)}]`)).toHaveCount(0);
		await b.screenshot({ path: "test-results/bots-remote-listed.png", scale: "css", animations: "disabled" });
		await b.locator("[data-sidebar-bots-open]").click();
		const pageRow = b.locator(`[data-bots-page-row="${courier.id}"]`);
		await expect(pageRow.locator(`[data-bot-owner="${deviceId}"]`)).toHaveText("Studio");

		// Its chat opens on A, as a tab of A on the bot's home chat.
		await row.locator(`[data-bot-row="${courier.id}"]`).click();
		await until(
			async () =>
				(await b.evaluate(() => window.omp.tabs.list())).some(
					tab => tab.device === deviceId && tab.sessionPath === courier.home,
				),
			"B never opened the bot's home chat on A",
		);

		// B answers the question; the same answer sent again (one request id) changes nothing on A.
		const answer = { action: "item" as const, id: itemId, answer: { choice: 1, question }, requestId: "b-answer-1" };
		for (let attempt = 0; attempt < 2; attempt++)
			await b.evaluate(request => window.omp.bots.command(request), answer);
		await until(async () => {
			const item = (await a.evaluate(() => window.omp.bots.command({ action: "get" }))).items.find(
				entry => entry.id === itemId,
			);
			return item?.status === "working";
		}, "the answer never reached A");
		const answered = (await a.evaluate(() => window.omp.bots.command({ action: "get" }))).items.find(
			entry => entry.id === itemId,
		);
		expect(answered?.events.filter(event => event.kind === "answered").map(event => event.text)).toEqual(["Tue"]);
		// B's copy follows A's.
		await until(async () => {
			const state = await b.evaluate(() => window.omp.bots.command({ action: "get" }));
			return state.remote?.[0]?.items.find(entry => entry.id === itemId)?.status === "working";
		}, "B's copy never followed A's answer");

		// A goes out of reach: B keeps listing the bot from its last copy, greyed and saying so.
		await proxy.drop();
		await expect(row.locator("[data-bot-offline]")).toHaveText("Studio · offline", { timeout: 60_000 });
		await expect(row.locator(".opacity-60")).toHaveCount(1);
		await until(
			async () => (await b.evaluate(() => window.omp.bots.command({ action: "get" }))).remote?.[0]?.online === false,
			"B never heard that A went away",
		);
		const offline = await b.evaluate(() => window.omp.bots.command({ action: "get" }));
		expect(offline.remote?.[0]?.bots.map(known => known.id)).toEqual([courier.id]);
		await b.locator("[data-sidebar-bots-open]").click();
		await expect(pageRow.locator("[data-bot-offline]")).toHaveText("Studio · offline");
		await expect(
			b.evaluate(id => window.omp.bots.command({ action: "update", id, paused: true }), courier.id),
		).rejects.toThrow(/offline/);
		await b.screenshot({ path: "test-results/bots-remote-offline.png", scale: "css", animations: "disabled" });
		expect(client.errors).toEqual([]);
	} finally {
		if (client) await exitApp(client.app).catch(() => undefined);
		if (host) await exitApp(host.app).catch(() => undefined);
		await proxy.close();
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
	}
});
