/**
 * The sidebar's device sections ("This device" and each paired host) are reordered by dragging a section header and the
 * order survives a relaunch (two apps on the fake omp, remote-harness.ts). Pairs a host, drags its header above this
 * device's with real mouse moves (the drop indicator shows while dragging), relaunches the client and reads the same
 * order, then moves the host back down with Alt+ArrowDown. Rules are unit-tested next to `SidebarDeviceSections`.
 *
 * `OMP_GUI_DEVICE_ORDER=<dir>` runs the spec in ko and en, light and dark, and writes captures of the reordered sidebar
 * and one mid-drag frame (indicator + chip) at desktop width (the app) and 390 px wide (the dev harness: an Electron
 * window cannot get that narrow).
 */
import * as fs from "node:fs/promises";
import { createServer as createServer0 } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { createServer } from "vite";
import type { SidebarFolds } from "../src/renderer/lib/sidebar-memory";
import type { RemoteState } from "../src/shared/ipc-types";
import { exitApp } from "./harness";
import {
	connectHost,
	type Language,
	launchRemote,
	makeRemoteProfile,
	openHostFolder,
	type RemoteInstance,
	type RemoteProfile,
	type Theme,
} from "./remote-harness";

const SHOTS = process.env.OMP_GUI_DEVICE_ORDER;
const VARIANTS: { language: Language; theme: Theme }[] = SHOTS
	? [
			{ language: "en", theme: "light" },
			{ language: "en", theme: "dark" },
			{ language: "ko", theme: "light" },
			{ language: "ko", theme: "dark" },
		]
	: [{ language: "en", theme: "light" }];

const order = (page: Page) =>
	page.locator("[data-device-slot]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-device-slot")));

async function dragTo(page: Page, from: string, to: string, release: boolean): Promise<void> {
	const source = page.locator(`[data-device-drag-handle="${from}"]`);
	const target = page.locator(`[data-device-drag-handle="${to}"]`);
	const a = await source.boundingBox();
	const b = await target.boundingBox();
	if (!a || !b) throw new Error("device headers have no box");
	const x = a.x + Math.min(a.width / 2, 60);
	await page.mouse.move(x, a.y + a.height / 2);
	await page.mouse.down();
	const toY = b.y + b.height / 2;
	const fromY = a.y + a.height / 2;
	for (let step = 1; step <= 12; step++) await page.mouse.move(x, fromY + ((toY - fromY) * step) / 12);
	if (release) await page.mouse.up();
}

for (const { language, theme } of VARIANTS) {
	test(`reorders the device sections by dragging and keeps the order (${language} ${theme})`, async () => {
		test.setTimeout(300_000);
		const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-device-order-")));
		let host: RemoteInstance | undefined;
		let client: RemoteInstance | undefined;
		const shoot = async (name: string) => {
			if (!SHOTS || !client) return;
			await fs.mkdir(SHOTS, { recursive: true });
			await client.page.screenshot({ path: path.join(SHOTS, `${name}-${language}-${theme}.png`) });
		};
		try {
			const hostProfile = await makeRemoteProfile(parent, "host", { language, theme });
			const clientProfile = await makeRemoteProfile(parent, "client", { language, theme, port: hostProfile.port });
			host = await launchRemote(hostProfile);
			client = await launchRemote(clientProfile);
			const hostId = await connectHost(host.page, client.page, "Studio B");
			const sections = () => (client as RemoteInstance).page.locator("[data-device-slot]");
			await expect(sections()).toHaveCount(2);
			await expect.poll(() => order((client as RemoteInstance).page)).toEqual(["local", hostId]);

			await test.step("dragging the host header above this device's reorders with a drop indicator", async () => {
				const page = (client as RemoteInstance).page;
				await dragTo(page, hostId, "local", false);
				await expect(page.locator("[data-device-drag-chip]")).toBeVisible();
				await expect(
					page.locator(`[data-device-slot="local"] [data-device-drop-indicator="before"]`),
				).toBeVisible();
				await expect(page.locator(`[data-device-drag-handle="${hostId}"]`)).toHaveAttribute(
					"data-dragging",
					"true",
				);
				await shoot("middrag-desktop");
				await page.mouse.up();
				await expect(page.locator("[data-device-drop-indicator]")).toHaveCount(0);
				await expect(page.locator("[data-device-drag-chip]")).toHaveCount(0);
				await expect.poll(() => order(page)).toEqual([hostId, "local"]);
			});

			await test.step("the order survives a relaunch", async () => {
				await exitApp((client as RemoteInstance).app);
				client = await launchRemote(clientProfile);
				await expect.poll(() => order((client as RemoteInstance).page)).toEqual([hostId, "local"]);
				await expect
					.poll(
						async () =>
							(await (client as RemoteInstance).page.evaluate(() => window.omp.remote.getState())).hosts[0]
								?.state,
						{ timeout: 30_000 },
					)
					.toBe("online");
				expect(await order((client as RemoteInstance).page)).toEqual([hostId, "local"]);
			});

			await test.step("captures: reordered sidebar at desktop width", async () => {
				if (!SHOTS) return;
				const instance = client as RemoteInstance;
				await instance.page.mouse.move(700, 600);
				await shoot("reordered-desktop");
			});

			await test.step("Alt+ArrowDown on the host header moves it back down", async () => {
				const page = (client as RemoteInstance).page;
				// A relaunch's tab activation queues the composer's focus hand-off (`followActivationFocus`) for the next
				// frame, and it takes focus from a sidebar button when it runs. A loaded window draws that frame late (a
				// second after the activation at 8x CPU throttle): the hand-off then ran just after the header was focused
				// and the key went to the composer. A callback asked for now runs after it in that same frame.
				await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
				await page.locator(`[data-device-drag-handle="${hostId}"]`).focus();
				await page.keyboard.press("Alt+ArrowDown");
				await expect.poll(() => order(page)).toEqual(["local", hostId]);
				await expect(page.locator(`[data-device-drag-handle="${hostId}"]`)).toBeFocused();
			});
		} finally {
			for (const instance of [client, host]) if (instance) await exitApp(instance.app);
			for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
			await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}

/** Per frame from the document's start: the first local row's top, whether a host section is drawn (pending or online), host rows. */
const FRAME_PROBE = `(() => {
	const frames = [];
	window.__deviceFrames = frames;
	const tick = () => {
		const row = document.querySelector("[data-sidebar-local-device] [data-session-path]");
		frames.push({
			top: row ? row.getBoundingClientRect().top : null,
			pending: document.querySelector("[data-device-pending]") !== null,
			online: document.querySelector('[data-sidebar-device][data-device-state="online"]') !== null,
			hostRows: document.querySelectorAll("[data-sidebar-device] [data-device-session]").length,
			section: document.querySelector("[data-sidebar-device]") !== null,
		});
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})();`;

interface DeviceFrame {
	top: number | null;
	pending: boolean;
	online: boolean;
	section: boolean;
	hostRows: number;
}

declare global {
	interface Window {
		__deviceFrames?: DeviceFrame[];
		__heldSidebar: {
			offlineRead: number;
			onlineRead: number;
			prefsDelivered: number;
			liveDelivered: number;
			unexpectedLive: number;
			releasePref: () => void;
			releaseLive: () => void;
		};
	}
}

/** `launchRemote` with the frame probe installed before the first document (a reload when the window beat it). */
async function launchProbed(profile: RemoteProfile): Promise<RemoteInstance> {
	const args = [
		path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
		profile.project,
		`--user-data-dir=${profile.desktop}`,
	];
	const app = await electron.launch({ args, env: profile.env });
	await app.context().addInitScript(FRAME_PROBE);
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	if (!(await page.evaluate(() => window.__deviceFrames !== undefined))) await page.reload();
	await page.waitForFunction(() => window.omp?.remote != null);
	return { app, page, profile, errors };
}

test("the local rows do not move across the first remote read of a relaunch", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-device-order-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const hostId = await connectHost(host.page, client.page, "Studio B");
		// The client's own session, typed into so it keeps a row (an empty one has none) and survives the host tab opening.
		const local = (await client.page.evaluate(() => window.omp.tabs.list())).find(tab => !tab.device)?.tabId ?? "";
		await client.page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Local session" }),
			local,
		);
		// A session of the host's own, so its section has rows to load on the next launch.
		await openHostFolder(client.page, hostId, hostProfile.project);
		const input = client.page.locator("[data-composer-input]").first();
		await input.fill("hello from the host");
		await input.press("Enter");
		await expect(client.page.locator(`[data-sidebar-device="${hostId}"] [data-device-session]`).first()).toBeVisible({
			timeout: 30_000,
		});
		await client.page.locator(`[data-device-drag-handle="${hostId}"]`).focus();
		await client.page.keyboard.press("Alt+ArrowUp");
		await expect.poll(() => order((client as RemoteInstance).page)).toEqual([hostId, "local"]);

		// Chromium commits localStorage to the profile a few seconds after a write, and the quit below is abrupt.
		await client.page.waitForTimeout(7000);
		await exitApp(client.app);
		client = await launchProbed(clientProfile);
		const page = client.page;
		await expect
			.poll(
				async () =>
					page.evaluate(() => {
						const last = window.__deviceFrames?.at(-1);
						return last?.online === true && last.hostRows > 0;
					}),
				{ timeout: 60_000 },
			)
			.toBe(true);
		await page.waitForTimeout(500); // frames after the rows are in: nothing may move then either
		const frames = await page.evaluate(() => window.__deviceFrames ?? []);
		const tops = frames.flatMap(frame => (frame.top === null ? [] : [frame.top]));
		expect(tops.length).toBeGreaterThan(0);
		const changes = frames
			.flatMap((frame, index) => {
				const before = frames[index - 1];
				const moved =
					!before ||
					before.top !== frame.top ||
					before.pending !== frame.pending ||
					before.online !== frame.online ||
					before.hostRows !== frame.hostRows;
				return moved
					? [
							`#${index} top=${frame.top} pending=${frame.pending} online=${frame.online} hostRows=${frame.hostRows}`,
						]
					: [];
			})
			.join("\n");
		const first = tops[0] as number;
		expect(Math.max(...tops) - first, changes).toBeLessThanOrEqual(1);
		expect(first - Math.min(...tops), changes).toBeLessThanOrEqual(1);
		const pendingFrame = frames.findIndex(frame => frame.pending);
		const onlineFrame = frames.findIndex(frame => frame.online);
		console.log(
			`device-order probe: ${frames.length} frames, pending first at ${pendingFrame}, online at ${onlineFrame}`,
		);
		// Whether a pending section is drawn at all depends on which comes first, the host list's read or the sidebar's
		// first frame (Sidebar.test.tsx pins the pending section itself). What must hold either way: the host's
		// section already has its place on the first frame that draws a local row.
		const firstRow = frames.findIndex(frame => frame.top !== null);
		expect(frames[firstRow]?.section, changes).toBe(true);
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a cached host row survives a stale offline preference delivered before live host state", async () => {
	test.setTimeout(180_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-offline-pref-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const page = client.page;
		const id = await connectHost(host.page, page, "Studio B");
		for (const device of [host.page, page]) {
			const input = device.locator("[data-composer-input]").first();
			await input.fill("Remember this fixture session");
			await input.press("Enter");
		}
		await page.evaluate(id => window.omp.remote.setDeviceSectionOrder([id, "local"]), id);
		const cacheKey = `omp.snap.1.sessions.${encodeURIComponent(`device:${id}`)}.global`;
		// Keep row identities inside the fixture window. Only observations about them leave it.
		await page.waitForFunction(
			({ id, cacheKey }) => {
				const [first, second] = document.querySelectorAll("[data-device-slot]");
				const section = first?.querySelector("[data-sidebar-device]");
				const rows = section?.querySelectorAll("[data-device-session]:not([data-live])");
				const row = rows?.length === 1 && rows[0]?.getAttribute("data-device-session");
				const local = second?.querySelector("[data-session-path]")?.getAttribute("data-session-path");
				const cached = JSON.parse(localStorage.getItem(cacheKey) ?? "null") as { d: { path: string }[] } | null;
				const localCache = JSON.parse(
					localStorage.getItem("omp.snap.1.sessions.local.global") ?? "null",
				) as typeof cached;
				if (
					first?.getAttribute("data-device-slot") !== id ||
					second?.getAttribute("data-device-slot") !== "local" ||
					section?.getAttribute("data-device-state") !== "online" ||
					!row ||
					!local ||
					!cached?.d.some(entry => entry.path === row) ||
					!localCache?.d.some(entry => entry.path === local)
				)
					return false;
				sessionStorage.setItem("offline-pref-probe", JSON.stringify({ row, local }));
				return true;
			},
			{ id, cacheKey },
			{ timeout: 30_000 },
		);
		await page.evaluate(async id => {
			const folds = JSON.parse(localStorage.getItem("omp.sidebarFolds") ?? "null") as SidebarFolds | null;
			if (folds?.knownHosts.length !== 1 || folds.knownHosts[0]?.id !== id || folds.knownHosts[0].offline)
				throw new Error("Expected one remembered online fixture host");
			await window.omp.prefs.set("sidebarFolds", {
				...folds,
				knownHosts: [{ ...folds.knownHosts[0], offline: true }],
			});
		}, id);
		// Delay the fixture bridge's actual replies and pushes, not the Sidebar's store or its DOM.
		await page.addInitScript(id => {
			if (window !== window.top) return;
			function install() {
				const { remote, prefs } = window.omp;
				const pref = Promise.withResolvers<void>();
				const live = Promise.withResolvers<void>();
				const held = {
					offlineRead: -1,
					onlineRead: -1,
					prefsDelivered: 0,
					liveDelivered: 0,
					unexpectedLive: 0,
					releasePref: pref.resolve,
					releaseLive: live.resolve,
				};
				window.__heldSidebar = held;
				const get = prefs.get;
				prefs.get = async key => {
					const value = await get(key);
					if (key === "sidebarFolds") {
						const hosts = (value as SidebarFolds | null)?.knownHosts;
						held.offlineRead = Number(hosts?.length === 1 && hosts[0]?.id === id && hosts[0].offline === true);
						await pref.promise;
						held.prefsDelivered++;
					}
					return value;
				};
				const getState = remote.getState;
				const isFixtureOnline = (state: RemoteState) =>
					state.hosts.length === 1 && state.hosts[0]?.deviceId === id && state.hosts[0].state === "online";
				const delivered = (state: RemoteState) => {
					held.liveDelivered++;
					if (!isFixtureOnline(state)) held.unexpectedLive++;
				};
				remote.getState = async () => {
					const state = await getState();
					held.onlineRead = Number(isFixtureOnline(state));
					await live.promise;
					delivered(state);
					return state;
				};
				const onState = remote.onState;
				remote.onState = callback => {
					let subscribed = true;
					const off = onState(state => {
						void live.promise.then(() => {
							if (subscribed) {
								delivered(state);
								callback(state);
							}
						});
					});
					return () => {
						subscribed = false;
						off();
					};
				};
			}
			if (window.omp) install();
			else document.addEventListener("readystatechange", install, { once: true });
		}, id);
		await page.reload();
		await page.waitForFunction(() => {
			const held = window.__heldSidebar;
			return (
				held &&
				held.onlineRead >= 0 &&
				held.offlineRead >= 0 &&
				document.querySelector("[data-sidebar-local-device] [data-session-path]") !== null
			);
		});
		const sample = () =>
			page.evaluate(
				async ({ id, cacheKey }) => {
					const paint = Promise.withResolvers<void>();
					requestAnimationFrame(() => requestAnimationFrame(() => paint.resolve()));
					await paint.promise;
					const { row, local } = JSON.parse(sessionStorage.getItem("offline-pref-probe") ?? "{}");
					const cached = JSON.parse(localStorage.getItem(cacheKey) ?? "null") as { d: { path: string }[] } | null;
					const folds = JSON.parse(localStorage.getItem("omp.sidebarFolds") ?? "null") as SidebarFolds | null;
					const remembered = folds?.knownHosts.find(h => h.id === id);
					const section = document.querySelector(`[data-sidebar-device="${id}"]`);
					const rows = [...(section?.querySelectorAll("[data-device-session]") ?? [])];
					const localRow = document.querySelector("[data-sidebar-local-device] [data-session-path]");
					const { offlineRead, onlineRead, prefsDelivered, liveDelivered, unexpectedLive } = window.__heldSidebar;
					return {
						offlineRead,
						onlineRead,
						prefsDelivered,
						liveDelivered,
						unexpectedLive,
						cached: Number(!!cached?.d.some(entry => entry.path === row)),
						mirrorOnline: Number(!!remembered && !remembered.offline),
						pending: Number(section?.hasAttribute("data-device-pending") === true),
						connecting: Number(section?.getAttribute("data-device-state") === "connecting"),
						offline: Number(section?.getAttribute("data-device-state") === "offline"),
						online: Number(section?.getAttribute("data-device-state") === "online"),
						rows: rows.length,
						row: Number(
							rows.some(
								el => el.getAttribute("data-device-session") === row && el.getBoundingClientRect().height > 0,
							),
						),
						local: Number(!!localRow && localRow.getAttribute("data-session-path") === local),
						top: localRow?.getBoundingClientRect().top ?? -1,
						hostFirst: Number(
							document.querySelector("[data-device-slot]")?.getAttribute("data-device-slot") === id,
						),
					};
				},
				{ id, cacheKey },
			);
		const before = await sample();
		await page.evaluate(() => window.__heldSidebar.releasePref());
		await page.waitForFunction(() => window.__heldSidebar.prefsDelivered > 0);
		const stale = await sample();
		await page.evaluate(() => window.__heldSidebar.releaseLive());
		await page.waitForFunction(() => window.__heldSidebar.liveDelivered > 0);
		let restored = await sample();
		await expect
			.configure({ soft: true })
			.poll(
				async () => {
					restored = await sample();
					return [restored.online, restored.row, restored.local];
				},
				{ timeout: 30_000 },
			)
			.toEqual([1, 1, 1]);
		const trace = JSON.stringify([before, stale, restored]);
		console.log(`device-order offline-pref stages: ${trace}`);
		expect(before, trace).toMatchObject({
			offlineRead: 1,
			onlineRead: 1,
			prefsDelivered: 0,
			liveDelivered: 0,
			cached: 1,
			mirrorOnline: 1,
			hostFirst: 1,
			pending: 1,
			connecting: 1,
			row: 1,
			local: 1,
		});
		expect(stale.prefsDelivered, trace).toBeGreaterThan(0);
		expect(stale, trace).toMatchObject({ liveDelivered: 0, cached: 1, hostFirst: 1, pending: 1, local: 1 });
		expect(restored, trace).toMatchObject({
			unexpectedLive: 0,
			online: 1,
			pending: 0,
			hostFirst: 1,
			row: 1,
			local: 1,
		});
		expect(Math.abs(stale.top - before.top), trace).toBeLessThanOrEqual(1);
		expect(stale.row, trace).toBe(1);
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("the drag chip stays under the pointer while the sidebar list scrolls", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-device-order-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const hostId = await connectHost(host.page, client.page, "Studio B");
		const page = client.page;
		await expect(page.locator("[data-device-slot]")).toHaveCount(2);
		// The list is as tall as a long one: a spacer after the sections (React leaves a foreign node alone).
		const scroller = page.locator('[data-tour="sessions"]');
		await scroller.evaluate(node => {
			const spacer = document.createElement("div");
			spacer.style.height = "2000px";
			node.appendChild(spacer);
		});
		const handle = page.locator(`[data-device-drag-handle="${hostId}"]`);
		const box = await handle.boundingBox();
		if (!box) throw new Error("host header has no box");
		const startX = box.x + 40;
		const startY = box.y + box.height / 2;
		await page.mouse.move(startX, startY);
		await page.mouse.down();
		for (let step = 1; step <= 8; step++) await page.mouse.move(startX, startY - step * 6);
		const chip = page.locator("[data-device-drag-chip]");
		await expect(chip).toBeVisible();
		await scroller.evaluate(node => {
			node.scrollTop = 300;
		});
		expect(await scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
		const pointer = { x: startX + 30, y: startY - 20 };
		for (let step = 1; step <= 4; step++)
			await page.mouse.move(startX + (30 * step) / 4, startY - 48 + ((pointer.y - startY + 48) * step) / 4);
		await expect
			.poll(async () => {
				const rect = await chip.boundingBox();
				return rect ? [Math.round(rect.x - pointer.x), Math.round(rect.y - pointer.y)] : null;
			})
			.toEqual([12, -14]);
		const rect = await chip.boundingBox();
		expect(Math.abs((rect?.x ?? 0) - (pointer.x + 12))).toBeLessThanOrEqual(2);
		expect(Math.abs((rect?.y ?? 0) - (pointer.y - 14))).toBeLessThanOrEqual(2);
		await page.keyboard.press("Escape");
		await page.mouse.up();
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

// Electron's window cannot go below its minimum width, so the 390 px frames come from the dev harness (phone drawer).
for (const { language, theme } of SHOTS ? VARIANTS : []) {
	test(`captures the reordered device sections at 390 px (${language} ${theme})`, async () => {
		test.setTimeout(120_000);
		const port = await freePort();
		const server = await createServer({
			configFile: path.resolve("vite.harness.config.ts"),
			server: { host: "127.0.0.1", port, strictPort: true },
			logLevel: "error",
		});
		await server.listen();
		const browser = await chromium.launch();
		try {
			const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
			const page = await context.newPage();
			await page.goto(`http://127.0.0.1:${port}/harness.html?theme=${theme}&lang=${language}`);
			await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
			await page.getByRole("button", { name: language === "ko" ? /메뉴 열기/ : /Open menu/ }).click();
			await expect(page.locator("[data-drawer] [data-device-sections]")).toBeVisible();
			await expect.poll(() => order(page)).toEqual(["local", "host-1", "host-2"]);
			const shoot = async (name: string) => {
				await fs.mkdir(SHOTS as string, { recursive: true });
				await page.screenshot({ path: path.join(SHOTS as string, `${name}-${language}-${theme}.png`) });
			};
			await dragTo(page, "host-1", "local", false);
			await expect(page.locator(`[data-device-slot="local"] [data-device-drop-indicator="before"]`)).toBeVisible();
			await expect(page.locator("[data-device-drag-chip]")).toBeVisible();
			await shoot("middrag-390");
			await page.mouse.up();
			await expect.poll(() => order(page)).toEqual(["host-1", "local", "host-2"]);
			await page.mouse.move(380, 800);
			await shoot("reordered-390");
		} finally {
			await browser.close();
			await server.close();
		}
	});
}

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createServer0();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		const port = typeof address === "object" && address ? address.port : 0;
		probe.close(() => resolve(port));
	});
	return promise;
}
