/** Sending during a running turn delivers a current instruction from every send control. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

const WINDOWS = process.platform === "win32";
const SEND_CHORD = WINDOWS ? "Control+Enter" : "Meta+Enter";

async function frames(file: string): Promise<Array<{ type: string; message?: unknown }>> {
	const text = await fs.readFile(file, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line): unknown => JSON.parse(line))
		.filter(
			(frame): frame is { type: string; message?: unknown } =>
				typeof frame === "object" && frame !== null && "type" in frame && typeof frame.type === "string",
		)
		.filter(frame => frame.type === "composer.prompt");
}

test("@smoke a message sent while a turn runs is delivered from Enter, Send and the send chord", async () => {
	test.setTimeout(90_000);
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-steer-send-")));
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const project = path.join(profile, "project");
	const record = path.join(profile, "commands.jsonl");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(project)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_RECORD: record,
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	try {
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const input = page.locator("textarea").first();
		const send = page.getByRole("button", { name: "Send", exact: true });
		await input.fill("fixture running");
		await input.press("Enter");
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

		/**
		 * Type `message` once the composer takes it. Send stays disabled while the previous message is still being
		 * delivered (the prompt's reply, or a steer's), and Enter and the chords read the same state: a key pressed
		 * before then is dropped and the draft stays, as a person sees it. Windows' slower IPC makes that window
		 * longer than the test's next step.
		 */
		const draft = async (message: string) => {
			await input.fill(message);
			await expect(send).toBeEnabled();
		};

		const sent = async (message: string) => {
			await expect(input).toHaveValue("");
			await expect.poll(async () => (await frames(record)).some(frame => frame.message === message)).toBe(true);
		};

		await draft("steer by enter");
		await input.press("Enter");
		await sent("steer by enter");

		await draft("steer by button");
		await send.click();
		await sent("steer by button");

		await draft("steer by chord");
		await input.press(SEND_CHORD);
		await sent("steer by chord");
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.rpc.getQueue())).data)
			.toMatchObject({
				entries: [{ text: "steer by enter" }, { text: "steer by button" }, { text: "steer by chord" }],
			});
		await draft("duplicate");
		await input.press("Enter");
		await sent("duplicate");
		await draft("duplicate");
		await input.press("Enter");
		await expect
			.poll(
				async () =>
					(
						(await page.evaluate(() => window.omp.rpc.getQueue())).data as {
							entries: { text: string }[];
						}
					).entries.filter(entry => entry.text === "duplicate").length,
			)
			.toBe(2);
		const duplicates = await page.evaluate(async () => {
			const data = (await window.omp.rpc.getQueue()).data as {
				instance: string;
				entries: { id: string; text: string }[];
			};
			const entries = data.entries.filter(entry => entry.text === "duplicate");
			await window.omp.rpc.queueRemove(data.instance, entries[0].id, "discard");
			return entries.map(entry => entry.id);
		});
		expect(duplicates[0]).not.toBe(duplicates[1]);
		await expect
			.poll(async () => {
				const data = (await page.evaluate(() => window.omp.rpc.getQueue())).data as { entries: { id: string }[] };
				return data.entries.filter(entry => duplicates.includes(entry.id)).map(entry => entry.id);
			})
			.toEqual([duplicates[1]]);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

for (const language of ["en", "ko"] as const) {
	test(`pictures sent during a turn show in the pending list (${language})`, async () => {
		test.setTimeout(90_000);
		const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-steer-image-")));
		const desktop = path.join(profile, "desktop");
		const agent = path.join(profile, "agent");
		const project = path.join(profile, "project");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(project)]);
		await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language, firstRunComplete: true }));
		const app = await launchApp({ project, desktop, agent, profile });
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		try {
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
				.toBe("ready");
			const input = page.locator("textarea").first();
			await input.fill("fixture running");
			await input.press("Enter");
			await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

			const rows = page.locator("[data-queue-row]");
			const queued = async () =>
				page.evaluate(async () => {
					const data = (await window.omp.rpc.getQueue()).data as { entries: unknown[] };
					return data.entries.length;
				});
			const paste = async (caption: string, rowsAfter: number) => {
				await input.focus();
				await page.evaluate(
					([png, text]) => {
						const field = document.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
						const data = new DataTransfer();
						data.items.add(
							new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], "p.png", { type: "image/png" }),
						);
						if (text) data.setData("text/plain", text);
						field?.dispatchEvent(
							new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
						);
					},
					[PNG, caption] as const,
				);
				// Send stays disabled while the previous message is being delivered, and Enter reads the same state.
				await expect(page.locator('[data-slot="send"] button')).toBeEnabled();
				await input.press("Enter");
				// The next send waits for this one to reach the queue (a send in flight ignores Enter).
				await expect.poll(queued).toBe(rowsAfter);
			};

			await paste("look at this picture", 1);
			await paste("", 2);
			await paste("", 3);
			const snapshot = await page.evaluate(
				async () =>
					(await window.omp.rpc.getQueue()).data as {
						entries: { id: string; text: string }[];
					},
			);
			expect(snapshot.entries[1].id).not.toBe(snapshot.entries[2].id);
			expect(snapshot.entries.slice(1).map(entry => entry.text)).toEqual(["", ""]);
			const counts = language === "en" ? "1 image" : "이미지 1개";
			const wordOnly = language === "en" ? "Image only" : "이미지만";
			await page.locator("[data-queue-pill]").click();
			await expect(rows.nth(0)).toContainText("look at this picture");
			await expect(rows.nth(0).locator("[data-queue-images]")).toHaveText(counts);
			await expect(rows.nth(1)).toContainText(wordOnly);
			await expect(rows.nth(1).locator("[data-queue-images]")).toHaveText(counts);
			await expect(rows.nth(1).locator("[data-queue-images] img")).toHaveCount(1);
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}

test("pending instructions leave the transcript and composer in place", async () => {
	test.setTimeout(150_000);
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-queue-pill-")));
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const project = path.join(profile, "project");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(project)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({ project, desktop, agent, profile });
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	try {
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const input = page.locator("textarea[data-composer-input]").first();
		await input.fill("fixture running");
		await input.press("Enter");
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

		const pane = page.locator('.omp-session-pane[data-active="true"]');
		/** The transcript's height and the composer's box, in px: what queuing must leave alone. */
		const geometry = () =>
			pane.evaluate(() => {
				const transcript = document.querySelector(".omp-session-pane[data-active='true'] .omp-transcript-scroll");
				const box = document.querySelector(".omp-session-pane[data-active='true'] .omp-composer-box");
				return {
					transcript: transcript?.clientHeight ?? -1,
					box: Math.round(box?.getBoundingClientRect().height ?? -1),
					top: Math.round(box?.getBoundingClientRect().top ?? -1),
				};
			});
		const queueCount = () =>
			page.evaluate(async () => {
				const data = (await window.omp.rpc.getQueue()).data as { entries: unknown[] };
				return data.entries.length;
			});
		const queue = async (text: string) => {
			const before = await queueCount();
			await input.fill(text);
			// Send stays disabled while the previous message is being delivered, and Enter and the chords read the same state.
			await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
			await input.press("Enter");
			await expect(input).toHaveValue("");
			await expect.poll(queueCount).toBe(before + 1);
		};

		const empty = await geometry();
		await queue("steer one");
		await expect(page.locator("[data-queue-pill]")).toContainText("1 queued");
		// The first message adds nothing above, under or inside the box.
		expect(await geometry()).toEqual(empty);
		expect(await page.locator(".omp-composer-queue").count()).toBe(0);
		await queue("instruction two");
		await queue("instruction three");
		await queue("instruction four");
		await expect(page.locator("[data-queue-pill]")).toContainText("4 queued");
		expect(await geometry()).toEqual(empty);
		for (let index = 5; index <= 10; index++) await queue(`more ${index}`);
		await expect(page.locator("[data-queue-pill]")).toContainText("10 queued");
		expect(await geometry()).toEqual(empty);

		// The list floats without changing the layout.
		await page.locator("[data-queue-pill]").click();
		const popover = page.locator("[data-queue-popover]");
		await expect(popover).toBeVisible();
		await expect(popover.locator("[data-queue-row]")).toHaveCount(10);
		expect(await geometry()).toEqual(empty);

		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
