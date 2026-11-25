import { describe, expect, it } from "vitest";
import attribution from "../../native/ompdesk/crates/core/src/procs/console-attribution.json";
import {
	CONSOLE_LINES_PER_HOUR,
	CONSOLE_RECENT_MS,
	type ConsoleWindow,
	ConsoleWindowWatch,
	listConsoleWindows,
} from "./console-window-watch";
import { stopCore } from "./core/process";

const NOW = Date.parse("2026-11-20T00:00:00.000Z");
const OWN = [
	{ pid: 200, role: "main" },
	{ pid: 100, role: "host" },
	{ pid: 300, role: "core" },
];

/** A git the core started without hiding its window: conhost's own window, named for the program. */
const GIT = {
	window: 0x1a2b,
	facts: {
		...attribution[0],
		pid: 900,
		class: "ConsoleWindowClass",
		title: "C:\\Program Files\\Git\\cmd\\git.exe",
		process: { pid: 900, name: "git.exe", startedMs: NOW - 400, commandLine: "git.exe status --porcelain" },
		parentCmd: "ompdesk-core.exe",
	},
} satisfies ConsoleWindow;

/** The person's own terminal. */
const TERMINAL = {
	window: 0x3c4d,
	facts: {
		...attribution[1],
		pid: 5000,
		class: "CASCADIA_HOSTING_WINDOW_CLASS",
		title: "PowerShell",
		process: {
			pid: 5000,
			name: "WindowsTerminal.exe",
			startedMs: NOW - 3_600_000,
			commandLine: "WindowsTerminal.exe",
		},
	},
} satisfies ConsoleWindow;

function rig(sessionOf: (tag: string) => string | undefined = () => undefined) {
	const clock = { now: NOW };
	const lines: Array<{ message: string; details: Record<string, string | number | boolean> }> = [];
	const asked: Array<{ known: number[]; roots: number[]; sinceMs: number }> = [];
	const desktop = { windows: [] as ConsoleWindow[], unavailable: false };
	const watch = new ConsoleWindowWatch({
		now: () => clock.now,
		own: () => OWN,
		sessionOf,
		log: (message, details) => lines.push({ message, details }),
		list: async (known, roots, sinceMs) => {
			asked.push({ known, roots, sinceMs });
			if (desktop.unavailable) throw new Error("core exited");
			// As the core answers: a window the caller knows comes bare.
			return desktop.windows.map(win => (known.includes(win.window) ? { window: win.window } : win));
		},
	});
	return { clock, lines, asked, desktop, watch };
}

describe("console window watch", () => {
	it("writes a new console window once, with its process, its ancestors up to OMPdesk and who started it", async () => {
		const { lines, asked, desktop, watch } = rig();
		await watch.poll();
		desktop.windows = [GIT];
		await watch.poll();
		await watch.poll();

		expect(lines).toEqual([
			{
				message: "console window opened by a process OMPdesk started",
				details: {
					class: "ConsoleWindowClass",
					title: "C:\\Program Files\\Git\\cmd\\git.exe",
					pid: 900,
					exe: "git.exe",
					cmd: "git.exe status --porcelain",
					ageMs: 400,
					ours: true,
					via: "core",
					chain: "git.exe(900) < ompdesk-core.exe(300) < node.exe(200) < OMPdesk.exe(100)",
					parentCmd: "ompdesk-core.exe",
				},
			},
		]);
		expect(asked.map(ask => ask.known)).toEqual([[], [], [GIT.window]]);
		expect(asked[0]).toMatchObject({ roots: [200, 100, 300], sinceMs: NOW - CONSOLE_RECENT_MS });
	});

	it("says nothing of the windows that stood before it looked, unless OMPdesk's processes opened one", async () => {
		const { lines, desktop, watch } = rig();
		desktop.windows = [TERMINAL, GIT];
		await watch.poll();
		await watch.poll();
		expect(lines.map(line => line.details.pid)).toEqual([900]);
	});

	it("names what OMPdesk started just before a window another program shows", async () => {
		const { lines, desktop, watch } = rig();
		await watch.poll();
		desktop.windows = [
			{
				...TERMINAL,
				facts: {
					...TERMINAL.facts,
					title: "C:\\Users\\admin\\.bun\\bin\\bun.exe",
					recent: [
						{ pid: 901, name: "bun.exe", startedMs: NOW - 1_200, commandLine: "bun.exe x vitest run" },
						{ pid: 902, name: "conhost.exe" },
					],
				},
			},
		];
		await watch.poll();
		expect(lines).toEqual([
			{
				message: "console window opened, not by a process OMPdesk started",
				details: {
					class: "CASCADIA_HOSTING_WINDOW_CLASS",
					title: "C:\\Users\\admin\\.bun\\bin\\bun.exe",
					pid: 5000,
					exe: "WindowsTerminal.exe",
					cmd: "WindowsTerminal.exe",
					ageMs: 3_600_000,
					ours: false,
					chain: "WindowsTerminal.exe(5000) < svchost.exe(800)",
					recent: "bun.exe(901) 1200ms ago: bun.exe x vitest run | conhost.exe(902)",
				},
			},
		]);
	});

	it("knows a session's process by its tag once the parent that started it is gone", async () => {
		const tag = "ab".repeat(16);
		let session = "/sessions/old.jsonl";
		const { lines, desktop, watch } = rig(asked => (asked === tag ? session : undefined));
		await watch.poll();
		desktop.windows = [
			{
				window: 7,
				facts: {
					...attribution[2],
					pid: 700,
					class: "ConsoleWindowClass",
					title: "cmd",
					process: { pid: 700, name: "cmd.exe" },
					tag,
				},
			},
			{
				window: 8,
				facts: { ...attribution[3], pid: 701, class: "ConsoleWindowClass", title: "cmd", tag: "cd".repeat(16) },
			},
		];
		const reading = watch.poll();
		session = "/sessions/2026-11-20_abc.jsonl";
		await reading;
		expect(lines.map(line => line.details)).toEqual([
			{
				class: "ConsoleWindowClass",
				title: "cmd",
				pid: 700,
				exe: "cmd.exe",
				ours: true,
				session: "2026-11-20_abc.jsonl",
				chain: "cmd.exe(700)",
			},
			{ class: "ConsoleWindowClass", title: "cmd", pid: 701, ours: true, session: `tag ${"cd".repeat(16)}` },
		]);
	});

	it("clips a title and command lines at UTF-16 units, even inside a pair", async () => {
		const { lines, desktop, watch } = rig();
		await watch.poll();
		const title = `${"x".repeat(199)}\u{1f680}`;
		const command = `${"y".repeat(599)}\u{1f680}`;
		desktop.windows = [
			{
				window: TERMINAL.window,
				facts: {
					...TERMINAL.facts,
					title,
					process: { ...TERMINAL.facts.process, commandLine: command },
					parentCmd: command,
					recent: [{ pid: 901, name: "bun.exe", commandLine: title }],
				},
			},
		];
		await watch.poll();
		expect(lines[0].details).toMatchObject({
			title: `${"x".repeat(199)}\ud83d…`,
			cmd: `${"y".repeat(599)}\ud83d…`,
			parentCmd: `${"y".repeat(599)}\ud83d…`,
			recent: `bun.exe(901): ${"x".repeat(199)}\ud83d…`,
		});
	});

	it.runIf(process.platform === "win32")("reads new facts and known handles through the core", async () => {
		try {
			const fresh = await listConsoleWindows([], [process.pid], Date.now() - CONSOLE_RECENT_MS);
			for (const row of fresh) {
				expect(row.facts).toMatchObject({
					ours: expect.any(Boolean),
					class: expect.any(String),
					title: expect.any(String),
					pid: expect.any(Number),
				});
			}
			const known = fresh.map(row => row.window);
			const next = await listConsoleWindows(known, [process.pid], Date.now() - CONSOLE_RECENT_MS);
			for (const row of next) expect(row.facts === undefined).toBe(known.includes(row.window));
		} finally {
			await stopCore();
		}
	});

	it("takes a window that went and came back for new, and keeps to the hour's lines", async () => {
		const { clock, lines, desktop, watch } = rig();
		await watch.poll();
		desktop.windows = [GIT];
		await watch.poll();
		desktop.windows = [];
		await watch.poll();
		desktop.windows = [GIT];
		await watch.poll();
		expect(lines).toHaveLength(2);

		desktop.windows = Array.from({ length: CONSOLE_LINES_PER_HOUR }, (_, index) => ({ ...GIT, window: 100 + index }));
		await watch.poll();
		expect(lines).toHaveLength(CONSOLE_LINES_PER_HOUR);
		desktop.unavailable = true;
		await watch.poll();
		desktop.unavailable = false;
		await watch.poll();
		expect(lines).toHaveLength(CONSOLE_LINES_PER_HOUR);

		clock.now += 60 * 60_000;
		desktop.windows = [{ ...GIT, window: 999 }];
		await watch.poll();
		expect(lines).toHaveLength(CONSOLE_LINES_PER_HOUR + 1);
		expect(lines.at(-1)?.details.dropped).toBe(2);
	});

	it("skips a look the core cannot answer, and asks no second time while one is out", async () => {
		const lines: unknown[] = [];
		const answer = Promise.withResolvers<ConsoleWindow[]>();
		let asks = 0;
		const watch = new ConsoleWindowWatch({
			own: () => OWN,
			sessionOf: () => undefined,
			log: (...line) => lines.push(line),
			list: () => {
				asks++;
				return answer.promise;
			},
		});
		const out = watch.poll();
		await watch.poll();
		expect(asks).toBe(1);
		answer.reject(new Error("ompdesk-core is shutting down"));
		await out;
		await watch.poll().catch(() => undefined);
		expect(asks).toBe(2);
		expect(lines).toEqual([]);
	});
});
