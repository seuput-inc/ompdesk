import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp } from "./harness";
import { launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

test("a legacy profile keeps its bot identities, template setup and original files across restart", async () => {
	test.setTimeout(180_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-face-upgrade-")));
	const home = path.join(parent, "home");
	const profile = await makeRemoteProfile(parent, "old", {
		language: "en",
		theme: "light",
		env: { HOME: home, USERPROFILE: home },
	});
	const records = [
		{ id: "bot-old-managed", name: "Courier", folder: path.join(home, ".omp", "bots", "courier") },
		{ id: "bot-old-custom", name: "Scout", folder: path.join(parent, "my-artwork") },
	];
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
		"base64",
	);
	const original = path.join(parent, "uploaded-red-pixel.png");
	const digest = async (file: string) =>
		createHash("sha256")
			.update(await fs.readFile(file))
			.digest("hex");
	const evidence: { stage: string; botId: string; faceId: string | null; sourceSha256: string; copySha256: string }[] =
		[];
	let app: RemoteInstance | null = null;
	try {
		await fs.writeFile(original, png);
		const before = await digest(original);
		for (const bot of records) {
			await fs.mkdir(bot.folder, { recursive: true });
			await fs.copyFile(original, path.join(bot.folder, "picture.png"));
		}
		await fs.writeFile(path.join(profile.desktop, "bots.json"), JSON.stringify(records));
		let created = "";
		for (const restart of [false, true]) {
			app = await launchRemote(profile);
			const page = app.page;
			for (const bot of records) {
				const row = page.locator(`[data-bot-entry="${bot.id}"]`);
				const face = row.locator(`[data-bot-face="${bot.id}"]`);
				await expect(face).toBeVisible();
				const sourceSha256 = await digest(original);
				const copySha256 = await digest(path.join(bot.folder, "picture.png"));
				expect(sourceSha256).toBe(before);
				expect(copySha256).toBe(before);
				evidence.push({
					stage: restart ? "reopened" : "upgrade",
					botId: bot.id,
					faceId: await face.getAttribute("data-bot-face"),
					sourceSha256,
					copySha256,
				});
			}
			if (restart) {
				await test
					.info()
					.attach("legacy-face-reopened", { body: await page.screenshot(), contentType: "image/png" });
			}
			if (!restart) {
				await page.locator("[data-sidebar-bots-open]").click();
				await page.getByRole("button", { name: "New bot", exact: true }).last().click();
				await page.getByText("Browse templates", { exact: true }).last().click();
				await page.locator("[data-bot-template-use]").click();
				const form = page.locator("[data-new-bot]");
				await form.getByLabel("Name", { exact: true }).fill("Template courier");
				await expect(form.locator('input[type="file"]')).toHaveCount(0);
				await page.locator("[data-new-bot-create]").click();
				await expect
					.poll(
						async () => {
							const state = await page.evaluate(() => window.omp.bots.command({ action: "get" }));
							created = state.bots.find(bot => bot.name === "Template courier")?.id ?? "";
							return created !== "";
						},
						{ message: "the template did not create a bot", timeout: 30_000 },
					)
					.toBe(true);
			}
			await expect(page.locator(`[data-bot-entry="${created}"] [data-bot-face="${created}"]`)).toBeVisible();
			const state = await page.evaluate(() => window.omp.bots.command({ action: "get" }));
			expect(state.bots.every(bot => !("picture" in bot))).toBe(true);
			await exitApp(app.app);
			app = null;
		}
		await test.info().attach("legacy-face-hashes", {
			body: JSON.stringify({ commit: process.env.GITHUB_SHA, before, evidence }, null, 2),
			contentType: "application/json",
		});
	} finally {
		if (app) await exitApp(app.app).catch(() => undefined);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
