/** DesktopTitleBar.test.tsx covers the renderer. Only a real app HWND can tell Windows what these pixels do. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp, launchApp, readRecords } from "./harness";

type Point = { x: number; y: number };
type Points = Record<string, Point>;
type Geometry = {
	width: number;
	height: number;
	screen: { width: number; height: number };
	scale: number;
	rendererBar: boolean;
	visibleCaptions: number;
	points: Points;
};
const HT = { client: 1, caption: 2, minimize: 8, maximize: 9, top: 12, close: 20 };

function geometry(page: Page, beforeFullscreen?: Geometry): Promise<Geometry> {
	return page.evaluate(previous => {
		const rectCenter = (rect: DOMRect): Point => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
		const visibleCenter = (el: Element): Point | undefined => {
			const { x, y } = rectCenter(el.getBoundingClientRect());
			return el.contains(document.elementFromPoint(x, y)) ? { x, y } : undefined;
		};
		const desktopBar = document.querySelector("[data-desktop-titlebar]");
		const points: Points = {};
		if (previous) {
			// The buttons disappear. Probe where their measured centers would be at the new right edge.
			for (const name of ["minimize", "maximize", "close"]) {
				const { x, y } = previous.points[name];
				points[name] = { x: innerWidth - (previous.width - x), y };
			}
		} else {
			const bar = desktopBar ?? document.querySelector("header.omp-titlebar");
			if (!bar) throw new Error("No desktop session title bar");
			for (const name of ["minimize", "maximize", "close"]) {
				const buttons = document.querySelectorAll(`button[data-caption="${name}"]`);
				const center = buttons.length === 1 && visibleCenter(buttons[0]);
				if (!center) throw new Error(`Expected one exposed ${name} caption button`);
				points[name] = center;
			}
			const control = [...bar.querySelectorAll("button:not([data-caption]):enabled")]
				.map(visibleCenter)
				.find(p => p);
			if (!control) throw new Error("No exposed interactive title bar control");
			points.control = control;
			const drag = bar.querySelector("[data-titlebar-drag]");
			if (drag) {
				const center = visibleCenter(drag);
				if (!center) throw new Error("The drag area is covered");
				points.drag = center;
			} else {
				// The preceding renderer has no drag spacer. Its exposed header between controls is draggable.
				const rect = bar.getBoundingClientRect();
				const { y } = rectCenter(rect);
				for (let x = Math.ceil(rect.left) + 12; x < rect.right - 12; x += 4) {
					if ([-3, 0, 3].every(dx => document.elementFromPoint(x + dx, y) === bar)) {
						points.drag = { x, y };
						break;
					}
				}
				if (!points.drag) throw new Error("No exposed draggable header between controls");
			}
			points.top = { x: points.drag.x, y: 1 };
		}
		return {
			width: innerWidth,
			height: innerHeight,
			screen: { width: screen.width, height: screen.height },
			scale: devicePixelRatio,
			rendererBar: !!desktopBar,
			visibleCaptions: [...document.querySelectorAll("button[data-caption]")].filter(el => el.checkVisibility())
				.length,
			points,
		};
	}, beforeFullscreen);
}

test("@smoke Windows title bar returns native hit codes for the rendered controls", async () => {
	test.skip(process.platform !== "win32", "WM_NCHITTEST is a Windows window message");
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-chrome-hit-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(profile, name));
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, sidebarVisible: false, panelVisible: false }),
	);
	await fs.writeFile(
		path.join(desktop, "window-state.json"),
		JSON.stringify({ windowState: { width: 1000, height: 640 } }),
	);
	const app = await launchApp({ project, desktop, agent, profile });
	try {
		const page = await app.firstWindow();
		const { id, wcId } = await app.evaluate(({ BrowserWindow }) => {
			const [win] = BrowserWindow.getAllWindows();
			return { id: win.id, wcId: win.webContents.id };
		});
		const records = await readRecords(path.join(desktop, "tauri-shell.jsonl"));
		const hwnd = Number(records.find(r => r.event === "window.boot_shell" && r.wcId === wcId)?.hwnd);
		const pid = app.process().pid;
		expect(Number.isSafeInteger(hwnd) && hwnd > 0, "test profile's window.boot_shell HWND").toBe(true);
		expect(pid, "launched Tauri host PID").toBeTruthy();
		type Native = { origin: Point; maximized: boolean; hits: Record<string, number> };
		const observe = async (state: "normal" | "maximized" | "restored" | "fullscreen", previous?: Geometry) => {
			const samples: { dom: Geometry; native: Native }[] = [];
			try {
				// Window operations return before WebView2 has resized and published its new hit regions.
				await expect(async () => {
					const dom = await geometry(page, state === "fullscreen" ? previous : undefined);
					const args = JSON.stringify({ hwnd, pid, points: dom.points, scale: dom.scale });
					const native: Native = JSON.parse(
						execFileSync("bun", [path.join(import.meta.dirname, "fixture/win-chrome-hit.ts"), args], {
							encoding: "utf8",
							timeout: 10_000,
							windowsHide: true,
						}),
					);
					samples.push({ dom, native });
					if (state === "fullscreen") {
						expect(Math.abs(dom.width - dom.screen.width)).toBeLessThanOrEqual(1);
						expect(Math.abs(dom.height - dom.screen.height)).toBeLessThanOrEqual(1);
						expect(native.hits).toEqual({ minimize: HT.client, maximize: HT.client, close: HT.client });
						// The native-only change predates the renderer taking ownership of the visible buttons.
						if (previous?.rendererBar) expect(dom.visibleCaptions).toBe(0);
					} else {
						expect(native.maximized).toBe(state === "maximized");
						const { top, ...hits } = native.hits;
						expect(hits).toEqual({
							minimize: HT.minimize,
							maximize: HT.maximize,
							close: HT.close,
							drag: HT.caption,
							control: HT.client,
						});
						expect(state === "maximized" ? [HT.caption, HT.client] : [HT.top]).toContain(top);
						if (state === "restored")
							expect([dom.width, dom.height]).toEqual([previous?.width, previous?.height]);
					}
				}).toPass({ timeout: 10_000 });
			} finally {
				await test.info().attach(`window-chrome-${state}.json`, {
					body: Buffer.from(JSON.stringify({ state, pid, hwnd, wcId, samples }, null, 2)),
					contentType: "application/json",
				});
			}
			const observed = samples.at(-1);
			if (!observed) throw new Error(`No native observation for ${state}`);
			return observed.dom;
		};
		const normal = await observe("normal");
		await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.maximize(), id);
		await observe("maximized");
		await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.unmaximize(), id);
		const restored = await observe("restored", normal);
		await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.setFullScreen(true), id);
		await observe("fullscreen", restored);
	} finally {
		await exitApp(app);
	}
});
