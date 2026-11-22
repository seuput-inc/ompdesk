/**
 * "Save diagnostic bundle" on the fake omp (e2e/fixture/rpc-ui.ts answers the bridge's `session_dump` with a real
 * zip in the temp dir): the session row's menu saves stock's dump members plus ompdesk-diagnostics.txt where the
 * (stubbed) save dialog points, and Option/Alt takes the anonymized archive (the menu has one item, not a twin);
 * the temp archive is gone afterwards. The real bridge method against stock is src/main/bridge-dump-stock.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import JSZip from "jszip";
import { exitApp, launchApp } from "./harness";

async function members(file: string): Promise<string[]> {
	return Object.keys((await JSZip.loadAsync(await fs.readFile(file))).files).sort();
}

async function tempArchives(): Promise<string[]> {
	return (await fs.readdir(os.tmpdir())).filter(name => /^omp-dump-.*\.zip$/.test(name));
}

test("the session row menu saves a diagnostic bundle, anonymized with Alt", async () => {
	test.setTimeout(180_000);
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bundle-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(profile, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir as string)));
	await fs.writeFile(
		path.join(desktop as string, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true }),
	);
	const logs = path.join(desktop as string, "logs");
	await fs.mkdir(logs);
	const marker = path.join(logs, "main-thread-hang.json");
	await fs.writeFile(
		marker,
		JSON.stringify({
			detectedAt: Date.UTC(2025, 4, 6),
			pid: 4242,
			unresponsiveMs: 7312,
			selfRecovered: false,
			phase: "quit",
			steps: ["update:quit-and-install", "quit:teardown:sidecars"],
			machine: { availMB: 317, cpuBusyPct: 98.5 },
		}),
	);
	await fs.writeFile(
		path.join(logs, "gui-runtime.jsonl.1"),
		'{"source":"slow-step","message":"이전 실행: sample@example.invalid"}\n',
	);
	const before = new Set(await tempArchives());
	const app = await launchApp({
		project: project as string,
		desktop: desktop as string,
		agent: agent as string,
		profile,
	});
	try {
		const page: Page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

		const input = page.locator(".omp-composer-input").first();
		await input.fill("hello there");
		await input.press("Enter");
		await expect(page.getByText("Local fixture reply")).toHaveCount(1, { timeout: 30_000 });

		const chooseTarget = (target: string) =>
			app.evaluate(({ dialog }, file) => {
				dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
			}, target);
		const openMenu = async () => {
			await page.locator(".omp-sidebar-session-row").first().click({ button: "right" });
			await expect(page.getByRole("menu")).toBeVisible();
		};

		const full = path.join(profile, "full.zip");
		await chooseTarget(full);
		await openMenu();
		await page.getByRole("menuitem", { name: /^Save diagnostic bundle/ }).click();
		await expect
			.poll(
				() =>
					fs.access(full).then(
						() => true,
						() => false,
					),
				{ timeout: 30_000 },
			)
			.toBe(true);
		expect(await members(full)).toEqual(["llm-request.json", "ompdesk-diagnostics.txt", "session.md"]);
		const diagnostics = await (await JSZip.loadAsync(await fs.readFile(full))).files[
			"ompdesk-diagnostics.txt"
		]?.async("string");
		expect(diagnostics).toContain("OMPdesk");
		const probes = diagnostics?.split("## Probes")[1]?.split("## Runtime log")[0];
		expect(probes).toContain('{"source":"slow-step","message":"이전 실행: <email>"}');
		const lines = diagnostics?.split("\n") ?? [];
		const hang = lines.find(line => line.includes('"source":"main-thread-hang"'));
		expect(JSON.parse(hang ?? "null")).toMatchObject({
			message: "Main thread stalled for 7s and never recovered",
			details: {
				previousPid: 4242,
				unresponsiveMs: 7312,
				selfRecovered: false,
				detectedAt: "2025-05-06T00:00:00.000Z",
				phase: "quit",
				steps: "update:quit-and-install > quit:teardown:sidecars",
			},
		});
		const machine = lines.find(line => line.includes('"message":"hang during"'));
		expect(JSON.parse(machine ?? "null")).toMatchObject({
			source: "machine-state",
			details: { trigger: "hang", when: "during", at: "2025-05-06T00:00:00.000Z", availMB: 317, cpuBusyPct: 98.5 },
		});
		expect(diagnostics).not.toContain("sample@example.invalid");

		const held = path.join(profile, "alt.zip");
		await chooseTarget(held);
		await openMenu();
		await page.getByRole("menuitem", { name: /^Save diagnostic bundle/ }).click({ modifiers: ["Alt"] });
		await expect
			.poll(
				() =>
					fs.access(held).then(
						() => true,
						() => false,
					),
				{ timeout: 30_000 },
			)
			.toBe(true);
		expect(await members(held)).toEqual(["ompdesk-diagnostics.txt", "session.jsonl"]);

		// One item, with its Option/Alt variant named on it; the anonymized item is Settings' (daily-flows).
		await openMenu();
		const items = page.getByRole("menuitem", { name: /diagnostic bundle/i });
		await expect(items).toHaveCount(1);
		await expect(items).toContainText(/(⌥|Alt) anonymized/);
		await page.keyboard.press("Escape");

		expect((await tempArchives()).filter(name => !before.has(name))).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
