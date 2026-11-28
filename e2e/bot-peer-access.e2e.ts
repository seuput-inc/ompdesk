import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { controlToolCaller, exitApp, pressShortcutUntilVisible, readRecords } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

async function review(page: Page) {
	const settings = page.locator("[data-settings-page]");
	if (!(await settings.isVisible())) await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="bots"]').click();
	await settings.getByRole("button", { name: "Set up paired access for existing bots" }).click();
	return page.getByRole("dialog", { name: "Set up paired access for existing bots" });
}

test("the first refused paired bot message asks the owner once; only an allowed bot receives a retry", async () => {
	test.setTimeout(300_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-peer-access-")));
	let owner: RemoteInstance | undefined;
	let peer: RemoteInstance | undefined;
	try {
		const a = await makeRemoteProfile(root, "owner", { language: "en", theme: "light" });
		const b = await makeRemoteProfile(root, "peer", {
			language: "en",
			theme: "light",
			port: a.port,
			prefs: { agentControlManage: true },
		});
		const fixture = [
			{ id: "bot-ada", name: "Ada", reach: [] },
			{ id: "bot-bess", name: "Bess", reach: [] },
			{ id: "bot-blocked", name: "Closed", reach: [], allPaired: false },
			{ id: "bot-list", name: "List", reach: ["another-peer"] },
		].map(bot => ({ ...bot, folder: path.join(root, bot.id) }));
		for (const bot of fixture) await fs.mkdir(bot.folder);
		await fs.writeFile(path.join(a.desktop, "bots.json"), JSON.stringify(fixture));
		await fs.writeFile(
			path.join(b.desktop, "bots.json"),
			JSON.stringify([{ id: "sender", name: "Courier", folder: b.project, allPaired: true }]),
		);
		owner = await launchRemote(a);
		const before = await review(owner.page);
		await expect(before.getByRole("checkbox")).toHaveCount(2);
		await before.getByRole("checkbox", { name: "Ada · bot-ada" }).check();
		await before.getByRole("button", { name: "Cancel" }).click();
		await owner.page.evaluate(() => window.omp.bots.command({ action: "update", id: "bot-list", name: "Renamed" }));
		await exitApp(owner.app);
		owner = await launchRemote(a);
		const local = owner.page;
		const afterRestart = await review(local);
		await expect(afterRestart.getByRole("checkbox")).toHaveCount(2);
		await expect(afterRestart.getByRole("checkbox", { name: "Ada · bot-ada" })).not.toBeChecked();
		await expect(afterRestart.getByRole("checkbox", { name: "Bess · bot-bess" })).not.toBeChecked();
		await afterRestart.getByRole("button", { name: "Cancel" }).click();
		await local.getByRole("button", { name: "Back to session" }).click();
		const freshFolder = path.join(root, "new");
		await local.evaluate(folder => window.omp.bots.command({ action: "create", name: "New", folder }), freshFolder);
		const homes = new Map<string, string>();
		for (const [name, folder] of [
			["Ada", fixture[0].folder],
			["New", freshFolder],
		] as const) {
			const id = randomUUID();
			const dir = path.join(a.env.PI_CODING_AGENT_DIR, "sessions", "fixture");
			await fs.mkdir(dir, { recursive: true });
			const file = path.join(dir, `2026-11-27T00-00-00Z_${id}.jsonl`);
			const timestamp = new Date().toISOString();
			await fs.writeFile(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: folder })}\n`);
			const tab = await local.evaluate(
				([cwd, sessionPath]) => window.omp.tabs.spawn({ cwd, sessionPath }),
				[folder, file],
			);
			expect(tab).toBeTruthy();
			const tabId = tab?.tabId ?? "";
			await expect
				.poll(async () => (await local.evaluate(() => window.omp.tabs.list())).find(t => t.tabId === tabId)?.status)
				.toBe("ready");
			await local.evaluate(
				t => window.omp.rpc.commandForTab(t, { type: "prompt", message: "Start the bot home chat" }),
				tabId,
			);
			await expect
				.poll(
					async () =>
						(await local.evaluate(() => window.omp.bots.command({ action: "get" }))).bots.find(
							bot => bot.name === name,
						)?.home,
				)
				.toBe(file);
			homes.set(name, file);
		}
		peer = await launchRemote(b);
		const client = peer.page;
		const sender = (await client.evaluate(() => window.omp.tabs.list())).find(tab => tab.active);
		if (!sender) throw new Error("The sending bot has no chat");
		await client.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "Start Courier" }),
			sender.tabId,
		);
		await expect
			.poll(async () => {
				const state = await client.evaluate(() => window.omp.bots.command({ action: "get" }));
				return state.bots.find(bot => bot.id === "sender")?.home;
			})
			.toBeTruthy();
		await client.evaluate(() => window.omp.remote.setDeviceName("Notebook"));
		await connectHost(local, client, "Studio");
		await expect
			.poll(async () => (await client.evaluate(() => window.omp.remote.getState())).hosts[0]?.state)
			.toBe("online");
		const call = await controlToolCaller(client, b.record, sender.tabId);
		const send = (bot: string, message: string, requestId = randomUUID()) =>
			call("ompdesk_session_send", { session: `bot:${bot}@Studio`, message, request_id: requestId });
		const delivered = async (bot: string) => {
			const id = randomUUID();
			const message = `Courier delivery ${id}`;
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await send(bot, message, id);
				expect(result.isError, result.text).toBe(false);
			}
			const file = homes.get(bot);
			if (!file) throw new Error(`No receiving journal for ${bot}`);
			await expect
				.poll(
					async () =>
						(await readRecords(file)).filter(
							entry => entry.type === "message" && JSON.stringify(entry.message).includes(message),
						).length,
				)
				.toBe(1);
		};
		const denied = async (bot: string) => {
			const result = await send(bot, `must not deliver to ${bot}`);
			expect(result.isError, result.text).toBe(true);
			return result.text;
		};
		const notices = local.locator("[data-legacy-peer-request]");
		await delivered("New");
		for (const bot of ["Closed", "Renamed"]) expect(await denied(bot)).toContain("does not take messages");
		await expect(notices).toHaveCount(0);

		expect(await denied("Ada")).toMatch(/owner can allow/i);
		const ada = local.locator('[data-legacy-peer-request="bot-ada"]');
		await expect(ada).toContainText("Ada");
		await expect(ada).toContainText("Notebook");
		expect(await denied("Ada")).not.toMatch(/owner can allow/i);
		await expect(notices).toHaveCount(1);
		await expect(client.locator("[data-legacy-peer-request]")).toHaveCount(0);
		await ada.getByRole("button", { name: "Allow paired computers", exact: true }).click();
		await expect(ada).toHaveCount(0);
		await delivered("Ada");
		expect(await fs.readFile(homes.get("Ada") ?? "", "utf8")).not.toContain("must not deliver to Ada");

		expect(await denied("Bess")).toMatch(/owner can allow/i);
		const bess = local.locator('[data-legacy-peer-request="bot-bess"]');
		await bess.getByRole("button", { name: "Only me", exact: true }).click();
		await expect(bess).toHaveCount(0);
		expect(await denied("Bess")).toContain("does not take messages");
		await expect(notices).toHaveCount(0);

		const id = (await local.evaluate(() => window.omp.remote.getState())).host.peers[0].deviceId;
		await local.evaluate(id => window.omp.remote.blockPeer(id), id);
		await expect
			.poll(async () => (await client.evaluate(() => window.omp.remote.getState())).hosts[0]?.state)
			.not.toBe("online");
		const revoked = await send("Ada", "revoked peer delivery");
		expect(revoked.isError, revoked.text).toBe(true);
		expect(await fs.readFile(homes.get("Ada") ?? "", "utf8")).not.toContain("revoked peer delivery");
	} finally {
		if (peer) await exitApp(peer.app);
		if (owner) await exitApp(owner.app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
