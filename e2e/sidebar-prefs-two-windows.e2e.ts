/**
 * Two windows share one stored sidebar: an order one window sets survives a change the other makes from what it read
 * earlier (the owner's report, 9 Nov 2026: the remembered session order kept getting lost). Real menus on the built
 * app with the fake omp; the stored prefs file is the verdict, and a relaunch draws it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp } from "./harness";

let app: ElectronApplication | undefined;

// Only event names and relative times leave this disposable launch profile.
async function networkStages(desktop: string, native: string): Promise<void> {
	const nativeEvents = native
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
	const start = nativeEvents.find(event => event.event === "shell.started");
	if (!start) return;
	const files = (await fs.readdir(desktop)).filter(file => file.startsWith("net-"));
	const file = `net-${start.pid}.json`;
	if (!files.includes(file)) {
		console.log("[network] missing first host log");
		return;
	}
	const data = await fs.readFile(path.join(desktop, file), "utf8");
	const net = JSON.parse(data) as {
		constants: {
			logEventTypes: Record<string, number>;
			timeTickOffset: string;
			clientInfo?: { command_line?: string };
		};
		events: { time: string; type: number; phase: number; source: { id: number }; params?: { url?: string } }[];
	};
	const names = new Map(Object.entries(net.constants.logEventTypes).map(([name, id]) => [id, name]));
	const matches = net.events.filter(
		row => row.params?.url?.split("?")[0] === "http://app.localhost/__profile/migrate",
	);
	const sources = new Set(matches.map(row => row.source.id));
	const relative = (time: string) => Number(time) + Number(net.constants.timeTickOffset) - start.at + start.t;
	const phases = (type: string, bootstrapOnly: boolean) =>
		net.events
			.filter(row => names.get(row.type) === type && (!bootstrapOnly || sources.has(row.source.id)))
			.map(row => [row.source.id, row.phase, relative(row.time)]);
	console.log(
		"[nav-compare]",
		JSON.stringify({
			rep: test.info().repeatEachIndex,
			arm: test.info().repeatEachIndex % 2 ? "bypass" : "default",
			flag: net.constants.clientInfo?.command_line?.includes("--proxy-bypass-list=app.localhost") ?? null,
			starts: nativeEvents
				.filter(row => row.event === "probe.nav.start" && row.kind === "bootstrap")
				.map(row => row.t),
			resources: nativeEvents.filter(row => row.event === "probe.nav.resource").map(row => row.t),
			waitPAC: phases("PROXY_RESOLUTION_SERVICE_WAITING_FOR_INIT_PAC", true),
			cookieLoad: phases("COOKIE_PERSISTENT_STORE_LOAD", false),
			stalls: nativeEvents.filter(row => row.event === "profile.migrate.stalled").map(row => row.t),
		}),
	);
}
let root = "";

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (root) {
		const text = await fs.readFile(path.join(root, "desktop", "tauri-shell.jsonl"), "utf8").catch(() => "");
		for (const line of text.split("\n")) {
			if (line.includes('"event":"probe.nav.') || line.includes('"event":"profile.migrate.stalled"'))
				console.log(line);
		}
		await networkStages(path.join(root, "desktop"), text).catch(error =>
			console.log(`[network] ${error.name}: log unavailable`),
		);
	}
	app = undefined;
	if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	root = "";
});

async function seed(agent: string, id: string, cwd: string, title: string, minutesAgo: number): Promise<void> {
	const file = path.join(agent, "sessions", "seeded", `${id}.jsonl`);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
	const lines = [
		{ type: "title", v: 1, title, updatedAt: at },
		{ type: "session", version: 3, id, timestamp: at, cwd },
		{ type: "message", id: `${id}-1`, parentId: null, timestamp: at, message: { role: "user", content: title } },
		{
			type: "message",
			id: `${id}-2`,
			parentId: `${id}-1`,
			timestamp: at,
			message: { role: "assistant", content: [{ type: "text", text: `${title} answer` }] },
		},
	];
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
}

const order = (page: Page) =>
	page
		.locator("[data-session-group] [data-session-path]")
		.evaluateAll(rows => rows.map(row => row.getAttribute("data-session-path")?.split(/[\\/]/).at(-1)));

async function rowMenu(page: Page, id: string, item: string): Promise<void> {
	await page.locator(`[data-session-group] [data-session-path$="${id}.jsonl"]`).first().click({ button: "right" });
	await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("an order one window sets survives what another window, which read the sidebar earlier, changes", async () => {
	test.setTimeout(120_000);
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-prefs-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(root, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	await seed(agent, "s-1", project, "Alpha plan", 1);
	await seed(agent, "s-2", project, "Bravo plan", 2);
	await seed(agent, "s-3", project, "Charlie plan", 3);
	const launch = async () => {
		const exists = (file: string) =>
			fs.stat(path.join(desktop, file)).then(
				() => true,
				() => false,
			);
		const [view, journal] = await Promise.all([exists("tauri-webview"), exists("tauri-local-storage-import.json")]);
		console.log(`[nav-profile] rep=${test.info().repeatEachIndex} webviewDir=${view} journal=${journal}`);
		return launchApp({
			project,
			desktop,
			agent,
			profile: root,
			env: {
				OMP_GUI_TEST_SESSION_FILES: "1",
				OMP_GUI_TEST_FIRST_NAV_NET: test.info().repeatEachIndex % 2 ? "bypass" : "default",
			},
		});
	};
	app = await launch();
	const first = await app.firstWindow();
	await first.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(() => order(first)).toEqual(["s-1.jsonl", "s-2.jsonl", "s-3.jsonl"]);
	expect(await first.evaluate(() => window.omp.sessions.openInNewWindow({}))).toBe(true);
	await expect.poll(() => app?.windows().length).toBe(2);
	const second = app.windows().find(page => page !== first);
	if (!second) throw new Error("The second window has no page");
	await second.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(() => order(second)).toEqual(["s-1.jsonl", "s-2.jsonl", "s-3.jsonl"]);

	// The first window puts Charlie on top; the second, which read the sidebar before that, archives Bravo.
	await rowMenu(first, "s-3", "Move up");
	await rowMenu(first, "s-3", "Move up");
	await expect.poll(() => order(first)).toEqual(["s-3.jsonl", "s-1.jsonl", "s-2.jsonl"]);
	await rowMenu(second, "s-2", "Archive");

	const stored = async () =>
		JSON.parse(await fs.readFile(path.join(desktop, "prefs.json"), "utf8")).sidebar as {
			sessionOrder?: Record<string, string[]>;
			archivedSessions?: string[];
		};
	await expect.poll(async () => (await stored()).archivedSessions).toEqual(["s-2"]);
	expect(
		Object.values((await stored()).sessionOrder ?? {})
			.flat()
			.map(file => file.split(/[\\/]/).at(-1)),
	).toEqual(["s-3.jsonl", "s-1.jsonl", "s-2.jsonl"]);
	// Both windows show both changes now, and a relaunch draws them from the stored file.
	for (const page of [first, second]) await expect.poll(() => order(page)).toEqual(["s-3.jsonl", "s-1.jsonl"]);
	await exitApp(app);
	app = await launch();
	const again = await app.firstWindow();
	await again.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(() => order(again)).toEqual(["s-3.jsonl", "s-1.jsonl"]);
});
