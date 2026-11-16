/**
 * A message typed while the phone's link to the computer has been down for a long time is kept, not refused: on the
 * built app's real web page behind the fake `tailscale serve` (e2e/fixture/phone-serve.ts refuses every request for a
 * whole minute), 390 px wide in WebKit and in Chromium.
 *
 * - Two messages sent during the outage leave the field and wait in the composer's "will send when connected" tray
 *   (`[data-composer-outbox]`), one row each; nothing reaches the computer.
 * - A third one is cancelled from the tray and never arrives.
 * - The page reloads in the middle of the outage (iOS killing a page in the background) and still shows both.
 * - Once the link is back each of the two reaches the computer's omp exactly once, in the order they were sent, and the
 *   tray empties.
 *
 * The desktop viewing a paired host's tab: remote-offline-send.e2e.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BrowserType, chromium, devices, expect, type Page, test, webkit } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, recordPhoneLoads, ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, fixtureOmp } from "./harness";

const ENGINES: { name: string; type: BrowserType; device: (typeof devices)[string] }[] = [
	{ name: "webkit", type: webkit, device: devices["iPhone 14"] },
	{ name: "chromium", type: chromium, device: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
];

/** How long the computer stays out of reach. */
const OUTAGE_MS = 60_000;

/** The user prompts the computer's omp received, in order (the fake omp records every frame it reads). */
async function received(record: string, texts: readonly string[]): Promise<string[]> {
	const lines = (await fs.readFile(record, "utf8").catch(() => "")).split("\n").filter(Boolean);
	const out: string[] = [];
	for (const line of lines) {
		let frame: { type?: string; message?: string };
		try {
			frame = JSON.parse(line);
		} catch {
			continue;
		}
		if (frame.type !== "prompt" && frame.type !== "steer" && frame.type !== "follow_up") continue;
		const text = texts.find(candidate => frame.message?.includes(candidate));
		if (text) out.push(text);
	}
	return out;
}

async function send(phone: Page, text: string): Promise<void> {
	const field = phone.locator("[data-composer-input]").first();
	await field.fill(text);
	await phone
		.locator(".omp-composer-box")
		.getByRole("button", { name: /^(Send|Queue|Steer)/ })
		.first()
		.click();
	await expect(field).toHaveValue("");
}

function tray(phone: Page) {
	return phone.locator("[data-composer-outbox]:visible");
}

for (const engine of ENGINES)
	test(`the phone (${engine.name}) keeps messages sent during a long outage and delivers each once, in order`, async () => {
		test.setTimeout(300_000);
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-phone-offline-")));
		const project = path.join(root, "project");
		const desktop = path.join(root, "desktop");
		const agent = path.join(root, "agent");
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
		);
		const tailscale = await fixtureTailscale(root, { backendState: "Running" });
		const record = path.join(root, "omp-received.jsonl");
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
		Object.assign(env, {
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: path.relative(os.homedir(), root),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_OMP: await fixtureOmp(root),
			OMP_GUI_TEST_SESSION_FILES: "1",
			OMP_GUI_TEST_RECORD: record,
			...tailscale.env,
		});
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		let app: ElectronApplication | null = null;
		let proxy: ServeProxy | null = null;
		const browser = await engine.type.launch();
		try {
			app = await electron.launch({
				args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`],
				env,
			});
			const desk = await app.firstWindow();
			await desk.waitForFunction(() => window.omp?.rpc != null);
			await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
			await expect
				.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
				.toBe("ready");
			await expect.poll(() => serveSites(tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
			const site = serveSites(tailscale).at(-1);
			if (!site) throw new Error("serve publishes no handler");
			proxy = await ServeProxy.start(site, "seuput@example.com", undefined, {
				plainCookie: engine.name === "webkit",
			});
			const link = proxy;
			const context = await browser.newContext({ ...engine.device, colorScheme: "light" });
			const phone = await context.newPage();
			const loads = recordPhoneLoads(phone);
			const t0 = Date.now();
			const workerEvents: string[] = [];
			context.on("serviceworker", worker =>
				workerEvents.push(`+${Date.now() - t0}ms serviceworker ${worker.url()}`),
			);
			const pending = new Set<string>();
			phone.on("request", request => pending.add(request.url()));
			phone.on("requestfinished", request => pending.delete(request.url()));
			phone.on("requestfailed", request => pending.delete(request.url()));
			const expectControlled = async () => {
				try {
					await expect
						.poll(() => phone.evaluate(() => navigator.serviceWorker?.controller != null), { timeout: 30_000 })
						.toBe(true);
				} catch (error) {
					// Where the worker and the page parted: the registration's states, what the worker sees as its clients
					// (windows it could claim), whether a claim made now takes the page, and the page's own loads and
					// worker log (phone-loads attachment). A claim that takes the page now means the activation's claim ran
					// before this document existed; one that does not means the page is not claimable.
					const worker = await phone
						.evaluate(async () => {
							const registration = await navigator.serviceWorker?.getRegistration();
							return {
								secure: isSecureContext,
								installing: registration?.installing?.state ?? null,
								waiting: registration?.waiting?.state ?? null,
								active: registration?.active?.state ?? null,
								scope: registration?.scope ?? null,
								url: location.href,
							};
						})
						.catch(failure => String(failure));
					const [serviceWorker] = context.serviceWorkers();
					const clients = await serviceWorker
						?.evaluate(
							"self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => list.map(c => [c.url, c.frameType, c.visibilityState, c.focused].join(' ')))",
						)
						.catch((failure: unknown) => String(failure));
					const claimed = await serviceWorker
						?.evaluate("self.clients.claim().then(() => 'claimed')")
						.catch((failure: unknown) => String(failure));
					const controlledAfter = await phone
						.evaluate(() => navigator.serviceWorker?.controller != null)
						.catch(failure => String(failure));
					await loads.attach("phone-loads");
					throw new Error(
						[
							String(error),
							`service worker: ${JSON.stringify(worker)}`,
							`worker events: ${JSON.stringify(workerEvents)} workers now: ${context.serviceWorkers().length}`,
							`worker's clients: ${JSON.stringify(clients)}`,
							`claim now: ${JSON.stringify(claimed)}, page controlled after: ${JSON.stringify(controlledAfter)}`,
							`open requests: ${[...pending].join(" ")}`,
						].join("\n"),
					);
				}
			};
			await phone.goto(`${link.url}/`, { timeout: 60_000 });
			await phonePaired(phone);
			// The first load's own worker takes the page (it registers once the app has loaded and claims on activation).
			// That is checked here, before the reload below: a document that is created while the worker is still installing
			// and activating can miss the activation's claim (Chromium on a hosted Windows runner: the reload landed between
			// the worker's install and its activation, the worker listed the page as a client and a claim made 30 s later
			// took it at once), and no page the person reloads that early is the point of this test.
			await expectControlled();
			const tabId = (await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project))?.tabId;
			if (!tabId) throw new Error("no tab on the phone");
			await phone.reload({ timeout: 60_000 });
			await phonePaired(phone);
			const field = phone.locator("[data-composer-input]").first();
			await expect(field).toBeEditable({ timeout: 60_000 });
			await expect
				.poll(
					async () => (await phone.evaluate(() => window.omp.tabs.list())).find(t => t.tabId === tabId)?.status,
					{ timeout: 60_000 },
				)
				.toBe("ready");
			// A first exchange, so the session has a file and a transcript, and the page its offline shell.
			await send(phone, "hello before the outage");
			await expect
				.poll(() => received(record, ["hello before the outage"]), { timeout: 30_000 })
				.toEqual(["hello before the outage"]);
			await expectControlled();
			// The tab strip and transcript snapshots are written after a quiet moment.
			await phone.waitForTimeout(1500);

			const texts = ["offline message one", "offline message two", "offline message cancelled"] as const;
			const outageStart = Date.now();
			const down = link.outage("refuse");
			// Past every wait the page used to give a call (15 s), so the link has been down "for any length".
			await phone.waitForTimeout(20_000);
			await send(phone, texts[0]);
			await send(phone, texts[1]);
			await send(phone, texts[2]);
			await expect(tray(phone)).toBeVisible();
			const rows = tray(phone).locator("[data-outbox-item]");
			await expect(rows).toHaveCount(3);
			await expect(rows.nth(0)).toContainText(texts[0]);
			await expect(rows.nth(1)).toContainText(texts[1]);
			await expect(rows.nth(2)).toContainText(texts[2]);
			await phone.screenshot({ path: `test-results/phone-offline-tray-${engine.name}.png`, animations: "disabled" });
			// Cancel takes one back for good.
			await rows
				.nth(2)
				.getByRole("button", { name: /^Don't send / })
				.click();
			await expect(rows).toHaveCount(2);

			// iOS kills a page left in the background: the reload still shows what waits.
			await phone.reload({ timeout: 60_000 }).catch(async (error: Error) => {
				// `load` waits for every request. The trace holds no page network (nightlies 41886483957, 41902079883), so the
				// failure carries three views: what the page still had open, what it loaded, and what the proxy saw reach
				// the host or get refused.
				await loads.attach("phone-loads.txt");
				await test.info().attach("serve-requests.txt", { body: link.requestLog() });
				throw new Error(`${error.message}\nrequests still open: ${JSON.stringify([...pending])}`);
			});
			await expect(tray(phone)).toBeVisible({ timeout: 30_000 });
			await expect(tray(phone).locator("[data-outbox-item]")).toHaveCount(2);
			await expect(tray(phone).locator("[data-outbox-item]").nth(0)).toContainText(texts[0]);
			await expect(tray(phone).locator("[data-outbox-item]").nth(1)).toContainText(texts[1]);
			await phone.screenshot({
				path: `test-results/phone-offline-reloaded-${engine.name}.png`,
				animations: "disabled",
			});
			expect(await received(record, texts)).toEqual([]);

			await phone.waitForTimeout(Math.max(0, OUTAGE_MS - (Date.now() - outageStart)));
			expect(await received(record, texts)).toEqual([]);
			down.restore();
			await expect.poll(() => received(record, texts), { timeout: 60_000 }).toEqual([texts[0], texts[1]]);
			await expect(tray(phone)).toHaveCount(0, { timeout: 10_000 });
			// Nothing arrives a second time once the page has caught up.
			await phone.waitForTimeout(3000);
			expect(await received(record, texts)).toEqual([texts[0], texts[1]]);
		} finally {
			await browser.close();
			await proxy?.close();
			if (app) await exitApp(app).catch(() => undefined);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
		}
	});
