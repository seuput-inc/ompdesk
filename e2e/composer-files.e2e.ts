/**
 * Files into the composer and paths out of replies, on the fake omp. Picked
 * files of any type become `@path` mentions (the host's copy of the bytes: a
 * WebView2 File has no path; quoted when the path has a space), a dropped file without a path goes in as its
 * text, the drop overlay names files and folders; bare path mentions in a
 * reply link only when the path exists, a file link opens the viewer and a
 * folder link the Files panel. Captures: light/dark × en/ko and a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { capture, exitApp, launchApp, variants } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function launch(
	language: Language,
	theme: Theme,
): Promise<{ app: ElectronApplication; page: Page; profile: string; project: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-composer-files-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([
		fs.mkdir(path.join(project, "local"), { recursive: true }),
		fs.mkdir(path.join(project, "docs"), { recursive: true }),
		fs.mkdir(desktop),
		fs.mkdir(agent),
		fs.mkdir(path.join(profile, "outside")),
	]);
	await fs.writeFile(path.join(project, "local", "PLAN.md"), "# Fixture plan\n\nShip the markdown wave.\n");
	await fs.writeFile(path.join(project, "docs", "spec.pdf"), Buffer.from("%PDF-1.4\n%\u0000fixture\n"));
	await fs.writeFile(path.join(profile, "outside", "Quarter Report.xlsx"), Buffer.from([80, 75, 3, 4, 0]));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const app = await launchApp({ project, desktop, agent, profile });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile, project };
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`composer takes files and replies link paths (${language} ${theme})`, async () => {
			test.setTimeout(150_000);
			const { app, page, profile, project } = await launch(language, theme);
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				const input = page.locator("textarea").first();
				const box = page.locator(".omp-composer-box").first();

				// Picker: any file type. A WebView2 File object carries bytes, never a path (`fs.pathForFile` is empty in
				// the Tauri host), so each pick lands as a copy in the profile's web-uploads folder, named by its own
				// name, and is mentioned by that absolute path (quoted when it holds a space).
				const sources = [
					path.join(project, "docs", "spec.pdf"),
					path.join(profile, "outside", "Quarter Report.xlsx"),
				];
				await box.locator('input[type="file"]').setInputFiles(sources);
				const uploads = path.join(profile, "desktop", "web-uploads");
				const copy = (name: string) =>
					`${escapeRegExp(path.join(uploads, "this-computer"))}${escapeRegExp(path.sep)}[0-9a-f-]{36}${escapeRegExp(path.sep)}${escapeRegExp(name)}`;
				const picked = new RegExp(`^@(${copy("spec.pdf")}) @"(${copy("Quarter Report.xlsx")})" $`);
				await expect(input).toHaveValue(picked);
				const mentions = picked.exec(await input.inputValue());
				if (!mentions) throw new Error("picked mentions missing");
				expect(await fs.readFile(mentions[1] ?? "")).toEqual(await fs.readFile(sources[0] ?? ""));
				expect(await fs.readFile(mentions[2] ?? "")).toEqual(await fs.readFile(sources[1] ?? ""));

				// A dropped file without a path (a browser blob) goes in as its text.
				await page.evaluate(() => {
					const target = document.querySelector(".omp-composer-box");
					if (!target) throw new Error("composer missing");
					const transfer = new DataTransfer();
					transfer.items.add(new File(["alpha\nbravo"], "notes.txt", { type: "text/plain" }));
					target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: transfer }));
				});
				await expect(box.locator(".omp-composer-drop")).toHaveText(
					language === "en" ? "Drop files or folders to attach" : "파일이나 폴더를 놓으면 첨부돼요",
				);
				await capture(page, `${language}-${theme}-drop-overlay`);
				await page.evaluate(() => {
					const target = document.querySelector(".omp-composer-box");
					if (!target) throw new Error("composer missing");
					const transfer = new DataTransfer();
					transfer.items.add(new File(["alpha\nbravo"], "notes.txt", { type: "text/plain" }));
					target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
				});
				await expect(input).toHaveValue(/\[Paste #\d+, \d+ chars\] $/);
				await expect(box.locator(".omp-composer-drop")).toHaveCount(0);
				await capture(page, `${language}-${theme}-composer-files`);

				// Replies: existing paths link, a missing one stays text.
				await input.fill("fixture paths");
				await input.press("Enter");
				const reply = page.locator(".omp-transcript-content .markdown-body").filter({ hasText: "src/gone.ts" });
				await expect(reply.locator('a[data-path-link="file"]')).toHaveCount(2, { timeout: 30_000 });
				await expect(reply.locator('a[data-path-link="dir"]')).toHaveText("local/");
				await expect(reply.locator("a", { hasText: "src/gone.ts" })).toHaveCount(0);
				await expect(reply.locator('a[data-path-link="file"]').first()).toHaveAttribute("title", "local/PLAN.md:3");
				await capture(page, `${language}-${theme}-path-links`);

				await reply.locator('a[data-path-link="file"]').first().click();
				const aside = page.locator("aside[data-docked]");
				await expect(aside).toContainText("Ship the markdown wave.", { timeout: 15_000 });
				await capture(page, `${language}-${theme}-path-open`);

				if (language === "en" && theme === "dark") {
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(720, 860));
					await reply.scrollIntoViewIfNeeded();
					await capture(page, "narrow-en-dark");
				}
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
