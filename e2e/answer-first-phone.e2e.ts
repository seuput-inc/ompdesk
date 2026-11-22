/**
 * The phone asks stock to steer if busy. Only its second send interrupts a running turn and must be answered first.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, test } from "@playwright/test";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { defaultTailscaleScenario } from "./fixture/tailscale-scenario";
import { exitApp, readRecords } from "./harness";
import { launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

const QUESTION = "어느정도 됐어?";
const SENDS: Record<string, true> = { prompt: true, steer: true, follow_up: true, typed_prompt: true };

test("a message the phone sends into a running turn is noted as a typed steer before the steer", async () => {
	test.setTimeout(180_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-answer-first-phone-")));
	let app: RemoteInstance | undefined;
	let proxy: ServeProxy | undefined;
	let browser: Browser | undefined;
	try {
		const tailscaleDir = path.join(parent, "tailscale");
		await fs.mkdir(tailscaleDir);
		const defaults = defaultTailscaleScenario();
		const tailscale = await fixtureTailscale(tailscaleDir, {
			backendState: "Running",
			selfIps: ["127.0.0.1"],
			peers: defaults.peers,
		});
		const profile = await makeRemoteProfile(parent, "app", { language: "en", theme: "light", env: tailscale.env });
		app = await launchRemote(profile);
		await app.page.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(
				() => app?.page.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "starting"),
				{ timeout: 60_000 },
			)
			.toBe("ready");
		const [site] = serveSites(tailscale);
		if (!site) throw new Error("no serve handler published");
		proxy = await ServeProxy.start(site, "seuput@example.com");
		browser = await chromium.launch();
		const phone = await (await browser.newContext({ ...devices["Pixel 7"], colorScheme: "light" })).newPage();
		const phoneErrors: string[] = [];
		phone.on("pageerror", error => phoneErrors.push(error.stack ?? error.message));
		await phone.goto(`${proxy.url}/`);
		await phonePaired(phone);

		const input = phone.locator("[data-composer-input]").first();
		const send = phone.getByRole("button", { name: /^(Send|보내기)$/ });
		await input.fill("fixture running");
		await send.click();
		await expect(phone.getByRole("button", { name: /^(Stop|중단)$/ })).toBeVisible({ timeout: 30_000 });
		await expect(phone.locator(".omp-composer-toolbar[data-turn-running]")).toBeVisible({ timeout: 30_000 });

		await input.fill(QUESTION);
		await expect(send).toBeEnabled();
		await send.click();

		const sends = async () =>
			(await readRecords(profile.record)).filter(
				record => typeof record.type === "string" && SENDS[record.type] === true,
			);
		const textOf = (record: Record<string, unknown>) =>
			record.type === "typed_prompt" ? record.text : record.message;
		await expect
			.poll(
				async () => (await sends()).some(record => record.type !== "typed_prompt" && textOf(record) === QUESTION),
				{
					timeout: 30_000,
				},
			)
			.toBe(true);

		const frames = await sends();
		const first = frames.findIndex(record => record.type === "typed_prompt" && record.text === "fixture running");
		expect(first).toBeGreaterThanOrEqual(0);
		expect(frames[first]).toMatchObject({ steer: false });
		expect(frames[first + 1]).toMatchObject({
			type: "prompt",
			message: "fixture running",
			streamingBehavior: "steer",
		});

		const note = frames.findIndex(record => record.type === "typed_prompt" && record.text === QUESTION);
		expect(note).toBeGreaterThan(first);
		expect(frames[note]).toMatchObject({ steer: true });
		// The very next send is the steer carrying the text: nothing between the note and it.
		const joined = frames[note + 1];
		expect(joined).toBeDefined();
		expect(joined?.message).toBe(QUESTION);
		const asSteer = joined?.type === "steer" || (joined?.type === "prompt" && joined.streamingBehavior === "steer");
		expect(asSteer, JSON.stringify(joined)).toBe(true);
		expect(phoneErrors).toEqual([]);
	} finally {
		await browser?.close().catch(() => undefined);
		await proxy?.close().catch(() => undefined);
		if (app) await exitApp(app.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
