import { describe, expect, it } from "vitest";
import {
	CONSOLE_LINES_PER_HOUR,
	CONSOLE_RECENT_MS,
	type ConsoleWindow,
	ConsoleWindowWatch,
} from "./console-window-watch";

const NOW = Date.parse("2026-11-20T00:00:00.000Z");
const OWN = [
	{ pid: 200, role: "main" },
	{ pid: 100, role: "host" },
	{ pid: 300, role: "core" },
];

/** A git the core started without hiding its window: conhost's own window, named for the program. */
const GIT: ConsoleWindow = {
	window: 0x1a2b,
	pid: 900,
	class: "ConsoleWindowClass",
	title: "C:\\Program Files\\Git\\cmd\\git.exe",
	chain: [
		{ pid: 900, name: "git.exe", startedMs: NOW - 400, commandLine: "git.exe status --porcelain" },
		{ pid: 300, name: "ompdesk-core.exe", startedMs: NOW - 90_000, commandLine: "ompdesk-core.exe" },
		{ pid: 200, name: "node.exe", startedMs: NOW - 91_000 },
		{ pid: 100, name: "OMPdesk.exe", startedMs: NOW - 92_000 },
	],
	recent: [],
};

/** The person's own terminal. */
const TERMINAL: ConsoleWindow = {
	window: 0x3c4d,
	pid: 5000,
	class: "CASCADIA_HOSTING_WINDOW_CLASS",
	title: "PowerShell",
	chain: [
		{ pid: 5000, name: "WindowsTerminal.exe", startedMs: NOW - 3_600_000, commandLine: "WindowsTerminal.exe" },
		{ pid: 800, name: "svchost.exe" },
	],
	recent: [],
};

function rig(sessionOf: (tag: string) => string | undefined = () => undefined) {
	const clock = { now: NOW };
	const lines: Array<{ message: string; details: Record<string, string | number | boolean> }> = [];
	const asked: Array<{ known: number[]; roots: number[]; sinceMs: number }> = [];
	const desktop = { windows: [] as ConsoleWindow[] };
	const watch = new ConsoleWindowWatch({
		now: () => clock.now,
		own: () => OWN,
		sessionOf,
		log: (message, details) => lines.push({ message, details }),
		list: async (known, roots, sinceMs) => {
			asked.push({ known, roots, sinceMs });
			// As the core answers: a window the caller knows comes bare.
			return desktop.windows.map(win =>
				known.includes(win.window) ? { window: win.window, pid: win.pid, class: win.class, title: win.title } : win,
			);
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
				title: "C:\\Users\\admin\\.bun\\bin\\bun.exe",
				recent: [
					{ pid: 901, name: "bun.exe", startedMs: NOW - 1_200, commandLine: "bun.exe x vitest run" },
					{ pid: 902, name: "conhost.exe" },
				],
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
		const { lines, desktop, watch } = rig(asked => (asked === tag ? "/sessions/2026-11-20_abc.jsonl" : undefined));
		await watch.poll();
		desktop.windows = [
			{
				window: 7,
				pid: 700,
				class: "ConsoleWindowClass",
				title: "cmd",
				chain: [{ pid: 700, name: "cmd.exe" }],
				tag,
			},
			{ window: 8, pid: 701, class: "ConsoleWindowClass", title: "cmd", chain: [], tag: "cd".repeat(16) },
		];
		await watch.poll();
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
