/**
 * A paired phone reads a long session back past the page its transcript opened with (H30: its page loaded no older
 * messages). The fake omp's long session is 250 turns of six messages, "Long session turn 000" to "Long session
 * answer 249" (`OMP_GUI_TEST_LONG_SESSION`). A transcript opens on the newest 200 of them from the start of the turn
 * the 200th falls in, turns 216 to 249, and asks its computer for the page before when the reader's view comes near
 * its top (ChatStream `handleScroll`).
 *
 * The thumb is real touch input: touch points Chromium scrolls and flings by itself, so most of the way up is scrolled
 * after the finger lifted, which is where a phone asked for nothing. Unit counterparts:
 * `ChatStream.older-history.test.tsx` (the fling, a wheel, a transcript that still follows its tail) and the pages
 * themselves in `use-rpc-events.test.tsx` (`loadOlderTranscript`).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, test } from "@playwright/test";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { defaultTailscaleScenario } from "./fixture/tailscale-scenario";
import { capture, exitApp } from "./harness";
import { launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

/** The oldest turn of the page a transcript of the long session opens with: message 1300 of 1500 is in turn 216. */
const FIRST_LOADED_TURN = 216;

test("a phone's flicks up a long session bring the messages before its newest page", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-phone-older-history-")));
	let app: RemoteInstance | undefined;
	let proxy: ServeProxy | undefined;
	let browser: Browser | undefined;
	try {
		const tailscaleDir = path.join(parent, "tailscale");
		await fs.mkdir(tailscaleDir);
		const tailscale = await fixtureTailscale(tailscaleDir, {
			backendState: "Running",
			selfIps: ["127.0.0.1"],
			peers: defaultTailscaleScenario().peers,
		});
		const profile = await makeRemoteProfile(parent, "app", {
			language: "en",
			theme: "light",
			env: { ...tailscale.env, OMP_GUI_TEST_LONG_SESSION: "1" },
		});
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
		const context = await browser.newContext({ ...devices["Pixel 7"], colorScheme: "light" });
		const phone = await context.newPage();
		const phoneErrors: string[] = [];
		phone.on("pageerror", error => phoneErrors.push(error.stack ?? error.message));
		await phone.goto(`${proxy.url}/`);
		await phonePaired(phone);

		// Every omp of this app starts on the long session, the phone's own start tab's too.
		const scroller = phone.locator(".omp-transcript-scroll").first();
		await expect(scroller.getByText("Long session answer 249", { exact: true })).toBeVisible({ timeout: 60_000 });
		const box = await scroller.boundingBox();
		if (!box) throw new Error("the phone shows no transcript");
		const x = Math.round(box.x + box.width / 2);
		const top = Math.round(box.y + box.height / 4);
		const cdp = await context.newCDPSession(phone);
		/**
		 * The thumb moves 240 px down the transcript, toward its older messages, a point a frame as a finger's come
		 * (`Input.synthesizeScrollGesture` sends no touchmove on Windows, e2e/mobile-no-zoom.e2e.ts). Lifted `moving`
		 * the view flings on without it; `held` first, it stays where the finger left it.
		 */
		const swipe = async (lift: "moving" | "held") => {
			await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: top }] });
			for (let step = 1; step <= 6; step++) {
				await phone.waitForTimeout(16);
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x, y: top + step * 40 }],
				});
			}
			if (lift === "held") await phone.waitForTimeout(250);
			await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		};
		/** Where the transcript's view is once it has not moved for ten frames (five seconds at most). */
		const settled = () =>
			scroller.evaluate(async element => {
				let still = 0;
				let last = element.scrollTop;
				for (let frame = 0; frame < 300 && still < 10; frame++) {
					const painted = Promise.withResolvers<void>();
					requestAnimationFrame(() => painted.resolve());
					await painted.promise;
					still = element.scrollTop === last ? still + 1 : 0;
					last = element.scrollTop;
				}
				return last;
			});
		/** The oldest of the long session's turns with a row on screen (`Infinity` with none). */
		const oldestTurnOnScreen = () =>
			scroller.evaluate(element => {
				const view = element.getBoundingClientRect();
				const turns = [...element.querySelectorAll<HTMLElement>("[data-row-key]")].flatMap(row => {
					const rect = row.getBoundingClientRect();
					const turn = /Long session (?:turn|answer) (\d{3})/.exec(row.textContent ?? "");
					return turn && rect.bottom > view.top && rect.top < view.bottom ? [Number(turn[1])] : [];
				});
				return Math.min(...turns);
			});

		// A drag takes the view off the newest messages; from there every swipe is a flick.
		const tail = await settled();
		await expect(async () => {
			await swipe("held");
			expect(await settled(), "the drag scrolls the transcript off its newest messages").toBeLessThan(tail);
		}).toPass({ timeout: 30_000 });
		expect(await oldestTurnOnScreen()).toBeGreaterThanOrEqual(FIRST_LOADED_TURN);
		await expect(async () => {
			await swipe("moving");
			await settled();
			expect(await oldestTurnOnScreen()).toBeLessThan(FIRST_LOADED_TURN);
		}).toPass({ timeout: 150_000 });
		await capture(phone, "phone-older-history");
		expect(phoneErrors).toEqual([]);
	} finally {
		await browser?.close().catch(() => undefined);
		await proxy?.close().catch(() => undefined);
		if (app) await exitApp(app.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
