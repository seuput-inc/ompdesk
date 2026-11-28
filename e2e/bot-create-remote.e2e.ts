import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { BOTS_FOLDER } from "../src/shared/bots";
import { exitApp } from "./harness";
import { connectHost, freePort, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

const botState = (page: Page) => page.evaluate(() => window.omp.bots.command({ action: "get" }));
const name = "Studio courier";
const label = "Dependency check";
const wait = { timeout: 60_000 };

async function readRegistry(desktop: string): Promise<{ id: string; home: string; folder: string }[]> {
	try {
		return JSON.parse(await fs.readFile(path.join(desktop, "bots.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function kickoffIds(file: string, folder: string) {
	const entries = (await fs.readFile(file, "utf8"))
		.trimEnd()
		.split("\n")
		.map(line => JSON.parse(line));
	const header = entries.find(entry => entry.type === "session");
	expect(header, "missing session header").toBeDefined();
	expect(path.resolve(header.cwd)).toBe(path.resolve(folder));
	return entries
		.map(e => e.message ?? e)
		.filter(m => m.customType === "ompdesk.mail" && m.details?.id?.startsWith("peer-kickoff-"))
		.map(m => m.details.id as string);
}

async function showRoutine(page: Page, id: string) {
	await page.locator("[data-sidebar-bots-open]").click();
	await page.locator(`[data-bots-page-row="${id}"]`).click();
	const pane = page.locator(`[data-bot-pane="${id}"]`);
	await pane.getByRole("tab", { name: "Activity" }).click();
	return pane.locator("[data-bot-automations] .omp-list-row").filter({ hasText: label });
}

test("creating a template bot writes only to the selected loopback profile (desktop, en)", {
	tag: "@smoke",
}, async () => {
	test.setTimeout(240_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paired-new-bot-")));
	let a: RemoteInstance | undefined;
	let b: RemoteInstance | undefined;
	try {
		const port = await freePort();
		const profile = (side: string) => {
			const home = path.join(root, side);
			return makeRemoteProfile(root, side, {
				language: "en",
				theme: "light",
				port,
				env: { HOME: home, USERPROFILE: home, PI_CONFIG_DIR: "." },
			});
		};
		const [creator, owner] = await Promise.all([profile("a"), profile("b")]);
		b = await launchRemote(owner);
		a = await launchRemote(creator);
		const host = b.page;
		const client = a.page;
		const device = await connectHost(host, client, "Studio");
		await client.locator("[data-sidebar-bots-open]").click();
		await client.locator("[data-bots-page]").getByRole("button", { name: "New bot", exact: true }).click();
		const form = client.locator("[data-new-bot]");
		const computer = form.getByRole("combobox", { name: "Computer", exact: true });
		await expect(computer.locator(`option[value="${device}"]`)).toBeEnabled(wait);
		await computer.selectOption(device);
		await client.getByRole("dialog").getByRole("button", { name: "Templates", exact: true }).click();
		await client.locator('[data-bot-template="dependency-updates"]').click();
		await client.locator("[data-bot-template-use]").click();
		await expect(computer).toHaveValue(device);
		await expect(form.getByText("Routines start off. Turn them on at Studio.")).toBeVisible();
		const input = form.getByRole("textbox", { name: "Name", exact: true });
		await input.fill(name);
		await client.locator("[data-new-bot-create]").click();
		await expect(form).toHaveCount(0, wait);
		await expect
			.poll(async () => (await botState(host)).bots, wait)
			.toEqual([expect.objectContaining({ name, home: expect.stringMatching(/.+/) })]);
		const [bot] = (await botState(host)).bots;
		if (!bot.home) throw new Error("B did not register its observed home");
		const home = bot.home;
		expect(path.dirname(await fs.realpath(bot.folder))).toBe(path.join(owner.root, BOTS_FOLDER));
		expect(await fs.realpath(home)).toContain(`${owner.env.PI_CODING_AGENT_DIR}${path.sep}`);
		expect(await fs.readFile(path.join(bot.folder, "SOUL.md"), "utf8")).toContain("dependencies");
		expect(
			await fs.readFile(path.join(bot.folder, ".omp", "skills", "dependency-upgrade", "SKILL.md"), "utf8"),
		).not.toBe("");
		// A fresh template has no memory facts. Save one through the app rather than pre-seeding either profile.
		const memory = "Use Monday for dependency reports.";
		await host.evaluate(
			([id, content]) => window.omp.bots.file({ id, file: "MEMORY.md", content }),
			[bot.id, memory],
		);
		expect(await fs.readFile(path.join(bot.folder, "MEMORY.md"), "utf8")).toBe(memory);
		const record = expect.objectContaining({ id: bot.id, home, folder: bot.folder });
		const checkPlacement = async (viewer: Page) => {
			expect(await readRegistry(owner.desktop)).toEqual([record]);
			expect(await readRegistry(creator.desktop)).toEqual([]);
			await expect(fs.stat(path.join(creator.root, BOTS_FOLDER, path.basename(bot.folder)))).rejects.toMatchObject({
				code: "ENOENT",
			});
			const view = await botState(viewer);
			expect(view.bots).toEqual([]);
			expect(view.remote?.find(r => r.device === device)?.bots).toEqual([record]);
		};
		const active = (page: Page) => page.evaluate(async () => (await window.omp.tabs.list()).find(tab => tab.active));
		const expectedTab = { device, sessionPath: home, status: "ready" };
		await expect.poll(() => active(client), wait).toMatchObject(expectedTab);
		await expect.poll(() => kickoffIds(home, bot.folder), wait).toHaveLength(1);
		const ids = await kickoffIds(home, bot.folder);
		await expect.poll(async () => (await botState(host)).bots[0]?.peerPending, wait).toBeUndefined();
		const peerRow = await showRoutine(client, bot.id);
		await expect(peerRow.getByText("Turn on at Studio", { exact: true })).toBeVisible();
		await expect(peerRow.getByText("Off", { exact: true })).toBeVisible();
		await expect(peerRow.getByRole("button", { name: "Run now" })).toHaveCount(0);
		await checkPlacement(client);
		const routine = (await host.evaluate(() => window.omp.schedules.command({ action: "get" }))).schedules.find(
			s => s.wakeSession === home && s.name === `${name}: ${label}`,
		);
		if (!routine) throw new Error("B did not save the template routine at its home");
		expect(routine.enabled).toBe(false);
		for (const action of ["setEnabled", "runNow"] as const) {
			await expect(
				client.evaluate(
					({ action, id, device }) =>
						window.omp.schedules.command(
							action === "setEnabled" ? { action, id, enabled: true } : { action, id },
							device,
						),
					{ action, id: routine.id, device },
				),
			).rejects.toThrow("Turn this bot routine on in a window on its host computer first.");
		}
		const hostRow = await showRoutine(host, bot.id);
		await hostRow.getByText(label, { exact: true }).click();
		await expect(peerRow.getByText("On", { exact: true })).toBeVisible(wait);
		await expect(peerRow.getByText("Turn on at Studio", { exact: true })).toHaveCount(0);
		await client.locator(".omp-page-header").getByRole("button", { name: "New bot", exact: true }).click();
		await client.getByRole("menuitem", { name: "New bot", exact: true }).click();
		await expect(computer).toHaveValue(device);
		await input.fill(name);
		await client.locator("[data-new-bot-create]").click();
		await expect(
			form.getByText(`A bot named “${name}” already exists on Studio. Choose another name.`),
		).toBeVisible();
		await expect(input).toBeFocused();
		await client.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
		await exitApp(a.app);
		a = undefined;
		await exitApp(b.app);
		b = undefined;
		b = await launchRemote(owner, { project: false });
		a = await launchRemote(creator, { project: false });
		const reopened = a.page;
		await expect(reopened.locator(`[data-sidebar-device="${device}"]`)).toHaveAttribute(
			"data-device-state",
			"online",
			wait,
		);
		await reopened.locator(`[data-bot-row="${bot.id}"]`).click();
		await expect.poll(() => active(reopened), wait).toMatchObject(expectedTab);
		await checkPlacement(reopened);
		expect(await kickoffIds(home, bot.folder)).toEqual(ids);
	} finally {
		if (a) await exitApp(a.app).catch(() => undefined);
		if (b) await exitApp(b.app).catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
