/**
 * A bot lives on the computer that made it and every paired computer lists it (orca-bots-remote; the owner's decision
 * of 27 Nov 2026). Two computers: B pairs with A through `linkProxy`.
 *
 * - A bot made on A, with an item asking its owner a question, is listed on B: in B's sidebar under its name with A's
 *   name beside it, and in B's bots state as A's (`remote`).
 * - B opens its chat: a tab of A on the bot's home chat.
 * - B answers the item's question, twice with one request id (a retry over the link): A records one answer.
 * - A goes out of reach: B still lists the bot, greyed, its owner label saying offline, and refuses a change.
 * - After reconnecting, B opens the same pre-upgrade chat from the host's bot row, not a duplicate project.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp, untilAnswered } from "./harness";
import {
	connectHost,
	freePort,
	launchRemote,
	linkProxy,
	makeRemoteProfile,
	type RemoteInstance,
	type RemoteProfile,
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

async function seedStoredBot(
	profile: RemoteProfile,
	bot: { id: string; name: string; folder: string },
	sessionId: string,
	text: string,
) {
	const journal = path.join(
		profile.env.PI_CODING_AGENT_DIR,
		"sessions",
		"fixture",
		`1761955200000_${sessionId}.jsonl`,
	);
	const timestamp = "2025-11-01T00:00:00.000Z";
	await fs.mkdir(path.dirname(journal), { recursive: true });
	await fs.writeFile(
		journal,
		[
			{ type: "session", version: 3, id: sessionId, timestamp, cwd: bot.folder },
			{
				type: "message",
				id: "handover",
				parentId: null,
				timestamp,
				message: { role: "user", content: text, timestamp: Date.parse(timestamp) },
			},
		]
			.map(entry => `${JSON.stringify(entry)}\n`)
			.join(""),
	);
	await fs.writeFile(
		path.join(profile.desktop, "bots.json"),
		JSON.stringify([{ ...bot, home: journal, sessions: [journal] }]),
	);
	return journal;
}

test("a bot made on one computer is listed, chatted with and answered on its paired computer, and reads offline", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bots-remote-")));
	const hostPort = await freePort();
	const proxy = await linkProxy(hostPort);
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const folder = path.join(parent, "old-workspace");
		const alias = "Dispatch archive";
		const old = { id: "bot-pre-upgrade", name: "Night clerk", folder };
		const oldId = "stored-night-shift";
		const text = "Handover from the previous shift";
		const home = path.join(parent, "host-home");
		const hostProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			port: hostPort,
			env: { HOME: home, USERPROFILE: home },
			prefs: { sidebar: { groupAliases: { [folder]: alias } } },
		});
		await Promise.all([fs.mkdir(folder), fs.mkdir(home)]);
		const journal = await seedStoredBot(hostProfile, old, oldId, text);
		const clientProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			port: Number(proxy.address.split(":")[1]),
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = host.page;
		const b = client.page;
		await a.evaluate(
			async ([legacy, human]) => {
				for (const path of [legacy, human]) await window.omp.sidebarProjects.command({ action: "add", path });
			},
			[folder, hostProfile.project] as const,
		);
		expect(await a.evaluate(() => window.omp.prefs.get("sidebar"))).toMatchObject({
			groupAliases: { [folder]: alias },
		});
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
		expect(offline.remote?.[0]?.bots.map(known => known.id).sort()).toEqual([courier.id, old.id].sort());
		await b.locator("[data-sidebar-bots-open]").click();
		await expect(pageRow.locator("[data-bot-offline]")).toHaveText("Studio · offline");
		await expect(
			b.evaluate(id => window.omp.bots.command({ action: "update", id, paused: true }), courier.id),
		).rejects.toThrow(/offline/);
		await b.screenshot({ path: "test-results/bots-remote-offline.png", scale: "css", animations: "disabled" });
		await proxy.restore();
		const legacyRow = b.locator(`[data-bot-entry="${old.id}"]`);
		await expect(legacyRow).toHaveCount(1);
		await expect(legacyRow.locator(`[data-bot-owner="${deviceId}"]`)).toHaveText("Studio", { timeout: 60_000 });
		await expect(legacyRow).toContainText(old.name);
		const device = b.locator(`[data-sidebar-device="${deviceId}"]`);
		const toggle = device.locator(`[data-sidebar-device-toggle="${deviceId}"]`);
		if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
		await expect(device.locator(`[data-device-group=${JSON.stringify(hostProfile.project)}]`)).toBeVisible();
		await expect(device.locator(`[data-device-group=${JSON.stringify(folder)}]`)).toHaveCount(0);
		const hostProjects = a.locator(".omp-session-sidebar [data-workspace-group]");
		await expect(a.locator(`[data-workspace-group=${JSON.stringify(hostProfile.project)}]`)).toBeVisible();
		await expect(a.locator(`[data-workspace-group=${JSON.stringify(folder)}]`)).toHaveCount(0);
		await expect(hostProjects.getByText(alias, { exact: true })).toHaveCount(0);
		await legacyRow.locator(`[data-bot-row="${old.id}"]`).click();
		const resumed = async () =>
			(await b.evaluate(() => window.omp.tabs.list())).find(
				tab => tab.device === deviceId && tab.active && tab.sessionPath === journal && tab.status === "ready",
			);
		await until(async () => Boolean(await resumed()), "B never reopened A's stored pre-upgrade chat");
		const tab = await resumed();
		if (!tab) throw new Error("The reopened chat closed before its journal could be read");
		const [state, history] = await b.evaluate(
			id =>
				Promise.all([
					window.omp.rpc.commandForTab(id, { type: "get_state" }),
					window.omp.rpc.commandForTab(id, { type: "get_branch_messages" }),
				]),
			tab.tabId,
		);
		expect(state).toMatchObject({ success: true, data: { sessionId: oldId, sessionFile: journal } });
		expect(history).toMatchObject({
			success: true,
			data: { messages: expect.arrayContaining([expect.objectContaining({ text })]) },
		});
		await test.info().attach("legacy-reconnected", {
			body: await b.screenshot({ scale: "css", animations: "disabled" }),
			contentType: "image/png",
		});
		expect(client.errors).toEqual([]);
	} finally {
		if (client) await exitApp(client.app).catch(() => undefined);
		if (host) await exitApp(host.app).catch(() => undefined);
		await proxy.close();
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
	}
});

test("paired bot chat omits quiet lookups live and after reopening, without hiding results, errors or questions", async () => {
	test.setTimeout(150_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paired-quiet-bot-")));
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const port = await freePort();
		const options = { language: "en", theme: "light", port } as const;
		const home = path.join(parent, "home");
		await fs.mkdir(home);
		const profile = await makeRemoteProfile(parent, "a", { ...options, env: { HOME: home, USERPROFILE: home } });
		const bot = { id: "quiet-courier", name: "Courier", folder: path.join(home, "courier") };
		await fs.mkdir(bot.folder);
		const journal = await seedStoredBot(profile, bot, "quiet-home", "Morning handover");
		host = await launchRemote(profile);
		const clientProfile = await makeRemoteProfile(parent, "b", options);
		client = await launchRemote(clientProfile);
		let b = client.page;
		const device = await connectHost(host.page, b, "Studio");
		const open = async () => {
			await b.locator(`[data-bot-row="${bot.id}"]`).click();
			const active = () => b.evaluate(async () => (await window.omp.tabs.list()).find(tab => tab.active));
			await expect.poll(active).toMatchObject({ sessionPath: journal, device, status: "ready" });
			const tab = await active();
			if (!tab) throw new Error("No active remote bot chat");
			return tab.tabId;
		};
		let id = await open();
		const prompt = (message: string) =>
			b.evaluate(([tab, text]) => window.omp.rpc.commandForTab(tab, { type: "prompt", message: text }), [
				id,
				message,
			] as const);
		const quote = "I am quoting NO_REPLY.";
		await prompt(quote);
		await untilAnswered(b, id, { after: quote });
		await expect(b.getByText(quote, { exact: true }).first()).toBeVisible();
		const before = await b.locator("[data-work-card]").count();
		for (const suffix of ["one", "two"]) {
			const text = `fixture quiet lookup ${suffix}`;
			await prompt(text);
			await untilAnswered(b, id, { after: text, text: "NO_REPLY" });
			await expect(b.getByText(text, { exact: true }).first()).toBeVisible();
		}
		const quiet = async () => {
			await expect(b.getByText("NO_REPLY", { exact: true })).toHaveCount(0);
			await expect(b.locator("[data-bot-quiet-reply]")).toHaveCount(0);
			await expect(b.locator("[data-work-card]")).toHaveCount(before);
			await expect(b.getByText("Local fixture reply", { exact: true }).last()).toBeVisible();
		};
		await quiet();
		await test.info().attach("paired-live", { body: await b.screenshot(), contentType: "image/png" });
		await exitApp(client.app);
		client = await launchRemote(clientProfile, { project: false });
		b = client.page;
		id = await open();
		await untilAnswered(b, id, { after: "fixture quiet lookup two", text: "NO_REPLY" });
		await expect(b.getByText(quote, { exact: true }).first()).toBeVisible();
		await quiet();
		await prompt("fixture transcript");
		const error = b.locator(".omp-message-error").last();
		await error.getByRole("button", { name: "Details" }).click();
		await expect(error.locator("pre")).toContainText("503 Service unavailable");
		await prompt("fixture ask");
		await expect(b.locator("[data-prompt-card]").filter({ hasText: "Where should this deploy?" })).toBeVisible();
		await test.info().attach("paired-reopened-controls", { body: await b.screenshot(), contentType: "image/png" });
	} finally {
		if (client) await exitApp(client.app).catch(() => undefined);
		if (host) await exitApp(host.app).catch(() => undefined);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
