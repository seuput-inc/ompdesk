import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { controlToolCaller, exitApp, pressShortcutUntilVisible } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

async function review(page: Page) {
	const settings = page.locator("[data-settings-page]");
	if (!(await settings.isVisible())) await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="bots"]').click();
	await settings.getByRole("button", { name: "Set up paired access for existing bots" }).click();
	return page.getByRole("dialog", { name: "Set up paired access for existing bots" });
}

test("only the owner-selected legacy bots accept messages from an authenticated peer", async () => {
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
		await connectHost(local, client, "Studio");
		await expect
			.poll(async () => (await client.evaluate(() => window.omp.remote.getState())).hosts[0]?.state)
			.toBe("online");
		const call = await controlToolCaller(client, b.record);
		const send = (bot: string, message: string) =>
			call("ompdesk_session_send", { session: `bot:${bot}@Studio`, message });
		const delivered = async (bot: string, message: string) => {
			const result = await send(bot, message);
			expect(result.isError, result.text).toBe(false);
			await expect.poll(() => fs.readFile(homes.get(bot) ?? "", "utf8")).toContain(message);
		};
		const denied = async (bot: string) => {
			const result = await send(bot, `must not deliver to ${bot}`);
			expect(result.isError, result.text).toBe(true);
			expect(result.text).toContain("does not take messages");
		};
		await delivered("New", "new peer delivery");
		await denied("Ada");
		await denied("Closed");
		await denied("Renamed");
		const dialog = await review(local);
		await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
		await dialog.getByRole("checkbox", { name: "Ada · bot-ada" }).check();
		await dialog.getByRole("button", { name: "Apply" }).click();
		await expect(dialog).toHaveCount(0);
		await delivered("Ada", "chosen peer delivery");
		await denied("Bess");
		await denied("Closed");
		const id = (await local.evaluate(() => window.omp.remote.getState())).host.peers[0].deviceId;
		await local.evaluate(id => window.omp.remote.blockPeer(id), id);
		await expect
			.poll(async () => (await client.evaluate(() => window.omp.remote.getState())).hosts[0]?.state)
			.not.toBe("online");
		const revoked = await send("New", "revoked peer delivery");
		expect(revoked.isError, revoked.text).toBe(true);
		expect(await fs.readFile(homes.get("New") ?? "", "utf8")).not.toContain("revoked peer delivery");
	} finally {
		if (peer) await exitApp(peer.app);
		if (owner) await exitApp(owner.app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
